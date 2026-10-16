/**
 * Central runtime configuration, read from server-side environment variables.
 *
 * NOTE: This module must only be imported from server code (route handlers,
 * server components). It reads secrets like GEMINI_API_KEY and must never be
 * bundled into the browser.
 */

/**
 * SINGLE SOURCE OF TRUTH for default model ids.
 *
 * Every model id is read from an environment variable with these as the only
 * fallbacks — code must NOT reference raw model-id strings anywhere else. To
 * change a model, set the env var; nothing in the call sites changes.
 */
export const DEFAULTS = /** @type {const} */ ({
  VIDEO_MODEL: "gemini-omni-1.1-flash",
  SOURCE_ENRICHMENT_MODEL: "gemini-3.1-flash-lite",
  // Image keyframe model (per-shot still generation). Separate, far cheaper
  // tier than video. GA image model; override via IMAGE_MODEL.
  IMAGE_MODEL: "gemini-2.5-flash-image",
});

/** @returns {boolean} */
export function isPaidGenerationEnabled() {
  return process.env.ENABLE_PAID_GENERATION === "true";
}

/**
 * HARD kill-switch for ALL paid generative-video calls, independent of provider
 * or ENABLE_PAID_GENERATION. When true, the generate route refuses to call ANY
 * paid provider (Veo/Omni) and only the deterministic compositor / mock paths
 * may run. Use during the product-quality rebuild to guarantee no credits are
 * spent. Defaults to DISABLED-PAID (true) unless explicitly set to "false".
 *
 *   DISABLE_PAID_GENERATION unset / "true"  → paid video HARD-disabled (safe default)
 *   DISABLE_PAID_GENERATION = "false"        → paid video allowed (still needs the
 *                                              other gates: provider + ENABLE_PAID_GENERATION)
 * @returns {boolean}
 */
export function isPaidGenerationHardDisabled() {
  return process.env.DISABLE_PAID_GENERATION !== "false";
}

/**
 * Dry-run mode: compile + plan + (optionally) render the DETERMINISTIC output,
 * but never call a paid generative model. Returns the full plan (offering,
 * format, script, storyboard, selected assets, final model request, estimated
 * cost) so the user can review before authorizing any spend.
 *
 * Dry-run is ON whenever paid generation is hard-disabled, or explicitly via
 * DRY_RUN=true. (So the safe default — no DISABLE_PAID_GENERATION=false — is a
 * dry run for any would-be paid generative request.)
 * @returns {boolean}
 */
export function isDryRun() {
  return process.env.DRY_RUN === "true" || isPaidGenerationHardDisabled();
}

/** @returns {string} The configured video model id (env-driven). */
export function getVideoModel() {
  return process.env.VIDEO_MODEL || DEFAULTS.VIDEO_MODEL;
}

/** @returns {string} The configured image keyframe model id (env-driven). */
export function getImageModel() {
  return process.env.IMAGE_MODEL || DEFAULTS.IMAGE_MODEL;
}

/**
 * Which image provider to use for per-shot keyframe generation.
 *   IMAGE_PROVIDER=mock (default)  → deterministic branded keyframe, NO cost.
 *   IMAGE_PROVIDER=gemini          → real Imagen/Gemini image call (paid-gated).
 * Falls back to "mock" so the pipeline always has a real visual path with zero
 * spend. A real call ALSO requires isPaidImageGenerationEnabled() AND a key.
 * @returns {"mock"|"gemini"}
 */
export function getImageProviderName() {
  return process.env.IMAGE_PROVIDER === "gemini" ? "gemini" : "mock";
}

/**
 * Paid IMAGE generation gate — independent of video. Image stills are a
 * separate, much cheaper call, but still billable, so they get their own
 * explicit switch. OFF by default: a real Gemini image call requires BOTH
 * IMAGE_PROVIDER=gemini AND ENABLE_PAID_IMAGE_GENERATION=true AND a key.
 * @returns {boolean}
 */
export function isPaidImageGenerationEnabled() {
  // The global hard kill-switch (DISABLE_PAID_GENERATION) covers images too.
  return process.env.ENABLE_PAID_IMAGE_GENERATION === "true" && !isPaidGenerationHardDisabled();
}

/**
 * Paid AUDIO (Gemini TTS voiceover + Lyria music bed). Separate gate from
 * video; the global hard kill-switch still covers it, and the per-job audio
 * allowance (JOB_MAX_PAID_AUDIO, default 0) must be > 0.
 * @returns {boolean}
 */
export function isPaidAudioGenerationEnabled() {
  return (
    process.env.ENABLE_PAID_AUDIO_GENERATION === "true" &&
    !isPaidGenerationHardDisabled() &&
    Number.parseInt(process.env.JOB_MAX_PAID_AUDIO || "0", 10) > 0
  );
}

/** Voiceover (TTS) model + voice. */
export function getTtsModel() {
  return process.env.TTS_MODEL || "gemini-3.8-flash-tts";
}
export function getTtsVoice() {
  return process.env.TTS_VOICE || "Charon";
}
/** Music-bed model. */
export function getMusicModel() {
  return process.env.MUSIC_MODEL || "lyria-3-clip-preview";
}

/**
 * Paid per-shot SCENE VIDEO (storyboard `ai_video` shots → video provider).
 * Requires the real video provider, the paid gate, the hard kill-switch lifted,
 * AND a per-job clip allowance (JOB_MAX_PAID_VIDEO_CLIPS > 0, default 0).
 * @returns {boolean}
 */
export function isPaidSceneVideoEnabled() {
  return (
    process.env.VIDEO_PROVIDER === "gemini" &&
    process.env.ENABLE_PAID_GENERATION === "true" &&
    !isPaidGenerationHardDisabled() &&
    Number.parseInt(process.env.JOB_MAX_PAID_VIDEO_CLIPS || "0", 10) > 0
  );
}

/**
 * Worst-case GPU seconds one Modal request can bill: the container timeout
 * plus the warm scaledown window (the worker's decorator values). Used for the
 * fail-closed per-job reservation, not as an expected cost.
 */
export function getModalWorstCaseGpuSeconds() {
  const raw = Number.parseFloat(process.env.MODAL_WORST_CASE_GPU_SECONDS || "720");
  return Number.isFinite(raw) && raw > 0 ? raw : 720;
}

/** @returns {string | undefined} */
export function getGeminiApiKey() {
  return process.env.GEMINI_API_KEY;
}

/**
 * Modal self-hosted video worker configuration.
 *
 *  MODAL_VIDEO_ENDPOINT  — the HTTPS URL of your deployed Modal web endpoint
 *                          (from `modal deploy`). Required to use the modal provider.
 *  MODAL_WORKER_SECRET   — a shared secret sent as a header; the worker rejects
 *                          requests without it (so your GPU isn't open to the world).
 *  MODAL_GPU_USD_PER_SECOND — per-second GPU rate for the GPU you selected in the
 *                          worker, used to ESTIMATE spend (default ~L4/A10G class).
 */
export function getModalEndpoint() {
  return process.env.MODAL_VIDEO_ENDPOINT || "";
}
export function getModalWorkerSecret() {
  return process.env.MODAL_WORKER_SECRET || "";
}
export function getModalGpuUsdPerSecond() {
  // Default ≈ an L4/A10G-class GPU on Modal. Set this to match the GPU your
  // worker requests so the spend estimate is accurate.
  const raw = Number.parseFloat(process.env.MODAL_GPU_USD_PER_SECOND || "0.000337");
  return Number.isFinite(raw) && raw > 0 ? raw : 0.000337;
}
/** Is the Modal worker configured (endpoint present)? */
export function isModalConfigured() {
  return Boolean(getModalEndpoint());
}

/**
 * Cheap/fast Gemini text model used for SOURCE ENRICHMENT (semantic extraction
 * of the crawled page into a structured profile). This is NOT the video model.
 * Defaults to a Flash-Lite tier; override to match your API tier.
 * @returns {string}
 */
export function getEnrichmentModel() {
  return process.env.SOURCE_ENRICHMENT_MODEL || DEFAULTS.SOURCE_ENRICHMENT_MODEL;
}

/**
 * Whether AI source enrichment is allowed to call Gemini. Separate from paid
 * VIDEO generation: enrichment is cheap text, but still a real API call, so it
 * has its own switch. Enabled automatically when a key is present unless
 * explicitly disabled.
 * @returns {boolean}
 */
export function isEnrichmentEnabled() {
  if (process.env.ENABLE_SOURCE_ENRICHMENT === "false") return false;
  if (process.env.ENABLE_SOURCE_ENRICHMENT === "true") return true;
  // Default: on when a key exists (cheap text), off otherwise.
  return Boolean(process.env.GEMINI_API_KEY);
}

/**
 * Developer spend ceiling (USD) for this process. When the running estimated
 * spend tracked in-memory exceeds this, paid generation is refused. This is a
 * soft local guard, NOT a durable billing cap.
 * @returns {number}
 */
export function getDevSpendLimitUsd() {
  const raw = Number.parseFloat(process.env.DEV_SPEND_LIMIT_USD || "5");
  return Number.isFinite(raw) && raw >= 0 ? raw : 5;
}

/**
 * Which provider implementation to use.
 * - "mock" (default): no API calls, no cost, clearly-labeled fake output.
 * - "gemini": real Gemini Omni Flash calls (requires key + paid gen enabled).
 * @returns {"mock" | "gemini"}
 */
export function getProviderName() {
  return process.env.VIDEO_PROVIDER === "gemini" ? "gemini" : "mock";
}

/**
 * Video production formats. These are PRODUCTION ROUTES (how the video is made),
 * NOT industry→creative mappings:
 *  - screen_demo:    the storyboard production engine (lib/render/compositor.js):
 *                    real assets + per-shot AI video (Veo/Modal) + voiceover/
 *                    music + exact copy. Paid shots/audio run ONLY when their
 *                    gates are on and within the per-job budget; otherwise it
 *                    composes from real assets alone and reports the gaps.
 *  - cinematic_card: deterministic branded title-card ad (text + brand backdrop,
 *                    optional real hero image). No paid model. IMPLEMENTED.
 *  - generative:     paid generative video model (Veo/Omni) for footage, then
 *                    the compositor finishes exact copy. GATED behind the paid
 *                    kill-switches; dry-run otherwise.
 */
export const VIDEO_FORMATS = /** @type {const} */ ([
  "screen_demo",
  "cinematic_card",
  "generative",
]);

/** Formats routed to the compositor (paid calls inside are separately gated + budgeted). */
export const DETERMINISTIC_FORMATS = /** @type {const} */ (["screen_demo", "cinematic_card"]);

/** Allowlisted aspect ratios the model supports. */
export const ASPECT_RATIOS = /** @type {const} */ (["16:9", "9:16"]);

/** Allowlisted output resolutions. */
export const RESOLUTIONS = /** @type {const} */ (["360p", "720p", "1080p"]);

/** Allowlisted ad template ids. */
export const TEMPLATES = /** @type {const} */ ([
  "luxury",
  "bold",
  "minimal",
  "product-demo",
  "problem-solution",
  "lifestyle",
]);

/** Brand influence levels for creative planning. */
export const BRAND_INFLUENCE_LEVELS = /** @type {const} */ ([
  "low",
  "balanced",
  "strong",
]);

/** Upload constraints. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB
export const ALLOWED_IMAGE_MIME = /** @type {const} */ ([
  "image/png",
  "image/jpeg",
  "image/webp",
]);
