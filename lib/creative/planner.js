/**
 * Brand-aware creative planner.
 *
 *   ProductProfile + BrandProfile + User Intent + Template + Source-image class
 *        → CreativeBrief → ScenePlan → professional video prompt
 *
 * Even though the video model takes a single prompt, the prompt is composed
 * from a deliberate internal plan rather than a static sentence. Brand signals
 * (colors/tone/style) are ACTIVE inputs, scaled by a brandInfluence setting, so
 * two different brands selling the same product get different ads.
 */

import { getTemplate } from "./templates.js";
import { isReferenceType } from "./sourceImage.js";

const BRAND_INFLUENCE = { low: 0.3, balanced: 0.65, strong: 1 };

/**
 * @param {{
 *   product: object,            // ProductProfile (may be partial)
 *   brand?: object,             // BrandProfile (optional)
 *   template: string,
 *   durationSeconds?: number,
 *   aspectRatio?: "16:9"|"9:16",
 *   sourceImage?: { type: string, treatAsReference: boolean },
 *   brandInfluence?: "low"|"balanced"|"strong",
 *   userIntent?: string,
 * }} input
 * @returns {{ brief: object, scenePlan: object }}
 */
export function buildCreativePlan(input) {
  const t = getTemplate(input.template);
  const product = input.product || {};
  const brand = input.brand || null;
  const duration = input.durationSeconds || 8;
  const influenceKey = input.brandInfluence || "balanced";
  const influence = BRAND_INFLUENCE[influenceKey] ?? 0.65;

  // Only treat brand as a strong constraint if we actually have evidence.
  const brandConfident = brand && (brand.confidence ?? 0) >= 0.4;
  const brandColors = brandConfident ? [...(brand.primaryColors || []), ...(brand.secondaryColors || [])] : [];
  const brandStyle = brandConfident ? brand.visualStyle : null;
  const brandTone = brandConfident ? brand.toneOfVoice : null;

  // Environment: brand palette can override the template's generic backdrop
  // when influence is high enough and we have colors.
  let environment = t.environment;
  if (brandColors.length && influence >= 0.65) {
    environment = `${t.environment}, using the brand's own palette (${brandColors.join(", ")}) rather than a generic backdrop`;
  }

  const brief = {
    objective: input.userIntent || `Produce a professional ${duration}s product advertisement.`,
    audience: product.targetCustomer || null,
    adAngle: t.label,
    brand: brandConfident
      ? {
          name: brand.name,
          visualStyle: brandStyle,
          tone: brandTone,
          colors: brandColors,
          logo: brand.logo || null,
          positioning: brand.positioning || null,
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
        ? "reference_only" // extract product/brand from it; do NOT animate the artwork
        : "product_hero" // the physical product is the hero
      : "no_image",
  };

  // Scene plan proportional to duration.
  const scenes = planScenes(t, brief, duration);
  return { brief, scenePlan: { scenes, totalDuration: duration } };
}

function planScenes(t, brief, duration) {
  const beats = duration <= 6 ? 2 : 3;
  const per = Math.round((duration / beats) * 10) / 10;
  const scenes = [];

  scenes.push({
    purpose: "establish",
    visual: `${brief.environment}; the product as the clean hero object`,
    camera: t.camera.split(" and ")[0] || t.camera,
    motion: "controlled",
    lighting: t.lighting,
    duration: per,
  });

  if (beats === 3) {
    scenes.push({
      purpose: "detail",
      visual: `macro / detail beat emphasizing ${t.productTreatment}`,
      camera: "slow move with a detail insert on a distinctive product feature",
      motion: "subtle",
      lighting: t.lighting,
      duration: per,
    });
  }

  scenes.push({
    purpose: "hero_end",
    visual: "final hero composition with reserved negative space for exact logo/CTA overlays (added in post, not drawn by the model)",
    camera: "settle to a stable hero framing",
    motion: "minimal",
    lighting: t.lighting,
    duration: duration - per * (beats - 1),
  });

  return scenes;
}
