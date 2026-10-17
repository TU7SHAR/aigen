/**
 * Model registry — every generative model the product can route to.
 *
 * Metadata only: identity, lifecycle, published price, capabilities and the
 * account's rate limits. Routing (lib/ai/router.js) reads the per-family
 * CHAIN (preference order) and switches automatically when a model is rate
 * limited, exhausted for the day, unavailable or overloaded — and records
 * every switch so a shot's provenance is never silent.
 *
 * VERIFIED 2026-10-17 against https://ai.google.dev/gemini-api/docs/pricing
 * and /docs/deprecations:
 *  - Veo 3.0 models were shut down 2026-06-30; only the Veo 3.1 family is live.
 *  - veo-3.1-lite has NO announced shutdown date (an earlier "2026-10-22"
 *    note in this repo was unverified and has been removed).
 *  - gemini-2.5-flash-image is deprecated (replacement:
 *    gemini-3.1-flash-lite-image / gemini-nano-banana-2.1).
 *  - gemini-3.1-flash-lite is deprecated (shutdown 2027-05-07 → 3.5 Flash-Lite).
 *  - gemini-3.1-flash-tts-preview and the 2.5 TTS models shut down 2026-11-17.
 * Default limits are the owner's Tier-1 dashboard values (2026-10-17). Override
 * per model with MODEL_LIMITS__<ID>=rpm:2,rpd:10 when the tier changes.
 *
 * Prices are PUBLISHED LIST PRICES used for estimates and worst-case
 * reservations. They are not invoices; reconcile in Google AI Studio billing.
 */

import { getVideoModel } from "../config.js";

/**
 * @typedef {{
 *   id: string, label: string,
 *   family: "video"|"image"|"tts"|"music"|"text",
 *   providerImpl: string, apiModelId?: string,
 *   status: "ga"|"preview"|"experimental"|"deprecated",
 *   shutdownDate?: string|null, replacement?: string,
 *   usdPerSecond720p?: number, usdPerSecondByRes?: Record<string, number>,
 *   usdPerUnit?: number, unit?: string,
 *   usdPerMInput?: number, usdPerMOutput?: number,
 *   durations?: number[], maxDurationSeconds?: number,
 *   resolutions?: string[], aspectRatios?: string[],
 *   supportsImageToVideo?: boolean, supportsReferenceImages?: boolean,
 *   nativeAudio?: boolean, languages?: string,
 *   limits: { rpm: number, rpd: number },
 *   qualityRank: number, recommended?: boolean, qualityNotes: string,
 * }} ModelInfo
 */

/** @type {Record<string, ModelInfo>} */
export const MODELS = {
  // ---------------------------------------------------------------- video --
  "veo-3.1-lite": {
    id: "veo-3.1-lite", label: "Veo 3.1 Lite", family: "video", providerImpl: "veo",
    apiModelId: "veo-3.1-lite-generate-preview", status: "preview", shutdownDate: null,
    usdPerSecond720p: 0.05, usdPerSecondByRes: { "720p": 0.05, "1080p": 0.08 },
    durations: [4, 6, 8], maxDurationSeconds: 8, resolutions: ["720p", "1080p"], aspectRatios: ["16:9", "9:16"],
    supportsImageToVideo: true, supportsReferenceImages: false, nativeAudio: true,
    limits: { rpm: 2, rpd: 10 }, qualityRank: 2, recommended: true,
    qualityNotes: "Newest and cheapest Veo ($0.05/s at 720p). Image-to-video and native audio; no reference images; 1080p only for 8s clips.",
  },
  "veo-3.1-fast": {
    id: "veo-3.1-fast", label: "Veo 3.1 Fast", family: "video", providerImpl: "veo",
    apiModelId: "veo-3.1-fast-generate-preview", status: "preview", shutdownDate: null,
    usdPerSecond720p: 0.1, usdPerSecondByRes: { "720p": 0.1, "1080p": 0.12, "4k": 0.3 },
    durations: [4, 6, 8], maxDurationSeconds: 8, resolutions: ["720p", "1080p", "4k"], aspectRatios: ["16:9", "9:16"],
    supportsImageToVideo: true, supportsReferenceImages: true, nativeAudio: true,
    limits: { rpm: 2, rpd: 10 }, qualityRank: 3,
    qualityNotes: "Faster/better than Lite at 2x the price. Supports up to 3 reference images (8s clips only).",
  },
  "gemini-omni-1.1-flash": {
    id: "gemini-omni-1.1-flash", label: "Gemini Omni 1.1 Flash", family: "video", providerImpl: "gemini-omni",
    apiModelId: "gemini-omni-1.1-flash", status: "ga", shutdownDate: null,
    usdPerSecond720p: 0.1, usdPerSecondByRes: { "360p": 0.1, "720p": 0.1, "1080p": 0.1 },
    // No duration parameter: the model chooses the length (up to ~10s), so the
    // worst-case reservation assumes the full 10s.
    durations: [], maxDurationSeconds: 10, resolutions: ["360p", "720p", "1080p"], aspectRatios: ["16:9", "9:16"],
    supportsImageToVideo: true, supportsReferenceImages: true, nativeAudio: true,
    limits: { rpm: 4, rpd: 20 }, qualityRank: 4,
    qualityNotes: "GA; Google's recommended default for coherence and character consistency. Token-billed ≈ $0.10/s of 720p; length is model-chosen so it costs more per shot than Veo Lite/Fast.",
  },
  "gemini-omni-flash-preview": {
    id: "gemini-omni-flash-preview", label: "Gemini Omni Flash (preview)", family: "video", providerImpl: "gemini-omni",
    apiModelId: "gemini-omni-flash-preview", status: "preview", shutdownDate: null,
    usdPerSecond720p: 0.1, usdPerSecondByRes: { "360p": 0.1, "720p": 0.1, "1080p": 0.1 },
    durations: [], maxDurationSeconds: 10, resolutions: ["360p", "720p", "1080p"], aspectRatios: ["16:9", "9:16"],
    supportsImageToVideo: true, supportsReferenceImages: true, nativeAudio: true,
    limits: { rpm: 4, rpd: 20 }, qualityRank: 4,
    qualityNotes: "Preview Omni with its own quota bucket — extra daily capacity when the GA model is exhausted.",
  },
  "veo-3.1": {
    id: "veo-3.1", label: "Veo 3.1", family: "video", providerImpl: "veo",
    apiModelId: "veo-3.1-generate-preview", status: "preview", shutdownDate: null,
    usdPerSecond720p: 0.4, usdPerSecondByRes: { "720p": 0.4, "1080p": 0.4, "4k": 0.6 },
    durations: [4, 6, 8], maxDurationSeconds: 8, resolutions: ["720p", "1080p", "4k"], aspectRatios: ["16:9", "9:16"],
    supportsImageToVideo: true, supportsReferenceImages: true, nativeAudio: true,
    limits: { rpm: 2, rpd: 10 }, qualityRank: 5,
    qualityNotes: "Highest Veo quality at 8x Lite's price. Not in the default chain; add it to VIDEO_MODEL_CHAIN to allow it.",
  },
  "modal-video": {
    id: "modal-video", label: "Self-hosted (Modal GPU)", family: "video", providerImpl: "modal",
    status: "experimental", shutdownDate: null,
    usdPerSecond720p: 0.03, durations: [], maxDurationSeconds: 8, resolutions: ["360p", "720p"], aspectRatios: ["16:9", "9:16"],
    supportsImageToVideo: true, supportsReferenceImages: false, nativeAudio: false,
    limits: { rpm: 30, rpd: 1000 }, qualityRank: 1,
    qualityNotes: "Open-source model on the owner's Modal GPU budget. Billed as GPU-seconds. Only routed when listed in VIDEO_MODEL_CHAIN and MODAL_VIDEO_ENDPOINT is set.",
  },

  // ---------------------------------------------------------------- image --
  "gemini-nano-banana-2.1": {
    id: "gemini-nano-banana-2.1", label: "Nano Banana 2.1", family: "image", providerImpl: "gemini-image",
    apiModelId: "gemini-nano-banana-2.1", status: "preview", shutdownDate: null,
    usdPerUnit: 0.0336, unit: "1K image", limits: { rpm: 100, rpd: 1000 }, qualityRank: 4,
    qualityNotes: "Google's recommended replacement for 3.1 Flash Image; same price as Nano Banana 2 Lite with better visual quality.",
  },
  "gemini-3.1-flash-lite-image": {
    id: "gemini-3.1-flash-lite-image", label: "Nano Banana 2 Lite", family: "image", providerImpl: "gemini-image",
    apiModelId: "gemini-3.1-flash-lite-image", status: "ga", shutdownDate: null,
    usdPerUnit: 0.0336, unit: "1K image", limits: { rpm: 150, rpd: 1000 }, qualityRank: 3,
    qualityNotes: "Fastest/cheapest image model.",
  },
  "gemini-3.1-flash-image": {
    id: "gemini-3.1-flash-image", label: "Nano Banana 2", family: "image", providerImpl: "gemini-image",
    apiModelId: "gemini-3.1-flash-image", status: "ga", shutdownDate: null, replacement: "gemini-nano-banana-2.1",
    usdPerUnit: 0.067, unit: "1K image", limits: { rpm: 100, rpd: 1000 }, qualityRank: 4,
    qualityNotes: "2x the price of 2.1; fallback only.",
  },
  "gemini-2.5-flash-image": {
    id: "gemini-2.5-flash-image", label: "Nano Banana (2.5, deprecated)", family: "image", providerImpl: "gemini-image",
    apiModelId: "gemini-2.5-flash-image", status: "deprecated", shutdownDate: "2027-03-15", replacement: "gemini-3.1-flash-lite-image",
    usdPerUnit: 0.039, unit: "image", limits: { rpm: 500, rpd: 2000 }, qualityRank: 2,
    qualityNotes: "Deprecated — not routed by default.",
  },

  // ------------------------------------------------------------------ tts --
  "gemini-3.8-flash-tts": {
    id: "gemini-3.8-flash-tts", label: "Gemini 3.8 Flash TTS", family: "tts", providerImpl: "gemini-tts",
    apiModelId: "gemini-3.8-flash-tts", status: "preview", shutdownDate: null,
    usdPerSecond720p: 0.000225, usdPerUnit: 0.000225, unit: "second of audio",
    languages: "130+ (see lib/i18n/languages.js)", limits: { rpm: 10, rpd: 100 }, qualityRank: 5,
    qualityNotes: "Studio-grade, expressive; best for regional dialects and code-switching. ~$0.003 per 15s line.",
  },
  "gemini-3.8-flash-lite-tts": {
    id: "gemini-3.8-flash-lite-tts", label: "Gemini 3.8 Flash-Lite TTS", family: "tts", providerImpl: "gemini-tts",
    apiModelId: "gemini-3.8-flash-lite-tts", status: "preview", shutdownDate: null,
    usdPerSecond720p: 0.00015, usdPerUnit: 0.00015, unit: "second of audio",
    languages: "100+ (subset of 3.8 Flash TTS)", limits: { rpm: 10, rpd: 100 }, qualityRank: 3,
    qualityNotes: "Cheaper, less expressive fallback; a few languages are missing.",
  },

  // ---------------------------------------------------------------- music --
  "lyria-3-clip-preview": {
    id: "lyria-3-clip-preview", label: "Lyria 3 Clip (30s)", family: "music", providerImpl: "lyria",
    apiModelId: "lyria-3-clip-preview", status: "preview", shutdownDate: null,
    usdPerUnit: 0.04, unit: "30s clip", limits: { rpm: 150, rpd: 500 }, qualityRank: 3,
    qualityNotes: "Cheapest and fastest bed; 30s is enough for a 6-20s ad.",
  },
  "lyria-3-pro-preview": {
    id: "lyria-3-pro-preview", label: "Lyria 3 Pro", family: "music", providerImpl: "lyria",
    apiModelId: "lyria-3-pro-preview", status: "preview", shutdownDate: null,
    usdPerUnit: 0.08, unit: "song", limits: { rpm: 150, rpd: 500 }, qualityRank: 4,
    qualityNotes: "Full song; slower. Fallback only.",
  },

  // ----------------------------------------------------------------- text --
  "gemini-3.8-flash": {
    id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", family: "text", providerImpl: "gemini-text",
    apiModelId: "gemini-3.8-flash", status: "ga", shutdownDate: null,
    usdPerMInput: 0.75, usdPerMOutput: 3.75, limits: { rpm: 1000, rpd: 10000 }, qualityRank: 5,
    qualityNotes: "Creative direction (concepts, script, storyboard, review). ~$0.01 per storyboard.",
  },
  "gemini-3.7-flash": {
    id: "gemini-3.7-flash", label: "Gemini 3.7 Flash", family: "text", providerImpl: "gemini-text",
    apiModelId: "gemini-3.7-flash", status: "ga", shutdownDate: null,
    usdPerMInput: 0.75, usdPerMOutput: 3.75, limits: { rpm: 1000, rpd: 10000 }, qualityRank: 4,
    qualityNotes: "Fallback for creative direction (price assumed equal to 3.8 Flash for estimates).",
  },
  "gemini-3.5-flash-lite": {
    id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite", family: "text", providerImpl: "gemini-text",
    apiModelId: "gemini-3.5-flash-lite", status: "ga", shutdownDate: null,
    usdPerMInput: 0.3, usdPerMOutput: 2.5, limits: { rpm: 4000, rpd: 150000 }, qualityRank: 3,
    qualityNotes: "Extraction / enrichment workhorse (replacement for 3.1 Flash-Lite).",
  },
  "gemini-3.1-flash-lite": {
    id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite", family: "text", providerImpl: "gemini-text",
    apiModelId: "gemini-3.1-flash-lite", status: "deprecated", shutdownDate: "2027-05-07", replacement: "gemini-3.5-flash-lite",
    usdPerMInput: 0.25, usdPerMOutput: 1.5, limits: { rpm: 4000, rpd: 150000 }, qualityRank: 2,
    qualityNotes: "Deprecated; last-resort fallback only.",
  },
};

/** Back-compat view: video models only (used by older callers/tests). */
export const VIDEO_MODELS = Object.fromEntries(Object.entries(MODELS).filter(([, m]) => m.family === "video"));

/**
 * Default preference order per routing purpose: cheapest acceptable model
 * first, then more capacity/quality. Override with the *_CHAIN env vars.
 */
export const DEFAULT_CHAINS = {
  video: ["veo-3.1-lite", "veo-3.1-fast", "gemini-omni-1.1-flash", "gemini-omni-flash-preview"],
  image: ["gemini-nano-banana-2.1", "gemini-3.1-flash-lite-image", "gemini-3.1-flash-image"],
  tts: ["gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts"],
  music: ["lyria-3-clip-preview", "lyria-3-pro-preview"],
  creative: ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.5-flash-lite"],
  enrichment: ["gemini-3.5-flash-lite", "gemini-3.8-flash", "gemini-3.1-flash-lite"],
};

const CHAIN_ENV = {
  video: "VIDEO_MODEL_CHAIN",
  image: "IMAGE_MODEL_CHAIN",
  tts: "TTS_MODEL_CHAIN",
  music: "MUSIC_MODEL_CHAIN",
  creative: "CREATIVE_MODEL_CHAIN",
  enrichment: "ENRICHMENT_MODEL_CHAIN",
};
// Legacy single-model vars: when set (and no *_CHAIN), they become the head.
const LEGACY_HEAD_ENV = {
  video: "VIDEO_MODEL",
  image: "IMAGE_MODEL",
  tts: "TTS_MODEL",
  music: "MUSIC_MODEL",
  creative: "CREATIVE_MODEL",
  enrichment: "SOURCE_ENRICHMENT_MODEL",
};

const splitList = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);

/**
 * The ordered model chain for a purpose. Auto-switching can be disabled with
 * MODEL_AUTO_SWITCH=false (or VIDEO_AUTO_SWITCH=false for video), in which
 * case only the head model is used and failures are reported, not rerouted.
 * @param {"video"|"image"|"tts"|"music"|"creative"|"enrichment"} purpose
 * @returns {string[]}
 */
export function getChain(purpose) {
  const explicit = splitList(process.env[CHAIN_ENV[purpose]]);
  let chain = explicit.length ? explicit : [...(DEFAULT_CHAINS[purpose] || [])];
  if (!explicit.length) {
    const head = (process.env[LEGACY_HEAD_ENV[purpose]] || "").trim();
    if (head) chain = [head, ...chain.filter((m) => m !== head)];
  }
  chain = [...new Set(chain)];
  const switchOff =
    process.env.MODEL_AUTO_SWITCH === "false" || (purpose === "video" && process.env.VIDEO_AUTO_SWITCH === "false");
  return switchOff ? chain.slice(0, 1) : chain;
}

/** Is auto-switching enabled for this purpose? */
export function isAutoSwitchEnabled(purpose = "video") {
  if (process.env.MODEL_AUTO_SWITCH === "false") return false;
  if (purpose === "video" && process.env.VIDEO_AUTO_SWITCH === "false") return false;
  return true;
}

/** Account rate limits for a model (env override: MODEL_LIMITS__<ID>=rpm:2,rpd:10). */
export function getModelLimits(id) {
  const base = MODELS[id]?.limits || { rpm: 10, rpd: 100 };
  const raw = process.env[`MODEL_LIMITS__${String(id).toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`];
  if (!raw) return { ...base };
  const out = { ...base };
  for (const part of splitList(raw)) {
    const [k, v] = part.split(":").map((x) => x.trim());
    const n = Number.parseInt(v, 10);
    if ((k === "rpm" || k === "rpd") && Number.isFinite(n) && n >= 0) out[k] = n;
  }
  return out;
}

/** True when the model's announced shutdown date has passed. */
export function isPastShutdown(info, now = Date.now()) {
  if (!info?.shutdownDate) return false;
  const t = Date.parse(`${info.shutdownDate}T00:00:00Z`);
  return Number.isFinite(t) && now >= t;
}

/**
 * Optional env override for a video model's estimate rate ($/sec @720p):
 *   VIDEO_USD_PER_SECOND__<ID>=0.07
 */
function rateFor(id, base) {
  const envKey = "VIDEO_USD_PER_SECOND__" + String(id).toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const raw = Number.parseFloat(process.env[envKey] || "");
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return Number.isFinite(base) && base >= 0 ? base : 0.1;
}

/** The configured head of the video chain (what estimates are based on). */
export function getDefaultModelId() {
  return getChain("video")[0] || getVideoModel();
}

/**
 * Resolve a model's registry info. Unknown ids resolve to a conservative
 * Omni-shaped video record so a newly released model id still routes.
 * @param {string} [id]
 * @returns {ModelInfo}
 */
export function getModelInfo(id) {
  const key = id || getDefaultModelId();
  const known = MODELS[key];
  if (known) {
    return known.family === "video" ? { ...known, usdPerSecond720p: rateFor(key, known.usdPerSecond720p) } : { ...known };
  }
  return {
    id: key, label: key, family: "video", providerImpl: "gemini-omni", apiModelId: key,
    status: "ga", shutdownDate: null,
    usdPerSecond720p: rateFor(key, 0.1), usdPerSecondByRes: { "720p": rateFor(key, 0.1) },
    durations: [], maxDurationSeconds: 10, resolutions: ["360p", "720p", "1080p"], aspectRatios: ["16:9", "9:16"],
    supportsImageToVideo: true, supportsReferenceImages: false, nativeAudio: true,
    limits: getModelLimits(key), qualityRank: 3, recommended: false,
    qualityNotes: "Unlisted model id — treated as a Gemini Omni Interactions model. Add a registry entry.",
  };
}

/** USD per second of generated video at a resolution (falls back to 720p rate). */
export function videoUsdPerSecond(info, resolution = "720p") {
  const byRes = info?.usdPerSecondByRes || {};
  return Number(byRes[resolution] ?? info?.usdPerSecond720p ?? 0.1);
}

/** All video models (comparison UIs / tests). */
export function listModels(family = "video") {
  return Object.values(MODELS).filter((m) => !family || m.family === family);
}

/**
 * Lifecycle heads-up for the configured head model (never a block): the
 * router already skips models whose shutdown date has passed.
 * @returns {string|null}
 */
export function deprecationWarning() {
  const info = getModelInfo(getDefaultModelId());
  if (info.status === "deprecated") {
    return `Configured video model "${info.id}" is deprecated${info.shutdownDate ? ` (shutdown ${info.shutdownDate})` : ""}.`;
  }
  if (info.shutdownDate) {
    return `Heads-up: video model "${info.id}" has a scheduled shutdown (${info.shutdownDate}); the router will switch to the next model automatically.`;
  }
  return null;
}
