/**
 * Video model registry.
 *
 * Metadata-only description of the video models we can target, so models can be
 * COMPARED and SWITCHED without changing the product workflow. The provider
 * factory and cost estimator read from here; the route handler and UI never
 * name a model.
 *
 * Selection is driven by VIDEO_MODEL (env). "Evaluate on usable output, not just
 * price" is a human judgement — captured in `qualityNotes` and `recommended`,
 * NOT a hardcoded auto-ranking.
 *
 * NOTE on pricing: `usdPerSecond720p` is an ESTIMATE for the pre-call cost
 * preview and dev spend guard only. Real cost is computed from the provider's
 * reported token usage after a call (see lib/costs/estimate.js). Confirm live
 * pricing at https://ai.google.dev/gemini-api/docs/pricing.
 */

import { getVideoModel } from "../config.js";

/**
 * @typedef {{
 *   id: string,
 *   label: string,
 *   providerImpl: "gemini-omni" | "veo" | "mock",
 *   apiModelId?: string,
 *   status: "ga" | "preview" | "deprecated",
 *   shutdownDate?: string,
 *   usdPerSecond720p: number,
 *   resolutions: string[],
 *   aspectRatios: string[],
 *   maxDurationSeconds: number,
 *   supportsImageToVideo: boolean,
 *   recommended: boolean,
 *   qualityNotes: string,
 * }} VideoModelInfo
 */

/** @type {Record<string, VideoModelInfo>} */
export const VIDEO_MODELS = {
  "gemini-omni-1.1-flash": {
    id: "gemini-omni-1.1-flash",
    label: "Gemini Omni 1.1 Flash",
    providerImpl: "gemini-omni",
    status: "ga",
    usdPerSecond720p: 0.1,
    resolutions: ["360p", "720p", "1080p"],
    aspectRatios: ["16:9", "9:16"],
    maxDurationSeconds: 10,
    supportsImageToVideo: true,
    recommended: true,
    qualityNotes:
      "Current default. Native image-to-video, editing and extension via the Interactions API. Stable (GA), no announced shutdown. Chosen for usable output + stability, not lowest price.",
  },

  // --- Veo family (long-running generateVideos operation; real adapter in
  //     lib/ai/veoProvider.js). `apiModelId` is the exact id sent to the Gemini
  //     API and is env-overridable (VEO_API_MODEL_ID) in case Google's id
  //     differs from the friendly key here. UNVERIFIED until run with a key. ---
  "veo-3.1-lite": {
    id: "veo-3.1-lite",
    label: "Veo 3.1 Lite",
    providerImpl: "veo",
    apiModelId: process.env.VEO_API_MODEL_ID || "veo-3.1-fast-generate-preview",
    status: "preview",
    shutdownDate: "2026-10-22",
    usdPerSecond720p: 0.05,
    resolutions: ["720p", "1080p"],
    aspectRatios: ["16:9", "9:16"],
    maxDurationSeconds: 8,
    supportsImageToVideo: true,
    recommended: false,
    qualityNotes:
      "Cheapest per second (~$0.05/s @720p). Veo preview scheduled for shutdown 2026-10-22 — fine for cheap testing, but don't build long-term on it. Confirm the exact API model id in AI Studio and set VEO_API_MODEL_ID if it differs.",
  },
  "veo-3.1-fast": {
    id: "veo-3.1-fast",
    label: "Veo 3.1 Fast",
    providerImpl: "veo",
    apiModelId: process.env.VEO_FAST_API_MODEL_ID || "veo-3.1-fast-generate-preview",
    status: "preview",
    usdPerSecond720p: 0.1,
    resolutions: ["720p", "1080p", "4k"],
    aspectRatios: ["16:9", "9:16"],
    maxDurationSeconds: 8,
    supportsImageToVideo: true,
    recommended: false,
    qualityNotes: "Faster/cheaper Veo tier with native audio. Preview.",
  },
  "veo-3.1": {
    id: "veo-3.1",
    label: "Veo 3.1",
    providerImpl: "veo",
    apiModelId: process.env.VEO_STD_API_MODEL_ID || "veo-3.1-generate-preview",
    status: "preview",
    usdPerSecond720p: 0.4,
    resolutions: ["720p", "1080p", "4k"],
    aspectRatios: ["16:9", "9:16"],
    maxDurationSeconds: 8,
    supportsImageToVideo: true,
    recommended: false,
    qualityNotes: "Highest-quality Veo tier with native audio. Preview; most expensive per second.",
  },
};

/**
 * The configured default model id. Delegates to config so there is ONE
 * env-driven source of truth (VIDEO_MODEL) — not a second hardcoded fallback.
 */
export function getDefaultModelId() {
  return getVideoModel();
}

/**
 * Optional env override for a model's estimate rate ($/sec @720p):
 *   VIDEO_USD_PER_SECOND__<ID>  (ID uppercased, non-alphanumerics → _)
 * e.g. VIDEO_USD_PER_SECOND__GEMINI_OMNI_1_1_FLASH=0.09
 * Falls back to the registry value, then 0.10.
 */
function rateFor(id, base) {
  const envKey = "VIDEO_USD_PER_SECOND__" + id.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const raw = Number.parseFloat(process.env[envKey] || "");
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return Number.isFinite(base) && base >= 0 ? base : 0.1;
}

/**
 * Resolve a model's registry info. Falls back to a minimal GA-style record for
 * unknown ids so ANY env VIDEO_MODEL value still works (treated as gemini-omni).
 * The per-model rate is env-overridable.
 * @param {string} [id]
 * @returns {VideoModelInfo}
 */
export function getModelInfo(id) {
  const key = id || getDefaultModelId();
  const known = VIDEO_MODELS[key];
  if (known) {
    return { ...known, usdPerSecond720p: rateFor(key, known.usdPerSecond720p) };
  }
  return {
    id: key,
    label: key,
    providerImpl: "gemini-omni",
    status: "ga",
    usdPerSecond720p: rateFor(key, 0.1),
    resolutions: ["360p", "720p", "1080p"],
    aspectRatios: ["16:9", "9:16"],
    maxDurationSeconds: 10,
    supportsImageToVideo: true,
    recommended: false,
    qualityNotes: "Unlisted model id (set via VIDEO_MODEL) — treated as a Gemini Omni Interactions model.",
  };
}

/** List models for comparison UIs/tools. */
export function listModels() {
  return Object.values(VIDEO_MODELS);
}

/**
 * Guard: warn if the configured default is a deprecated model so we never
 * silently depend on something scheduled for shutdown.
 * @returns {string | null} a warning message, or null when fine
 */
export function deprecationWarning() {
  const info = getModelInfo(getDefaultModelId());
  if (info.status === "deprecated") {
    return `Configured video model "${info.id}" is deprecated${
      info.shutdownDate ? ` (shutdown ${info.shutdownDate})` : ""
    }. Switch VIDEO_MODEL to a GA model.`;
  }
  // Preview/other models with a shutdown date still get a heads-up (not a block).
  if (info.shutdownDate) {
    return `Heads-up: video model "${info.id}" has a scheduled shutdown (${info.shutdownDate}). Usable for now, but plan to migrate to a GA model.`;
  }
  return null;
}
