# Visual Intelligence & Entity-Aware Creative

_Last updated: 2026-10-09_

## Why this exists

A source import correctly understood BhavishAI as a SaaS/astrology service, but
the creative stage then generated a physical dropper bottle on a grey studio
background. Root cause: `buildCreativePlan`/`composeVideoPrompt` were hard-coded
for physical products and ignored the detected entity type.

## What changed (implemented)

### Entity type is now first-class in the creative engine
- `lib/creative/entityStrategies.js` defines per-entity strategies
  (physical_product, saas, app, service, business, agency, creator,
  personal_brand, course, event, unknown). Each sets subject noun, scene
  vocabulary, fidelity rule, extra negatives, default concepts, generation mode
  and whether physical-product language is allowed.
- `lib/creative/planner.js` dispatches scene planning on the strategy — SaaS/
  service/creator get entity-appropriate scenes, NOT "the product as the hero".
- `lib/creative/promptComposer.js` builds entity-appropriate prompts. Physical
  fidelity terms (bottle/cap/packaging/geometry) appear ONLY for physical
  products; non-physical entities get an explicit "This is NOT a physical
  product" instruction plus entity-specific negatives.

### One canonical compiler (no client/server prompt divergence)
- `lib/creative/compile.js` → `compileCreativeRequest()` builds brief + scene
  plan + generation context + final prompt + preflight. BOTH
  `/api/creative/preview` and `/api/generate` call it, so the prompt the user
  reviews is exactly what the model receives.

### Creative preflight / quality gate
- `runPreflight()` deterministically BLOCKS entity/prompt contradictions. The
  key guard: a non-physical entity whose prompt uses physical-product language
  (affirmatively, not inside a "do not …" negation) is blocked. Also blocks
  creator ads without an authorized asset and very-low-confidence entities.
- `/api/generate` refuses to call the model (422 `PREFLIGHT_BLOCKED`) unless
  `readyForPaidGeneration` is true. **This prevents another BhavishAI→bottle
  paid call.**

### SVG support
- `lib/crawl/images.js` keeps useful SVGs (logo/illustration) instead of
  dropping all non-structured SVGs; adds an `illustration` role and `isVector`.
- `lib/assets/store.js` handles `image/svg+xml`, sanitizes SVGs
  (`sanitizeSvg`: strips `<script>`, `on*` handlers, external refs,
  `<foreignObject>`, entities) before storing.

### Imported asset → generation reference (bug fix)
- Previously only a manual upload populated `input.image`, so a crawler-found
  image never reached the model. Now the chosen hero flows as
  `referenceAssetUrl`; `/api/generate` resolves it server-side (local stored
  asset read from `public/imported-assets`, or SSRF-safe remote fetch) into the
  generation reference. SVGs are not sent as raster references.

## Scoped / NOT yet implemented (honest status)

- **Headless-browser screenshots + computed-style DesignProfile** (Playwright/
  Puppeteer): the `designProfile` is threaded through the compiler and planner
  (palette/motifs/visualPersonality influence prompts when present), but a
  runtime rendered-screenshot + computed-style extractor is **not** built in
  this PR. DesignProfile is currently populated only from the existing
  deterministic brand signals + AI enrichment. Full visual extraction is the
  next milestone.
- **Remotion deterministic composition** (exact logo/UI/screenshot overlays,
  motion-graphics ads): architected for (prompts reserve overlay negative
  space; `generationMode` is `hybrid`/`motion_graphics` for SaaS) but the
  Remotion renderer itself is **not** implemented yet.
- **AI multimodal image/design classification & cheap keyframe preview**:
  scoped; not wired. Source-image classification remains the conservative
  heuristic.
- **AssetLibrary** generalized model: partially realized via image roles +
  `isVector`; a full first-class Asset entity with raster previews is pending.

See `docs/ROADMAP.md` for sequencing.

---

## Update 2026-10-11 — Visual-intelligence PR (what's now REAL)

### Implemented and tested
- **Verified asset lifecycle** (`lib/assets/verify.js`): every candidate image is
  downloaded (SSRF-safe) and **decoded with `sharp`** to confirm it's a real,
  non-corrupt image with true dimensions. Broken / undecodable / too-small
  (<200px max edge) images are **rejected** (kept in `rejectedAssets` for
  debugging), never counted as usable. The importer now stores only verified
  assets, so the gallery can't show broken thumbnails. *Live-verified*: a
  Wikipedia import kept 3 of 9 candidates, all with real `storedUrl` +
  dimensions.
- **SVG support** (`verify.js` + `store.sanitizeSvg` + `sharp`): SVGs are
  sanitized then **rasterized to PNG** so raster-only video models can use them;
  the vector is kept too.
- **DesignProfile** (`lib/design/designProfile.js`): evidence-based palette
  (intentional colors from theme-color / CSS vars / CTA colors; white ignored),
  typography families, shape hints, with provenance + confidence. If no palette
  exists it reports `detected:false` and **does not invent one**. The importer
  returns `designProfile`; brand colors now prefer it.
- **Relevance-based reference selection** (`lib/assets/selectReference.js`,
  **now wired into `lib/crawl/importProduct.js`**): an icon/logo is **never**
  chosen as the primary scene reference; selection depends on entity type
  (physical → product shot; SaaS → UI screenshot; brand → hero visual). A
  logo-only site yields "no scene primary" (logo kept for an end-card overlay).
  The importer calls `selectReference(assets, { entityType })` and exposes the
  result as `primaryReferenceRole`; `primaryImage` now resolves from the chosen
  reference (`storedUrl` → `sourceUrl` → hero fallback) instead of blindly
  taking the first hero asset. *Live-verified*: a wikipedia.org import selected
  `website_hero` as the primary reference (not an icon).
- **Reference resolution for generation** (`lib/assets/resolveReference.js`):
  `resolveReferenceAsset(url)` was extracted out of the generate route into a
  reusable module. It reads locally-stored assets from `/imported-assets/` via
  `path.basename` (anti-traversal), fetches `http(s)` references through the
  SSRF-safe fetcher, and returns `null` for SVG (raster models can't consume it
  directly). `app/api/generate/route.js` imports this instead of inlining it.
- **Pure image validation** (`lib/assets/verify.js` → `validateImageBuffer`):
  the decode/dimension/size checks were extracted into a pure
  `validateImageBuffer(raw, mime, opts)` that operates on an in-memory buffer,
  so they can be unit-tested without a network fetch (`verifyImageUrl` is
  SSRF-blocked against loopback, which is correct, but made buffer-level tests
  impossible before).

### Implemented (browser capture now exercised + hardened)
- **Rendered screenshots + computed-style capture** (`lib/design/screenshot.js`):
  a Playwright provider behind an interface, **opt-in** via
  `ENABLE_RENDERED_CAPTURE=true`. The app does **not** depend on it — when the
  browser/Playwright is absent it returns `{available:false}` and we fall back to
  HTML/CSS design extraction. It has now been exercised with a live Chromium
  (produced a real ~58KB screenshot) and **security-hardened**:
  - **Per-subrequest SSRF guard** — every resource the page tries to load is
    checked (`isSubrequestAllowed`: DNS-resolve the host, then `isBlockedIp` on
    the resolved address), so a page can't pivot the browser to
    `169.254.169.254`, `127.0.0.1`, or private ranges via a redirect/subresource.
    *Verified*: blocks the cloud metadata IP, loopback and `10.x`; allows public
    hosts; a legitimate capture still succeeds.
  - **Hard resource limits** — `{ maxRequests: 150, maxTotalBytes: 25MB,
    maxCaptureMs: 30000 }`, `waitUntil: "domcontentloaded"` + a 1200ms settle,
    `acceptDownloads: false`, and a capture-deadline timeout, to bound a hostile
    or runaway page.

### NOT yet implemented (honest)
- Multi-image upload / per-asset role tagging / extra-context field inside the
  import review UI (the backend asset model supports roles; the richer upload UX
  is the next slice).
- AI multimodal image classification (we classify by role/URL heuristics +
  verification; a vision pass for ambiguous assets is future).
- Missing-image **AI keyframe** generation (recovery currently = screenshots /
  SVG / logo / user upload; a cheap image-model keyframe is future and must be
  cost-approved).
