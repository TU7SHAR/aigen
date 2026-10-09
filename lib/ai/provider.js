/**
 * VideoProvider contract (documented interface).
 *
 * A provider turns a prompt (+ optional reference image) into a video. We keep
 * this boundary so the model can be swapped (Gemini Omni today; another model
 * later) without touching the route handler or UI.
 *
 * Shape:
 *
 *   generate(request): Promise<GenerateResult>
 *
 *   request = {
 *     prompt: string,
 *     image?: { data: string (base64, no data: prefix), mimeType: string },
 *     aspectRatio: "16:9" | "9:16",
 *     resolution: "360p" | "720p" | "1080p",
 *     durationSeconds: number,
 *   }
 *
 *   GenerateResult = {
 *     videoBase64: string,       // base64-encoded MP4 bytes
 *     mimeType: string,          // e.g. "video/mp4"
 *     provider: string,          // "mock" | "gemini"
 *     model: string,
 *     cost: { amountUsd: number | null, state: "estimated"|"billed"|"unknown" },
 *     mock: boolean,             // true when NOT a real generation
 *   }
 *
 * Providers should THROW a ProviderError on failure rather than returning a
 * fake success, so the route handler can report an honest error.
 */

export class ProviderError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, cause?: unknown }} [opts]
   */
  constructor(message, opts = {}) {
    super(message);
    this.name = "ProviderError";
    this.status = opts.status ?? 502;
    if (opts.cause) this.cause = opts.cause;
  }
}
