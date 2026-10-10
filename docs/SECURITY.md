# Security — MakeAdClips Studio

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

## Crawler SSRF protection (product URL importer)

The `/api/products/import` and `/refresh` endpoints fetch user-supplied URLs,
so SSRF protection is enforced in `lib/crawl/safeFetch.js`:

- **http/https only** — `file://`, `ftp://`, etc. are rejected.
- **DNS-resolution-based blocking** (not just string matching): the hostname is
  resolved and every resulting address is checked. This blocks a public name
  that resolves to an internal address (e.g. `evil.com → 127.0.0.1`).
- Blocked ranges: loopback (`127.0.0.0/8`, `::1`), private (`10/8`,
  `172.16/12`, `192.168/16`), link-local + cloud metadata (`169.254/16`,
  incl. `169.254.169.254`), CGNAT (`100.64/10`), IPv6 unique-local (`fc/fd`)
  and link-local (`fe80`), multicast/reserved, and IPv4-mapped IPv6.
- **Redirects are followed manually** and every hop is re-validated against the
  same rules; redirect count is capped (≤4).
- **Response size cap** (streamed; aborts if exceeded) and **request timeout**.
- Image downloads for the asset store go through the same `safeFetch`.
- `FIRECRAWL_API_KEY` (if used) stays server-side only.

Covered by tests in `tests/crawl.test.mjs` (private/metadata IPs, non-http
schemes, localhost).

## Prelaunch checklist (before any public/paid traffic)

- [ ] Authenticated sessions + per-tenant authorization on all endpoints.
- [ ] Durable, idempotent credit reservations + hard server-side spend caps.
- [ ] Durable rate limits and abuse monitoring.
- [ ] Private object storage with signed URLs; defined retention + deletion.
- [ ] Secrets management + audit logging; confirm provider commercial-use terms.
