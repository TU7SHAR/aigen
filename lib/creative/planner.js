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
import { resolveProductionMethod } from "./productionMethods.js";

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
 *   emphasis?: string[],       // user messages/features to foreground
 *   avoid?: string[],          // user "must NOT appear" constraints
 *   concept?: object,          // selected CreativeConcept (AI-reasoned) — drives
 *                              // scene plan + production method when present
 *   hasUsableImage?: boolean,
 * }} input
 * @returns {{ brief, scenePlan, strategy, generationMode, productionMethod }}
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
    // Product PR A: user-directed emphasis / avoid carried on the brief so the
    // preview, the prompt composer and (PR B) the AI Creative Director all see
    // the same operator constraints.
    emphasis: Array.isArray(input.emphasis) ? input.emphasis.filter(Boolean) : [],
    avoid: Array.isArray(input.avoid) ? input.avoid.filter(Boolean) : [],
  };

  // The SELECTED concept (AI-reasoned) drives the scene plan when it carries a
  // visual idea/subject; otherwise fall back to the strategy's generic scenes.
  const concept = input.concept || null;
  // Carry the concept's visual direction onto the brief so the prompt composer
  // and scenes stay consistent.
  if (concept) {
    brief.conceptTitle = concept.title || null;
    brief.conceptCentralMessage = concept.centralMessage || null;
    brief.conceptVisualIdea = concept.visualIdea || null;
    brief.conceptSubject = concept.proposedSubject || null;
  }

  // Resolve the ACTUAL production method (only honor recommended ones that are
  // implemented). Default generationMode from the strategy is a hint; the
  // resolved method is authoritative.
  const resolved = resolveProductionMethod(
    concept?.recommendedProductionMethod,
    { hasUsableImage: input.hasUsableImage }
  );

  // Prefer the AI Creative Director's executable storyboard when present: it is
  // a variable-length, per-shot-technique plan reasoned for THIS concept. Only
  // when there is no storyboard do we fall back to the generic scene builder.
  const scenes = input.storyboard?.shots?.length
    ? scenesFromStoryboard(input.storyboard, brief)
    : planScenes({ strategy, brief, duration, concept });
  const totalDuration = input.storyboard?.totalDurationSec || duration;
  return {
    brief,
    scenePlan: {
      scenes, totalDuration, storyboardOrigin: input.storyboard?.origin || null,
      // Storyboard-level audio direction (Creative Director) for the audio pass.
      music: typeof input.storyboard?.music === "string" ? input.storyboard.music : null,
      voiceStyle: typeof input.storyboard?.voiceStyle === "string" ? input.storyboard.voiceStyle : null,
      language: input.storyboard?.language || null,
      creativeBrief: input.storyboard?.brief || null,
      validation: input.storyboard?.validation || null,
    },
    strategy,
    // Keep generationMode as the human-facing family; productionMethod is the
    // executable path.
    generationMode: strategy.generationMode,
    productionMethod: resolved,
  };
}

/**
 * Build the scene plan. When the concept provides a visual idea/subject, the
 * scenes are built FROM the concept (so selecting a different concept changes
 * the actual plan). Scene count matches duration (short clips = fewer beats).
 */
function planScenes({ strategy, brief, duration, concept }) {
  const beats = duration <= 6 ? 2 : 3;
  const per = Math.round((duration / beats) * 10) / 10;
  const vocab = strategy.scene(brief); // entity-safe generic descriptions

  // Concept-driven visuals (preferred). These are grounded in the AI concept's
  // own fields, not a per-industry template.
  const subject = concept?.proposedSubject || null;
  const idea = concept?.visualIdea || null;
  const establishVisual = idea
    ? `${idea}${subject ? ` (subject: ${subject})` : ""}`
    : vocab.establish;
  const detailVisual = concept?.centralMessage
    ? `a beat that reinforces: ${concept.centralMessage}`
    : vocab.detail;

  const scenes = [];
  scenes.push({
    purpose: "establish",
    visual: establishVisual,
    camera: brief.cameraLanguage.split(" and ")[0] || brief.cameraLanguage,
    motion: "controlled",
    lighting: brief.lighting,
    duration: per,
  });

  if (beats === 3) {
    scenes.push({
      purpose: "detail",
      visual: detailVisual,
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

/**
 * Convert the AI Creative Director's storyboard shots into the planner's scene
 * shape, preserving the per-shot PRODUCTION TECHNIQUE and exact on-screen copy
 * so the per-scene production router + compositor can execute each shot.
 */
function scenesFromStoryboard(storyboard, brief) {
  return storyboard.shots.map((shot, i) => ({
    // keep a coarse purpose for back-compat (first=establish, last=end)
    purpose: i === 0 ? "establish" : i === storyboard.shots.length - 1 ? "end" : "detail",
    intent: shot.intent,
    shotPurpose: shot.purpose || "",
    linksTo: shot.linksTo || "",
    evidence: shot.evidence || "",
    visual: shot.visual,
    camera: shot.camera || shot.motion || brief.cameraLanguage,
    motion: shot.motion || "subtle",
    lighting: brief.lighting,
    duration: shot.durationSec,
    // Director-specific execution fields:
    technique: shot.technique,          // real_asset | motion_graphic | ai_image | ai_video | composite
    assetHint: shot.assetHint || "none",
    onScreenText: shot.onScreenText || "",
    voiceover: shot.voiceover || "",
    transitionOut: shot.transitionOut || "cut",
  }));
}
