/**
 * Production-method capability map.
 *
 * A CreativeConcept may RECOMMEND a production method, but we only honor it when
 * an actual, executable implementation exists. This prevents the "hybrid is a
 * label, not an implementation" problem: an AI concept asking for
 * "motion_graphics" won't silently pretend we have a Remotion compositor.
 *
 * `implemented` reflects what the code can genuinely execute today:
 *   - text_to_video  : video provider with a text prompt (Omni/Veo) ✓
 *   - image_to_video : video provider with a reference image (Omni/Veo) ✓
 *   - hybrid         : NOT a distinct executable path yet — currently resolves
 *                      to image_to_video (if a reference exists) or
 *                      text_to_video. Flagged so we don't claim composition.
 *   - motion_graphics: NOT implemented (needs a deterministic renderer, e.g.
 *                      Remotion) — resolves to text_to_video with a note.
 *   - avatar_presenter: NOT implemented (needs an avatar/voice provider).
 */

export const PRODUCTION_METHODS = {
  text_to_video: { id: "text_to_video", implemented: true, needsImage: false },
  image_to_video: { id: "image_to_video", implemented: true, needsImage: true },
  hybrid: { id: "hybrid", implemented: false, fallsBackTo: "image_to_video" },
  motion_graphics: { id: "motion_graphics", implemented: false, fallsBackTo: "text_to_video" },
  avatar_presenter: { id: "avatar_presenter", implemented: false, fallsBackTo: null },
};

/**
 * Resolve the ACTUAL production method we will execute, given what a concept
 * recommended and whether a usable reference image exists.
 *
 * @param {string|undefined} recommended  method the AI concept recommended
 * @param {{ hasUsableImage?: boolean }} ctx
 * @returns {{
 *   method: "text_to_video"|"image_to_video",
 *   requested: string|null,
 *   honored: boolean,
 *   note: string|null,
 *   blocker: string|null,
 * }}
 */
export function resolveProductionMethod(recommended, ctx = {}) {
  const hasImage = Boolean(ctx.hasUsableImage);
  const spec = recommended ? PRODUCTION_METHODS[recommended] : null;

  // Default when nothing recommended: image_to_video if we have a reference,
  // else text_to_video.
  if (!spec) {
    return {
      method: hasImage ? "image_to_video" : "text_to_video",
      requested: recommended || null,
      honored: true,
      note: null,
      blocker: null,
    };
  }

  // Implemented methods: honor directly, but image_to_video needs an image.
  if (spec.implemented) {
    if (spec.needsImage && !hasImage) {
      return {
        method: "text_to_video",
        requested: recommended,
        honored: false,
        note: `"${recommended}" needs a usable reference image; none available, using text_to_video.`,
        blocker: null,
      };
    }
    return { method: spec.id, requested: recommended, honored: true, note: null, blocker: null };
  }

  // Not implemented: fall back if we can, else block.
  if (spec.fallsBackTo) {
    let method = spec.fallsBackTo;
    if (method === "image_to_video" && !hasImage) method = "text_to_video";
    return {
      method,
      requested: recommended,
      honored: false,
      note: `Production method "${recommended}" is not implemented yet; using ${method}. (Deterministic composition / overlays are a planned milestone.)`,
      blocker: null,
    };
  }

  // No fallback (e.g. avatar_presenter): this is a real blocker.
  return {
    method: "text_to_video",
    requested: recommended,
    honored: false,
    note: null,
    blocker: `The selected concept needs "${recommended}", which is not available (no implemented provider). Choose a different concept/format.`,
  };
}
