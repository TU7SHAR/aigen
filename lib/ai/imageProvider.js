/**
 * ImageProvider contract (documented interface) — the per-shot KEYFRAME path.
 *
 * The AI Creative Director emits shots with technique `ai_image` (and `ai_video`
 * degrades to a keyframe when no video provider is available). Those shots need
 * an actual generated STILL to animate — otherwise the compositor can only draw
 * a flat card, which is the black-slideshow failure. This boundary turns a
 * grounded shot brief into a real image, exactly like VideoProvider does for
 * video, so the model is swappable (mock ⇆ Gemini/Imagen) without touching the
 * compositor.
 *
 *   generateKeyframe(request): Promise<KeyframeResult>
 *
 *   request = {
 *     prompt: string,            // the shot's visual description, grounded
 *     brand?: { name, colors?: string[] },
 *     subjectText?: string,      // optional focal word/phrase (exact, verified)
 *     width: number, height: number,  // target frame size (keyframe is rendered at this AR)
 *     aspectRatio?: "16:9" | "9:16",
 *     referenceImage?: { data: base64, mimeType },  // product/site image to stay faithful to
 *     seed?: number,
 *   }
 *
 *   KeyframeResult = {
 *     imageBase64: string,       // base64 PNG/JPEG bytes (no data: prefix)
 *     mimeType: string,          // "image/png" | "image/jpeg"
 *     width: number, height: number,
 *     provider: string,          // "mock" | "gemini"
 *     model: string,
 *     cost: { amountUsd: number | null, state: "estimated"|"billed"|"unknown" },
 *     mock: boolean,             // true when NOT a real model generation
 *   }
 *
 * Providers THROW ImageProviderError on failure (never a fake success), so the
 * compositor can fall back honestly and REPORT the downgrade.
 */

export class ImageProviderError extends Error {
  /** @param {string} message @param {{ status?: number, cause?: unknown, category?: string, notCharged?: boolean, uncertain?: boolean, scope?: string, retryAfterMs?: number|null, stage?: string }} [opts] */
  constructor(message, opts = {}) {
    super(message);
    this.name = "ImageProviderError";
    this.status = opts.status ?? 502;
    if (opts.cause) this.cause = opts.cause;
    for (const k of ["category", "notCharged", "uncertain", "scope", "retryAfterMs", "stage"]) {
      if (opts[k] !== undefined) this[k] = opts[k];
    }
  }
}
