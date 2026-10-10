# Database — MakeAdClips Studio

_Last updated: 2026-10-09_

## Status: NOT implemented

The Milestone 1 prototype has **no database**. Generated videos are returned
inline to the browser and not persisted. The in-memory guards in the route
handler (duplicate-submit, concurrency, spend) reset on every restart.

This document describes the **planned** persistence design so later milestones
can be built against it. Do not treat anything below as implemented.

## Planned stack

Supabase (PostgreSQL + Storage), with Row-Level Security scoping every row to a
workspace/tenant, and private Storage buckets served via signed URLs.

## Planned entities (sketch)

| Table | Purpose |
|---|---|
| `users` | Authenticated accounts |
| `workspaces` / `memberships` | Multi-tenant grouping + roles |
| `products` / `assets` | Product metadata + uploaded source images |
| `projects` | A saved editor state (copy, template, options) |
| `generations` | One generation attempt: prompt, model, status, cost, output ref |
| `credit_accounts` / `credit_ledger` | Prepaid credits + settlements/refunds |
| `payment_events` | Verified billing webhook events (idempotent) |
| `audit_events` | Security/ops audit trail |

### `generations` lifecycle (planned)

`draft → quoted → reserved → queued → running → succeeded | failed → settled | refunded`

Rules: reserve credits exactly once with an idempotency key before any paid
call; store the provider request id; reconcile completion after restart; never
refund on a mere timeout without checking the provider's charge state.

## Access control (planned)

- RLS policies restrict every table to the owning workspace.
- Media is stored in private buckets; downloads use short-lived signed URLs.
- No cross-tenant reads of projects, generations or assets.
