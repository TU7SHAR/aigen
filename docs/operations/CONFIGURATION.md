# Configuration Reference

Copy `.env.example` to `.env.local` (production) or `.env.development` (local dev) and fill in the values below.

## Security

| Variable | Default | Description |
|----------|---------|-------------|
| `MAC_API_TOKEN` | unset | Shared secret for job submission. When set, every `POST /api/jobs` must include `X-MAC-Token: <value>`. Leave unset for local dev; **set in production** to prevent unauthorized paid generation. Generate with `openssl rand -hex 32`. |

## Required

| Variable | Description |
|----------|-------------|
| `GEMINI_API_KEY` | Google Gemini API key. Server-only — never expose to the browser. |
| `FIRECRAWL_API_KEY` | Firecrawl key for URL crawl. Server-only. **Rotate if leaked.** |

## Video generation

| Variable | Default | Description |
|----------|---------|-------------|
| `VIDEO_PROVIDER` | `gemini` | `gemini` or `mock`. Must be `gemini` for real output. |
| `ENABLE_PAID_GENERATION` | `false` | Must be `true` to make real Veo calls. |
| `VIDEO_MODEL_CHAIN` | `veo-3.1-lite,...` | Comma-separated ordered chain of video model IDs. |
| `VIDEO_AUTO_SWITCH` | `true` | Enable/disable auto model switching on quota/availability failures. |
| `JOB_MAX_USD` | `2.50` | Hard per-job USD cap (reserves before starting; refuses if exceeded). |
| `JOB_MAX_PAID_VIDEO_CLIPS` | `0` | Maximum paid video clips per job. Set to `4` for production. |
| `DAILY_SPEND_LIMIT_USD` | `10` | Rolling daily cap across all jobs. |
| `MONTHLY_SPEND_LIMIT_USD` | `60` | Rolling monthly cap. |
| `SHOT_CONCURRENCY` | `3` | Parallel shot generation threads. |

## Text / image models

| Variable | Default | Description |
|----------|---------|-------------|
| `IMAGE_MODEL_CHAIN` | `nano-banana-2.1,...` | Comma-separated image model chain. |
| `TEXT_MODEL_CHAIN` | `gemini-3.8-flash,...` | Creative text model chain. |
| `ENRICHMENT_MODEL_CHAIN` | `gemini-3.5-flash-lite,...` | Enrichment text model chain. |
| `TEXT_MODEL_TIMEOUT_MS` | `45000` | Per-text-call hard timeout (ms). |
| `TEXT_HEDGE_MS` | `15000` | When to start the hedge model (ms). |
| `CREATIVE_THINKING_LEVEL` | `LOW` | Gemini thinking budget for director calls. |

## Jobs

| Variable | Default | Description |
|----------|---------|-------------|
| `JOB_EXECUTION` | `inline` | `inline` (Next worker thread) or `worker` (separate process via `scripts/worker.mjs`). |
| `MAC_DATA_DIR` | `.data` | Root for jobs, quota, spend ledger. Must be writable and not served statically. |
| `SCENE_MEDIA_CACHE_DIR` | (mac data dir) | Override the shot media cache directory. |

## Browser capture

| Variable | Default | Description |
|----------|---------|-------------|
| `CAPTURE_NETWORK_ISOLATED` | unset | Set to `true` only when the server runs in a network-isolated environment (prevents captured sites from seeing your real IP). Capture is disabled in production unless set. |

## Development

| Variable | Default | Description |
|----------|---------|-------------|
| `NEXT_PUBLIC_APP_URL` | `http://localhost:3000` | Public URL used for share links. |

## Production checklist

1. `VIDEO_PROVIDER=gemini` + `ENABLE_PAID_GENERATION=true`
2. `JOB_MAX_PAID_VIDEO_CLIPS=4` (or higher; 0 blocks all paid video)
3. `JOB_EXECUTION=worker` + run `node scripts/worker.mjs` as a service
4. `CAPTURE_NETWORK_ISOLATED=true` only with real network isolation
5. Rotate `FIRECRAWL_API_KEY` if it appeared in any logs or commits
6. Set `DAILY_SPEND_LIMIT_USD` and `MONTHLY_SPEND_LIMIT_USD` to match your tier
7. Update `VIDEO_MODEL_CHAIN` if your tier unlocks higher Veo quota
