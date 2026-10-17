/**
 * Auto-switching model router.
 *
 * Runs one logical generation (a shot clip, a keyframe, a voiceover, a music
 * bed, a text completion) against an ordered model CHAIN and switches to the
 * next model when the current one cannot serve it:
 *
 *   - skipped before sending: shut down, cannot produce the shot (capability),
 *     locally known to be exhausted (RPD) or would exceed the job budget;
 *   - after a refusal the provider did NOT bill: rate limit (429), model not
 *     available (404/403), overload (503), request shape not supported (400),
 *     or a safety block (after one rephrased attempt on the same model).
 *
 * It NEVER switches when the outcome is uncertain (a long-running request
 * that timed out may still finish and be billed) or when the API key is
 * rejected — those stop the chain and are reported with the operation id so
 * the work can be resumed instead of paid for twice.
 *
 * Every attempt (model, outcome, reason, billing certainty, timing) is
 * returned so provenance and the job record show exactly what ran and why.
 */

import { getModelInfo, isPastShutdown } from "./modelRegistry.js";
import { acquireModel, checkModel, reportRateLimited, reportUnavailable } from "./quota.js";
import { classifyProviderError, describeCategory } from "./errors.js";

export class RoutingError extends Error {
  constructor(message, { attempts = [], category = "provider_error", uncertain = false, operationName = null, fatal = false } = {}) {
    super(message);
    this.name = "RoutingError";
    this.attempts = attempts;
    this.category = category;
    this.uncertain = uncertain;
    this.operationName = operationName;
    this.fatal = fatal;
    this.status = category === "auth" ? 401 : category === "rate_limited" ? 429 : 502;
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error("Cancelled."), { category: "cancelled" }));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener?.("abort", () => {
      clearTimeout(t);
      reject(Object.assign(new Error("Cancelled."), { category: "cancelled" }));
    }, { once: true });
  });
}

const DEFAULT_WAIT = { video: 65_000 };

/**
 * @param {{
 *   purpose: string,
 *   chain: string[],
 *   label?: string,
 *   attempt: (info: object, ctx: { safe: boolean, attemptNo: number }) => Promise<any>,
 *   eligible?: (info: object) => { ok: boolean, reason?: string },
 *   worstCaseUsd?: (info: object) => number,
 *   budget?: { reserve: Function, settle: Function } | null,
 *   budgetKind?: "video"|"image"|"audio",
 *   maxWaitMs?: number,
 *   maxAttempts?: number,
 *   onEvent?: (evt: object) => void,
 *   signal?: AbortSignal,
 * }} opts
 * @returns {Promise<{ result: any, model: string, info: object, attempts: object[], switched: boolean }>}
 */
export async function routeCall(opts) {
  const {
    purpose, chain, label = purpose, attempt, eligible, worstCaseUsd, budget = null, budgetKind,
    maxAttempts = Number(process.env.MODEL_MAX_ATTEMPTS || 4), onEvent = () => {}, signal,
  } = opts;
  const maxWaitMs = opts.maxWaitMs ?? Number(process.env.MODEL_MAX_WAIT_MS || DEFAULT_WAIT[purpose] || 20_000);
  const attempts = [];
  const deferred = [];
  let sent = 0;
  let last = null;

  const finish = (value, id, info) => {
    const okIdx = attempts.findIndex((a) => a.outcome === "ok");
    const switched = attempts.slice(0, okIdx).some((a) => a.outcome === "failed" || a.outcome === "skipped");
    return { result: value, model: id, info, attempts, switched };
  };

  /** One send to one model. Returns { ok, value } | { next: true } | { stop: Error }. */
  async function send(id, info, safe) {
    // Budget first (cheap, local) — a model whose worst case does not fit the
    // remaining job budget is skipped, never sent.
    let entry = null;
    if (budget && worstCaseUsd) {
      try {
        entry = budget.reserve(budgetKind, worstCaseUsd(info), `${label} · ${id}${safe ? " (rephrased)" : ""}`);
      } catch (err) {
        attempts.push({ model: id, outcome: "skipped", category: "budget", reason: String(err?.message || err).slice(0, 200) });
        return { next: true };
      }
    }
    // Atomically take a quota slot (waits briefly for a per-minute window).
    let q = acquireModel(id);
    for (let i = 0; !q.ok && q.scope === "minute" && q.waitMs <= maxWaitMs && i < 3; i++) {
      onEvent({ type: "waiting", model: id, label, waitMs: q.waitMs, reason: q.reason });
      await sleep(q.waitMs, signal);
      q = acquireModel(id);
    }
    if (!q.ok) {
      if (entry) budget.settle(entry, { ok: false, notCharged: true, error: "not sent (quota)" });
      attempts.push({ model: id, outcome: "skipped", category: "quota_local", reason: q.reason, retryInSec: Math.ceil(q.waitMs / 1000) });
      if (q.scope === "minute") deferred.push({ id, waitMs: q.waitMs });
      return { next: true };
    }

    sent += 1;
    const started = Date.now();
    onEvent({ type: "attempt", model: id, label, safe });
    try {
      const value = await attempt(info, { safe, attemptNo: sent });
      if (entry) budget.settle(entry, { ok: true, actualUsd: value?.cost?.amountUsd ?? null });
      attempts.push({ model: id, outcome: "ok", ms: Date.now() - started, safe: Boolean(safe) });
      onEvent({ type: "succeeded", model: id, label, ms: Date.now() - started });
      return { ok: true, value };
    } catch (err) {
      const cls = classifyProviderError(err, { stage: err?.stage || "submit" });
      if (entry) budget.settle(entry, { ok: false, notCharged: cls.notCharged, error: err?.message || String(err) });
      const record = {
        model: id, outcome: "failed", category: cls.category, scope: cls.scope,
        reason: describeCategory(cls.category, cls.scope), detail: String(err?.message || err).slice(0, 240),
        notCharged: cls.notCharged, uncertain: cls.uncertain, ms: Date.now() - started,
        operationName: err?.operationName || null, safe: Boolean(safe),
      };
      attempts.push(record);
      onEvent({ type: "failed", ...record, label });
      last = { err, cls };
      if (cls.category === "rate_limited") reportRateLimited(id, { scope: cls.scope, retryAfterMs: cls.retryAfterMs, message: err?.message });
      if (cls.category === "model_unavailable") reportUnavailable(id, { reason: "model not available to this account", message: err?.message });
      if (cls.category === "overloaded" && cls.notCharged) reportUnavailable(id, { ms: 90_000, reason: "provider overloaded", message: err?.message });
      if (cls.fatal) return { stop: err };
      if (cls.uncertain && !cls.notCharged) return { stop: err };
      if (cls.category === "safety_blocked") return { blocked: true };
      return { next: true };
    }
  }

  const triedSafe = new Set();
  for (const id of chain) {
    if (signal?.aborted) throw new RoutingError("Cancelled.", { attempts, category: "cancelled" });
    if (sent >= maxAttempts) break;
    const info = getModelInfo(id);
    if (isPastShutdown(info)) {
      attempts.push({ model: id, outcome: "skipped", category: "model_unavailable", reason: `shut down on ${info.shutdownDate}` });
      continue;
    }
    const el = eligible ? eligible(info) : { ok: true };
    if (!el.ok) {
      attempts.push({ model: id, outcome: "skipped", category: "capability", reason: el.reason || "not eligible" });
      continue;
    }
    const pre = checkModel(id);
    if (!pre.ok && !(pre.scope === "minute" && pre.waitMs <= maxWaitMs)) {
      attempts.push({ model: id, outcome: "skipped", category: "quota_local", reason: pre.reason, retryInSec: Math.ceil(pre.waitMs / 1000) });
      if (pre.scope === "minute") deferred.push({ id, waitMs: pre.waitMs });
      continue;
    }
    let r = await send(id, info, false);
    if (r.blocked && !triedSafe.has(id) && sent < maxAttempts) {
      triedSafe.add(id);
      r = await send(id, info, true);
    }
    if (r.ok) return finish(r.value, id, info);
    if (r.stop) {
      const cls = classifyProviderError(r.stop, { stage: r.stop?.stage || "submit" });
      throw new RoutingError(`${label}: ${describeCategory(cls.category, cls.scope)} on ${id} — not switching models (${cls.fatal ? "fix the key" : "the request may still be running and billed"}).`, {
        attempts, category: cls.category, uncertain: cls.uncertain, operationName: r.stop?.operationName || null, fatal: cls.fatal,
      });
    }
  }

  // Everything that could serve the request was only per-minute limited:
  // wait for the soonest window (bounded) rather than fail.
  if (deferred.length && sent < maxAttempts) {
    const soonest = deferred.sort((a, b) => a.waitMs - b.waitMs)[0];
    if (soonest.waitMs <= 75_000) {
      onEvent({ type: "waiting", model: soonest.id, label, waitMs: soonest.waitMs, reason: "all models at their per-minute limit" });
      await sleep(soonest.waitMs, signal);
      const info = getModelInfo(soonest.id);
      const r = await send(soonest.id, info, false);
      if (r.ok) return finish(r.value, soonest.id, info);
    }
  }

  const cat = last?.cls?.category || (attempts.every((a) => a.category === "quota_local") ? "rate_limited" : attempts[attempts.length - 1]?.category || "provider_error");
  const summary = attempts.map((a) => `${a.model}: ${a.outcome === "ok" ? "ok" : a.reason}`).join("; ");
  throw new RoutingError(`${label}: no model in the ${purpose} chain could run it (${summary || "empty chain"}).`, {
    attempts, category: cat, uncertain: false,
  });
}
