/**
 * Job runner — durable background production for the Studio.
 *
 *   submitJob(body)  validate + preflight (no spend) → create/reuse the job
 *                    (idempotency key) → schedule it → 202 { jobId }
 *   runJob(id)       claim the lease, run the engine with live progress,
 *                    heartbeat + cancel checks, write the export and the
 *                    production record, settle the final state
 *   recoverJobs()    after a restart: re-claim queued jobs and jobs whose
 *                    worker died; finished media comes from the media cache
 *                    and accepted provider operations are POLLED, not re-sent
 *
 * Execution model: inline in the web process by default (JOB_EXECUTION=inline,
 * right for `next dev` / `next start` on a long-running server). Set
 * JOB_EXECUTION=worker and run `node scripts/worker.mjs` to execute jobs in a
 * separate process (required on serverless hosts).
 */

import fs from "node:fs";
import crypto from "node:crypto";
import { prepareGeneration, produceGeneration, composedSummary, buildDryRunPlan } from "../api/generateCore.js";
import {
  createJob, getJob, updateJob, addEvent, claimJob, heartbeat, recoverableJobIds, publicSummary,
  requestForExecution, jobMediaDir, jobOutputPath, TERMINAL,
} from "./jobStore.js";
import { isDryRun, isPaidGenerationHardDisabled } from "../config.js";
import { runMediaChecks } from "../quality/mediaChecks.js";
import { createJobBudget } from "../costs/jobBudget.js";

const OWNER = `${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
const running = new Set();
const executionMode = () => (process.env.JOB_EXECUTION === "worker" ? "worker" : "inline");

/** Canonical idempotency key: the client's request id, else a hash of the request. */
function idempotencyKeyFor(body) {
  if (body?.clientRequestId) return `client:${String(body.clientRequestId).slice(0, 100)}`;
  const { clientRequestId, ...rest } = body || {};
  void clientRequestId;
  const bucket = Math.floor(Date.now() / 120_000); // identical request within ~2 min = same job
  return `hash:${crypto.createHash("sha256").update(JSON.stringify(rest)).digest("hex").slice(0, 32)}:${bucket}`;
}

/**
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function submitJob(body) {
  const prepared = await prepareGeneration(body);
  if (!prepared.ok) return { status: prepared.status, body: prepared.body };
  const { compiled, format, deterministic, est, input, creativePayload } = prepared;
  if (!deterministic && (isPaidGenerationHardDisabled() || isDryRun())) {
    return { status: 200, body: { ok: true, dryRun: true, format, plan: buildDryRunPlan(input, compiled, est, format), creative: creativePayload } };
  }
  if (!compiled.preflight.readyForPaidGeneration) {
    return { status: 422, body: { error: "Creative preflight failed — nothing was generated or charged.", code: "PREFLIGHT_BLOCKED", preflight: compiled.preflight } };
  }
  const { job, created } = createJob({
    body,
    idempotencyKey: idempotencyKeyFor(body),
    summary: {
      productName: input.productName, brand: input.brand, format, aspectRatio: input.aspectRatio,
      resolution: input.resolution, durationSeconds: input.durationSeconds,
      language: creativePayload.language?.label || null, shots: compiled.scenePlan?.scenes?.length || 0,
      destination: prepared.destination?.display || null,
    },
  });
  if (created) {
    updateJob(job.id, (j) => {
      j.shots = (compiled.scenePlan?.scenes || []).map((s, i) => ({
        shot: i + 1, intent: s.intent || s.purpose, technique: s.technique || null, status: "pending", message: "", model: null,
      }));
      j.record = productionRecordSeed(input, compiled, creativePayload);
    });
    if (executionMode() === "inline") schedule(job.id);
  }
  return { status: created ? 202 : 200, body: { ok: true, jobId: job.id, status: getJob(job.id).status, reused: !created } };
}

/** Run a job soon, in this process (no duplicate runs per process). */
export function schedule(id) {
  if (running.has(id)) return;
  running.add(id);
  setImmediate(() => {
    runJob(id).catch(() => {}).finally(() => running.delete(id));
  });
}

/** Request cancellation (undispatched work stops; dispatched calls may still bill). */
export function cancelJob(id) {
  const job = getJob(id);
  if (!job) return { status: 404, body: { error: "Job not found." } };
  if (TERMINAL.has(job.status)) return { status: 409, body: { error: `Job already ${job.status}.` } };
  updateJob(id, (j) => {
    j.cancelRequested = true;
    j.events.push({ at: new Date().toISOString(), message: "Cancel requested — stopping work that has not been sent to a provider. Clips already being generated may still finish and be billed." });
  });
  return { status: 202, body: { ok: true, status: "cancel_requested" } };
}

/** Re-claim jobs left queued or orphaned by a crashed/restarted process. */
let recovered = false;
export function recoverJobs({ force = false } = {}) {
  if (recovered && !force) return [];
  recovered = true;
  const ids = recoverableJobIds();
  if (executionMode() === "inline") {
    for (const id of ids) {
      // A job whose body was not written before the crash cannot be re-run.
      const job = getJob(id);
      if (!job?.body) {
        updateJob(id, (j) => {
          j.status = "failed";
          j.error = { code: "RECOVERY_FAILED", message: "Job body missing — job was created but not fully written before the server restarted. Resubmit.", details: null, uncertainSpend: false };
          j.events.push({ at: new Date().toISOString(), message: "Recovery failed: job body missing. Resubmit." });
        });
        continue;
      }
      schedule(id);
    }
  }
  return ids;
}

function productionRecordSeed(input, compiled, creativePayload) {
  const pp = input.productProfile || {};
  const sb = input.storyboard || {};
  return {
    schema: "makeadclips.production-record/v1",
    input: {
      sourceUrl: pp.canonicalUrl || pp.sourceUrl || null,
      uploadedImage: Boolean(input.image),
      focus: input.focus || null,
      selectedAssets: (input.referenceAssets || []).map((a) => ({ url: a.url, role: a.role || null, primary: Boolean(a.primary) })),
    },
    evidence: {
      name: input.productName, brand: input.brand || null, description: input.description || null,
      offer: input.offer || null, cta: input.cta || null, price: pp.price || null, currency: pp.currency || null,
      provenance: pp.fieldSources || pp.provenance || null,
    },
    creative: {
      concept: input.concept ? { title: input.concept.title, centralMessage: input.concept.centralMessage } : null,
      brief: sb.brief || null, logline: sb.logline || null, directorModel: sb.directorModel || null,
      shots: (compiled.scenePlan?.scenes || []).map((s, i) => ({
        shot: i + 1, intent: s.intent, purpose: s.shotPurpose || "", technique: s.technique, durationSec: s.duration,
        visual: s.visual, caption: s.onScreenText || "", voiceover: s.voiceover || "", evidence: s.evidence || "", transition: s.transitionOut || null,
      })),
    },
    language: creativePayload.language || null,
    destination: creativePayload.destination || null,
    validation: { preflight: compiled.preflight, plan: sb.validation || null, media: null },
    media: null,
    usage: null,
    artifacts: null,
  };
}

/** Execute one job end to end. */
export async function runJob(id) {
  let job = claimJob(id, OWNER);
  if (!job) return null;
  const controller = new AbortController();
  const hb = setInterval(() => {
    try {
      const latest = heartbeat(id, OWNER);
      if (latest?.cancelRequested && !controller.signal.aborted) controller.abort();
    } catch { /* keep working; the lease will be retried */ }
  }, 3000);

  const progress = (p) => {
    try {
      updateJob(id, (j) => {
        const stage = p.stage || j.stage;
        j.stage = stage;
        if (j.stages[stage]) j.stages[stage] = { ...j.stages[stage], status: p.status === "done" ? "done" : "running", message: p.message || j.stages[stage].message };
        if (p.shot) {
          const sh = j.shots.find((x) => x.shot === p.shot) || (j.shots[p.shot - 1] = { shot: p.shot });
          if (p.status) sh.status = p.status;
          if (p.message) sh.message = p.message;
          if (p.model) sh.model = p.model;
        }
        if (p.message) j.events.push({ at: new Date().toISOString(), message: p.shot ? `Shot ${p.shot}: ${p.message}` : p.message });
      });
    } catch { /* progress must never break production */ }
  };

  try {
    const body = requestForExecution(job);
    const prepared = await prepareGeneration(body);
    if (!prepared.ok) throw Object.assign(new Error(prepared.body?.error || "Validation failed."), { code: "VALIDATION", details: prepared.body?.details });
    if (!prepared.compiled.preflight.readyForPaidGeneration) throw Object.assign(new Error("Preflight blocked."), { code: "PREFLIGHT_BLOCKED" });

    // Resume: accepted provider operations recorded by an earlier run.
    const resume = {};
    for (const sh of job.shots || []) if (sh.operation?.name && sh.status !== "done") resume[sh.shot - 1] = { operationName: sh.operation.name, model: sh.operation.model };
    if (Object.keys(resume).length) addEvent(id, `Resuming ${Object.keys(resume).length} accepted provider operation(s) instead of re-generating.`);

    const budget = createJobBudget({ jobId: id });
    const out = await produceGeneration(prepared, {
      jobId: id, budget, mediaDir: jobMediaDir(id), progress, resume, signal: controller.signal,
      onOperation: (shotIndex, name, meta) => {
        updateJob(id, (j) => {
          const sh = j.shots[shotIndex] || (j.shots[shotIndex] = { shot: shotIndex + 1 });
          sh.operation = { name, model: meta?.model || null, at: new Date().toISOString() };
        });
      },
    });
    if (out.kind !== "composed") throw new Error("Only storyboard (screen_demo / cinematic_card) formats run as jobs.");
    const composed = out.composed;
    fs.writeFileSync(jobOutputPath(id), composed.buffer);

    progress({ stage: "checks", status: "running", message: "checking the exported video" });
    const checks = await runMediaChecks({ file: jobOutputPath(id), composed, input: prepared.input, compiled: prepared.compiled }).catch((err) => ({
      technical: { status: "error", findings: [{ level: "warning", code: "CHECKS_FAILED", message: String(err?.message || err) }] },
    }));
    progress({ stage: "checks", status: "done", message: "checks complete" });

    const requested = composed.quality.requestedVideoShots || 0;
    const partial = requested > (composed.quality.aiVideoShots || 0);
    const canceled = controller.signal.aborted;
    updateJob(id, (j) => {
      j.status = canceled ? "canceled" : partial ? "partial" : "completed";
      j.stage = "done";
      for (const k of Object.keys(j.stages)) if (j.stages[k].status !== "done") j.stages[k].status = "done";
      j.result = {
        video: jobOutputPath(id),
        durationSec: composed.durationSec, width: composed.width, height: composed.height, fps: composed.fps,
        render: composedSummary(composed), checks,
        partial, partialReason: partial ? `${requested - composed.quality.aiVideoShots} of ${requested} requested AI-video shots were not generated.` : null,
      };
      j.record = {
        ...(j.record || {}),
        media: composed.shotReport.map((s) => ({
          shot: s.shot, executed: s.executedMethod, source: s.visualSource, model: s.videoModel || s.keyframeModel || null,
          attempts: s.modelAttempts, fromCache: s.fromCache, firstFrame: s.firstFrame, notes: s.productionNotes,
        })),
        audio: composed.quality.audioDetail,
        usage: { ...composed.budget, basis: "local estimates and worst-case reservations from published prices — not an invoice" },
        validation: { ...(j.record?.validation || {}), media: checks },
        artifacts: { final: "final.mp4", media: safeList(jobMediaDir(id)) },
        timings: composed.timings,
      };
      j.lease = null;
      j.events.push({ at: new Date().toISOString(), message: canceled ? "Canceled after media that was already generated." : partial ? "Finished with missing shots (partial result)." : "Finished." });
    });
  } catch (err) {
    const canceled = controller.signal.aborted;
    updateJob(id, (j) => {
      j.status = canceled ? "canceled" : "failed";
      j.stage = "done";
      j.lease = null;
      j.error = {
        code: err?.code || err?.category || "PRODUCTION_FAILED",
        message: String(err?.message || err).slice(0, 400),
        details: err?.details || null,
        uncertainSpend: Boolean(err?.uncertain),
      };
      j.events.push({ at: new Date().toISOString(), message: canceled ? "Canceled." : `Failed: ${String(err?.message || err).slice(0, 200)}` });
    });
  } finally {
    clearInterval(hb);
  }
  return getJob(id);
}

function safeList(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

export { publicSummary };
