/**
 * Central runtime configuration, read from server-side environment variables.
 *
 * NOTE: This module must only be imported from server code (route handlers,
 * server components). It reads secrets like GEMINI_API_KEY and must never be
 * bundled into the browser.
 */

/** @returns {boolean} */
export function isPaidGenerationEnabled() {
  return process.env.ENABLE_PAID_GENERATION === "true";
}

/** @returns {string} The configured video model id. */
export function getVideoModel() {
  return process.env.VIDEO_MODEL || "gemini-omni-1.1-flash";
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
  return process.env.SOURCE_ENRICHMENT_MODEL || "gemini-3.1-flash-lite";
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
