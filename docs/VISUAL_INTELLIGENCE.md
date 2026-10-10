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
