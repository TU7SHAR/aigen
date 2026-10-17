/** GET /api/jobs/{id} — client-safe job status, stages, shots and result. */

import { NextResponse, connection } from "next/server";
import { getJob, publicSummary, isValidJobId } from "@/lib/jobs/jobStore.js";
import { recoverJobs } from "@/lib/jobs/runner.js";

export async function GET(_request, { params }) {
  await connection();
  const { id } = await params;
  if (!isValidJobId(id)) return NextResponse.json({ error: "Invalid job id." }, { status: 400 });
  recoverJobs();
  const job = getJob(id);
  if (!job) return NextResponse.json({ error: "Job not found." }, { status: 404 });
  return NextResponse.json({ job: publicSummary(job), record: job.record || null });
}
