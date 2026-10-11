# Visual Intelligence & Entity-Aware Creative

_Last updated: 2026-10-11_

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
- **SVG support + allowlist sanitizer** (`store.sanitizeSvg` + `verify.js` +
  `sharp`): SVGs are sanitized then **rasterized to PNG** so raster-only video
  models can use them; the vector is kept too. The sanitizer is now a **real XML
  parse + strict allowlist** (cheerio), not the old regex stripper — it keeps
  only presentational elements/attributes and drops `<script>`, event handlers,
  `<foreignObject>`, external `href`/`use`/`image` refs, `url()`/`javascript:`
  in styles, and DOCTYPE/entity/CDATA (XXE) constructs; unknown constructs fail
  closed. Covered by `tests/svg-sanitize.test.mjs`.
- **DesignProfile** (`lib/design/designProfile.js`): evidence-based palette
  (intentional colors from theme-color / CSS vars / CTA colors; white ignored),
  typography families, shape hints, with provenance + confidence. If no palette
  exists it reports `detected:false` and **does not invent one**. The importer
  returns `designProfile`; brand colors now prefer it.
- **Role-based reference selection** (`lib/assets/selectReference.js`, **wired
  into `lib/crawl/importProduct.js`**). HONEST SCOPE: this ranks assets by their
  crawl-assigned **role** then resolution — it is **NOT** image-content
  relevance analysis (nothing inspects pixels to confirm an image depicts the
  product). Its strong guarantee is **negative**: an icon/logo/navigation asset
  is **never** promoted to the primary scene reference. The importer calls
  `selectReference(assets, { entityType })` and exposes `primaryReferenceRole` +
  a `primaryReferenceSelection` provenance object (`selected`, `role`,
  `basis: "role_rank_then_resolution"`, `reason`). When the selector
  deliberately returns no scene-worthy reference (e.g. logo-only site),
  `primaryImage` is **null** — it does **not** fall back to `heroAssets[0]`
  (that would re-promote exactly what the selector rejected). A user-chosen
  reference (Milestone 2) is authoritative (`basis: "user_selected"`).
  "Verified" (decodable + sized) is distinct from "creatively suitable"; true
  visual-relevance ranking is future work. *Live check*: a wikipedia.org import
  selected `website_hero` as primary (not an icon).
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

### Rendered capture — DISABLED by default, NOT production-safe
- **Rendered screenshots + computed-style capture** (`lib/design/screenshot.js`):
  a Playwright provider behind an interface. The app **never depends on it** —
  when disabled/absent it returns `{available:false}` and we fall back to
  HTML/CSS design extraction. It is **doubly gated** (`ENABLE_RENDERED_CAPTURE`
  **and** `ACKNOWLEDGE_CAPTURE_UNSAFE`) and must stay off for public/multi-tenant
  use. In-process mitigations (per-subrequest DNS+IP blocklist, scheme
  allowlist, request/byte/time budgets with the byte budget enforced on actual
  received bytes) **raise the bar but are not a boundary**: DNS rebinding
  (Chromium re-resolves after our check) and `--no-sandbox` mean the real fix is
  network-level isolation outside the process. Full rationale in
  `docs/SECURITY.md § Rendered capture`. Not relied upon for product quality.

### NOT yet implemented (honest)
- Multi-image upload / per-asset role tagging / extra-context field inside the
  import review UI (the backend asset model supports roles; the richer upload UX
  is the next slice).
- AI multimodal image classification (we classify by role/URL heuristics +
  verification; a vision pass for ambiguous assets is future).
- Missing-image **AI keyframe** generation (recovery currently = screenshots /
  SVG / logo / user upload; a cheap image-model keyframe is future and must be
  cost-approved).
