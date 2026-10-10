/**
 * Generation Context Compiler.
 *
 * Builds the SMALLEST high-quality context the video step needs — never the
 * whole profile/crawl. Excludes raw HTML, cleaned text, JSON-LD blobs, all
 * specs/reviews/FAQs, warnings, provenance, observability and every image URL.
 */

/**
 * @param {{
 *   entityType?: string,
 *   profile?: object,        // merged final profile
 *   brand?: object,          // BrandProfile
 *   heroAsset?: string|null,
 *   sourceType?: string,     // source-image class
 *   concept?: object|null,
 *   brief?: object|null,
 * }} input
 * @returns {object} GenerationContext
 */
export function compileGenerationContext(input) {
  const p = input.profile || {};
  const b = input.brand || null;

  const trimList = (arr, n) => (Array.isArray(arr) ? arr.slice(0, n) : []);

  return {
    entityType: input.entityType || "unknown",
    identity: {
      name: p.name || null,
      brand: p.brand || b?.name || null,
    },
    offer: {
      primaryOffer: p.offer || null,
      importantFeatures: trimList(p.features, 4),
      importantBenefits: trimList(p.benefits, 4),
    },
    audience: p.targetCustomer || (trimList(p.targetAudience, 1)[0] ?? null),
    brand: b
      ? {
          visualStyle: b.visualStyle || null,
          tone: b.toneOfVoice || null,
          primaryColors: trimList(b.primaryColors, 3),
        }
      : null,
    visualReference: {
      heroAsset: input.heroAsset || null,
      sourceType: input.sourceType || null,
    },
    creative: input.brief
      ? {
          selectedConcept: input.concept?.title || null,
          objective: input.brief.objective || null,
          environment: input.brief.environment || null,
          camera: input.brief.cameraLanguage || null,
          lighting: input.brief.lighting || null,
        }
      : { selectedConcept: input.concept?.title || null },
  };
}

/** Rough char size of the compiled context (for reduction measurement). */
export function contextSize(ctx) {
  return JSON.stringify(ctx).length;
}
