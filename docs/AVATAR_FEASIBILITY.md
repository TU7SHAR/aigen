# Self-Hosted AI Presenter — Technical Feasibility Report

_Last updated: 2026-10-09 · Status: RESEARCH ONLY. Nothing in this report is
implemented in the codebase. No avatar/TTS code has been written or integrated._

> **Correction note (2026-10-09):** an earlier revision of this report stated
> "Piper — MIT — commercial-safe" without qualification, and treated MuseTalk's
> model dependencies as covered by MuseTalk's own MIT license. Both were
> imprecise. The Piper license situation is forked (archived MIT original vs.
> maintained **GPL-3.0** OHF project), and MuseTalk's runtime pulls several
> *separate* model weights with their *own* licenses. Those are corrected and
> audited in §3 and §3a below. No performance/GPU-cost figure in this report was
> measured on our hardware; every such number is a **public benchmark or
> planning estimate** and is labelled as such.

You asked me to evaluate self-hosted, commercially-permitted open-source avatar
models (MuseTalk, SadTalker, alternatives) + a TTS pipeline before assuming a
paid vendor. This is that evaluation.

**Benchmarks vs. measurements — read this first.** Every speed, latency, FPS,
VRAM, and $/clip figure below is either a **published benchmark** from the
model's own docs/paper or a **planning estimate** I derived from those. I have
**not run any of these models on our hardware**. "~30fps" is MuseTalk's claim on
a Tesla V100, not something I timed. Do not treat any number here as a measured
result. A real benchmark on the chosen GPU is a prerequisite before relying on
them (see §5, §11).

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

**Licensing reality:** MuseTalk's **own code** is MIT ([LICENSE](https://github.com/TMElyralab/MuseTalk/blob/main/LICENSE)),
which is the easy part. But MuseTalk is **not self-contained** — at runtime it
downloads several *separate* model weights, each with its *own* license.
MuseTalk's MIT license does **not** extend to those. See §3a for the dependency
audit. Wav2Lip/LatentSync/SadTalker weights additionally need per-checkpoint
verification before any paid use.

## 3. TTS (the voice) — licensing is the real minefield

| Model | License | Commercial-safe | Notes |
|---|---|---|---|
| **Piper** | **forked — read below** | ⚠ depends which fork | See the Piper breakdown immediately below. The original (MIT) is archived; the maintained project is **GPL-3.0**. |
| **Kokoro-82M** | Apache-2.0 | ✅ yes | Permissive, good quality; **cannot clone a voice** ([forasoft](https://www.forasoft.com/blog/article/voice-cloning-synthesis)). |
| **Chatterbox** | MIT | ✅ yes | Preferred over ElevenLabs in a public blind A/B; embeds a watermark ([localaimaster](https://localaimaster.com/blog/local-ai-voice-clone)). |
| **XTTS-v2 (Coqui)** | code MPL-2.0, **weights CPML (non-commercial)** | ❌ NO | Coqui shut down Jan 2024; there is no one left to sell a commercial license ([localaimaster](https://localaimaster.com/blog/xtts-coqui-commercial-license)). **Avoid for a paid product.** |
| **F5-TTS / Fish Speech** | CC-BY-NC | ❌ NO | Non-commercial. |

### Piper — the license is NOT a simple "MIT" (corrected)

Piper split in October 2025. There is no single "Piper license" anymore:

| Fork | License | espeak-ng dependency | Commercial read |
|---|---|---|---|
| **`rhasspy/piper`** (original) | **MIT** | yes (bundled) | Archived/read-only since ~Oct 2025 ([cekura](https://www.cekura.ai/discover/piper-tts)). MIT code, but unmaintained — and it still ships espeak-ng (GPL), so a distributed binary inherits espeak-ng's copyleft regardless of the MIT wrapper. |
| **`OHF-Voice/piper1-gpl`** (maintained) | **GPL-3.0** | yes (embeds espeak-ng for phonemization) ([GitHub](https://github.com/OHF-Voice/piper1-gpl)) | The actively-developed project, by the Open Home Foundation ([cekura](https://www.cekura.ai/discover/piper-tts)). GPL-3.0 is **commercially usable**, but it is **copyleft**: if we distribute a binary/derivative we must honour GPL-3.0 obligations (source availability, same license on the combined work). Running it as a **separate service the Next.js app calls over HTTP** generally avoids combining it into our own codebase, but this must be reviewed by counsel before shipping. |
| **`piper-plus`** (community fork) | MIT, **no espeak-ng** | no | Markets itself as the only MIT-compatible fork, having dropped the espeak-ng dependency ([GitHub](https://github.com/ayutaz/piper-plus/blob/dev/README_EN.md)). If accurate, this is the cleanest permissive option — but it is a smaller community fork; verify maturity/voice coverage before betting on it. |

**Why the GPL even enters the picture:** Piper phonemizes text with **espeak-ng**,
which is **GPL-licensed**. That is the pressure that pushed the maintained
project to GPL-3.0 and why the "it's just MIT" shorthand is wrong.

**Voice models:** Piper's published voices are generally under permissive terms
(commonly MIT / CC0 / CC-BY depending on the dataset), but the license is
**per-voice** and tied to the training corpus — each voice we ship must have its
own license checked. "Piper is MIT" says nothing about a given voice's dataset
rights.

**Corrected TTS takeaway:** the clean permissive choices are **Kokoro-82M
(Apache-2.0)** and, for cloning, **Chatterbox (MIT)**. For Piper specifically:
use **`piper-plus` (MIT, no espeak-ng)** if its maturity checks out, OR run
**OHF `piper1-gpl` (GPL-3.0) as an isolated out-of-process service** with a legal
review of the GPL obligations. Do **not** describe Piper as "MIT, commercial-safe"
without that qualification, and do **not** ship XTTS-v2 weights.

## 3a. MuseTalk dependency-license audit (corrected)

MuseTalk's MIT license covers the *orchestration code only*. On first run it
auto-downloads several model weights, each governed by its own terms. MuseTalk's
own `LICENSE` file enumerates these dependencies and the licenses it believes
apply ([MuseTalk LICENSE](https://github.com/TMElyralab/MuseTalk/blob/main/LICENSE)):

| Dependency (auto-downloaded) | Purpose | License (per MuseTalk's LICENSE / upstream) | Commercial read |
|---|---|---|---|
| **sd-vae-ft-mse** (`stabilityai/sd-vae-ft-mse`) | latent encode/decode (VAE) | MuseTalk's LICENSE lists it as **MIT**; upstream HF model card also shows MIT ([HF](https://huggingface.co/stabilityai/sd-vae-ft-mse)) | ✅ permissive **if** the MIT tag is correct — but Stability weights are frequently under OpenRAIL/CreativeML terms, so **confirm the exact checkpoint's license at download time**, don't assume. |
| **whisper-tiny** (`openai/whisper`) | audio encoder | **MIT** (OpenAI) ([LICENSE](https://github.com/openai/whisper/blob/main/LICENSE)) | ✅ clean. |
| **DWPose** (`yzd-v/DWPose`) | pose/landmarks | **Apache-2.0** per MuseTalk's LICENSE | ✅ permissive. (Note: some DWPose training traces to COCO/other datasets; the *weights* license is Apache-2.0 but dataset provenance is worth a glance for a paid product.) |
| **face-parsing.PyTorch** (`zllrunning/face-parsing.PyTorch`) | face segmentation | **MIT** per MuseTalk's LICENSE | ✅ clean. |
| **MuseTalk weights** themselves (`TMElyralab/MuseTalk` on HF) | the lip-sync model | Distributed by the MIT repo; **confirm the HF weights repo carries the same MIT grant** (code license ≠ automatic weights license) | ⚠ verify the weights repo's license tag, not just the GitHub code LICENSE. |

**Honest reading:** this is a **mostly-permissive stack (MIT + Apache-2.0)** as
MuseTalk's maintainers assert it — which is genuinely favourable. The caveats
are: (1) a code repo's MIT license is **not** proof the HF *weights* repo carries
the same terms, so each weight must be license-checked **at the version/commit we
actually pin**; (2) Stability-authored VAE checkpoints in particular sometimes
ship under OpenRAIL rather than MIT, so that one deserves an explicit look; (3)
model dependencies can be swapped/relicensed upstream over time, so the audit
must be re-run against the pinned versions, not taken from this report. None of
this is a blocker — it's due diligence that must happen before paid use, and it
had been glossed over as "MuseTalk is MIT, done."

## 4. Recommendation (single pick, per your instruction)

**Pipeline: Gemini script → [commercial-safe TTS] → MuseTalk (lip-sync code MIT
+ permissive model deps), driven by a licensed/owned base presenter clip.**

For the TTS stage, pick in this order (corrected — Piper is NOT a plain "MIT"):
1. **Kokoro-82M (Apache-2.0)** — cleanest permissive default for narration.
2. **`piper-plus` (MIT, no espeak-ng)** — if its maturity/voice coverage checks
   out, this is a permissive Piper path.
3. **OHF `piper1-gpl` (GPL-3.0)** — only as an **isolated out-of-process
   service**, with a legal review of GPL-3.0 obligations. Do not statically link
   or vendor it into our own code.
4. **Chatterbox (MIT)** — if voice *cloning* is required.

Rationale:
- MuseTalk's **code is MIT** and its model dependencies are **asserted
  MIT/Apache-2.0** (§3a) — favourable, but each pinned weight still needs a
  license check; it is not a blanket "MIT, done."
- MuseTalk is **documented** real-time (~30fps on a V100-class GPU) — a
  **published benchmark, not our measurement** — so render cost *should* be
  bounded and predictable, pending our own benchmark.
- The TTS license is the subtle trap: "Piper = MIT" is **wrong** post-Oct-2025
  (maintained project is GPL-3.0). Choose per the ordered list above.
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

- **Feasible and commercially clean?** The path is real, but "clean" needs
  qualification. MuseTalk (code MIT + asserted-permissive model deps) is a
  licensable lip-sync base; the **TTS** stage is where the licensing trap
  actually lives, and the earlier "Piper = MIT" claim was wrong (maintained
  OHF Piper is GPL-3.0). A commercially-clean build is achievable with
  Kokoro/`piper-plus`/isolated-GPL Piper, **after** the per-weight license
  checks in §3a and §3 are done against the pinned versions.
- **Is MuseTalk + Piper production-ready?** **No — do not claim that.** No
  presenter-video proof of concept has been built or benchmarked on our
  hardware. Every performance/cost number here is a public benchmark or
  estimate. "Production-ready" is only earned after a working PoC renders a
  real lip-synced clip and we benchmark speed/VRAM/$ on the actual GPU.
- **Can I ship it in this repo today?** No. It needs: a GPU worker service, the
  durable-job/storage layer, a licensed base-presenter asset set, and the
  license audit above. Those are larger infra items (your PR 4/5/6).
- **Current code status:** the production-method map already treats
  `avatar_presenter` as **not implemented → hard preflight block**, so the app
  will NOT silently fake a presenter. That's the correct interim behavior until
  the worker exists.

## 9. Recommended next step (small, safe)

Before any GPU spend: build a **mock `AvatarProvider`** behind a provider
interface + the job contract (script/voice/presenter → video), with a Python
worker stub. That lets the whole UX/flow be built and tested with **zero GPU
cost**, and the real MuseTalk+TTS worker drops in behind the same interface
once a GPU host is chosen. I did not build this yet — flagging it as the
cheapest first move when you want to proceed.

**Then, before calling it production-ready:** run a **benchmarked proof of
concept** on the chosen GPU — one real presenter clip end-to-end (script → TTS →
MuseTalk) — and record measured FPS, VRAM, wall-clock per 15s/30s clip, and
actual $/clip. Until that PoC exists and is benchmarked, the stack stays
"researched and plausible," not "production-ready."
