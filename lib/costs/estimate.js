/**
 * Cost estimation and spend protection.
 *
 * IMPORTANT: These are ESTIMATES ONLY. Google's authoritative per-second
 * pricing for Gemini Omni Flash must be confirmed in Google AI Studio billing
 * for your account/tier. The default rate below is a placeholder used to drive
 * the UI estimate and the local dev spend guard; it is NOT a billed figure.
 *
 * The cost tracker distinguishes three states:
 *   - "estimated": computed locally before a call.
 *   - "billed":    confirmed by the provider response (if it reports usage).
 *   - "unknown":   a call happened but no usage/cost was reported.
 */

/**
 * Placeholder per-second USD rate for 720p. Override via env if you have
 * confirmed pricing. Treat as an estimate until verified in AI Studio.
 */
export function getRatePerSecondUsd() {
  const raw = Number.parseFloat(process.env.VIDEO_USD_PER_SECOND || "0.10");
  return Number.isFinite(raw) && raw >= 0 ? raw : 0.1;
}

const RESOLUTION_MULTIPLIER = {
  "360p": 0.5,
  "720p": 1,
  "1080p": 1.6,
};

/**
 * @param {{ durationSeconds?: number, resolution?: string }} opts
 * @returns {{ amountUsd: number, state: "estimated", basis: string }}
 */
export function estimateCost({ durationSeconds = 8, resolution = "720p" }) {
  const rate = getRatePerSecondUsd();
  const mult = RESOLUTION_MULTIPLIER[resolution] ?? 1;
  const amountUsd = Number((rate * durationSeconds * mult).toFixed(4));
  return {
    amountUsd,
    state: "estimated",
    basis: `${durationSeconds}s @ $${rate}/s x${mult} (${resolution}) — UNVERIFIED estimate`,
  };
}

/**
 * Minimal in-memory spend ledger for the local prototype. Resets on restart.
 * This is a safety guard for development, NOT a durable billing ledger.
 */
let runningEstimatedSpendUsd = 0;

export function getRunningSpendUsd() {
  return runningEstimatedSpendUsd;
}

/** @param {number} amountUsd */
export function recordSpendUsd(amountUsd) {
  if (Number.isFinite(amountUsd) && amountUsd > 0) {
    runningEstimatedSpendUsd = Number(
      (runningEstimatedSpendUsd + amountUsd).toFixed(4)
    );
  }
  return runningEstimatedSpendUsd;
}

/**
 * @param {number} prospectiveUsd amount about to be spent
 * @param {number} limitUsd
 * @returns {{ ok: boolean, reason?: string }}
 */
export function checkSpendBudget(prospectiveUsd, limitUsd) {
  if (runningEstimatedSpendUsd + prospectiveUsd > limitUsd) {
    return {
      ok: false,
      reason: `Dev spend limit reached: $${runningEstimatedSpendUsd} + $${prospectiveUsd} would exceed cap $${limitUsd}. Raise DEV_SPEND_LIMIT_USD to continue.`,
    };
  }
  return { ok: true };
}
