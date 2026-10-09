# Security — AdForge Studio

_Last updated: 2026-10-09_

## Current safeguards

- **Server-only secret.** `GEMINI_API_KEY` is read exclusively in server code
  (`lib/config.js`, route handler, `lib/ai/geminiProvider.js`). It is never sent
  to the client and never logged.
- **`.env.local` is gitignored.** Only `.env.example` (no secrets) is committed.
- **Input validation.** All request fields are validated server-side with Zod
  against enum/size/MIME allowlists before any provider call.
- **No arbitrary URL fetching.** Images are accepted only as base64 with an
  allowlisted MIME type and a 5 MB cap — no remote URL ingestion (avoids SSRF).
- **Paid-generation kill-switch.** Real calls require both
  `VIDEO_PROVIDER=gemini` and `ENABLE_PAID_GENERATION=true`. Default is safe.
- **Local spend guard.** `DEV_SPEND_LIMIT_USD` blocks real calls once the
  running estimate exceeds the cap (soft, in-memory).
- **Abuse guards (prototype).** Duplicate-submit guard via `clientRequestId`
  and a single-concurrent-generation limit. In-memory; reset on restart.
- **Honest errors.** No fabricated successes; provider failures surface real
  status codes.

## Known risks / not yet addressed (do NOT launch publicly without these)

- **No authentication / tenant isolation.** Anyone who can reach the server can
  call `/api/generate`.
- **No durable rate limiting or abuse prevention** — guards are in-memory and
  per-process only.
- **No durable spend cap / billing reservations** — the spend guard is an
  estimate-based local guard, not a billing control.
- **Base64 image payloads** flow through JSON request bodies; large uploads are
  size-capped but there is no virus/content scanning.
- **No data-retention / deletion workflow** (videos are returned inline, not
  stored, in this prototype).

## Prelaunch checklist (before any public/paid traffic)

- [ ] Authenticated sessions + per-tenant authorization on all endpoints.
- [ ] Durable, idempotent credit reservations + hard server-side spend caps.
- [ ] Durable rate limits and abuse monitoring.
- [ ] Private object storage with signed URLs; defined retention + deletion.
- [ ] Secrets management + audit logging; confirm provider commercial-use terms.
