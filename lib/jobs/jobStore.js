/**
 * Durable job store (local file backend).
 *
 * Layout under the data dir:
 *   jobs/index.json          idempotencyKey → jobId
 *   jobs/<id>/job.json       the job record (state, stages, shots, events,
 *                            production record, result)
 *   jobs/<id>/input-image.*  an uploaded reference image (kept out of JSON)
 *   jobs/<id>/media/         raw generated media (clips, keyframes, audio)
 *   jobs/<id>/final.mp4      the export
 *
 * State machine: queued → running → completed | partial | failed | canceled
 * (running → queued again only through lease-expiry recovery). The interface
 * (createJob/getJob/updateJob/listJobs/claimJob) is deliberately small so a
 * Postgres/Supabase implementation can replace this file.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { dataPath, getDataDir, readJsonSync, updateJsonSync, writeJsonAtomicSync } from "../store/fileStore.js";

export const TERMINAL = new Set(["completed", "partial", "failed", "canceled"]);
const ID_RE = /^[a-f0-9-]{36}$/;

export const isValidJobId = (id) => typeof id === "string" && ID_RE.test(id);
export const jobDir = (id) => {
  if (!isValidJobId(id)) throw new Error("Invalid job id.");
  return path.join(getDataDir(), "jobs", id);
};
const jobFile = (id) => path.join(jobDir(id), "job.json");
const indexFile = () => dataPath("jobs", "index.json");
export const jobMediaDir = (id) => path.join(jobDir(id), "media");
export const jobOutputPath = (id) => path.join(jobDir(id), "final.mp4");

/** Strip binary payloads from a request snapshot (image bytes go to a file). */
function snapshotRequest(id, body) {
  const snap = structuredClone(body || {});
  if (snap.image?.data) {
    const ext = snap.image.mimeType === "image/png" ? "png" : snap.image.mimeType === "image/webp" ? "webp" : "jpg";
    const file = path.join(jobDir(id), `input-image.${ext}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(snap.image.data, "base64"));
    snap.image = { file: path.basename(file), mimeType: snap.image.mimeType };
  }
  delete snap.promptOverride;
  return snap;
}

/** Rebuild the request body for execution (reads the stored image back). */
export function requestForExecution(job) {
  const body = structuredClone(job.request || {});
  if (body.image?.file) {
    const file = path.join(jobDir(job.id), path.basename(body.image.file));
    body.image = fs.existsSync(file) ? { data: fs.readFileSync(file).toString("base64"), mimeType: body.image.mimeType } : undefined;
  }
  return body;
}

/**
 * Create a job, or return the existing one for the same idempotency key
 * (double clicks, retries and second tabs never create a second paid job).
 * @returns {{ job: object, created: boolean }}
 */
export function createJob({ body, idempotencyKey, summary = {} }) {
  let existing = null;
  let job = null;
  updateJsonSync(indexFile(), { version: 1, keys: {} }, (idx) => {
    const prior = idempotencyKey ? idx.keys[idempotencyKey] : null;
    if (prior && fs.existsSync(jobFile(prior))) {
      existing = prior;
      return;
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    job = {
      id, version: 1, status: "queued", createdAt: now, updatedAt: now, idempotencyKey: idempotencyKey || null,
      summary, request: snapshotRequest(id, body), stage: "queued",
      stages: {
        plan: { status: "done" }, media: { status: "pending" }, audio: { status: "pending" },
        render: { status: "pending" }, checks: { status: "pending" },
      },
      shots: [], events: [{ at: now, message: "Job queued" }], cancelRequested: false, lease: null,
      runs: 0, result: null, error: null, record: null,
    };
    writeJsonAtomicSync(jobFile(id), job);
    if (idempotencyKey) idx.keys[idempotencyKey] = id;
  });
  if (existing) return { job: getJob(existing), created: false };
  return { job, created: true };
}

export function getJob(id) {
  if (!isValidJobId(id)) return null;
  const file = jobFile(id);
  if (!fs.existsSync(file)) return null;
  return readJsonSync(file, null);
}

/** Locked read-modify-write of one job. `mutate(job)` edits in place. */
export function updateJob(id, mutate) {
  return updateJsonSync(jobFile(id), null, (job) => {
    if (!job) throw new Error(`Job ${id} not found.`);
    mutate(job);
    job.version = (job.version || 0) + 1;
    job.updatedAt = new Date().toISOString();
    if (job.events?.length > 250) job.events = job.events.slice(-250);
    return job;
  });
}

/** Append a progress event (and optionally set fields) atomically. */
export function addEvent(id, message, patch = null) {
  return updateJob(id, (job) => {
    job.events.push({ at: new Date().toISOString(), message: String(message).slice(0, 300) });
    if (patch) patch(job);
  });
}

/**
 * Claim a job for execution (atomic lease). Returns the job when this
 * process now owns it, or null when it is terminal/owned by someone else.
 */
export function claimJob(id, owner, leaseMs = 60_000) {
  let claimed = null;
  updateJob(id, (job) => {
    const now = Date.now();
    const leaseFree = !job.lease || Date.parse(job.lease.until) < now || job.lease.owner === owner;
    if (TERMINAL.has(job.status) || !leaseFree) return;
    if (job.status !== "queued" && job.status !== "running" && job.status !== "interrupted") return;
    if (job.status === "running" && job.lease && job.lease.owner !== owner) {
      job.events.push({ at: new Date().toISOString(), message: "Previous worker stopped responding — resuming (finished media is reused; in-flight provider operations are polled, not re-sent)." });
    }
    job.status = "running";
    job.lease = { owner, until: new Date(now + leaseMs).toISOString() };
    job.runs = (job.runs || 0) + 1;
    claimed = job;
  });
  return claimed ? getJob(id) : null;
}

/** Extend the lease while working; returns the latest job (for cancel checks). */
export function heartbeat(id, owner, leaseMs = 60_000) {
  let latest = null;
  updateJob(id, (job) => {
    if (job.lease?.owner === owner) job.lease.until = new Date(Date.now() + leaseMs).toISOString();
    latest = job;
  });
  return latest;
}

/** Recent jobs, newest first (summaries only). */
export function listJobs({ limit = 30 } = {}) {
  const root = path.join(getDataDir(), "jobs");
  if (!fs.existsSync(root)) return [];
  const ids = fs.readdirSync(root).filter(isValidJobId);
  const jobs = [];
  for (const id of ids) {
    const j = getJob(id);
    if (j) jobs.push(j);
  }
  jobs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return jobs.slice(0, limit).map(publicSummary);
}

/** Jobs a recovery pass should pick up (queued, or running with a dead lease). */
export function recoverableJobIds(now = Date.now()) {
  const root = path.join(getDataDir(), "jobs");
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter(isValidJobId).filter((id) => {
    const j = getJob(id);
    if (!j) return false;
    if (j.status === "queued" || j.status === "interrupted") return true;
    return j.status === "running" && (!j.lease || Date.parse(j.lease.until) < now);
  });
}

/** The client-safe view of a job (no local paths, no raw request body). */
export function publicSummary(job) {
  if (!job) return null;
  return {
    id: job.id, status: job.status, stage: job.stage, createdAt: job.createdAt, updatedAt: job.updatedAt,
    summary: job.summary || {}, stages: job.stages, shots: job.shots,
    events: (job.events || []).slice(-40), cancelRequested: Boolean(job.cancelRequested),
    error: job.error, hasVideo: Boolean(job.result?.video), result: job.result ? { ...job.result, video: undefined } : null,
  };
}
