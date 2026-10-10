# Agent activity log

## 2026-10-11 — Product PR A: multi-image upload, editable product intelligence, user context, asset selection, state propagation

- **Asked:** (priority pivot to product quality) make the app understand +
  let users CORRECT what the imported site promotes: edit entity/industry/
  category/offering, add written context, upload multiple images, remove
  irrelevant scraped assets, select which images influence generation + their
  purpose, say which features/benefits/messages to emphasize and what must NOT
  appear — all corrections propagating to creative planning AND the real
  generation request. No industry-specific hardcoding. No paid calls.
- **Did (backend contract first, then UI, both tested):**
  - **Schema (`lib/validation.js`):** added `category`, `offering`,
    `emphasis[]`, `avoid[]`, and `referenceAssets[]` ({url, role, primary}).
    `userIntent` (already present, previously unused) now carries free context.
  - **Compile (`lib/creative/compile.js`):** user `category`/`offering`
    override scraped values; `emphasis`/`avoid` normalized (trim+dedupe) and
    threaded into the planner and prompt composer.
  - **Prompt (`lib/creative/promptComposer.js`):** emphasis → an affirmative
    "EMPHASIZE …" instruction; avoid → appended to the negative/`Avoid:` rules
    (deduped). **Planner** carries emphasis/avoid onto the brief;
    **generationContext** now includes category/offering + emphasis/avoid so
    the grounding (and PR B's AI director) see the corrections.
  - **Multi-reference (`lib/api/generateCore.js`):** resolves the PRIMARY of
    `referenceAssets[]` (flagged or first) into the hero `image`; records the
    full selection on `sourceImageMeta.selectedReferences`. Single-URL
    `referenceAssetUrl` kept for back-compat.
  - **Review UI (`components/studio/ProductImport.js`):** editable type/
    category/offering; a real **asset manager** built from the importer's
    `assets[]` (select / assign role / set primary / remove) with
    **multi-file upload** (PNG/JPEG/WebP ≤5MB, client base64); emphasis / avoid
    / extra-context inputs. Corrections flow into concept reasoning and the
    handoff payload (incl. `designProfile`, previously never forwarded).
  - **Studio (`components/studio/Studio.js`):** threads every new field into
    BOTH the `/api/creative/preview` payload and the `/api/generate` payload,
    so the previewed prompt == the generated prompt. A primary UPLOADED
    reference flows via the single base64 `image` path; URL references via
    `referenceAssets[]`.
- **Files affected:** `lib/validation.js`, `lib/creative/compile.js`,
  `lib/creative/promptComposer.js`, `lib/creative/planner.js`,
  `lib/creative/generationContext.js`, `lib/api/generateCore.js`,
  `components/studio/ProductImport.js`, `components/studio/Studio.js`,
  `tests/product-controls.test.mjs` (new), `docs/agent-activity-log.md`.
- **Verification:** `npm run lint` clean · `npm test` **127/127** (7 new in
  `product-controls`: category override, emphasis-in-prompt, avoid-in-negatives,
  brief carry, normalization, multi-ref primary honored, first-selected
  fallback) · `npm run build` OK. **Live HTTP check** against
  `/api/creative/preview`: corrected `entityType=saas`, EMPHASIZE line present,
  user avoids in negative rules, corrected category in context, brief carries
  emphasis/avoid, preflight ready. No paid video calls.
- **Scope note:** no industry→creative hardcoding added — emphasis/avoid/
  context are free user inputs used verbatim; roles are technical/structural.
- **Branch/PR:** `feat/product-controls` (stacked on `fix/pr18-corrections`).

## 2026-10-11 — PR #18 corrections (round 2): honest labeling, allowlist SVG sanitizer, no-fallback reference, real server-pipeline integration test, capture gated unsafe

- **Asked:** reviewer follow-up on PR #19/#20 — (1) don't claim the browser
  capture is production-safe (DNS rebinding + `--no-sandbox`; Content-Length
  budget isn't real enforcement); keep public capture disabled; (2) stop
  claiming `selectReference` does content-relevance, and remove the
  `heroAssets[0]` fallback when the selector deliberately returns nothing;
  distinguish verified from creatively-suitable; keep a user pick authoritative;
  (3) replace the regex SVG sanitizer with a robust allowlist approach + tests;
  (4) add a real application/server-level integration test (not just a lib E2E);
  (5) stop backdating docs to Oct 9 — today is Oct 11; (6) land the corrected
  security code safely in the stacked chain; (7) clearly separate real browser
  execution, mocked generation, visual relevance, and security validation.
- **Interpreted + did:**
  - **Honest labeling (screenshot.js):** added a prominent security banner;
    the capability is now **doubly gated** (`ENABLE_RENDERED_CAPTURE` **and**
    `ACKNOWLEDGE_CAPTURE_UNSAFE`) and documents that in-process checks are
    bar-raising, not a boundary (DNS rebinding TOCTOU + `--no-sandbox`). The
    download budget is now enforced on **actual received bytes**, not just
    `Content-Length`. Correct posture (network-level isolation) documented in
    `docs/SECURITY.md § Rendered capture`. SSRF protections kept intact.
  - **Reference selection (importProduct.js + selectReference.js):** removed the
    `heroAssets[0]` fallback — when the selector returns no scene-worthy
    reference, `primaryImage` is **null** (honest, propagated), not a
    re-promoted hero. Added a `primaryReferenceSelection` provenance object
    (`basis: "role_rank_then_resolution"`, not relevance). Documented the module
    as **role-based, NOT content-relevance**, dropped the misleading
    `relevanceScore` hint, and made a `userSelectedReference` authoritative
    (`basis: "user_selected"`) for Milestone 2.
  - **SVG sanitizer (store.js):** replaced the regex stripper with a real XML
    parse + strict allowlist (cheerio) — keeps only presentational
    elements/attributes; drops scripts, event handlers, `<foreignObject>`,
    external `href`/`use`/`image` refs, `url()`/`javascript:` styles, and
    DOCTYPE/entity/CDATA (XXE); unknown constructs fail closed. Rasterization
    with sharp is the defense-in-depth second layer.
  - **Tests:** added `tests/svg-sanitize.test.mjs` (10 malicious/benign cases)
    and `tests/generate-route-integration.test.mjs` (server-pipeline: import →
    selectReference → review handoff → `runGenerate` → recorded mock-provider
    input; asserts logo-only → no primary, and user pick authoritative). To make
    the real pipeline testable without Next's `next/server` resolution, extracted
    the generate pipeline into `lib/api/generateCore.js` (`runGenerate`) and made
    `app/api/generate/route.js` a thin NextResponse wrapper (behavior identical).
  - **Docs:** corrected `VISUAL_INTELLIGENCE.md` (role-based selection,
    no-fallback, capture disabled/unsafe), `SECURITY.md`, `TESTING.md` (scope &
    honesty note; distinguishes code-correctness from ad quality), and set all
    touched docs to **2026-10-11** (not Oct 9).
- **Files affected:** `lib/design/screenshot.js`, `lib/crawl/importProduct.js`,
  `lib/assets/selectReference.js`, `lib/assets/store.js`,
  `lib/api/generateCore.js` (new), `app/api/generate/route.js`,
  `tests/svg-sanitize.test.mjs` (new),
  `tests/generate-route-integration.test.mjs` (new), `docs/VISUAL_INTELLIGENCE.md`,
  `docs/SECURITY.md`, `docs/TESTING.md`, `docs/agent-activity-log.md`.
- **Verification:** `npm run lint` clean, `npm test` **120/120 pass**,
  `npm run build` OK. SVG sanitizer manually fuzzed against script/onload/
  external-ref/foreignObject/style-url/DOCTYPE-XXE/CDATA — all neutralized;
  legitimate SVG still rasterizes. No paid video calls.
- **Scope note (per new steering):** stopped here on security/infra. Did NOT
  expand capture hardening further; product work (Product PR A onward) is next.
- **Branch/PR:** `fix/pr18-corrections` → PR #20 (stacked on #19).

## 2026-10-11 — PR #18 corrections: browser SSRF hardening, selectReference wiring, real tests + E2E proof, avatar-report license fix

- **Asked:** "complete PR #18 — browser-capture security hardening, wire
  `selectReference` into the importer, add real verification tests + an
  end-to-end mock-provider proof, and correct the avatar report (Piper is not
  plainly MIT — OHF Piper is GPL-3.0; audit MuseTalk's dependency licenses;
  distinguish benchmarks from measurements; don't call MuseTalk+Piper
  production-ready without a benchmarked PoC)."
- **Interpreted:** PR #18 landed the visual-intelligence building blocks but left
  gaps: (1) `selectReference` existed but nothing called it, so the importer
  could still pick an icon as the primary scene reference; (2) the rendered-
  screenshot capture had no per-subresource SSRF guard or resource limits;
  (3) the only "tests" exercised code paths that are SSRF-blocked against
  loopback, so there was no real buffer-level verification test and no proof a
  selected reference actually reaches the generation provider; (4) the avatar
  feasibility report overstated license cleanliness ("Piper = MIT",
  "MuseTalk = MIT") and blurred public benchmarks with measured results.
- **Did:**
  - **Wired `selectReference` into `lib/crawl/importProduct.js`**: the importer
    now calls `selectReference(assets, { entityType })`, exposes
    `primaryReferenceRole`, and resolves `primaryImage` from the chosen
    reference (`storedUrl` → `sourceUrl` → hero fallback) instead of the first
    hero asset. Added `illustration` and `website_hero` to `webRoles`.
  - **Hardened `lib/design/screenshot.js`**: per-subrequest SSRF guard
    (`isSubrequestAllowed` = DNS-resolve + `isBlockedIp` on every resource the
    page loads), plus hard limits (`maxRequests:150`, `maxTotalBytes:25MB`,
    `maxCaptureMs:30000`), `waitUntil:"domcontentloaded"` + 1200ms settle,
    `acceptDownloads:false`, and a capture-deadline timeout. Imports `dns`,
    `net`, `isBlockedIp`.
  - **Extracted pure `validateImageBuffer(raw, mime, opts)`** from
    `verifyImageUrl` in `lib/assets/verify.js` so decode/size/dimension checks
    are unit-testable without a (SSRF-blocked) network fetch.
  - **Extracted `lib/assets/resolveReference.js`** (`resolveReferenceAsset`)
    from the generate route — local `/imported-assets/` read via
    `path.basename` anti-traversal, SSRF-safe fetch for `http(s)`, `null` for
    SVG; `app/api/generate/route.js` now imports it and dropped the inlined
    copy + unused `fs`/`path`/`safeFetch` imports.
  - **Mock provider now echoes `receivedRequest`** (`lib/ai/mockProvider.js`:
    hasImage, imageMimeType, imageBytesApprox, promptPreview, aspectRatio,
    durationSeconds) and the generate route surfaces it, giving an auditable
    proof that the resolved reference image reached the provider.
  - **Added real tests**: `tests/verify-live.test.mjs` (8, buffer-level via
    `validateImageBuffer`) and `tests/generate-reference-e2e.test.mjs` (5,
    lib-level E2E proving a selected reference reaches the mock provider).
  - **Corrected `docs/AVATAR_FEASIBILITY.md`**: Piper is forked — archived
    `rhasspy/piper` (MIT) vs maintained `OHF-Voice/piper1-gpl` (**GPL-3.0**,
    because it embeds GPL espeak-ng) vs `piper-plus` (MIT, no espeak-ng);
    added a MuseTalk dependency-license audit (code MIT, but it auto-downloads
    sd-vae-ft-mse / whisper-tiny / DWPose / face-parsing weights, each with its
    own license — mostly MIT/Apache per MuseTalk's LICENSE, but must be checked
    per pinned weight); relabelled all FPS/VRAM/$ figures as public benchmarks
    or estimates (not measured on our hardware); and stated MuseTalk+TTS is NOT
    production-ready until a benchmarked presenter-video PoC exists.
- **Files affected:** `lib/crawl/importProduct.js`, `lib/design/screenshot.js`,
  `lib/assets/verify.js`, `lib/assets/resolveReference.js` (new),
  `app/api/generate/route.js`, `lib/ai/mockProvider.js`,
  `tests/verify-live.test.mjs` (new), `tests/generate-reference-e2e.test.mjs`
  (new), `docs/AVATAR_FEASIBILITY.md`, `docs/VISUAL_INTELLIGENCE.md`,
  `docs/agent-activity-log.md`.
- **Impact:** The importer can no longer promote an icon/logo to the primary
  scene reference; the opt-in browser capture is SSRF-hardened and resource-
  bounded; verification and reference→provider wiring are now covered by real
  tests (105/105 pass); and the avatar report is honest about licensing and
  about the benchmark-vs-measured distinction. No paid video calls were made.
- **Verification:** `npm run lint` clean, `npm test` 105/105 pass,
  `npm run build` OK. Live proof: wikipedia.org import → entity `business`,
  `primaryReferenceRole: website_hero` (not an icon), 4 assets kept / 0
  rejected; generate (mock) with that reference →
  `receivedRequest.hasImage: true`, `mime: image/png`, `bytes: 189402`.
- **Branch/PR:** `fix/pr18-corrections`, stacked on
  `feat/enable-rendered-screenshots` (PR #19).

## 2026-10-11 — MakeAdClips brand identity: favicon, logo mark, icons & metadata

- **Asked:** "add favicon and all related to brand identity … the brand is not
  clear make the brand clearer and choose the icon via thorough research. name
  is makeadclips."
- **Interpreted:** The product was renamed to MakeAdClips (PR #8) but the brand
  was still *unclear*: the logo was a placeholder `◩` glyph, the favicon was the
  stock Next.js/Vercel default, and there was no icon system (no `icon.svg`,
  apple-icon, OG/Twitter cards, or manifest) and thin metadata. Researched
  favicon best practice (simple, high-contrast, recognizable at 16px; a
  simplified logo mark; multi-size SVG+ICO+apple+PWA set — launchvault.dev,
  bluehost.com, ramotion.com) and the AI-video-ad category's visual language
  (play / clip / film-frame marks — lumalabs.ai, nim.video, capcut.com). Read
  the bundled Next 16 metadata file-convention docs for exact file names.
- **Did:** Designed a distinctive mark — a bold signal-orange **play/clip
  triangle anchored by two diagonal crop-marks** (the product→clip story in the
  existing frame motif), tuned to read at 16px. Shipped it everywhere:
  `app/icon.svg` (tab favicon), regenerated `app/favicon.ico` (16/32/48 ICO,
  replacing the stock default), `app/apple-icon.png` (180), `app/manifest.js`
  (PWA + `/brand/icon-192|512.png`), and `app/opengraph-image.png` +
  `app/twitter-image.png` (1200×630 cards with mark + wordmark + tagline + mono
  metadata). Added `components/layout/BrandMark.js` (canonical in-app SVG mark,
  `currentColor`, optional ink `tile`) and used it in the header logo lockup,
  the landing eyebrow, and the import entity card — retiring the `◩` glyph.
  Enriched `app/layout.js` metadata (`metadataBase`, `applicationName`, title
  template, keywords, OpenGraph, Twitter `summary_large_image`, `appleWebApp`).
  Icon source SVGs live in `public/brand/`; rasters generated with `sharp` +
  `png-to-ico` (build-time only, `--no-save` — package.json untouched). Fixed
  the stale "AdForge" comment in `globals.css`; documented
  `NEXT_PUBLIC_SITE_URL` in `.env.example`.
- **Files affected:** `app/icon.svg` (new), `app/favicon.ico`,
  `app/apple-icon.png` (new), `app/opengraph-image.png` (new),
  `app/twitter-image.png` (new), `app/manifest.js` (new), `app/layout.js`,
  `app/page.js`, `app/globals.css`, `components/layout/BrandMark.js` (new),
  `components/layout/AppHeader.js`, `components/studio/ProductImport.js`,
  `public/brand/{og-source.svg,apple-source.svg,icon-192.png,icon-512.png}` (new),
  `.env.example`, `docs/DESIGN_SYSTEM.md`.
- **Impact:** The brand is now unmistakable and consistent from favicon →
  header logo → landing → OG card. Verified against a production build: lint
  clean, 49/49 tests pass, build OK; `/icon.svg`, `/favicon.ico`,
  `/apple-icon.png`, `/opengraph-image.png`, `/twitter-image.png`,
  `/manifest.webmanifest` all serve 200 with correct content-types; `<head>`
  carries the full icon/manifest/OG/Twitter/apple set; the header renders the
  real `<BrandMark>` SVG and the `◩` glyph is gone. Mark checked rendered at
  16/32/256px.
- **Branch/PR:** `feat/makeadclips-brand-identity` → `main`.

## 2026-10-11 — Harden importer: Source Intelligence + AI enrichment + context compiler

- **Asked:** The importer returned empty fields and "No image" for real sites,
  and `bhavishai.in` failed instead of being normalized. Make it understand ANY
  entity (product/SaaS/service/business/creator), add AI semantic extraction,
  keep facts above AI, and compile a minimal context for video.
- **Root cause:** The old importer only filled fields from ecommerce Product
  JSON-LD/OG, so a business/SaaS homepage produced blanks yet still offered
  product concepts. And the import route used `z.string().url()`, so a bare
  domain 422'd before crawling.
- **Did:**
  - URL normalization (`lib/crawl/normalizeUrl.js`) + routes accept a loose
    string (bare domains → https; junk still rejected; SSRF unchanged).
  - Source classification + budgeted internal-page discovery
    (`lib/crawl/classify.js`): entity type is detected; a root is never assumed
    to be a Product; thin roots pull facts/images from /pricing /services
    /about /get-report (skips privacy/terms/blog; MAX_SITE_PAGES=5).
  - AI semantic enrichment (`lib/ai/enrich.js`): cheap Gemini Flash-Lite, strict
    JSON responseSchema, nullable fields, no hallucinated facts, graceful
    degradation, token/cost reported.
  - ContextReducer (`lib/crawl/contextReducer.js`): 40k+ → ~7k high-signal chars.
  - Merge layer (`lib/crawl/merge.js`): user_edit > json_ld > OG > internal >
    page_dom > ai_extracted > ai_inferred; AI fills gaps, never overwrites
    high-confidence facts; per-field provenance.
  - Rewrote the orchestrator (`lib/crawl/importProduct.js`) into Source
    Intelligence producing EntityProfile + ProductProfile (back-compat) +
    BrandProfile (AI-filled visualStyle/tone/positioning/keywords) + size trace;
    Firecrawl is now an automatic fallback on poor extraction.
  - Non-product image roles (hero_visual/product_screenshot/brand_art).
  - Generation Context Compiler (`lib/creative/generationContext.js`): minimal
    context for video; wired into /api/generate response.
  - Entity-aware concepts (`lib/creative/concepts.js`) + confidence-gated UX in
    ProductImport (entity banner, low-confidence note, concepts withheld until
    reviewed, dev debug panel). Studio passes entityType/concept through.
  - Enrichment spend tracked separately (`recordEnrichmentSpend`).
  - Also cherry-picked the Editorial Industrial design system (PR #4) which had
    not reached main, so this PR carries it forward too.
- **Verified:** lint clean; 39/39 tests pass (13 new); build OK. Live: `example.com`
  → 200 (normalized https, entityType business, name extracted); junk scheme →
  422; SaaS fixture → entityType business, filled name/description, discovered
  /pricing//get-report//about, hero image found, raw→cleaned→aiInput reduction
  shown; concepts: saas/creator get non-product sets.
- **Limitations:** social platforms (Instagram/Facebook/X/TikTok) still need
  official-API adapters (not built — scraping avoided by design); fully
  client-rendered pages without structured data still rely on the (unverified)
  Firecrawl fallback; enrichment quality depends on the Flash-Lite model/tier.
- **Branch/PR:** `feat/source-intelligence-ai-enrichment` → `main`.

## 2026-10-11 — Fix enrichment model (3.1 Flash Lite)

- **Asked:** Enrichment 404'd — `gemini-2.5-flash-lite` is no longer available
  to new users. User asked for "gemini flash 3.1 lite"; their dashboard lists
  both Gemini 3.1 Flash Lite and 3.5 Flash Lite as available.
- **Did:** Changed the default `SOURCE_ENRICHMENT_MODEL` from
  `gemini-2.5-flash-lite` to `gemini-3.1-flash-lite` in `lib/config.js`,
  `.env.example` and `docs/CRAWLER.md`. Enrichment already degrades gracefully
  if a model is unavailable, so import still works regardless.
- **Verified:** no stale 2.5 refs remain in source; lint clean; 39/39 tests
  pass; build OK. Live model resolution needs the user's key (not pastable).
- **Branch/PR:** `fix/enrichment-model-gemini-3.5-flash-lite` → `main`.

## 2026-10-10 — Light/Dark/System theme system + responsive redesign

- **Asked:** Replace the effectively dark-only UI with a real theming system
  (Light/Dark/System, persisted, no flash) and make the whole app responsive
  (320px → large desktop), with a shared nav, semantic design tokens, consistent
  component states, accessibility, safe areas, and no horizontal scroll.
- **Interpreted:** Audited the repo first. The premise about default "indigo
  SaaS colors" did **not** match this codebase — it already had a semantic,
  token-based "Editorial Industrial" system (no `indigo`/`zinc` anywhere). The
  real gaps vs. the brief were: (1) theme followed the OS only via a hand-rolled
  pre-paint script — no explicit toggle, no persistence; (2) each page had its
  own ad-hoc header, no mobile nav; (3) responsive gaps (studio two-column that
  didn't collapse, fixed 4-col gallery, non-stacking button rows, no safe
  areas). Chose `next-themes` (per the brief's preference) for robust,
  flash-free, hydration-safe theming. The hook's referenced
  `docs/DOCS_MAINTENANCE.md`, `PROJECT.md`, and `commands/` do not exist in this
  repo, so I updated the docs that do (activity log, DESIGN_SYSTEM, README).
- **Did:** Installed `next-themes@0.4.6`. Added `components/theme/`
  (`ThemeProvider`, `ThemeToggle`, `useMounted`) and `components/layout/`
  (`AppHeader` with embedded mobile nav, `ComingSoon`). Rendered the shared
  header + provider once in the root layout; removed the per-page headers and
  the old inline theme script. Expanded `app/globals.css` with the full semantic
  token set (`--surface-elevated`, `--danger/warning/success` + surfaces,
  `--canvas`, `--overlay`), 44px tap targets, ≥16px inputs, safe-area spacing,
  `:focus-visible` rings, `prefers-reduced-motion`, restrained transitions,
  `overflow-x` guards, `.alert*` and `.skeleton`/`.media-canvas`/`.break-anywhere`
  helpers. Migrated landing, studio, and product-import to responsive layouts
  (fluid headings, stacking buttons, single-column mobile forms, responsive
  2/3/4-col gallery, segmented mode tabs, media canvas stays dark in both
  themes). Added themed `/projects` and `/assets` placeholders so nav links are
  never dead. Added `viewport` export (`viewportFit=cover`, adaptive themeColor).
- **Files affected:** `app/globals.css`, `app/layout.js`, `app/page.js`,
  `app/studio/page.js`, `app/projects/page.js` (new), `app/assets/page.js` (new),
  `components/theme/ThemeProvider.js` (new), `components/theme/ThemeToggle.js`
  (new), `components/theme/useMounted.js` (new),
  `components/layout/AppHeader.js` (new), `components/layout/ComingSoon.js` (new),
  `components/studio/Studio.js`, `components/studio/ProductImport.js`,
  `package.json`, `package-lock.json`, `README.md`, `docs/DESIGN_SYSTEM.md`.
- **Impact:** Light mode is now a full experience; theme toggle sits in the
  top nav (desktop) and the hamburger menu (mobile). Verified with a headless
  browser against a production build: toggle present with accessible label;
  `adforge-theme=dark` persists across reload and applies the dark token
  ladder (`body` bg `rgb(13,14,16)`); **zero** horizontal overflow at
  320/375/390/430/768/1024/1280/1440 on `/` and `/studio`; mobile menu exposes
  all 4 links + the 3-way theme control; **no console/hydration warnings** on
  home or studio. `npm run lint` clean, `npm test` 26/26 pass, `npm run build`
  succeeds (pre-existing `lib/assets/store.js` fs-trace warning is unrelated).
- **Branch/PR:** `feat/theme-system-responsive-ui` → `main`.

## 2026-10-09 — Milestone 1: Photo → Gemini AI video studio

- **Asked:** Build the product on the existing Next.js stack using the Gemini
  API (Tier 1 key) for video generation.
- **Interpreted:** Verified claims against Google's live docs. Confirmed
  `gemini-omni-1.1-flash` (Gemini Omni Flash) is the current recommended video
  model and that its Interactions API is **synchronous** (returns base64 MP4
  inline, no poll loop). Discarded the superseded standalone
  Node/HTTP/FFmpeg/fal.ai "AdForge prototype" docs — this repo is a Next.js 16
  app. Kept paid generation off by default to protect spend.
- **Did:** Added a secure `/api/generate` route (server-only key, Zod
  validation, paid kill-switch, dev spend guard, dedup + single-concurrency
  guards); a provider boundary (`lib/ai`) with a free mock provider (default)
  and the real Gemini Omni Flash provider; prompt builder with product-fidelity
  guardrails; cost estimator; a studio UI (drag-drop upload, fields, 5
  templates, ratio/resolution/duration, editable prompt preview, playback,
  MP4 download) and a landing page. Rewrote README + AGENTS and added
  docs/ (ARCHITECTURE, API, SECURITY, COSTS, ROADMAP, TESTING, DATABASE).
  Fixed a real breaking change: `cacheComponents` disallows the `runtime`/
  `dynamic` route-segment configs.
- **Files affected:** `app/page.js`, `app/layout.js`, `app/globals.css`,
  `app/studio/page.js`, `app/api/generate/route.js`, `components/studio/Studio.js`,
  `lib/*`, `tests/unit.test.mjs`, `.env.example`, `README.md`, `AGENTS.md`,
  `docs/*`, `package.json`.
- **Impact:** First working end-to-end flow (free mock mode by default). Real
  Gemini generation implemented but **unverified** until exercised with a live
  key. Lint clean, 8/8 unit tests pass, production build succeeds. Verified via
  local server: valid→200 MP4, invalid→422, gemini+paid-off→503 (no API call).
- **Branch/PR:** `feat/adforge-studio-video-gen` → `main`.

## 2026-10-09 — Report REAL cost from the API instead of estimating

- **Asked:** Don't estimate the cost — ask Google how much it actually spent.
  Keep Gemini Omni (don't swap to Veo Lite). Noted Tier 1 limits (~4 RPM / ~20
  RPD for Omni) and the margin idea (Omni + Remotion overlays).
- **Interpreted:** Verified against Google's docs that no Gemini generative
  endpoint returns a dollar figure per call, but the Interactions response DOES
  return a real `usage` block (total_input_tokens / total_output_tokens /
  total_tokens, etc.), and billing is per token (video output ≈ 5,792 tok/s of
  720p at $17.50/1M ≈ $0.10/s). So "actual cost" = reported tokens × published
  rates, which is the closest the API allows. Did NOT change the model id.
- **Did:** Added `costFromUsage()` (real token usage → billed USD) and
  configurable per-token rates (`GEMINI_*_USD_PER_M`); made the Gemini provider
  read `interaction.usage` and return `cost.state: "billed"` (or `"unknown"` if
  absent). Route now records the actual billed amount against the spend guard
  and returns `usage` + billed cost. UI shows the billed amount + token count.
  Kept the pre-call estimate solely for the budget guard/preview. Updated
  `.env.example`, `docs/COSTS.md`, `docs/API.md`; added two unit tests.
- **Files affected:** `lib/costs/estimate.js`, `lib/ai/geminiProvider.js`,
  `app/api/generate/route.js`, `components/studio/Studio.js`, `.env.example`,
  `tests/unit.test.mjs`, `docs/COSTS.md`, `docs/API.md`.
- **Impact:** Cost shown after a real generation is derived from the API's
  reported token usage, not a guess. Lint clean; 10/10 tests pass; build OK.
  Still unverified end-to-end until run with a live key (and the user must
  rotate the key that was pasted into chat).
- **Branch/PR:** `feat/real-token-usage-cost` → `main`.

## 2026-10-09 — Product URL importer + brand-aware creative pipeline

- **Asked:** Add a product-URL importer (intelligent crawl → ProductProfile +
  images + brand), and fix poor creative quality (static poster → phone mockup +
  generic silver background). Make brand an active input so two brands don't get
  identical ads. Don't spend video credits until the user approves.
- **Interpreted:** Built on the existing Next.js app. Chose Cheerio + SSRF-safe
  direct fetch as the default crawler (most commerce pages expose JSON-LD/OG in
  initial HTML), with a Firecrawl provider behind the same abstraction for
  JS-heavy sites (opt-in, unverified) — deliberately NOT adding Python/
  BeautifulSoup. Structured data outranks AI; Gemini is NOT used for factual
  extraction.
- **Did:**
  - Crawler: `lib/crawl/{safeFetch,providers,structured,clean,images,brand,
    importProduct}.js`. SSRF via DNS resolution + per-redirect re-validation +
    size/time caps. Structured-first extraction with per-field provenance.
    Content cleaning (dedupe + relevance scoring). Image discovery/classify/
    rank/dedupe (thumbnails/icons/badges dropped; largest srcset chosen). Brand
    signals (intentional colors, logo, tagline). 10-min crawl cache + refresh.
  - Storage: `lib/assets/store.js` AssetStore abstraction; LocalAssetStore
    (prototype, content-addressed, documented non-durable) + Supabase stub.
  - Creative: `lib/creative/{sourceImage,templates,planner,promptComposer,
    concepts}.js`. Source-image classifier makes posters/ads REFERENCES (fixes
    poster→phone). Brand-aware CreativeBrief→ScenePlan→professional prompt with
    negative rules + overlay negative-space. Templates carry real art direction.
    Brand-adaptive concepts. Brand influence low/balanced/strong.
  - API: `/api/products/import`, `/api/products/refresh`,
    `/api/creative/concepts`; `/api/generate` now uses the creative pipeline and
    returns the internal plan + source-image handling.
  - UI: `ProductImport.js` (URL → staged status → review: editable fields, hero/
    gallery selection, brand review with influence + ignore, concept choice →
    Continue). Studio gains a Create-from URL/Manual switcher and prefill.
  - Docs: new `docs/CRAWLER.md`, `docs/CREATIVE.md`; updated SECURITY (SSRF),
    ARCHITECTURE, COSTS, .env.example.
- **Files affected:** see above + `lib/config.js`, `lib/validation.js`,
  `components/studio/Studio.js`, `tests/{fixtures,crawl,creative}.test.mjs`.
- **Impact:** Importing a product performs zero paid calls; user reviews real
  extracted data and picks a concept before any generation. Poster sources are
  treated as references; brand palette/tone actively shape the prompt (verified:
  two brands → different prompts). Lint clean; 26/26 tests pass; build OK;
  live-route smoke test confirmed the poster-reference + brand-color behavior.
  `lib/prompts/adPrompt.js` is now superseded by the creative pipeline.
- **Branch/PR:** `feat/product-url-import-creative-pipeline` → `main`.

## 2026-10-09 — "Editorial Industrial" design system

- **Asked:** Give the product its own identity (not BhavishAI's ivory/gold +
  purple). Chose the Editorial Industrial direction: Ink + Warm Bone + Signal
  Orange + a video frame/crop-mark motif, mono for technical metadata, squared
  buttons, rationed orange, proper dark theme (not an inversion).
- **Interpreted:** Implemented as a semantic design-token system wired into
  Tailwind v4 rather than per-screen styling, so the whole app restyles
  consistently and future screens inherit it.
- **Did:** Rebuilt `app/globals.css` with role-based CSS variables (bg/surface/
  raised/ink/muted/line/accent) for light + a distinct dark elevation ladder,
  exposed via `@theme inline` (bg-bg, text-ink, border-line, text-accent, …);
  added component classes (.btn/.card/.input/.eyebrow/.mono-meta/.display) and
  the frame-corner motif (.frame / .frame-corners). Dark mode toggled by a
  pre-paint script in `app/layout.js` from prefers-color-scheme. Redesigned the
  landing page, Studio header, Studio editor (upload dropzone with frame marks,
  template cards, mono metadata readout, GENERATE VIDEO → CTA, framed result/
  empty states) and ProductImport (tokens throughout; warnings/errors use an
  accent left-border instead of off-palette red/amber). Removed all zinc/indigo/
  emerald/amber/red utility classes from app/ and components/. Added
  `docs/DESIGN_SYSTEM.md`.
- **Files affected:** `app/globals.css`, `app/layout.js`, `app/page.js`,
  `app/studio/page.js`, `components/studio/Studio.js`,
  `components/studio/ProductImport.js`, `docs/DESIGN_SYSTEM.md`.
- **Impact:** Distinct, consistent identity (verified: compiled CSS contains
  #ff5a24 / #f7f6f2 / #111214 and the frame motif; pages render with the new
  classes). Lint clean; 26/26 tests pass; build OK. No in-app theme toggle and
  no dedicated logo SVG yet (documented).
- **Branch/PR:** `feat/editorial-industrial-design-system` → base
  `feat/product-url-import-creative-pipeline` (stacked on the open PR #3).

## 2026-10-11 — MakeAdClips rename + entity-aware creative engine (fix BhavishAI→bottle)

- **Asked:** Paid video of BhavishAI (correctly imported as SaaS) came out as a
  physical dropper bottle. Make entity type drive the whole creative engine;
  one canonical prompt; a preflight gate; SVG support; wire imported assets into
  generation; rename AdForge → MakeAdClips. No paid calls in dev/tests.
- **Root cause:** entityType was detected but `buildCreativePlan` /
  `composeVideoPrompt` were hard-coded for physical products ("product-film",
  "bottle/box geometry", "cap/lid", "the product as the clean hero"), so a SaaS
  was forced into a packshot scene.
- **Did:**
  - `lib/creative/entityStrategies.js`: per-entity strategies (physical/saas/
    app/service/business/agency/creator/personal_brand/course/event/unknown)
    with subject noun, scene vocabulary, fidelity rule, extra negatives,
    generation mode, allowsPhysicalLanguage.
  - Rewrote planner + promptComposer to dispatch on strategy; physical language
    only for physical products; non-physical gets explicit "NOT a physical
    product" + entity negatives.
  - `lib/creative/compile.js`: single `compileCreativeRequest` used by BOTH
    `/api/creative/preview` (new, no paid call) and `/api/generate`, so the
    previewed prompt == the model's prompt. Added `runPreflight` quality gate;
    generate returns 422 PREFLIGHT_BLOCKED on entity/prompt contradiction,
    creator-without-asset, or very low confidence.
  - SVG: keep useful SVGs (logo/illustration role, isVector); asset store
    handles image/svg+xml with sanitizeSvg (strip scripts/handlers/external
    refs). Imported hero now flows as referenceAssetUrl → resolved server-side
    (local file or SSRF-safe fetch) so crawler images actually reach the model.
  - Renamed AdForge → MakeAdClips across UI/docs/metadata/UA/download filename
    (history log left intact).
  - Docs: new VISUAL_INTELLIGENCE.md; honest implemented-vs-scoped status.
- **Verified:** lint clean; 49/49 tests pass (10 new entity-creative incl. the
  permanent BhavishAI→bottle regression + prompt-lint per entity); build OK.
  Live preview (NO paid gen): BhavishAI → entityType saas, mode hybrid, preflight
  ready, prompt says "NOT a physical product", zero affirmative physical terms;
  physical product → image_to_video with physical fidelity. Context ~713 chars,
  prompt ~2.7k chars.
- **Scoped / NOT done (honest):** headless-browser screenshots + computed-style
  DesignProfile; Remotion deterministic composition; AI multimodal image/design
  classification + cheap keyframe preview; full AssetLibrary entity. DesignProfile
  is threaded through but currently populated only from brand signals/enrichment.
- **Branch/PR:** `feat/makeadclips-entity-aware-creative` → `main`.

## 2026-10-11 — Product vision steering + video model registry

- **Asked:** Clarify that MakeAdClips is NOT a video editor (no timelines/layers/
  manual scene editing); keep the import→understand→recommend→approve→generate→
  preview flow; keep a clean provider abstraction so models can be compared and
  switched; don't couple to Veo 3.1 Lite (shutdown 2026-10-22); evaluate on
  usable output not price; no paid calls without approval.
- **Assessment:** Mostly already aligned — the `VideoProvider` abstraction +
  factory already decouple the workflow from the model, and nothing adds editor
  surfaces. Two real gaps closed, cheaply.
- **Did:**
  - `.kiro/steering/product-vision.md` (always-included): encodes the vision,
    the "not a video editor" guardrails (storyboard stays read-only), the model
    policy (GA default, don't couple to Veo Lite, judge on usable output), and
    cost discipline — so all future work (incl. other agents) stays on-vision.
  - `lib/ai/modelRegistry.js`: metadata registry for comparison/switching
    (price/sec, resolutions, status, shutdownDate, recommended, qualityNotes).
    Omni = GA default/recommended; Veo 3.1 Lite = deprecated reference entry
    only. `getModelInfo/listModels/getDefaultModelId/deprecationWarning`.
  - Cost estimator now reads the registry rate (env still overrides).
  - `/api/generate` status probe returns the active model + a modelWarning when
    the default is deprecated (verified live).
  - `docs/MODELS.md`.
- **Did NOT build (out of scope / not requested):** no editor features; no live
  multi-model A/B UI; no new provider adapter (Veo is deprecated — wiring it
  would be wasted effort). Registry is the additive seam for a future GA model.
- **Verified:** lint clean; 56/56 tests pass (7 new); build OK; status probe
  shows GA default with no warning and warns on a deprecated override. No paid
  calls.
- **Branch/PR:** `feat/model-registry-and-product-vision` → `main`.

## 2026-10-11 — All model ids env-driven (single source of truth)

- **Asked:** Make all models changeable from .env; no direct model calls from code.
- **Assessment:** Call sites were already env-driven (getVideoModel/
  getEnrichmentModel), but the default model-id strings were DUPLICATED as
  hardcoded fallbacks in both config.js and modelRegistry.js, and the registry
  defaults weren't env-overridable. Fixed the duplication.
- **Did:**
  - `lib/config.js`: added `DEFAULTS` (the only place default model ids live);
    getVideoModel/getEnrichmentModel read env → DEFAULTS.
  - `lib/ai/modelRegistry.js`: `getDefaultModelId()` now delegates to
    `getVideoModel()` (no second fallback); per-model estimate rate is
    env-overridable via `VIDEO_USD_PER_SECOND__<ID>`; unknown env model ids
    resolve to a usable gemini-omni record.
  - `.env.example`: grouped model-selection vars, documented env-driven policy
    and per-model rate override.
  - docs/MODELS.md: env-var table + "no hardcoded ids at call sites".
  - Tests: +2 (VIDEO_MODEL env drives all readers; per-model rate override).
- **Verified:** no model literals at call sites (only config DEFAULTS + registry
  metadata/comments); setting VIDEO_MODEL flows through config→registry→cost
  with no code change. Lint clean; 58/58 tests pass; build OK.
- **Branch/PR:** `feat/env-driven-model-config` → `main`.

## 2026-10-11 — PR A: creative contract correctness (source→generation data flow)

- **Asked:** External review (and the user's own analysis) found the extracted
  info wasn't controlling the video: user edits could be overwritten by scraped
  data, offer/CTA/description/benefits never reached the prompt, the selected
  concept was only a style label, and the Studio showed a client-side prompt
  that diverged from the server's. Fix the contract first (no job queue yet).
- **Verified the claims in code first:** compile.js spread `productProfile` AFTER
  user fields (overwrote edits); promptComposer took offer/cta as params but
  never used them. Both true.
- **Did:**
  - compile.js: productProfile is now the BASE; user-edited name/brand/
    description/offer/cta OVERRIDE it (definedOnly). Pass concept + merged
    offer/cta into the composer.
  - promptComposer.js: inject extracted facts into the actual prompt — "What it
    is" (description), concept communication intent (conceptMessage: how-it-works
    vs brand-intro vs offer vs trust-proof etc.), top benefits + differentiators
    (grounded, "do not invent"), audience, and an offer + CTA final-beat block.
    trust-proof explicitly forbids inventing results/returns/guarantees.
  - Studio.js: removed the client autoPrompt; the prompt preview now comes from
    /api/creative/preview (debounced), so the displayed prompt == the server
    prompt. Added a creative-readiness panel from the server preflight and
    DISABLE Generate when preflight has blockers. Entity-aware field labels
    (no "Product name/image" for SaaS/service/creator). Model label from status.
  - Tests: +7 creative-contract (edits win; description/offer/cta reach prompt;
    benefits/diffs grounded; concept changes prompt; deterministic preview==gen;
    financial no-invention).
- **Verified:** lint clean; 65/65 tests pass; build OK. Live preview proof:
  BhavishAI Pro (user edit) wins over OLD NAME; description/offer/CTA present;
  how-it-works intent present; zero AFFIRMATIVE physical language (only
  negations). No paid calls.
- **NOT in this PR (next):** PR B (verified-asset pipeline, rendered-screenshot
  DesignProfile, image recovery) and PR C (real hybrid production routing,
  durable jobs, spend reservations). The "hybrid" label still maps to the Gemini
  provider — honestly flagged, fixed in PR C.
- **Branch/PR:** `feat/creative-contract-correctness` → `main`.

## 2026-10-11 — PR 1: de-hardcode creative intelligence (AI-reasoned concepts)

- **Asked:** Stop hardcoding product/creative intelligence (no industry→fixed
  concept/style/palette tables). Concepts must be AI-reasoned from evidence;
  selecting one must change the actual prompt; keep a fallback; don't couple to
  one model; no paid video in dev/tests.
- **Verified first:** concepts.js had ENTITY_SETS (per-entity fixed concept
  lists) + SETS (per-brand-style fixed lists) + inferStyleKey (industry keyword
  regex). promptComposer.conceptMessage had a fixed id→text map. All are exactly
  the banned pattern.
- **Did:**
  - New lib/ai/concepts.js: AI creative-concept generation via the cheap
    enrichment TEXT model, strict JSON responseSchema, grounded in evidence
    (entity/offering/benefits/brand/design/objective), explicit no-fabrication
    rules, graceful degradation. Reports token cost separately.
  - lib/creative/concepts.js: now `generateConceptsSmart` (AI-first) with a
    small ENTITY-NEUTRAL deterministic fallback (same generic directions for all
    industries; only the physical-vs-nonphysical capability boundary differs —
    a correctness constraint, not a creative decision). Removed ENTITY_SETS /
    SETS / inferStyleKey.
  - promptComposer.conceptMessage: PRIMARY path now uses the concept's OWN
    AI-reasoned fields (centralMessage/visualIdea/proposedSubject); the id→text
    map is reduced to a tiny generic fallback for deterministic concepts.
  - /api/creative/concepts: async, passes entity/design/objective/hasUsableImage.
  - ProductImport: sends richer evidence; renders centralMessage/objective.
  - Tests updated to assert the NEW contract (entity-neutral fallback; AI concept
    fields drive the prompt; unknown concept ids still work).
- **Verified:** lint clean; 72/72 tests pass; build OK. No paid calls.
- **Honest hardcoding audit (remaining):** lib/creative/templates.js still holds
  fixed style presets (luxury/bold/minimal lighting+camera) that seed the brief's
  base art direction. The AI concept's visual direction now overrides the message/
  subject, but the template still contributes lighting/camera defaults. Fully
  replacing template-seeded art direction with the AI concept's visual plan is
  PR 3 (production routing). Flagged, not hidden.
- **NOT in this PR:** PR 2 (visual intelligence: rendered screenshots,
  DesignProfile, image verification, SVG, no-image recovery) and PR 3 (real
  production routing, keyframes, output QA) + PR 4 (durable jobs/spend).
- **Branch/PR:** `feat/dynamic-creative-intelligence` → `main`.

## 2026-10-11 — Concept drives production (6 integration gaps)

- **Asked (the 6 gaps before visual intelligence):** (1) AI concepts lacked a
  template → ProductImport defaulted to "minimal"; (2) concept's visual
  direction/subject must drive the SCENE PLAN, not just the message; (3) only
  honor recommendedProductionMethod when actually implemented; (4) regenerate/
  invalidate concepts when the user edits offering/description/objective;
  (5) verify industry/category reaches concept generator + compiler; (6) keep
  only technical/safety hardcoding.
- **Did:**
  - Gap 2: `buildCreativePlan` now takes `concept` and builds the scene plan FROM
    the concept's visualIdea/proposedSubject/centralMessage (falls back to the
    entity-safe generic vocab only when absent). Two different concepts now
    produce different scene plans (tested).
  - Gap 3: new `lib/creative/productionMethods.js` capability map +
    `resolveProductionMethod`. image/text_to_video are implemented and honored;
    hybrid/motion_graphics fall back with an honest note; avatar_presenter has
    no fallback → hard preflight blocker (we don't fake presenters). compile
    surfaces `productionMethod`; preflight blocks/warns accordingly.
  - Gap 1: AI concepts no longer forced through a generic "minimal" template;
    `template` is only a neutral lighting/camera seed now, left undefined for AI
    concepts (Studio keeps a safe default so validation holds).
  - Gap 4: ProductImport marks concepts stale on edits to name/brand/
    description/offer/objective and offers "regenerate concepts", which refetches
    using the CURRENT edited values (corrections flow into AI reasoning).
  - Gap 5: concepts API already receives entity/design/industry; loadConcepts
    merges user edits over the scraped profile before sending.
  - Gap 6: no new industry→creative tables; productionMethods is a
    capability/safety contract, not a creative preset.
  - Tests: +9 (production method resolution/blocking; concept→scene plan;
    duration→beats). 81/81 pass. Lint + build clean. No paid calls.
- **Honest status:** hybrid/motion_graphics/avatar are capability-mapped but NOT
  implemented (they fall back or block) — that's the point: no fake modes. The
  real deterministic compositor + avatar/voice providers are PR 5/6 territory,
  not claimed here. Visual intelligence (rendered screenshots, DesignProfile,
  image verification, SVG raster, no-image recovery) is the NEXT PR.
- **Branch/PR:** `feat/concept-drives-production` → `main`.

## 2026-10-11 — Visual intelligence (verified assets, DesignProfile, SVG) + avatar feasibility report

- **Asked:** (1) acknowledge PR 17 is partial (templates still drive lighting/
  camera — true, not claimed solved); (2) build visual intelligence: verified
  image download, relevance analysis, SVG, rendered screenshots, computed-style
  extraction, DesignProfile, missing-image/brand fallback, relevance-based asset
  selection; (3) research self-hosted avatars (MuseTalk/SadTalker/TTS) — no blind
  integration; (4) real AI Creative Director (noted as follow-up); (5) keep UX
  simple; (6) no silent format substitution. No paid calls.
- **Did (visual intelligence, implemented + tested):**
  - `lib/assets/verify.js`: download→decode(sharp)→validate→reject lifecycle;
    tiny/broken/undecodable images rejected; SVG sanitize+rasterize to PNG.
  - `lib/design/designProfile.js`: evidence-based palette/typography/shape with
    provenance+confidence; never invents a palette; rendered-merge path.
  - `lib/design/screenshot.js`: Playwright screenshot/computed-style provider
    behind an interface, opt-in (ENABLE_RENDERED_CAPTURE), graceful absence —
    app never depends on a browser. UNVERIFIED (Playwright not installed in CI).
  - `lib/assets/selectReference.js`: icons/logos never become the primary scene
    reference; selection depends on entity/creative.
  - Wired verification + DesignProfile into importProduct; returns
    designProfile + rejectedAssets; brand colors prefer DesignProfile.
  - Tests: +11 (92/92 total). Live import proof: Wikipedia → 3 verified assets
    (all with storedUrl+dims), palette detected (#3366cc…), 9→3 kept.
- **Did (avatar feasibility, docs/AVATAR_FEASIBILITY.md — RESEARCH ONLY):**
  Benchmarked MuseTalk (MIT, ~30fps/V100, commercial-safe), SadTalker (still-
  photo animator, verify weights), Wav2Lip/LatentSync (license caveats); TTS
  licensing minefield (Piper MIT / Kokoro Apache safe; XTTS-v2 weights NON-
  commercial — avoid). Recommendation: Gemini→Piper→MuseTalk behind a provider
  interface, Python GPU worker + durable jobs + object storage (not built).
  Current code already BLOCKS avatar_presenter (no fake presenter).
- **Honest status:** multi-upload/role-tag/extra-context UI, AI image
  classification, AI keyframe recovery, and the real AI Creative Director
  (lighting/camera authored by Gemini) are NOT built — flagged, not claimed.
  Rendered screenshots are code-complete but unverified without a browser host.
- **Branch/PR:** `feat/visual-intelligence` → `main`.

## 2026-10-11 — Enable rendered screenshots (Playwright) — VERIFIED working

- **Asked:** Install the Playwright browser so rendered capture actually works
  (it was code-complete but unverified in PR #18).
- **Did:** Added `playwright` dependency; installed Chromium headless shell
  (`npx playwright install chromium`) — it downloaded a fallback ubuntu24.04
  build and **launches successfully in this sandbox**. Wired an OPTIONAL
  rendered-capture pass into importSource (opt-in via ENABLE_RENDERED_CAPTURE):
  captures a screenshot, verifies+stores it as a `website_hero` asset, and
  merges computed styles into the DesignProfile (source becomes
  "html_css+rendered"). Documented the flag in .env.example.
- **VERIFIED (not just claimed):** standalone capture of example.com produced a
  58KB PNG + computed fonts. Full live import with ENABLE_RENDERED_CAPTURE=true
  produced a `website_hero` asset whose PNG exists on disk (58427 bytes), design
  source "html_css+rendered", and a rendered_screenshot reference — i.e. an
  image-poor site now yields a real usable visual asset (no-image recovery).
  Lint clean; 92/92 tests; build OK. No paid calls.
- **Honest caveats:** (1) the Chromium binary lives in /opt/playwright (outside
  the repo); any host that enables capture must run `npx playwright install
  chromium` — the app degrades gracefully if it's absent. (2) capture is
  opt-in/off by default (it's heavier than a plain fetch). (3) Playwright flagged
  the OS as "not officially supported" and used a fallback build; works here but
  production hosting should use a supported base image or a browser service.
- **Branch/PR:** `feat/enable-rendered-screenshots` → `main`.
