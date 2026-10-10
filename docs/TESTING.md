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

## Crawler + creative tests (added for the importer milestone)

`tests/crawl.test.mjs` and `tests/creative.test.mjs` (fixtures in
`tests/fixtures.mjs`) — all run on HTML fixtures / pure functions, **no network,
no Firecrawl, no Gemini, no cost**:

- Structured JSON-LD populates product fields (with provenance).
- No-structured-data page still extracts from DOM/meta + warns.
- Content cleaning strips nav/footer noise and dedupes repeated blocks.
- High-res gallery image outranks a tiny icon; payment/star icons dropped.
- Duplicate size-variants of one asset are deduped.
- Brand extraction finds intentional colors (ignores white) + logo + confidence.
- SSRF: private/loopback/metadata IPs blocked; non-http + localhost rejected;
  normal public https allowed.
- Source image: poster/ad → reference; clean packshot → product hero.
- Prompt: poster source forbids phones/poster-in-frame and includes brand color.
- Prompt: two brands, same product → different art direction.
- Prompt with no brand → explicitly avoids generic "AI silver".
- Concepts: luxury vs. playful brands get different concept sets.

**Last run (2026-10-09): 26/26 passing** (10 prior + 16 new).

Live smoke test (mock provider): importer pipeline on a fixture extracted
name/brand/price, ranked the hero image, found brand colors + logo, stripped
footer noise; `/api/creative/concepts` returned luxury concepts; `/api/generate`
with a poster source returned `treatAsReference: true` and a prompt that forbids
phones and includes the brand color.

## NOT yet verified

- **Real Gemini Omni Flash generation** against a live key. The integration is
  implemented but unexercised — treat as unverified until a safe-cost test is
  run with real credentials (see `docs/COSTS.md`).

## How to run a safe live test (when you have a key)

1. Set `VIDEO_PROVIDER=gemini`, `GEMINI_API_KEY=...`, `ENABLE_PAID_GENERATION=true`
   in `.env.local`.
2. Generate one short clip (3–5 s, 720p).
3. Confirm the actual charge in Google AI Studio billing.
