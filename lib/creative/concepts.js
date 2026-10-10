/**
 * Ad-concept generation.
 *
 * PRIMARY path is AI creative reasoning (lib/ai/concepts.js) grounded in the
 * actual source evidence — NOT a per-industry lookup table. The old
 * ENTITY_SETS/SETS tables (fixed concepts per entity/style) were removed because
 * they hardcoded creative decisions, which the product must not do.
 *
 * FALLBACK (only when AI is unavailable: no key / disabled / failure) is a
 * small, ENTITY-NEUTRAL, clearly-labeled set of generic directions. It makes no
 * industry assumptions and never implies a physical product for a non-physical
 * entity. It exists so the UI still works offline — not as the intelligence.
 */

import { generateConceptsAI } from "../ai/concepts.js";
import { getEntityStrategy } from "./entityStrategies.js";

/**
 * Async: AI-reasoned concepts with a deterministic fallback.
 * @returns {Promise<{ concepts: object[], basis: string, origin: "ai"|"fallback" }>}
 */
export async function generateConceptsSmart(input = {}) {
  const ai = await generateConceptsAI(input);
  if (ai.concepts && ai.concepts.length) {
    return {
      concepts: ai.concepts,
      basis: "Concepts reasoned from the source evidence by the enrichment model.",
      origin: "ai",
      aiCost: ai.cost,
    };
  }
  const fb = fallbackConcepts(input);
  return {
    concepts: fb,
    basis:
      (ai.skipped || ai.error || "AI concepts unavailable") +
      " — showing generic directions; edit details and regenerate for tailored ideas.",
    origin: "fallback",
    aiCost: ai.cost,
  };
}

/**
 * Entity-NEUTRAL fallback. No per-industry mapping, no fixed palette/style. The
 * only thing the entity type influences is the SAFE capability boundary
 * (physical vs non-physical), which is a correctness constraint, not a creative
 * decision.
 * @returns {object[]}
 */
export function fallbackConcepts(input = {}) {
  const name = input.product?.name || input.entity?.name || "this";
  const strategy = getEntityStrategy(input.entityType || input.product?.entityType || input.entity?.entityType);
  const physical = strategy.allowsPhysicalLanguage;

  const subject = physical
    ? "the product itself as the hero"
    : "the brand and its real on-screen visuals";

  return [
    {
      id: "introduce",
      title: "Introduce & Position",
      objective: "Establish what it is and why it matters",
      centralMessage: `Introduce ${name} clearly and establish its positioning`,
      visualIdea: `A clean, confident presentation of ${subject}`,
      proposedSubject: subject,
      recommendedProductionMethod: strategy.generationMode,
      origin: "fallback",
      estimatedComplexity: "low",
    },
    {
      id: "problem-solution",
      title: "Problem → Solution",
      objective: "Show a need, then the resolution",
      centralMessage: `Frame a relatable need, then present ${name} as the resolution`,
      visualIdea: "Open on the problem context, resolve to the offering",
      proposedSubject: subject,
      recommendedProductionMethod: strategy.generationMode,
      origin: "fallback",
      estimatedComplexity: "medium",
    },
    {
      id: "outcome",
      title: "Outcome / Benefit Lead",
      objective: "Lead with the result the audience gets",
      centralMessage: `Lead with the concrete outcome ${name} delivers (only outcomes supported by the source)`,
      visualIdea: "A confident, benefit-forward beat",
      proposedSubject: subject,
      recommendedProductionMethod: strategy.generationMode,
      origin: "fallback",
      estimatedComplexity: "medium",
    },
  ];
}
