#!/usr/bin/env node
/**
 * Job worker — runs queued/orphaned production jobs outside the web process.
 *
 *   JOB_EXECUTION=worker  (in the web server's env, so POST /api/jobs only enqueues)
 *   node scripts/worker.mjs
 *
 * Uses the same job store, leases and engine as inline execution, so it is
 * safe to run alongside the web server: a job is claimed atomically, a dead
 * worker's lease expires and another worker resumes it (finished media comes
 * from the media cache; accepted provider operations are polled, not re-sent).
 * Loads .env.local / .env.development / .env the way `next dev` does.
 */

import fs from "node:fs";
import path from "node:path";

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}
const env = process.env.NODE_ENV === "production" ? "production" : "development";
for (const f of [`.env.${env}.local`, ".env.local", `.env.${env}`, ".env"]) loadEnvFile(path.join(process.cwd(), f));
process.env.JOB_EXECUTION = "inline"; // this process executes

const { recoverableJobIds } = await import("../lib/jobs/jobStore.js");
const { runJob } = await import("../lib/jobs/runner.js");

const POLL_MS = Number(process.env.WORKER_POLL_MS || 3000);
let stopping = false;
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });

console.log(`[worker] polling for jobs every ${POLL_MS}ms (pid ${process.pid})`);
while (!stopping) {
  const ids = recoverableJobIds();
  for (const id of ids) {
    if (stopping) break;
    const job = await runJob(id);
    if (job) console.log(`[worker] job ${id} → ${job.status}`);
  }
  await new Promise((r) => setTimeout(r, POLL_MS));
}
console.log("[worker] stopped (in-flight work was finished or left for lease recovery)");
