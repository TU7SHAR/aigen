/**
 * Per-job paid-call budget guard (FAIL-CLOSED).
 *
 * Every paid image/video/audio call made while producing ONE ad reserves its
 * WORST-CASE cost here before it is sent. A reservation that would exceed the
 * per-job count caps, the per-job USD cap, or the durable daily/monthly caps
 * (lib/costs/ledger.js — shared by all processes, survives restarts) is
 * refused BEFORE the call.
 *
 *  - Unknown actual cost → the worst-case reservation stands (never $0).
 *  - A failed call keeps its reservation unless the provider certainly did
 *    not bill it (`notCharged`), in which case the money and the slot return.
 *  - Retries/switches are made by the router; each one reserves again.
 */

import { reserveSpend, settleSpend, releaseSpend } from "./ledger.js";
import { getDailySpendLimitUsd } from "../config.js";

export class BudgetError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "BudgetError";
    this.category = "budget";
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
    maxVideoClips: Math.floor(num("JOB_MAX_PAID_VIDEO_CLIPS", 0, { max: 8 })),
    // Audio calls per job (1 voiceover + 1 music bed). Default 0 = off.
    maxAudio: Math.floor(num("JOB_MAX_PAID_AUDIO", 0, { max: 4 })),
    maxRetries: Math.floor(num("JOB_MAX_PAID_RETRIES", 0, { max: 1 })),
    // Worst-case per-unit reservations (USD); actuals are estimated afterwards.
    imageUsdPerImage: num("IMAGE_USD_PER_IMAGE", 0.07, { min: 0.001 }),
    ttsUsdPerCall: num("TTS_USD_PER_CALL", 0.02, { min: 0.001 }),
    musicUsdPerCall: num("MUSIC_USD_PER_CALL", 0.08, { min: 0.001 }),
  };
}

/**
 * @param {Partial<ReturnType<typeof getJobBudgetConfig>> & { jobId?: string }} [overrides]
 */
export function createJobBudget(overrides = {}) {
  const { jobId = null, ...capOverrides } = overrides;
  const cfg = { ...getJobBudgetConfig(), ...capOverrides };
  const state = { spentUsd: 0, images: 0, videoClips: 0, audio: 0, calls: [] };

  function reserve(kind, worstCaseUsd, label = "", model = null) {
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
    if (kind === "audio" && state.audio + 1 > cfg.maxAudio) {
      throw new BudgetError(`Per-job audio cap reached (${cfg.maxAudio}). Raise JOB_MAX_PAID_AUDIO to allow more.`, { kind });
    }
    if (state.spentUsd + usd > cfg.maxUsd + 1e-9) {
      throw new BudgetError(
        `Per-job budget would be exceeded: $${state.spentUsd.toFixed(3)} + $${usd.toFixed(3)} > $${cfg.maxUsd.toFixed(2)} (JOB_MAX_USD).`,
        { kind }
      );
    }
    // Durable daily/monthly caps (throws SpendLimitError, a BudgetError).
    const ledgerEntry = reserveSpend({ usd, jobId, kind, label, model });
    if (kind === "image") state.images += 1;
    if (kind === "video") state.videoClips += 1;
    if (kind === "audio") state.audio += 1;
    state.spentUsd = Number((state.spentUsd + usd).toFixed(4));
    const entry = { kind, label, model, reservedUsd: usd, actualUsd: null, ok: null, ledgerId: ledgerEntry.id };
    state.calls.push(entry);
    return entry;
  }

  /** Mark a reserved call's outcome. */
  function settle(entry, { ok, actualUsd = null, error = null, notCharged = false, basis = "estimated_from_published_rates" }) {
    if (!entry || entry.ok !== null) return;
    entry.ok = ok;
    entry.actualUsd = Number.isFinite(actualUsd) ? actualUsd : null;
    if (error) entry.error = String(error).slice(0, 200);
    if (!ok && notCharged) {
      // The provider certainly did not bill this attempt → money + slot return.
      entry.actualUsd = 0;
      entry.released = true;
      state.spentUsd = Number(Math.max(0, state.spentUsd - entry.reservedUsd).toFixed(4));
      if (entry.kind === "image") state.images = Math.max(0, state.images - 1);
      if (entry.kind === "video") state.videoClips = Math.max(0, state.videoClips - 1);
      if (entry.kind === "audio") state.audio = Math.max(0, state.audio - 1);
      releaseSpend(entry.ledgerId, error || "provider did not bill");
      return;
    }
    // Success with a known estimate counts the estimate; anything uncertain
    // counts the worst case (fail-closed).
    settleSpend(entry.ledgerId, ok && Number.isFinite(actualUsd) ? { usd: actualUsd, basis } : { usd: null });
  }

  /**
   * Run one paid call under the budget (single model, no routing). Kept for
   * callers that do not need model switching.
   * @template T
   * @param {"image"|"video"|"audio"} kind
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
        settle(entry, { ok: false, error: err?.message || err, notCharged: Boolean(err?.notCharged) });
        lastErr = err;
        if (err?.retryable === false || err?.status === 401 || err?.status === 400 || err?.filtered) break;
      }
    }
    throw lastErr;
  }

  function summary() {
    return {
      caps: { ...cfg, dailySpendLimitUsd: getDailySpendLimitUsd() },
      reservedUsd: state.spentUsd,
      paidImages: state.images,
      paidVideoClips: state.videoClips,
      paidAudio: state.audio,
      calls: state.calls.map((c) => ({ ...c })),
    };
  }

  return { reserve, settle, run, summary, config: cfg, jobId };
}
