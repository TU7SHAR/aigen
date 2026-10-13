# Modal self-hosted video worker

Runs an open-source text/image→video model on **your** Modal GPU budget
(~$30/month free credit) and returns MP4 **footage**. The ffmpeg compositor
still renders all exact copy (brand/URL/price/CTA) — the model never draws text.

The app tracks estimated GPU spend in a persistent monthly ledger and
**auto-switches to Gemini** once the monthly budget is reached, so neither your
Modal credit nor Gemini credits are burned unexpectedly.

## What YOU need to do (one-time, on your machine)

The agent cannot run `modal deploy` with your account — these steps are yours.

```bash
# 1. Install + authenticate the Modal CLI
pip install modal
modal token new                     # opens a browser to link your account

# 2. Create the shared secret the worker checks (pick a long random string)
modal secret create makeadclips-worker WORKER_SECRET=<LONG_RANDOM_STRING>

# 3. Deploy the worker — this prints an https://...modal.run endpoint URL
modal deploy modal/video_worker.py
```

Then put these in the Next.js app's `.env.local` (NOT committed):

```bash
VIDEO_PROVIDER=gemini
VIDEO_MODEL=modal-video
MODAL_VIDEO_ENDPOINT=<the https URL that `modal deploy` printed>
MODAL_WORKER_SECRET=<the SAME LONG_RANDOM_STRING from step 2>
MODAL_GPU_USD_PER_SECOND=<per-second rate for the GPU in the worker>
MODAL_MONTHLY_BUDGET_USD=30
```

Restart the dev server. Requests with `VIDEO_MODEL=modal-video` now hit your
Modal worker; when the ledger reaches `MODAL_MONTHLY_BUDGET_USD`, the app falls
back to Gemini automatically.

## Also do this (the real backstop)

Set a **hard spend limit in the Modal dashboard**. Our ledger is an *estimate*
(GPU-seconds × rate); the dashboard limit is Modal's authoritative cap.

## Keeping GPU time (and cost) low

The worker is built for minimal GPU wall-time:
- model loaded **once** per warm container (`@modal.enter`), not per request;
- stays warm 2 min after a request, then **scales to zero** (no idle cost);
- weights cached on a Modal Volume (download once);
- short clips + a hard max; it reports the GPU seconds it used so spend is tracked.

## Changing the model / GPU

- Model: set `MAC_WORKER_MODEL` (default `Lightricks/LTX-Video`) or swap the
  pipeline in `video_worker.py`. The HTTP contract (`{videoBase64, mimeType,
  gpuSeconds, model}`) stays the same, so the Next.js side doesn't change.
- GPU: set `MAC_WORKER_GPU` (default `L4`) — and update
  `MODAL_GPU_USD_PER_SECOND` in the app to match, so the estimate stays accurate.
