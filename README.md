# MakeAdClips Studio — AI product video ads

Turn a single product photo into a short, on-brand video ad using Google's
**Gemini Omni Flash** (`gemini-omni-1.1-flash`). Built on **Next.js 16 (App
Router)**, **React 19**, **Tailwind CSS v4**.

> **Status: working prototype (Milestone 1).** The end-to-end flow — upload a
> product photo, pick a style, generate, play, download — works today. By
> default it runs in a **free mock mode** (no API calls, no cost). Real Gemini
> generation is fully implemented but **off by default** and, until you run it
> once with a live key, should be treated as **unverified**.

## Quick start

Requires **Node.js 22+**.

```bash
npm install
npm run dev          # http://localhost:3000
```

Open `/` for the landing page and `/studio` for the generator.

Other commands:

```bash
npm run build        # production build
npm start            # run the production build
npm run lint         # eslint
npm test             # unit tests (mock only — no API cost)
```

## Environment variables

Copy `.env.example` to `.env.local` and fill in values. **`.env.local` is
gitignored — never commit it, and never expose `GEMINI_API_KEY` to the browser.**

| Variable | Default | Purpose |
|---|---|---|
| `VIDEO_PROVIDER` | `mock` | `mock` (free placeholder) or `gemini` (real) |
| `GEMINI_API_KEY` | — | Your Gemini API key. Required only for `gemini` |
| `VIDEO_MODEL` | `gemini-omni-1.1-flash` | Video model id |
| `ENABLE_PAID_GENERATION` | `false` | Kill-switch; must be `true` for real calls |
| `DEV_SPEND_LIMIT_USD` | `5` | Local estimate-based spend guard |
| `VIDEO_USD_PER_SECOND` | `0.10` | Placeholder rate for estimates **only** |

### Enabling real generation

1. Put your key in `.env.local`:
   ```
   VIDEO_PROVIDER=gemini
   GEMINI_API_KEY=your_key_here
   ENABLE_PAID_GENERATION=true
   ```
2. Confirm the `gemini-omni-1.1-flash` model is enabled for your API tier in
   [Google AI Studio](https://aistudio.google.com/).
3. Confirm real pricing in AI Studio billing — the cost figures shown in the UI
   are **estimates**, not billed amounts.

If the model isn't accessible with your key/tier, the API returns a clear,
actionable error instead of pretending generation succeeded.

## What works right now

- [x] Landing page + responsive AI video studio (mobile/tablet/desktop,
      verified 320–1440px, no horizontal overflow).
- [x] Light / Dark / System theme (via `next-themes`) with a toggle in the
      shared header; preference persists in `localStorage`, no theme flash.
- [x] Drag-and-drop product image upload (PNG/JPEG/WEBP, max 5 MB) with preview.
- [x] Product name, brand, description, offer, CTA fields.
- [x] Five ad templates: Luxury, Bold, Minimal, Product Demo, Problem→Solution.
- [x] Aspect ratios 9:16 / 16:9; resolutions 360p/720p/1080p; 3–10 s duration.
- [x] Auto-generated, editable prompt preview with product-fidelity guardrails.
- [x] Secure server-side `/api/generate` route (key never reaches the browser).
- [x] Zod validation, paid-gen kill-switch, dev spend guard, duplicate-submit
      and single-concurrent-generation guards.
- [x] HTML5 playback + MP4 download.
- [x] Real Gemini Omni Flash integration (image-to-video + text-to-video).
- [x] Mock provider + unit tests (no API cost).
- [ ] Real generation **verified** against a live key (needs your credentials).
- [ ] Branded overlays / exact logo + CTA compositing (Remotion — next milestone).
- [ ] Persistence: saved projects, history (Supabase — planned).
- [ ] Auth, credits, billing, durable job queue (planned).

## Repo map

```
app/
  page.js              # landing page
  studio/page.js       # studio page shell
  api/generate/route.js# secure generation + status endpoint
components/studio/
  Studio.js            # the studio UI (client component)
lib/
  config.js            # env-driven config + allowlists
  validation.js        # Zod request schema
  ai/                  # provider boundary: index, provider contract, gemini, mock
  prompts/adPrompt.js  # ad prompt builder
  costs/estimate.js    # cost estimation + spend guard
tests/unit.test.mjs    # mock-based unit tests
docs/                  # API, ARCHITECTURE, SECURITY, COSTS, ROADMAP, TESTING, DATABASE
.env.example           # configuration reference
```

See [`docs/`](docs/) for architecture, API, security, costs, roadmap and testing.

## Design philosophy

Target buyer: small ecommerce operators (beauty/skincare first). Compete on
**usable ads per paid dollar**, product fidelity, and fast time-to-first-export
— not model count. Keep paid generation safe-by-default until auth, durable
jobs and billing exist.
