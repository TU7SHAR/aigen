# Costs — AdForge Studio

_Last updated: 2026-10-09_

## How cost is reported (updated)

There are two numbers, and they mean different things:

1. **Pre-call estimate** — computed locally from the requested duration ×
   `VIDEO_USD_PER_SECOND` × a resolution multiplier. Used **only** to show a
   preview figure and to drive the dev spend guard *before* we know the real
   cost. Labeled `state: "estimated"`.

2. **Actual billed cost** — after a real generation, computed from the **token
   usage the Gemini Interactions API actually reports** (`interaction.usage`)
   multiplied by Google's published per-token rates. Labeled `state: "billed"`.
   This is "what Google says it spent" to the degree the API exposes it.

If the API returns no usage block, cost is reported as `state: "unknown"` and
you must check Google AI Studio billing. We **never** claim a request was free
unless it was the mock provider (which makes no API call).

> Why not read the exact invoiced dollars from the API? Gemini generative
> endpoints do not return a dollar amount per call. Google states that accurate
> billing usage is only available after execution in the response's usage
> metadata; the authoritative invoice lives in Cloud Billing / AI Studio, not in
> the per-request response. We therefore use the reported token meters × rates.

## Gemini Omni Flash billing model

Billed **per token** across three meters (confirm current rates at
<https://ai.google.dev/gemini-api/docs/pricing>):

| Meter | Default rate (USD / 1M tokens) | Env override |
|---|---|---|
| Input tokens | `1.50` | `GEMINI_INPUT_USD_PER_M` |
| Text output tokens | `9.00` | `GEMINI_TEXT_OUTPUT_USD_PER_M` |
| Video output tokens | `17.50` | `GEMINI_VIDEO_OUTPUT_USD_PER_M` |

Video output dominates: ~**5,792 tokens per second** of 720p ⇒ roughly
**$0.10 / second** at the $17.50/1M rate (≈ **$0.80** for an 8 s 720p clip).

Because the usage block reports total output tokens without splitting text vs.
video, `costFromUsage()` attributes all output tokens to the video meter by
default (the most conservative / highest reading).

## Model cost comparison (per published pricing; confirm in AI Studio)

| Model | Per second (720p) | 8-second clip | Notes |
|---|---|---|---|
| Veo 3.1 Lite | ~$0.05 | ~$0.40 | Cheapest, but **Gemini API preview shutdown ~2026-10-22** |
| Veo 3.1 Fast | ~$0.10 | ~$0.80 | Includes audio |
| **Gemini Omni 1.1 Flash** | ~$0.10 | ~$0.80 | **In use here**; image-to-video, editing, extension |
| Veo 3.1 Standard | ~$0.40 | ~$3.20 | Highest quality |

We stay on **Gemini Omni 1.1 Flash**: it's already integrated and avoids an
imminent migration. Veo uses a different request/response shape and would need
its own provider implementation behind the `lib/ai` boundary — not a drop-in
model-id swap.

## Your Tier 1 limits (reference)

| Model | Req/min | Req/day |
|---|---|---|
| gemini-omni-1.1-flash | ~4 | ~20 |
| veo-3-lite | ~2 | ~10 |

**20 requests/day is capacity, not 20 free videos.** Each billable call still
incurs per-token charges — e.g. 20 × 8 s/720p ≈ **$16** output + input charges.
This is testing capacity, not commercial scale; request higher limits before
scaling.

## Spend controls

- `ENABLE_PAID_GENERATION=false` (default) — no real calls at all.
- `DEV_SPEND_LIMIT_USD` (default `5`) — the pre-call estimate is checked against
  this; the running total is updated with the **actual billed** amount after
  each call. In-memory; resets on restart. A dev guard, **not** a durable cap.
- No automatic paid retries.

## Margin strategy (planned)

- Full AI footage via Omni (~$0.80 / 8 s) for premium videos.
- Low-cost ads: Gemini image generation + **Remotion** rendering, so most of the
  finished 15–20 s MP4 comes from conventional rendering rather than paying to
  AI-generate every second. Turning one ~$0.80 clip into a finished ad with
  cheap overlays/stills is where margin improves.

## Cost surfaces across the pipeline

The importer + creative pipeline exist partly to spend video credits wisely.
Which steps can incur cost:

| Operation | Cost |
|---|---|
| Crawl + structured extraction + cleaning + image ranking + brand signals | **$0** (deterministic, no AI) |
| Ad concepts (`/api/creative/concepts`) | **$0** (deterministic) |
| Image download + local storage | **$0** (bandwidth only) |
| Firecrawl crawl (only when it falls back / is forced) | Firecrawl per-request cost |
| **AI source enrichment** (`/api/products/import`) | Gemini **TEXT** tokens (cheap Flash-Lite); tracked separately via `recordEnrichmentSpend` |
| Video generation (`/api/generate`) | Gemini **video** tokens (the expensive meter) |

Enrichment cost is reported per-import under `aiEnrichment.cost` and accumulated
separately from video spend, so the cheap "understand the source" stage and the
expensive "generate video" stage are never bundled together. Automated tests
run enrichment disabled / on fixtures → **no** Gemini or Firecrawl cost.

No paid video call happens on import — the user must explicitly click Generate.
Automated tests use fixtures/mocks and incur **no** Firecrawl/Gemini cost.

## Recommended first live test

Generate **one** short clip (3–5 s, 720p), then compare the reported `cost`
(`state: "billed"`) against the charge shown in Google AI Studio to validate the
rate constants.
