# Bug Register

| ID | Title | Status | Fix location |
|----|-------|--------|--------------|
| MAC-001 | Veo 3.1 Lite API id wrong | Fixed | `lib/ai/modelRegistry.js` |
| MAC-002 | Generate hangs forever (synchronous polling) | Fixed | `lib/jobs/`, `app/api/jobs/` |
| MAC-003 | Empty template/ratio → 422 (Studio unusable) | Fixed | `lib/validation.js` |
| MAC-004 | Same-URL asset causes React key collision | Fixed | `lib/crawl/importProduct.js`, `Studio.js` |
| MAC-005 | Akamai "Access Denied" page stored as footage | Fixed | `lib/crawl/blockDetect.js`, `lib/design/screenshot.js` |
| MAC-006 | Brushed-gold texture classified as product asset | Fixed | `lib/crawl/assetQuality.js` → `texture_background` tag |
| MAC-007 | Same photo at two sizes ingested as two assets | Fixed | `lib/crawl/importProduct.js` — dHash dedup |
| MAC-008 | Store homepage title used as product/brand name | Fixed | `lib/crawl/focus.js` — vision-model campaign focus |
| MAC-009 | Dev server recompile loop on every file save | Fixed | `next.config.mjs` — `turbopack.root` pinned |
| MAC-010 | Creative text calls hang indefinitely | Fixed | `lib/ai/textModel.js` — 45s timeout + 15s hedge |
| MAC-011 | Director returns only 1 shot (whole ad is 12s) | Fixed | `lib/ai/director.js` — schema min/maxItems + corrective retry |
| MAC-012 | Hinglish narration produces English-only captions | Fixed | `lib/i18n/profile.js` — mixed-lang caption check + retry |
| MAC-013 | CTA copy drifts from user-supplied text | Fixed | `lib/ai/director.js` — verbatim CTA enforcement post-edit |

## Format

```
MAC-NNN  title
  Root cause:  …
  Fix:         …
  Regression:  tests/…
  Verified:    yes/no + evidence
```

### MAC-001 — Veo 3.1 Lite API id
- **Root cause:** registry mapped `veo-3.1-lite` to `veo-3.1-fast-generate-preview`; the actual Interactions API id is `veo-3.1-lite-generate-preview`.
- **Fix:** corrected in `modelRegistry.js`; shutdown note removed (Google deprecations page lists no shutdown date).
- **Regression:** `tests/model-registry.test.mjs`
- **Verified:** no — Lite not exercised in a live run yet.

### MAC-002 — Generate hangs forever
- **Root cause:** generate route ran Veo polling synchronously inside a single HTTP request with a ~4-minute ceiling. If the browser tab closed, the job was lost. No progress was visible.
- **Fix:** durable background jobs (`lib/jobs/`): submit → idempotency key, lease, heartbeat, cancel, recovery, Veo operation resume, production record. MP4 served from disk with Range support. Studio polls `/api/jobs/<id>`.
- **Regression:** `tests/production-routing.test.mjs`
- **Verified:** yes — H&M Hinglish (12s, 3 ai_video shots, completed) and Blue Bottle French (12s, 3 shots, completed).

### MAC-003 — Empty template → 422
- **Root cause:** AI concepts carry no `template` field; Studio form posted `template=""` which `z.enum(TEMPLATES)` hard-rejected before any render. CLI was immune because it sets `template` itself.
- **Fix:** `lib/validation.js` — `.catch("minimal")` coerces empty/unknown template; same for `aspectRatio`.
- **Regression:** `tests/validation.test.mjs` (2 new assertions).
- **Verified:** yes — HTTP probe with `template=""` returns 200.

### MAC-009 — Dev server recompile loop
- **Root cause:** a stray `package-lock.json` (or similar artefact) in `C:\Users\gauta` caused Turbopack to watch the entire home directory; every file save in `~/Desktop/…` triggered a full rebuild.
- **Fix:** `next.config.mjs` — `turbopack: { root: process.cwd() }` (no trailing separator).
- **Verified:** yes — server on :3100 stable across many file changes.
