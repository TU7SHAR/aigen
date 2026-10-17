/**
 * POST /api/jobs/{id}/cancel — stop work that has not been sent to a
 * provider. Clips already being generated may still finish and be billed;
 * the response says so rather than promising a refund.
 */

import { NextResponse } from "next/server";
import { cancelJob } from "@/lib/jobs/runner.js";
import { isValidJobId } from "@/lib/jobs/jobStore.js";

export async function POST(_request, { params }) {
  const { id } = await params;
  if (!isValidJobId(id)) return NextResponse.json({ error: "Invalid job id." }, { status: 400 });
  const { status, body } = cancelJob(id);
  return NextResponse.json(body, { status });
}
