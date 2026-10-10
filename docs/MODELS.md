# Video models — comparison & switching

_Last updated: 2026-10-11_

MakeAdClips reaches every video model through one abstraction so models can be
compared and switched **without touching the product workflow**:

- `lib/ai/provider.js` — the `VideoProvider` contract (prompt + optional image →
  video; throws `ProviderError` on failure).
- `lib/ai/index.js` — `getVideoProvider()` factory (config-driven).
- `lib/ai/modelRegistry.js` — metadata for comparison/selection.

The route handler and UI never name a model; they call the provider.

## Registry

| Model | Status | ~$/sec (720p) | Default | Notes |
|---|---|---:|:---:|---|
| `gemini-omni-1.1-flash` | GA | 0.10 | ✅ | Image-to-video, editing, extension via Interactions API. Chosen for usable output + stability. |
| `veo-3.1-lite` | **deprecated** (shutdown 2026-10-22) | 0.05 | — | Cheapest/sec but preview is being shut down; different request/response shape → needs its own adapter. Reference entry only; **do not couple to it**. |

`usdPerSecond720p` drives only the pre-call **estimate** and dev spend guard.
Real cost is computed from the provider's reported token usage after a call
(see `docs/COSTS.md`). Confirm live pricing at
<https://ai.google.dev/gemini-api/docs/pricing>.

## Switching models

Set `VIDEO_MODEL` to a registry id. If the id maps to the existing
`gemini-omni` provider impl, no code changes are needed. A model with a
different API shape (e.g. a Veo-style `generateContent` model) requires a new
provider adapter behind the same `VideoProvider` contract — the workflow,
routes and UI stay unchanged.

The `/api/generate` status probe returns the active model and a
`modelWarning` when the configured default is deprecated, so a shutdown model is
never depended on silently.

## Policy

- Default must be **GA / non-deprecated**.
- Evaluate on **usable output**, not just price (`qualityNotes`).
- Not implemented yet: a live multi-model A/B comparison UI and additional
  provider adapters (e.g. a non-deprecated Veo successor). The registry is the
  seam that makes those additive.
