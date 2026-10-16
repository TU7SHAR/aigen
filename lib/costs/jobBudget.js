/**
 * Per-job paid-call budget guard (FAIL-CLOSED).
 *
 * Every paid image/video call made while producing ONE ad goes through a
 * JobBudget created for that job. Before a call we `reserve()` its WORST-CASE
 * cost; if that reservation would exceed any cap (per-job count, per-job USD,
 * or the process-wide dev spend limit) the call is refused BEFORE it is made.
 *
 * Fail-closed rules:
 *  - A call whose cost the provider cannot report is charged at the worst-case
 *    reservation (never at $0).
 *  - A failed call still consumes its reservation (the provider may have
 *    billed it) unless the failure is known to happen before any request was
 *    sent (e.g. budget/config refusal — those never reserve).
 *  - Retries are bounded by `maxRetries` (default 0 = no retry, per AGENTS.md:
 *    never silently retry a billable call); every retry reserves again.
 */

import { getRunningSpendUsd, recordSpendUsd } from "./estimate.js";
import { getDevSpendLimitUsd } from "../config.js";

export class BudgetError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "BudgetError";
    this.details = details;
  }
}

function num(envName, fallback, { min = 0, max = Infinity } = {}) {
  const raw = Number.parseFloat(process.env[envName] ?? "");
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, raw));
}

/** Caps read from env with conservative defaults. */
export function getJobBudgetConfig() {
  return {
    maxUsd: num("JOB_MAX_USD", 0.5, { max: 25 }),
    maxImages: Math.floor(num("JOB_MAX_PAID_IMAGES", 4, { max: 12 })),
    maxVideoClips: Math.floor(num("JOB_MAX_PAID_VIDEO_CLIPS", 0, { max: 6 })),
    maxRetries: Math.floor(num("JOB_MAX_PAID_RETRIES", 0, { max: 1 })),
    // Worst-case per-unit prices used for reservations (USD).
    imageUsdPerImage: num("IMAGE_USD_PER_IMAGE", 0.039, { min: 0.001 }),
  };
}

/**
 * @param {Partial<ReturnType<typeof getJobBudgetConfig>>} [overrides]
 */
export function createJobBudget(overrides = {}) {
  const cfg = { ...getJobBudgetConfig(), ...overrides };
  const devLimit = getDevSpendLimitUsd();
  const state = { spentUsd: 0, images: 0, videoClips: 0, calls: [] };

  function reserve(kind, worstCaseUsd, label = "") {
    const usd = Number(worstCaseUsd);
    if (!Number.isFinite(usd) || usd <= 0) {
      throw new BudgetError(`Refusing ${kind} call "${label}": no positive worst-case cost estimate (fail-closed).`);
    }
    if (kind === "image" && state.images + 1 > cfg.maxImages) {
      throw new BudgetError(`Per-job image cap reached (${cfg.maxImages}). Raise JOB_MAX_PAID_IMAGES to allow more.`, { kind });
    }
    if (kind === "video" && state.videoClips + 1 > cfg.maxVideoClips) {
      throw new BudgetError(`Per-job video-clip cap reached (${cfg.maxVideoClips}). Raise JOB_MAX_PAID_VIDEO_CLIPS to allow more.`, { kind });
    }
    if (state.spentUsd + usd > cfg.maxUsd + 1e-9) {
      throw new BudgetError(
        `Per-job budget would be exceeded: $${state.spentUsd.toFixed(3)} + $${usd.toFixed(3)} > $${cfg.maxUsd.toFixed(2)} (JOB_MAX_USD).`,
        { kind }
      );
    }
    if (getRunningSpendUsd() + usd > devLimit + 1e-9) {
      throw new BudgetError(
        `Dev spend limit would be exceeded: $${getRunningSpendUsd()} + $${usd.toFixed(3)} > $${devLimit} (DEV_SPEND_LIMIT_USD).`,
        { kind }
      );
    }
    // Commit the reservation now (fail-closed: charged even if the call fails).
    if (kind === "image") state.images += 1;
    if (kind === "video") state.videoClips += 1;
    state.spentUsd = Number((state.spentUsd + usd).toFixed(4));
    recordSpendUsd(usd);
    const entry = { kind, label, reservedUsd: usd, actualUsd: null, ok: null };
    state.calls.push(entry);
    return entry;
  }

  /** Mark a reserved call's outcome. Actual cost only replaces the reservation if known AND lower is NOT assumed. */
  function settle(entry, { ok, actualUsd = null, error = null }) {
    entry.ok = ok;
    entry.actualUsd = Number.isFinite(actualUsd) ? actualUsd : null;
    if (error) entry.error = String(error).slice(0, 200);
  }

  /**
   * Run one paid call under the budget with bounded retries.
   * @template T
   * @param {"image"|"video"} kind
   * @param {number} worstCaseUsd
   * @param {string} label
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async function run(kind, worstCaseUsd, label, fn) {
    let lastErr;
    for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
      const entry = reserve(kind, worstCaseUsd, attempt ? `${label} (retry ${attempt})` : label);
      try {
        const out = await fn();
        settle(entry, { ok: true, actualUsd: out?.cost?.amountUsd ?? null });
        return out;
      } catch (err) {
        settle(entry, { ok: false, error: err?.message || err });
        lastErr = err;
        if (err?.retryable === false || err?.status === 401 || err?.status === 400) break;
      }
    }
    throw lastErr;
  }

  function summary() {
    return {
      caps: { ...cfg, devSpendLimitUsd: devLimit },
      reservedUsd: state.spentUsd,
      paidImages: state.images,
      paidVideoClips: state.videoClips,
      calls: state.calls.map((c) => ({ ...c })),
    };
  }

  return { reserve, settle, run, summary, config: cfg };
}
