/**
 * Canonical creative compilation + preflight quality gate.
 *
 * ONE function builds the brief, scene plan, generation context and final
 * prompt. Both /api/creative/preview and /api/generate call it, so the prompt
 * the user reviews is EXACTLY the prompt the model receives — no client-side
 * approximation.
 *
 * `runPreflight` deterministically validates the compiled plan and BLOCKS
 * obvious contradictions (e.g. a SaaS plan whose prompt contains "bottle"),
 * so we never spend video credits on an entity/prompt mismatch again.
 */

import { buildCreativePlan } from "./planner.js";
import { composeVideoPrompt } from "./promptComposer.js";
import { classifySourceImageHeuristic, isReferenceType } from "./sourceImage.js";
import { compileGenerationContext, contextSize } from "./generationContext.js";
import { getEntityStrategy, normalizeEntityType } from "./entityStrategies.js";

// Physical-object language that must NOT appear in a non-physical entity's prompt.
const PHYSICAL_TERMS = [
  "bottle", "cap/lid", "cap or lid", "packaging proportion", "box geometry",
  "bottle geometry", "physical product", "product bottle", "packshot",
  "product pedestal", "jar", "tube", "cosmetic container", "the product as the clean hero",
];

/**
 * @param {object} input validated generate/preview payload
 * @returns {{
 *   entityType, strategy, brief, scenePlan, generationMode, generationContext,
 *   generationContextChars, finalVideoPrompt, negativeRules, sourceImage,
 *   preflight
 * }}
 */
export function compileCreativeRequest(input) {
  const entityType = normalizeEntityType(
    input.entityType || input.productProfile?.entityType
  );
  const product = {
    name: input.productName,
    brand: input.brand || input.productProfile?.brand || undefined,
    description: input.description || input.productProfile?.description,
    category: input.productProfile?.category,
    targetCustomer: input.productProfile?.targetCustomer,
    entityType,
    ...(input.productProfile || {}),
  };
  const brand = input.brandProfile || null;
  const design = input.designProfile || null;

  // Source image classification (conservative). A chosen imported asset or an
  // uploaded file both flow through here.
  const sourceImage = input.image || input.sourceImageMeta
    ? classifySourceImageHeuristic({
        role: input.sourceImageMeta?.role,
        url: input.sourceImageMeta?.url,
        hintText: input.sourceImageMeta?.hintText,
      })
    : undefined;

  const { brief, scenePlan, strategy, generationMode } = buildCreativePlan({
    entityType,
    product,
    brand,
    design,
    template: input.template,
    durationSeconds: input.durationSeconds,
    aspectRatio: input.aspectRatio,
    sourceImage,
    brandInfluence: input.brandInfluence,
    userIntent: input.userIntent,
  });

  const composed = composeVideoPrompt({
    brief,
    scenePlan,
    entityType,
    product,
    brand,
    design,
    sourceImage,
    aspectRatio: input.aspectRatio,
    offer: input.offer,
    cta: input.cta,
  });

  const finalVideoPrompt =
    input.promptOverride && input.promptOverride.length > 0
      ? input.promptOverride
      : composed.prompt;

  const generationContext = compileGenerationContext({
    entityType,
    profile: product,
    brand,
    heroAsset: input.productProfile?.primaryImage || null,
    sourceType: sourceImage?.type || null,
    concept: input.concept || null,
    brief,
  });

  const preflight = runPreflight({
    entityType,
    strategy,
    finalVideoPrompt,
    scenePlan,
    product,
    brand,
    sourceImage,
    hasVisualReference: Boolean(input.image || input.productProfile?.primaryImage),
    confidence: input.productProfile?.extractionConfidence ?? input.entityConfidence ?? null,
  });

  return {
    entityType,
    strategy: { key: strategy.key, generationMode, allowsPhysicalLanguage: strategy.allowsPhysicalLanguage },
    brief,
    scenePlan,
    generationMode,
    generationContext,
    generationContextChars: contextSize(generationContext),
    finalVideoPrompt,
    negativeRules: composed.negativeRules,
    sourceImage: sourceImage || null,
    preflight,
  };
}

/**
 * Deterministic quality gate. Returns warnings + blockers; `readyForPaidGeneration`
 * is false when any blocker exists.
 */
export function runPreflight(ctx) {
  const warnings = [];
  const blockers = [];
  // Only scan the AFFIRMATIVE part of the prompt (before the "Avoid:" negative
  // block), so the negatives listing forbidden terms don't false-trigger.
  const full = ctx.finalVideoPrompt || "";
  const affirmative = full.split(/\bavoid:\s/i)[0];
  const promptLower = affirmative.toLowerCase();
  const isPhysical = ctx.strategy.allowsPhysicalLanguage;

  // 1. entity/prompt compatibility — the BhavishAI→bottle guard. We detect
  //    physical terms used as an INSTRUCTION, not inside a "do not …" negation.
  if (!isPhysical) {
    const found = PHYSICAL_TERMS.filter((term) => affirmativeContains(promptLower, term));
    if (found.length) {
      blockers.push(
        `Entity is "${ctx.entityType}" but the prompt contains physical-product language (${found.join(", ")}). Refusing to generate a physical object for a non-physical entity.`
      );
    }
  }

  // 2. scene plan sanity for non-physical.
  if (!isPhysical) {
    const sceneText = (ctx.scenePlan?.scenes || []).map((s) => s.visual).join(" ").toLowerCase();
    if (/the product as the clean hero|packshot|bottle|package/.test(sceneText)) {
      blockers.push("Scene plan assumes a physical product, which contradicts the detected entity type.");
    }
  }

  // 3. creator likeness guard.
  if ((ctx.entityType === "creator" || ctx.entityType === "personal_brand") && !ctx.hasVisualReference) {
    blockers.push(
      "Creator / personal-brand ads require an authorized portrait or video. Upload an authorized asset before generating."
    );
  }

  // 4. physical product without a reference image.
  if (isPhysical && !ctx.hasVisualReference) {
    warnings.push(
      "No product reference image was provided — product fidelity cannot be guaranteed. Consider uploading or selecting a product photo."
    );
  }

  // 5. low entity confidence.
  if (typeof ctx.confidence === "number" && ctx.confidence < 0.35) {
    blockers.push(
      "Entity understanding is low-confidence. Confirm what you're advertising before paid generation."
    );
  } else if (typeof ctx.confidence === "number" && ctx.confidence < 0.5) {
    warnings.push("Entity confidence is moderate — review the plan carefully before generating.");
  }

  // 6. no visual reference at all for non-physical → allowed but warn (motion-
  //    graphics/brand-led is a valid path).
  if (!isPhysical && !ctx.hasVisualReference) {
    warnings.push(
      "No visual reference found — the ad will rely on brand colors, typography and motion. Add a screenshot or logo for a stronger result."
    );
  }

  return {
    entityType: ctx.entityType,
    warnings,
    blockers,
    readyForPaidGeneration: blockers.length === 0,
  };
}

/**
 * True only if `term` appears in `text` NOT immediately preceded by a negation
 * ("no", "not", "do not", "don't", "without", "never"). Prevents a prohibition
 * like "do not invent a bottle" from counting as a physical instruction.
 */
function affirmativeContains(text, term) {
  let idx = text.indexOf(term);
  while (idx !== -1) {
    // Scope the negation search to the current sentence/clause.
    const start = Math.max(
      text.lastIndexOf(".", idx),
      text.lastIndexOf(";", idx),
      text.lastIndexOf(":", idx)
    );
    const before = text.slice(start + 1, idx);
    if (!/\b(no|not|n't|without|never|avoid)\b/.test(before)) {
      return true;
    }
    idx = text.indexOf(term, idx + term.length);
  }
  return false;
}

export { PHYSICAL_TERMS };
