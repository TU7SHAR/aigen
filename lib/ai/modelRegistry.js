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

/**
 * @typedef {{
 *   id: string,
 *   label: string,
 *   providerImpl: "gemini-omni" | "mock",
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

  // Reference entries — NOT wired to a provider impl. They exist so models can
  // be compared in one place and a future switch is a config + small adapter,
  // never a workflow rewrite. Veo is intentionally NOT the default.
  "veo-3.1-lite": {
    id: "veo-3.1-lite",
    label: "Veo 3.1 Lite",
    providerImpl: "gemini-omni", // placeholder: needs its own adapter if adopted
    status: "deprecated",
    shutdownDate: "2026-10-22",
    usdPerSecond720p: 0.05,
    resolutions: ["720p", "1080p"],
    aspectRatios: ["16:9", "9:16"],
    maxDurationSeconds: 8,
    supportsImageToVideo: true,
    recommended: false,
    qualityNotes:
      "Cheapest per second but the Gemini API preview is scheduled for shutdown 2026-10-22 — do NOT couple the product to it. Uses a different request/response shape (generateContent, not Interactions), so adopting it requires a dedicated provider adapter.",
  },
};

/** The configured default model id. */
export function getDefaultModelId() {
  return process.env.VIDEO_MODEL || "gemini-omni-1.1-flash";
}

/**
 * Resolve a model's registry info. Falls back to a minimal GA-style record for
 * unknown ids so an unlisted env value still works (treated as gemini-omni).
 * @param {string} [id]
 * @returns {VideoModelInfo}
 */
export function getModelInfo(id) {
  const key = id || getDefaultModelId();
  return (
    VIDEO_MODELS[key] || {
      id: key,
      label: key,
      providerImpl: "gemini-omni",
      status: "ga",
      usdPerSecond720p: 0.1,
      resolutions: ["360p", "720p", "1080p"],
      aspectRatios: ["16:9", "9:16"],
      maxDurationSeconds: 10,
      supportsImageToVideo: true,
      recommended: false,
      qualityNotes: "Unlisted model id — treated as a Gemini Omni Interactions model.",
    }
  );
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
  return null;
}
