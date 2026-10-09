# Architecture — AdForge Studio

**This is a Next.js 16 App Router application** (React 19, Tailwind v4). It is
*not* the earlier standalone Node/HTTP/FFmpeg/fal.ai prototype that some
historical planning docs described — those are superseded by this document.

_Last updated: 2026-10-09_

## 1. Current architecture (implemented)

```
Browser (/studio, client component)
  │  upload image (base64) + copy + options
  ▼
POST /api/generate  (Next.js route handler, server-only)
  │  1. Zod validation (size/MIME/enum allowlists)
  │  2. duplicate-submit + single-concurrency guards
  │  3. build ad prompt (or use user's edited override)
  │  4. [real provider only] paid kill-switch + dev spend guard
  │  5. provider.generate(...)
  ▼
Video provider boundary (lib/ai)
  ├─ mock     → placeholder MP4, no cost (default)
  └─ gemini   → Gemini Omni Flash Interactions API (synchronous)
  ▼
JSON response: data: URL MP4 + prompt + cost {estimated, reported}
  ▼
Browser: <video> playback + MP4 download
```

### Files and ownership

| File | Responsibility |
|---|---|
| `app/page.js` | Marketing landing page |
| `app/studio/page.js` | Studio page shell (server component) |
| `components/studio/Studio.js` | Studio UI: upload, fields, prompt preview, generate, playback/download |
| `app/api/generate/route.js` | Validation, guards, provider orchestration, status probe |
| `lib/config.js` | Env-driven config + allowlists (ratios, resolutions, templates, upload limits) |
| `lib/validation.js` | Zod request schema |
| `lib/prompts/adPrompt.js` | Structured fields → video prompt (with fidelity guardrails) |
| `lib/ai/provider.js` | `VideoProvider` contract + `ProviderError` |
| `lib/ai/mockProvider.js` | Free placeholder provider (dev/tests) |
| `lib/ai/geminiProvider.js` | Real Gemini Omni Flash provider |
| `lib/ai/index.js` | Provider factory (chooses mock vs gemini) |
| `lib/costs/estimate.js` | Cost estimate + in-memory spend guard |
| `tests/unit.test.mjs` | Mock-based unit tests |

### Key design decisions

- **Key stays server-side.** `GEMINI_API_KEY` is read only in route/lib server
  code; it is never sent to or bundled for the browser.
- **Provider boundary.** The route depends on a documented `VideoProvider`
  contract, so the model can be swapped later without UI changes.
- **Safe by default.** `VIDEO_PROVIDER=mock` means zero cost until a human
  explicitly switches to `gemini` *and* sets `ENABLE_PAID_GENERATION=true`.
- **Honest failures.** Providers throw `ProviderError`; the route returns real
  error codes/messages rather than fabricating a success or a fake video.
- **Allowlists.** Aspect ratio, resolution, template, MIME and size are all
  validated against server-side allowlists.

## 2. The Gemini Omni Flash call is synchronous

Per Google's [Omni docs](https://ai.google.dev/gemini-api/docs/omni), the
Interactions API call `ai.interactions.create(...)` **blocks until the video is
ready** and returns the base64 MP4 inline (`output_video.data`, or the `steps[]`
array in raw REST). There is no separate poll loop.

Consequence: a request can be long-running. The route sets `maxDuration = 300`.
On serverless hosts (e.g. Vercel) this must stay within the plan's execution
limit; for longer videos or production load, move generation to a worker service
with a durable job record (see Roadmap).

> Note: this build enables `cacheComponents`, which **disallows** the `runtime`
> and `dynamic` route segment configs. POST handlers are dynamic by default, so
> they are omitted; only `maxDuration` is set.

## 3. Request → state model (prototype)

`idle → processing → completed | failed` — tracked client-side. Server guards
(dedup, single concurrency, spend) are **in-memory and reset on restart**. There
is no durable job store, reservation, or cancellation yet.

## 4. Planned production direction (NOT implemented)

- Auth + tenant scoping; Supabase Postgres with RLS; private object storage.
- Durable job queue + worker service for generation (off the request path).
- Credit wallet: quote → reserve (idempotent) → settle/refund.
- Remotion compositing for exact logos / CTA / price overlays.
- Observability, rate limits, abuse prevention, data-retention lifecycle.
