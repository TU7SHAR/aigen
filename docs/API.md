# API — AdForge Studio

_Last updated: 2026-10-09_

Base: Next.js route handlers under `app/api/`. All generation logic runs
server-side; the Gemini key never reaches the client.

## `GET /api/generate`

Capability/status probe used by the UI.

**200 response:**
```json
{
  "provider": "mock",
  "paidGenerationEnabled": false,
  "devSpendLimitUsd": 5
}
```

## `POST /api/generate`

Create a product video ad.

### Request body (JSON)

| Field | Type | Required | Notes |
|---|---|---|---|
| `productName` | string | yes | 1–120 chars |
| `brand` | string | no | ≤120 |
| `description` | string | no | ≤1000 |
| `offer` | string | no | ≤240 |
| `cta` | string | no | ≤80 |
| `template` | enum | yes | `luxury` \| `bold` \| `minimal` \| `product-demo` \| `problem-solution` |
| `aspectRatio` | enum | yes | `16:9` \| `9:16` |
| `resolution` | enum | no | `360p` \| `720p` \| `1080p` (default `720p`) |
| `durationSeconds` | int | no | 3–10 (default 8) |
| `image` | object | no | `{ data: base64 (no data: prefix), mimeType: image/png\|image/jpeg\|image/webp }`, ≤5 MB |
| `promptOverride` | string | no | ≤2000; replaces the auto-generated prompt |
| `clientRequestId` | string | no | idempotency / duplicate-submit guard |

### Success — 200

```json
{
  "ok": true,
  "prompt": "Create an 8-second product advertisement video for ...",
  "mock": false,
  "provider": "gemini",
  "model": "gemini-omni-1.1-flash",
  "mimeType": "video/mp4",
  "usage": {
    "total_input_tokens": 1200,
    "total_output_tokens": 46336,
    "total_tokens": 47536
  },
  "video": "data:video/mp4;base64,AAAA...",
  "cost": {
    "estimated": { "amountUsd": 0.8, "state": "estimated", "basis": "8s @ $0.1/s x1 (720p) — pre-call estimate" },
    "reported": {
      "amountUsd": 0.8125,
      "state": "billed",
      "basis": "From reported usage: input 1200 tok, output 46336 tok ...",
      "tokens": { "input": 1200, "output": 46336, "total": 47536 }
    },
    "note": "Cost computed from the provider's reported token usage × published rates. ..."
  }
}
```

- `usage` — the token meters the Gemini Interactions API actually returns
  (`null` for the mock provider or when the API reports none).
- `cost.estimated` — pre-call estimate; drives the UI preview + spend guard.
- `cost.reported` — the **actual** cost, computed from `usage` × published
  per-token rates. `state` is `"billed"` when usage was reported, `"unknown"`
  when it wasn't, and `"estimated"` for the mock provider (`amountUsd: 0`).
- `mock: true` means the video is a placeholder and **no real generation
  occurred** — surfaced explicitly in the UI.

### Errors

| Status | When | Shape |
|---|---|---|
| 400 | Invalid JSON | `{ "error": "Invalid JSON body." }` |
| 422 | Validation failed | `{ "error": "Validation failed.", "details": [{ "path", "message" }] }` |
| 409 | Duplicate `clientRequestId` within 60 s | `{ "error": "Duplicate request ignored ..." }` |
| 429 | Another generation already running / rate limit | `{ "error": "..." }` |
| 503 | Real provider selected but `ENABLE_PAID_GENERATION` is not `true` | `{ "error": "...", "code": "PAID_GENERATION_DISABLED", "estimatedCost": {...} }` |
| 402 | Dev spend limit would be exceeded | `{ "error": "...", "code": "SPEND_LIMIT", "estimatedCost": {...} }` |
| 400/429/502 | Provider error (model not accessible, quota, upstream failure) | `{ "error": "...", "code": "PROVIDER_ERROR" }` |
| 500 | Unexpected server error | `{ "error": "Unexpected error: ..." }` |

Providers never return a fabricated success: on failure the route reports an
honest error with an appropriate status.
