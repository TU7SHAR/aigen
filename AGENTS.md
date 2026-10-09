<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

---

# AdForge Studio — instructions for coding agents

> Keep the auto-managed `nextjs-agent-rules` block above intact — `next dev`
> re-adds it; committing it with your work keeps the tree clean.

## What this project is

A Next.js 16 (App Router) + React 19 + Tailwind v4 web app that turns a product
photo into a short AI video ad using **Google Gemini Omni Flash**
(`gemini-omni-1.1-flash`) via the official `@google/genai` SDK.

> Historical planning docs may describe a standalone Node/HTTP/FFmpeg/fal.ai
> prototype. That is **superseded**. This repo is the Next.js app; use
> `fal.ai`/Kling nowhere. Video generation goes through the provider boundary in
> `lib/ai/`.

## Required reading before modifying

1. The bundled Next.js docs under `node_modules/next/dist/docs/` — this build
   (16.4.0, `cacheComponents: true`) has breaking changes. Notably, the
   `runtime` and `dynamic` route-segment configs are **disallowed** with
   `cacheComponents`.
2. `docs/ARCHITECTURE.md`, `docs/API.md`, `docs/SECURITY.md`, `docs/COSTS.md`.

## Non-negotiable constraints

- Never expose `GEMINI_API_KEY` (or any secret) to the browser or logs. It is
  server-only. Never commit `.env.local`.
- Paid generation stays **off by default**: real calls require
  `VIDEO_PROVIDER=gemini` **and** `ENABLE_PAID_GENERATION=true`.
- Do not fabricate successful generations or fake sample videos. If the model
  isn't available, return an honest, actionable error.
- Do not silently retry a billable call.
- Keep the Zod validation and the ratio/resolution/template/MIME/size
  allowlists. Do not accept remote image URLs (SSRF).
- Preserve product fidelity in prompts; don't promise perfect preservation.
- Keep video generation behind the `lib/ai` provider boundary so models are
  swappable.
- The React lint here is strict (React Compiler era): no `setState` inside an
  effect body, no impure calls (e.g. `Date.now()`) during render.

## Workflow for each change

1. Read the relevant bundled Next.js docs for anything you're unsure about.
2. Implement in the right boundary (no business logic only in the client).
3. Run `npm run lint`, `npm run build`, `npm test` (mock-only — no API cost).
4. Update the matching docs in the SAME change (README, docs/*, this file).
5. Label any paid integration as **unverified** until exercised with a real key
   in a safe, low-cost test.

## Testing note

A coded provider integration is not evidence it works with a live key. The
Gemini provider is unverified until explicitly tested with real credentials.
