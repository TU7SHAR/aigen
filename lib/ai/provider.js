/**
 * Provider contracts (documented interfaces) + the typed provider error.
 *
 * VideoProvider:
 *   generate(request, ctx?) → GenerateResult
 *   resume?(operationName, ctx?) → GenerateResult   (long-running providers)
 *
 *   request = {
 *     prompt: string, negativePrompt?: string,
 *     image?: { data: string (base64), mimeType: string },  // first frame
 *     aspectRatio: "16:9"|"9:16", resolution: "360p"|"720p"|"1080p",
 *     durationSeconds: number,
 *   }
 *   ctx = { onOperation?(name), signal?: AbortSignal }
 *   GenerateResult = { videoBase64, mimeType, provider, model, usage?, cost, mock, operationName? }
 *
 * Providers THROW a ProviderError on failure — never a fake success — and say
 * what they KNOW about billing so the router can decide whether switching to
 * another model risks paying twice:
 *   notCharged: the provider definitely did not bill this attempt
 *   uncertain:  a request may still be running/billed remotely (never re-sent)
 */

export class ProviderError extends Error {
  /**
   * @param {string} message
   * @param {{
   *   status?: number, cause?: unknown, category?: string, notCharged?: boolean,
   *   uncertain?: boolean, billed?: boolean, scope?: string, retryAfterMs?: number|null,
   *   operationName?: string, stage?: string, filtered?: boolean, audioFilter?: boolean,
   * }} [opts]
   */
  constructor(message, opts = {}) {
    super(message);
    this.name = "ProviderError";
    this.status = opts.status ?? 502;
    if (opts.cause) this.cause = opts.cause;
    for (const k of ["category", "notCharged", "uncertain", "billed", "scope", "retryAfterMs", "operationName", "stage", "filtered", "audioFilter"]) {
      if (opts[k] !== undefined) this[k] = opts[k];
    }
  }
}
