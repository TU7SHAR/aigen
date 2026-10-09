# Testing — AdForge Studio

_Last updated: 2026-10-09_

## Automated tests

Run: `npm test` (Node's built-in test runner; **mock provider only — no API
cost**).

`tests/unit.test.mjs` covers:

- `buildAdPrompt` includes the product/brand and the fidelity guardrail (image
  case) and avoids inventing logos (no-image case).
- Validation rejects missing `productName` and unknown `template`/`aspectRatio`;
  accepts a well-formed payload and applies defaults (`720p`, 8 s).
- `estimateCost` scales correctly with duration and resolution.
- `checkSpendBudget` blocks spend over the cap.
- Mock provider returns a flagged (`mock: true`) placeholder MP4 with a valid
  `ftyp` box and zero cost.

**Last run (2026-10-09): 8/8 passing.**

## Verified manually (mock provider, local server)

| Check | Result |
|---|---|
| `GET /api/generate` status probe | `{provider: mock, paidGenerationEnabled: false, devSpendLimitUsd: 5}` |
| `POST` valid payload | 200, `mock:true`, base64 MP4 (`ftyp` verified), estimate `$0.80 UNVERIFIED` |
| `POST` missing `productName` | 422 with field-level message |
| `POST` invalid `aspectRatio` | 422 |
| `POST` with `VIDEO_PROVIDER=gemini` + paid OFF | 503 `PAID_GENERATION_DISABLED`, **no Gemini call** |
| `npm run lint` | 0 errors (1 justified `<img>` warning suppressed) |
| `npm run build` | success; `/`, `/studio` static, `/api/generate` dynamic |

## NOT yet verified

- **Real Gemini Omni Flash generation** against a live key. The integration is
  implemented but unexercised — treat as unverified until a safe-cost test is
  run with real credentials (see `docs/COSTS.md`).

## How to run a safe live test (when you have a key)

1. Set `VIDEO_PROVIDER=gemini`, `GEMINI_API_KEY=...`, `ENABLE_PAID_GENERATION=true`
   in `.env.local`.
2. Generate one short clip (3–5 s, 720p).
3. Confirm the actual charge in Google AI Studio billing.
