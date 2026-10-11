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

/** @returns {string | undefined} */
export function getGeminiApiKey() {
  return process.env.GEMINI_API_KEY;
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
 *  - screen_demo:    deterministic ffmpeg compositor animating REAL screenshots
 *                    + exact text overlays. No paid model. IMPLEMENTED.
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

/** Formats rendered deterministically (never a paid generative call). */
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
