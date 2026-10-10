# Agent activity log

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
