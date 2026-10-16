"""
Modal GPU video worker for MakeAdClips (self-hosted, budget-conscious).

WHAT THIS IS
------------
A Modal web endpoint that runs an open-source text/image -> video model on a
GPU and returns base64 MP4 FOOTAGE. The Next.js app calls it; the ffmpeg
compositor still renders all exact copy (brand/URL/price/CTA), so this worker
never has to produce readable text.

COST DISCIPLINE (per-second GPU billing)
----------------------------------------
Modal bills GPU time per second, so this worker is built to minimize GPU
wall-time:
  * `@app.cls` with `scaledown_window` keeps ONE warm container so the model is
    loaded ONCE (via `@modal.enter`), not per request — cold starts are the main
    cost sink.
  * `min_containers=0` so it scales to zero when idle (you pay nothing idle).
  * It measures and RETURNS the GPU wall-time it used (`gpuSeconds`) so the app
    can estimate spend and enforce the $30/month budget.
  * Short default clips; a hard max.
Set a HARD spend limit in the Modal dashboard too — this worker is the fast
path, the dashboard limit is the real backstop.

DEPLOY
------
  pip install modal
  modal token new                      # one-time auth on your machine
  modal secret create makeadclips-worker WORKER_SECRET=<a-long-random-string>
  modal deploy modal/video_worker.py   # prints the https://...modal.run URL

Then in the Next.js app's .env.local:
  VIDEO_PROVIDER=gemini
  VIDEO_MODEL=modal-video
  MODAL_VIDEO_ENDPOINT=<the printed URL>
  MODAL_WORKER_SECRET=<same WORKER_SECRET>
  MODAL_GPU_USD_PER_SECOND=<the per-second rate of the GPU below>

MODEL
-----
Defaults to LTX-Video (Lightricks) — fast, low-VRAM, Apache-2.0, good for short
clips — the cheapest viable first path. Swap MODEL_ID / the pipeline for another
open model later without changing the Next.js side (the HTTP contract is fixed).
"""

import base64
import io
import os
import time

import modal

try:  # resolved inside the container (fastapi is in the image)
    from fastapi import Request
except ImportError:  # local `modal deploy` machine without fastapi
    Request = object

# ---- GPU selection -------------------------------------------------------
# L4 (24GB) is a good price/perf default for LTX short clips. If you change it,
# also update MODAL_GPU_USD_PER_SECOND in the app's env to match Modal's rate
# for that GPU so the spend estimate stays accurate.
GPU = os.environ.get("MAC_WORKER_GPU", "L4")
MODEL_ID = os.environ.get("MAC_WORKER_MODEL", "Lightricks/LTX-Video")

image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "torch",
        "diffusers>=0.32.0",
        "transformers>=4.44.0",
        "accelerate",
        "imageio[ffmpeg]",
        "sentencepiece",
        "pillow",
        # Required for @modal.fastapi_endpoint (Modal no longer auto-installs it).
        "fastapi[standard]",
    )
)

app = modal.App("makeadclips-video-worker")

# Cache model weights on a Volume so they download ONCE, not per cold start
# (another big GPU-time saver).
weights = modal.Volume.from_name("makeadclips-weights", create_if_missing=True)
WEIGHTS_DIR = "/weights"

MAX_SECONDS = 8
DEFAULT_FPS = 24


@app.cls(
    image=image,
    gpu=GPU,
    volumes={WEIGHTS_DIR: weights},
    secrets=[modal.Secret.from_name("makeadclips-worker")],
    scaledown_window=120,   # stay warm 2 min after a request (avoid reloads)
    min_containers=0,       # scale to zero when idle → no idle cost
    timeout=600,
)
class VideoWorker:
    @modal.enter()
    def load(self):
        """Load the model ONCE per container (not per request)."""
        import torch
        from diffusers import LTXPipeline, LTXImageToVideoPipeline

        os.environ.setdefault("HF_HOME", WEIGHTS_DIR)
        self.torch = torch
        self.pipe = LTXPipeline.from_pretrained(
            MODEL_ID, torch_dtype=torch.bfloat16, cache_dir=WEIGHTS_DIR
        ).to("cuda")
        # Image->video shares the SAME weights (no extra VRAM / download).
        self.i2v = LTXImageToVideoPipeline(**self.pipe.components)

    def _dims(self, aspect_ratio):
        # Keep resolution modest to bound GPU time; compositor upscales/pads.
        return (704, 480) if aspect_ratio == "16:9" else (480, 704)

    @modal.fastapi_endpoint(method="POST")
    def generate(self, payload: dict, request: Request):
        """HTTP entrypoint. Returns {videoBase64, mimeType, gpuSeconds, model, mode}."""
        from fastapi import HTTPException

        # ---- auth: reject anything without the correct shared secret ----
        expected = os.environ.get("WORKER_SECRET", "")
        if not expected:
            raise HTTPException(status_code=503, detail="worker secret not configured")
        got = request.headers.get("x-worker-secret", "")
        if got != expected:
            raise HTTPException(status_code=401, detail="bad worker secret")

        gpu_start = time.time()
        try:
            prompt = (payload or {}).get("prompt") or ""
            if not prompt.strip():
                return {"error": "empty prompt", "gpuSeconds": 0}
            seconds = max(2, min(MAX_SECONDS, int((payload or {}).get("durationSeconds") or 4)))
            width, height = self._dims((payload or {}).get("aspectRatio"))

            # LTX-Video requires num_frames ≡ 1 (mod 8). Snap to a valid count.
            raw_frames = seconds * DEFAULT_FPS
            num_frames = max(25, ((raw_frames // 8) * 8) + 1)

            negative_prompt = (
                "worst quality, inconsistent motion, blurry, jittery, distorted, "
                "text, watermark, logo, caption, subtitles"
            )
            common = dict(
                prompt=prompt,
                negative_prompt=negative_prompt,
                width=width,
                height=height,
                num_frames=num_frames,
                decode_timestep=0.03,
                decode_noise_scale=0.025,
                num_inference_steps=int(os.environ.get("MAC_WORKER_STEPS", "30")),
            )
            image_b64 = (payload or {}).get("image")
            mode = "t2v"
            if image_b64:
                from PIL import Image as PILImage

                still = PILImage.open(io.BytesIO(base64.b64decode(image_b64))).convert("RGB")
                still = still.resize((width, height))
                out = self.i2v(image=still, **common)
                mode = "i2v"
            else:
                out = self.pipe(**common)
            frames = out.frames[0]

            # Encode frames -> mp4 in-memory. LTX returns PIL frames or float
            # arrays; normalize to uint8 numpy for imageio.
            import numpy as np
            import imageio

            norm = []
            for fr in frames:
                arr = np.asarray(fr)
                if arr.dtype != np.uint8:
                    arr = np.clip(arr * 255.0, 0, 255).astype(np.uint8) if arr.max() <= 1.0 else arr.astype(np.uint8)
                norm.append(arr)

            buf = io.BytesIO()
            imageio.mimwrite(buf, norm, format="mp4", fps=DEFAULT_FPS, codec="libx264")
            video_b64 = base64.b64encode(buf.getvalue()).decode("ascii")

            gpu_seconds = round(time.time() - gpu_start, 2)
            return {
                "videoBase64": video_b64,
                "mimeType": "video/mp4",
                "gpuSeconds": gpu_seconds,
                "model": MODEL_ID,
                "numFrames": num_frames,
                "mode": mode,
            }
        except Exception as e:  # noqa: BLE001
            return {"error": f"{type(e).__name__}: {e}", "gpuSeconds": round(time.time() - gpu_start, 2)}


# CPU-only capability probe: lets the app verify the deployed worker contract
# WITHOUT starting a GPU container (requests to the class endpoint above would
# boot an L4 and load the model, which is billable).
@app.function(image=modal.Image.debian_slim(python_version="3.11").pip_install("fastapi[standard]"), cpu=0.25)
@modal.fastapi_endpoint(method="GET")
def health():
    return {
        "ok": True,
        "contract": 2,
        "model": MODEL_ID,
        "gpu": GPU,
        "modes": ["t2v", "i2v"],
        "maxSeconds": MAX_SECONDS,
    }
