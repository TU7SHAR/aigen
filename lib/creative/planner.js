/**
 * Entity-aware creative planner.
 *
 *   EntityProfile + BrandProfile + Entity Strategy + Template + Source-image
 *        → CreativeBrief → ScenePlan
 *
 * The ENTITY TYPE drives scene vocabulary and generation mode via
 * entityStrategies. Physical-product language is used ONLY for physical
 * products. Brand signals (colors/tone/style) are active inputs scaled by
 * brandInfluence, so two brands get different ads.
 */

import { getTemplate } from "./templates.js";
import { isReferenceType } from "./sourceImage.js";
import { getEntityStrategy, normalizeEntityType } from "./entityStrategies.js";

const BRAND_INFLUENCE = { low: 0.3, balanced: 0.65, strong: 1 };

/**
 * @param {{
 *   entityType?: string,
 *   product: object,            // EntityProfile/ProductProfile (may be partial)
 *   brand?: object,             // BrandProfile (optional)
 *   design?: object,            // DesignProfile (optional)
 *   template: string,
 *   durationSeconds?: number,
 *   aspectRatio?: "16:9"|"9:16",
 *   sourceImage?: { type: string, treatAsReference: boolean },
 *   brandInfluence?: "low"|"balanced"|"strong",
 *   userIntent?: string,
 * }} input
 * @returns {{ brief: object, scenePlan: object, strategy: object, generationMode: string }}
 */
export function buildCreativePlan(input) {
  const entityType = normalizeEntityType(input.entityType || input.product?.entityType);
  const strategy = getEntityStrategy(entityType);
  const t = getTemplate(input.template);
  const product = input.product || {};
  const brand = input.brand || null;
  const design = input.design || null;
  const duration = input.durationSeconds || 8;
  const influenceKey = input.brandInfluence || "balanced";
  const influence = BRAND_INFLUENCE[influenceKey] ?? 0.65;

  const brandConfident = brand && (brand.confidence ?? 0) >= 0.4;
  // Prefer DesignProfile palette (from visual intelligence) when present.
  const designColors = design?.palette ? [
    ...(design.palette.primary || []),
    ...(design.palette.accent || []),
  ] : [];
  const brandColors = designColors.length
    ? designColors.slice(0, 4)
    : brandConfident ? [...(brand.primaryColors || []), ...(brand.secondaryColors || [])] : [];
  const brandStyle = design?.visualPersonality?.join(", ") || (brandConfident ? brand.visualStyle : null);
  const brandTone = brandConfident ? brand.toneOfVoice : null;

  // Environment: brand palette can override the template backdrop when we have
  // colors and influence is high enough.
  let environment = t.environment;
  if (brandColors.length && influence >= 0.65) {
    environment = `${t.environment}, using the brand's own palette (${brandColors.join(", ")}) rather than a generic backdrop`;
  }

  const brief = {
    entityType,
    objective: input.userIntent || `Produce a professional ${duration}s advertisement for this ${strategy.subjectNoun}.`,
    audience: product.targetCustomer || (Array.isArray(product.targetAudience) ? product.targetAudience[0] : null) || null,
    adAngle: t.label,
    subjectNoun: strategy.subjectNoun,
    brand: brandConfident || brandColors.length
      ? {
          name: brand?.name || product.brand || null,
          visualStyle: brandStyle,
          tone: brandTone,
          colors: brandColors,
          logo: brand?.logo || null,
          positioning: brand?.positioning || null,
          motifs: design?.motifs || [],
          influence: influenceKey,
        }
      : null,
    visualStyle: brandStyle || t.style,
    lighting: t.lighting,
    environment,
    cameraLanguage: t.camera,
    pacing: t.pacing,
    productHeroMoment: t.productTreatment,
    ending: "calm final beat with reserved negative space for exact logo/CTA overlays",
    sourceImageHandling: input.sourceImage
      ? isReferenceType(input.sourceImage.type)
        ? "reference_only"
        : "subject_hero"
      : "no_image",
  };

  const scenes = planScenes(strategy, brief, duration);
  return {
    brief,
    scenePlan: { scenes, totalDuration: duration },
    strategy,
    generationMode: strategy.generationMode,
  };
}

function planScenes(strategy, brief, duration) {
  const beats = duration <= 6 ? 2 : 3;
  const per = Math.round((duration / beats) * 10) / 10;
  const vocab = strategy.scene(brief); // entity-specific scene descriptions
  const scenes = [];

  scenes.push({
    purpose: "establish",
    visual: vocab.establish,
    camera: brief.cameraLanguage.split(" and ")[0] || brief.cameraLanguage,
    motion: "controlled",
    lighting: brief.lighting,
    duration: per,
  });

  if (beats === 3) {
    scenes.push({
      purpose: "detail",
      visual: vocab.detail,
      camera: "a deliberate move that supports the beat",
      motion: "subtle",
      lighting: brief.lighting,
      duration: per,
    });
  }

  scenes.push({
    purpose: "end",
    visual: vocab.end,
    camera: "settle to a stable, composed framing",
    motion: "minimal",
    lighting: brief.lighting,
    duration: duration - per * (beats - 1),
  });

  return scenes;
}
