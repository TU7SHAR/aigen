# Model Auto-Switch Router

`lib/ai/router.js`

## Purpose

Routes AI calls through a priority-ordered model chain, automatically switching to the next model on unbilled failures. Every attempt is recorded for diagnostics.

## Switch conditions

The router switches **only** on:
- HTTP 429 — quota exhausted (RPM/RPD)
- HTTP 404 — model not found / deprecated
- HTTP 403 — model access denied (not auth failure)
- HTTP 503 — provider unavailable
- HTTP 400 — prompt rejected (bad request, not billing)
- Safety block — after one automatic prompt rephrase attempt

The router **does not** switch on:
- Uncertain billing outcomes (e.g. Omni returned no video — charge unclear)
- Auth failures (401) — these need credential fixes, not model switches
- User cancellations — `AbortError` propagates up as `category: "cancelled"`

## Chains (cheapest first)

Defined in `lib/ai/modelRegistry.js` → `DEFAULT_CHAINS`:

| Chain | Head | Fallback(s) |
|-------|------|-------------|
| `video` | `veo-3.1-lite` ($0.05/s) | `veo-3.1-fast` → `omni-1.1-flash` → `omni-flash-preview` |
| `image` | `nano-banana-2.1` | *(more in registry)* |
| `creative` | `gemini-3.8-flash` | `gemini-3.5-flash-lite` → `gemini-3.7-flash` |
| `enrichment` | `gemini-3.5-flash-lite` | *(more in registry)* |

## Hedging (creative calls)

To reduce tail latency, `lib/ai/textModel.js` starts the fallback model in parallel after `TEXT_HEDGE_MS` (default 15 000 ms). Whichever returns first wins; the loser is aborted. This avoids a sequential 45s timeout per model on slow responses.

## Diagnostics

Each job stores per-shot model attempt records in `job.record.shots[n].attempts`. The `/api/creative/storyboard` response includes a top-level `attempts` array from the director.

## Configuration

| Env var | Default | Meaning |
|---------|---------|---------|
| `VIDEO_AUTO_SWITCH` | `true` | Enable/disable auto-switching for video |
| `VIDEO_MODEL_CHAIN` | `veo-3.1-lite,...` | Override the video chain |
| `TEXT_MODEL_TIMEOUT_MS` | `45000` | Hard timeout per text call |
| `TEXT_HEDGE_MS` | `15000` | When to start the hedge model |
| `CREATIVE_THINKING_LEVEL` | `LOW` | Gemini thinking budget for creative calls |
