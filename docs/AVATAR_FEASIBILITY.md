# Self-Hosted AI Presenter — Technical Feasibility Report

_Last updated: 2026-10-11 · Status: RESEARCH ONLY. Nothing in this report is
implemented in the codebase. No avatar/TTS code has been written or integrated._

You asked me to evaluate self-hosted, commercially-permitted open-source avatar
models (MuseTalk, SadTalker, alternatives) + a TTS pipeline before assuming a
paid vendor. This is that evaluation. Figures marked ~ are from public
model docs/benchmarks (cited), not measurements on our hardware.

> Content below was rephrased from public sources for licensing compliance.

## 1. The architecture the task actually needs

A "talking presenter" ad is three separable stages, not one model:

```
script (Gemini text)  →  TTS (audio)  →  talking-head video (audio + a face)
```

The talking-head stage itself splits into two model families:
- **Still-photo animators** (SadTalker): animate ONE still image into a talking
  head. Good when you have a presenter photo, not existing footage.
- **Lip-sync / re-sync models** (MuseTalk, Wav2Lip, LatentSync): drive the mouth
  of an EXISTING video/clip to match audio.

So "which model" depends on whether we start from a photo or a base video clip.

## 2. Lip-sync / talking-head models

| Model | License (code / weights) | Commercial | Hardware | ~Speed | Quality notes |
|---|---|---|---|---|---|
| **MuseTalk** | MIT | ✅ yes ([sync.so](https://sync.so/blog/what-is-musetalk)) | NVIDIA GPU (benchmarked on Tesla V100) | **~30 fps+ real-time**, 256×256 face region ([GitHub](https://github.com/tmelyralab/musetalk), [arXiv](https://arxiv.org/html/2410.10122v2)) | Strong visual fidelity; it re-syncs the mouth region on a base video — needs a base clip/avatar video, and only syncs audio already in the target language. |
| **SadTalker** | code open ([OpenTalker/SadTalker](https://github.com/OpenTalker/SadTalker)) — verify weight terms per checkpoint | ⚠ verify per weight | NVIDIA GPU | slow (per-render, not real-time) | Animates a SINGLE still photo into a talking head; cannot re-sync existing footage. Good for "one presenter photo → talking head." |
| **Wav2Lip** | research code; weights historically research-only | ⚠ often non-commercial | NVIDIA GPU | fast | Best raw lip-sync accuracy, lower face fidelity ([sync.so](https://sync.so/blog/the-best-free-open-source-lipsync-tools-2/)). License is the catch. |
| **LatentSync** | check repo | ⚠ verify | heavier GPU | slower | Highest visual fidelity of the three ([sync.so](https://sync.so/blog/the-best-free-open-source-lipsync-tools-2/)). |

**Licensing reality:** only **MuseTalk (MIT)** is unambiguously
commercial-safe among these. Wav2Lip/LatentSync/SadTalker weights need
per-checkpoint license verification before any paid use.

## 3. TTS (the voice) — licensing is the real minefield

| Model | License | Commercial-safe | Notes |
|---|---|---|---|
| **Piper** | MIT | ✅ yes | Tiny, fast, runs even on CPU/Raspberry Pi ([forasoft](https://www.forasoft.com/blog/article/voice-cloning-synthesis)). Good default for narration; fixed voices (no cloning). |
| **Kokoro-82M** | Apache-2.0 | ✅ yes | Permissive, good quality; **cannot clone a voice** ([forasoft](https://www.forasoft.com/blog/article/voice-cloning-synthesis)). |
| **Chatterbox** | MIT | ✅ yes | Preferred over ElevenLabs in a public blind A/B; embeds a watermark ([localaimaster](https://localaimaster.com/blog/local-ai-voice-clone)). |
| **XTTS-v2 (Coqui)** | code MPL-2.0, **weights CPML (non-commercial)** | ❌ NO | Coqui shut down Jan 2024; there is no one left to sell a commercial license ([localaimaster](https://localaimaster.com/blog/xtts-coqui-commercial-license)). **Avoid for a paid product.** |
| **F5-TTS / Fish Speech** | CC-BY-NC | ❌ NO | Non-commercial. |

**Takeaway:** ship **Piper (MIT)** or **Kokoro (Apache-2.0)** for commercial
narration; **Chatterbox (MIT)** if we need voice cloning. Do **not** ship XTTS-v2
weights.

## 4. Recommendation (single pick, per your instruction)

**Pipeline: Gemini script → Piper (TTS, MIT) → MuseTalk (lip-sync, MIT), driven
by a licensed/owned base presenter clip.**

Rationale:
- Both are **MIT** → unambiguous commercial use (the decisive filter — most
  alternatives fail licensing).
- MuseTalk is **real-time (~30fps on a V100-class GPU)**, so render cost is
  bounded and predictable.
- Piper is cheap/fast and commercial-safe.
- If we need "one presenter photo → talking head" instead of a base clip, add
  **SadTalker** later *only after* verifying its weight license — don't ship it
  on assumption.

Do **not** integrate multiple models at once. Start with MuseTalk + Piper behind
a provider interface; add others only if a concept genuinely needs them.

## 5. Hardware & cost (estimates — not measured on our infra)

- MuseTalk is documented real-time (~30fps) on a **Tesla V100** (16/32GB). A
  modern **L4 (24GB)** or **A10G (24GB)** is a reasonable, cheaper production
  target; expect to need a CUDA GPU with **≥16GB VRAM** for comfortable
  headroom (face model + VAE + whisper-tiny audio encoder).
- At ~30fps real-time, a **15s** clip ≈ ~15s of compute + model load/warm; a
  **30s** clip ≈ ~30s. Add TTS (Piper is sub-second to a few seconds) and
  I/O/encoding overhead → call it **~30–60s wall-clock for 15s**, **~60–120s for
  30s** on a warm worker (rough; must be benchmarked).
- **Cost per completed video (illustrative):** a spot L4/A10G is roughly
  ~$0.30–$0.60/GPU-hour depending on cloud/region. At ~1–2 min of warm GPU time
  per video, that's **~$0.01–$0.03 of GPU compute per clip** — dramatically
  cheaper than a per-second commercial video API, IF the worker stays warm and
  utilized. Cold starts (model load) and idle GPU time dominate real cost, so
  batching/keep-warm matters more than raw inference speed.
- These numbers are **planning estimates**; a real benchmark on the chosen GPU
  is required before relying on them.

## 6. Deployment architecture with Next.js (honest)

The main app **stays Next.js**. Avatars need a GPU, which Next.js serverless
cannot provide. The realistic shape:

```
Next.js app (Vercel/Node)
   │  POST job {script, presenterId, voiceId}
   ▼
Durable job queue (e.g. Redis/QStash)        ← we don't have this yet
   ▼
Python GPU worker (separate service, CUDA)   ← MuseTalk + Piper
   │  renders mp4, writes to object storage
   ▼
Next.js polls job status → signed video URL
```

- A **Python GPU worker is acceptable** (per your note) — it's a separate
  service the Next.js app talks to over an HTTP/queue contract, not an in-process
  dependency.
- This requires the **durable-job + object-storage** work (PR 4 / "operational
  reliability") that is *also not built yet*. Avatars are gated on that.

## 7. Lip-sync / quality honesty

- MuseTalk edits the **mouth region** of a base clip; it does not invent a whole
  person. Presenter **consistency** comes from the base clip, not the model —
  so we need a licensed/owned/synthetic base presenter video per presenter.
- Lip-sync accuracy is good but not perfect; expect occasional artifacts on
  fast speech or extreme head poses. This must be shown in the preview and QA
  stage, not hidden.
- Only syncs audio in the target language of the base content.

## 8. What this means for the product right now

- **Feasible and commercially clean?** Yes — MuseTalk (MIT) + Piper (MIT) is a
  real, licensable path. Licensing is the main trap and this combo avoids it.
- **Can I ship it in this repo today?** No. It needs: a GPU worker service, the
  durable-job/storage layer, and a licensed base-presenter asset set. Those are
  larger infra items (your PR 4/5/6).
- **Current code status:** the production-method map already treats
  `avatar_presenter` as **not implemented → hard preflight block**, so the app
  will NOT silently fake a presenter. That's the correct interim behavior until
  the worker exists.

## 9. Recommended next step (small, safe)

Before any GPU spend: build a **mock `AvatarProvider`** behind a provider
interface + the job contract (script/voice/presenter → video), with a Python
worker stub. That lets the whole UX/flow be built and tested with **zero GPU
cost**, and the real MuseTalk+Piper worker drops in behind the same interface
once a GPU host is chosen. I did not build this yet — flagging it as the
cheapest first move when you want to proceed.
