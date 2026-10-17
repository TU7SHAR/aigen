/**
 * /api/jobs — durable ad production.
 *
 * POST: validate + preflight (no spend), then create (or reuse, for the same
 *       idempotency key) a background job → 202 { jobId }. Poll
 *       GET /api/jobs/{id} for truthful stage/shot progress.
 * GET:  recent jobs (newest first).
 *
 * SECURITY NOTE: there is no authentication yet (single-operator local
 * deployment). Job ids are unguessable UUIDs, but anyone who can reach this
 * server can submit paid work. Do not expose it publicly before accounts.
 */

import { NextResponse, connection } from "next/server";
import { submitJob, recoverJobs } from "@/lib/jobs/runner.js";
import { listJobs } from "@/lib/jobs/jobStore.js";

export const maxDuration = 60;

/** Verify MAC_API_TOKEN when set. Fail-open in dev (token not required) unless VIDEO_PROVIDER=gemini. */
function checkToken(request) {
  const required = process.env.MAC_API_TOKEN;
  if (!required) return null; // not configured — open (dev only)
  const sent = request.headers.get("x-mac-token") || new URL(request.url).searchParams.get("token");
  if (!sent || sent !== required) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  return null;
}

export async function POST(request) {
  const authErr = checkToken(request);
  if (authErr) return authErr;
  recoverJobs();
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { status, body: payload } = await submitJob(body);
  return NextResponse.json(payload, { status });
}

export async function GET() {
  await connection();
  recoverJobs();
  return NextResponse.json({ jobs: listJobs({ limit: 30 }) });
}
