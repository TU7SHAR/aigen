# Roadmap — MakeAdClips Studio

_Last updated: 2026-10-09_

## Milestone 1 — Photo → AI video (DONE in this PR)

- [x] Next.js studio UI: upload, fields, templates, ratio/resolution/duration.
- [x] Secure `/api/generate` route with Zod validation + safety guards.
- [x] Provider boundary: mock (default) + real Gemini Omni Flash.
- [x] Cost estimate + dev spend guard; paid-gen kill-switch (off by default).
- [x] Playback + MP4 download; mock-based unit tests.
- [ ] **Verify** real generation once with a live key (requires credentials).

## Milestone 2 — Product URL importer + creative pipeline (DONE in this PR)

- [x] Product URL import: SSRF-safe crawl, structured-first extraction,
      content cleaning, image discovery/ranking/dedupe, brand-signal extraction.
- [x] ProductProfile + BrandProfile with per-field provenance + warnings.
- [x] AssetStore abstraction (local prototype store; Supabase stub).
- [x] Crawl provider abstraction (DirectFetch default; Firecrawl opt-in).
- [x] Review UX (edit fields, choose hero, remove images, brand review, concepts).
- [x] Brand-aware creative pipeline: source-image classification (fixes
      poster→phone), CreativeBrief → ScenePlan → professional prompt + negatives.
- [x] Brand-adaptive concepts; brand influence low/balanced/strong.
- [ ] Firecrawl path **verified** with a live key (opt-in, currently unverified).

## Milestone 3 — Branded, exportable ads

- [ ] Remotion compositing: exact logo, price, CTA and captions over the AI
      footage (the prompt already reserves negative space for this).
- [ ] Multiple hooks / variants from one product in a batch.
- [ ] First/last-frame interpolation and video extension (Omni features).
- [ ] Product fidelity: segmentation / masks / first-frame compositing (experimental).
- [ ] Optional Gemini enrichment (benefits/angles/tone, vision classification).

## Milestone 3 — Persistence & accounts

- [ ] Supabase Postgres + Storage; saved projects and generation history.
- [ ] Auth + per-tenant isolation (RLS, signed media URLs).

## Milestone 4 — Commerce & durability

- [ ] Credit wallet: quote → reserve (idempotent) → settle/refund.
- [ ] Durable job queue + worker service (generation off the request path).
- [ ] Durable rate limits, abuse monitoring, observability, data retention.
- [ ] Payment provider + signed webhooks.

## Launch gate

Do not take payments or drive public/paid traffic until auth, durable jobs,
billing/webhooks, spend caps, content rights and monitoring are complete.
Validate real paying customers on the MVP before model-marketplace features.
