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

import { getModelInfo } from "../ai/modelRegistry.js";

/**
 * Per-second USD rate for 720p, used ONLY for the pre-call estimate / dev spend
 * guard. Resolution order: VIDEO_USD_PER_SECOND env → the active model's
 * registry rate → 0.10 fallback. Real cost comes from reported token usage.
 */
export function getRatePerSecondUsd() {
  const envRaw = Number.parseFloat(process.env.VIDEO_USD_PER_SECOND || "");
  if (Number.isFinite(envRaw) && envRaw >= 0) return envRaw;
  const r = getModelInfo().usdPerSecond720p;
  return Number.isFinite(r) && r >= 0 ? r : 0.1;
}

/**
 * Gemini Omni Flash is billed PER TOKEN across three meters. These defaults are
 * Google's published introductory rates (USD per 1,000,000 tokens); override
 * via env and confirm the current figures on
 * https://ai.google.dev/gemini-api/docs/pricing for your tier.
 *   - input tokens:        $1.50 / 1M
 *   - text output tokens:  $9.00 / 1M
 *   - video output tokens: $17.50 / 1M  (~$0.10 / s of 720p @ 5792 tok/s)
 */
function num(env, fallback) {
  const raw = Number.parseFloat(process.env[env] || "");
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}
export function getTokenRatesPerMillion() {
  return {
    input: num("GEMINI_INPUT_USD_PER_M", 1.5),
    textOutput: num("GEMINI_TEXT_OUTPUT_USD_PER_M", 9.0),
    videoOutput: num("GEMINI_VIDEO_OUTPUT_USD_PER_M", 17.5),
  };
}

/**
 * Compute the REAL billed cost from the token usage block returned by the
 * Gemini Interactions API (`interaction.usage`). This replaces the pre-call
 * estimate with actual metered units once the provider reports them.
 *
 * The usage object reports total token counts but does not separate text vs.
 * video output tokens. Because video output dominates cost, we attribute all
 * output tokens to the video meter by default (the most conservative, i.e.
 * highest, interpretation). If `videoOutputTokens` is provided explicitly we
 * use it and bill the remainder as text output.
 *
 * @param {{
 *   total_input_tokens?: number, total_output_tokens?: number,
 *   total_cached_tokens?: number, total_thought_tokens?: number,
 *   total_tool_use_tokens?: number, total_tokens?: number,
 *   videoOutputTokens?: number,
 * } | null | undefined} usage
 * @returns {{
 *   amountUsd: number, state: "billed"|"unknown", basis: string,
 *   tokens?: object, note?: string,
 * }}
 */
export function costFromUsage(usage) {
  if (!usage || typeof usage !== "object") {
    return {
      amountUsd: null,
      state: "unknown",
      basis: "Provider returned no usage block; actual cost unknown. Check Google AI Studio billing.",
    };
  }
  const rates = getTokenRatesPerMillion();
  const inputTok = Number(usage.total_input_tokens || 0);
  const outputTok = Number(usage.total_output_tokens || 0);

  const videoTok =
    typeof usage.videoOutputTokens === "number"
      ? usage.videoOutputTokens
      : outputTok; // attribute all output to video (conservative)
  const textTok = Math.max(0, outputTok - videoTok);

  const inputUsd = (inputTok / 1_000_000) * rates.input;
  const textUsd = (textTok / 1_000_000) * rates.textOutput;
  const videoUsd = (videoTok / 1_000_000) * rates.videoOutput;
  const amountUsd = Number((inputUsd + textUsd + videoUsd).toFixed(6));

  return {
    amountUsd,
    state: "billed",
    basis: `From reported usage: input ${inputTok} tok, output ${outputTok} tok (video≈${videoTok}) × published rates`,
    tokens: {
      input: inputTok,
      output: outputTok,
      total: Number(usage.total_tokens || inputTok + outputTok),
    },
    note: "Computed from the Interactions API usage block × Google's published per-token rates. Reconcile against AI Studio billing for the authoritative amount.",
  };
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
 * Enrichment (cheap TEXT) spend is tracked SEPARATELY from video spend so we
 * can reason about profitability per stage.
 */
let runningEnrichmentSpendUsd = 0;
export function recordEnrichmentSpend(amountUsd) {
  if (Number.isFinite(amountUsd) && amountUsd > 0) {
    runningEnrichmentSpendUsd = Number((runningEnrichmentSpendUsd + amountUsd).toFixed(6));
  }
  return runningEnrichmentSpendUsd;
}
export function getEnrichmentSpendUsd() {
  return runningEnrichmentSpendUsd;
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
