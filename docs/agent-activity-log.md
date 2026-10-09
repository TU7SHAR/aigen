# Agent activity log

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
