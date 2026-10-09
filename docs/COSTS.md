# Costs — AdForge Studio

_Last updated: 2026-10-09_

## Important: estimates vs. billed amounts

The costs shown in the UI and returned by the API are **estimates only**. The
authoritative per-second pricing for `gemini-omni-1.1-flash` must be confirmed
in **Google AI Studio billing** for your account and tier. Do not treat the
numbers here as billed figures.

The cost tracker (`lib/costs/estimate.js`) distinguishes three states:

- `estimated` — computed locally before a call.
- `billed` — confirmed by a provider response that reports usage.
- `unknown` — a real call happened but no usage/cost was reported.

Currently the real Gemini provider returns `cost.state: "unknown"` because the
Interactions response is not assumed to carry billed usage; the local estimate
is recorded against the dev spend guard. We **never claim a request was free**
unless it was the mock provider (which makes no API call).

## Estimate model

```
amountUsd = ratePerSecond × durationSeconds × resolutionMultiplier
```

- `ratePerSecond` — `VIDEO_USD_PER_SECOND` env, default `0.10` (**placeholder**).
- `resolutionMultiplier` — `360p` ×0.5, `720p` ×1, `1080p` ×1.6.

Example: 8 s @ 720p → `0.10 × 8 × 1 = $0.80` (unverified estimate).

> The `$0.10/s` default and any monthly tier cap figures are **unverified**
> placeholders carried over from third-party sources. Replace them once you
> confirm real pricing and limits in AI Studio.

## Spend controls

- `ENABLE_PAID_GENERATION=false` (default) — no real calls at all.
- `DEV_SPEND_LIMIT_USD` (default `5`) — refuses real calls once the running
  estimate would exceed the cap. In-memory; resets on restart. This is a dev
  guard, **not** a durable billing cap.
- No automatic paid retries — a failed billable call is reported, not retried.

## Recommended first live test

With a key set, generate **one** short clip (e.g. 3–5 s, 720p) to verify access
and observe the real charge in AI Studio before enabling broader use.
