# MakeAdClips — Work State

**Branch:** `feat/production-quality-languages`  
**Base:** `020b8c9` (main after merging feat/finished-ad-engine / PR #35)  
**Commits:**
- `65c0fa6` feat(engine): model auto-switching, durable jobs/spend, multilingual pipeline
- `c687823` feat(studio): guided job-based Studio, video language picker, import focus
- `44445fd` fix(dev,import): pin Turbopack root, focus-aware concepts, near-duplicate images
- `5a2e3e1` fix(creative): bounded/hedged model calls, plan structure guard, Hinglish caption + alternation checks
- `62cc917` fix(render,veo): frame-exact assembly, shot-coverage check, Veo Lite prompt
- `a609200` feat(studio): add New Video button and startNew flow

**Not yet pushed** (as of last update).

## Consolidated Checklist

### Core engine
- [x] Model registry refresh (verified 2026-10-17: Veo 3.x, Nano Banana 2.1, 3.5-flash-lite, TTS 3.8)
- [x] Auto-switching router (`lib/ai/router.js`) — switches only on unbilled failures
- [x] Durable quota tracker — RPM/RPD with Pacific-midnight reset
- [x] Durable spend ledger — daily ($10) and monthly ($60) caps, atomic across processes
- [x] Parallel shot generation (SHOT_CONCURRENCY=3), concurrent audio
- [x] 1080p default; lanczos scaling + unsharp on upscale; fit-over-blur on ratio mismatch
- [x] storyboard transitions, native 24fps, 9:16 safe areas, voiceover compressor, -14 LUFS, minimum caption read time

### Durable jobs
- [x] Submit with idempotency key, lease, heartbeat
- [x] Cancel, recovery on server restart, Veo operation resume
- [x] Production record (shots, timings, usage, model attempts)
- [x] MP4 served from disk with Range support
- [x] Worker script (`scripts/worker.mjs`) for out-of-process execution

### Language pipeline
- [x] 84-language catalogue with 14 mixed presets
- [x] Language profile schema (Zod) — mode, primary, secondary, caption script
- [x] TTS routing filtered by Google's supported listing
- [x] Mixed-language caption check + retry (English-only captions over Hinglish flagged)
- [x] Sentence-by-sentence alternation detection and retry
- [x] 38 Noto fonts + OFL.txt; glyph coverage via cmap
- [x] Verified scripts: Devanagari, Gurmukhi, Tamil, Arabic RTL, Bengali
- [ ] CJK fonts — not bundled (bundle size); documented as limitation
- [ ] Urdu/Ukrainian voice — not in Google TTS listing; captions-only fallback

### Import and focus
- [x] Blocked-page detection in crawl (HTTP 403/Access Denied → honest error)
- [x] Texture/background asset classification (`texture_background` tag)
- [x] dHash perceptual dedup (same photo at two sizes → keep higher-res)
- [x] Campaign focus via vision model (asks one question when ambiguous)
- [x] Focus title as the advertised product/brand name (not raw page title)

### Studio UX
- [x] Guided flow: Source → Direction & Language → Review & Create → Production → Result
- [x] Language picker (LanguagePicker.js) with search, mixed presets, capability hints
- [x] Plan review: brief, shots, validation, estimate with worst-case
- [x] Job tracker (JobTracker.js) with real-time progress
- [x] Result panel: checks (technical/factual/language/creative), shot provenance, download
- [x] Recent jobs (RecentJobs.js)
- [x] New Video button (startNew clears state, keeps language/format prefs)
- [x] localStorage persistence via useSyncExternalStore

### Validation
- [x] Empty template/ratio → coerced to default (no 422)
- [x] Explicit invalid value → field error (was silently coerced before)

### Testing
- [x] 230/230 passing (last full run)
- [x] New: production-routing, languages, provider-router, model-registry, validation regression
- [ ] Alternation detection regression — added to languages.test.mjs, not re-run on HEAD
- [ ] Playwright E2E browser tests
- [ ] Automated accessibility tests

### Docs
- [x] docs/README.md (index)
- [x] docs/bugs/REGISTER.md
- [x] docs/agents/WORK_STATE.md (this file)
- [ ] docs/architecture/ROUTING.md, JOBS.md, LANGUAGES.md
- [ ] docs/operations/CONFIGURATION.md
- [ ] docs/security/SECURITY.md (move/merge from root docs/SECURITY.md)
- [ ] README.md / AGENTS.md update

### Code Review Sage
- [ ] Sage pass on branch diff

### Push / PR
- [ ] `git push -u origin feat/production-quality-languages`
- [ ] `gh pr create`

### Supabase (blocked)
- [ ] Auth, DB, storage, RLS, migrations — **blocked: no credentials, CLI/Docker install needs approval**
- [ ] Analytics events, saved projects, media retention pages
- Interfaces (jobStore, ledger, quota) shaped for Supabase replacement

### Not in scope / documented limitations
- Playwright E2E + a11y automation — not done
- CJK captions — fonts not bundled
- Lip sync / dialogue — not offered
- Language model support (Urdu, Ukrainian voice) — Google TTS gap
- Supabase/auth/analytics/accounts — blocked

## Spend Log

| Date | Description | Estimate | Actual |
|------|-------------|----------|--------|
| 2026-10-17 | H&M Hinglish 12s (Veo 3 Fast) | $0.74 | check AI Studio |
| 2026-10-17 | Blue Bottle French 12s | ~$0.74 | check AI Studio |
| 2026-10-17 | Text/vision calls (enrichment, director, focus) | ~$0.14 | check AI Studio |
| | **Total** | **~$1.62** | |
