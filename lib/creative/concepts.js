/**
 * Ad-concept generation (deterministic, brand-adaptive).
 *
 * Produces several distinct ad concepts BEFORE any paid video generation, so
 * the user picks a direction and we don't waste credits. Concepts adapt to the
 * detected brand style/tone — two different brands should NOT get identical
 * concept lists.
 *
 * This is intentionally deterministic (no AI cost). An optional Gemini pass can
 * refine wording later (lib/ai/enrich), clearly labeled as AI-generated.
 */

import { TEMPLATES } from "./templates.js";

/**
 * @param {{ product?: object, brand?: object, entityType?: string }} input
 * @returns {{ concepts: {id,title,template,angle,rationale}[], basis: string }}
 */
export function generateConcepts({ product = {}, brand = null, entityType } = {}) {
  const type = entityType || product.entityType || "unknown";
  const name = product.name || "your product";

  // Entity-aware concepts first — a SaaS/service/business/creator must NOT get
  // "Product Demo / Lifestyle / Packshot" concepts that assume a physical item.
  const ENTITY_SETS = {
    saas: [
      concept("product-reveal", "Product Reveal", "minimal", `Introduce ${name} and what it does, clean and modern.`),
      concept("feature-flow", "Feature Flow", "product-demo", "Walk through the key capabilities with crisp motion."),
      concept("problem-solution", "Problem → Solution", "problem-solution", "Show the pain, then reveal the product as the fix."),
      concept("outcome", "Outcome Story", "bold", "Lead with the result users get, fast and confident."),
    ],
    service: [
      concept("intro", "Service Introduction", "minimal", `Explain what ${name} offers and who it's for.`),
      concept("problem-solution", "Problem → Solution", "problem-solution", "Establish the need, then present the service."),
      concept("trust", "Trust & Proof", "bold", "Lead with credibility and client outcomes."),
      concept("how-it-works", "How It Works", "product-demo", "A simple, confident step-by-step."),
    ],
    business: [
      concept("brand-intro", "Brand Introduction", "minimal", `Introduce ${name} and its positioning.`),
      concept("value", "Core Value Reveal", "bold", "Lead with the single strongest value proposition."),
      concept("problem-solution", "Problem → Solution", "problem-solution", "Frame the problem, then the business as the answer."),
      concept("experience", "Experience Film", "luxury", "A premium brand-feel film with reserved overlay space."),
    ],
    course: [
      concept("outcome", "Transformation Promise", "bold", "What the learner can achieve."),
      concept("curriculum", "What You'll Learn", "product-demo", "A crisp pass over the key modules."),
      concept("authority", "Instructor Authority", "minimal", "Position the teacher and credibility."),
      concept("problem-solution", "Problem → Solution", "problem-solution", "The gap, then the course as the path."),
    ],
    creator: [
      concept("authority", "Authority Introduction", "bold", "Direct-to-camera energy establishing who you are."),
      concept("social-proof", "Social Proof Reel", "bold", "Lead with proof and momentum."),
      concept("offer", "Offer Launch", "minimal", "Introduce the offer cleanly with a strong CTA beat."),
      concept("story", "Transformation Story", "problem-solution", "A relatable arc toward your offer."),
    ],
    app: [
      concept("app-reveal", "App Reveal", "minimal", `Show ${name} and its core screen clearly.`),
      concept("feature-flow", "Feature Flow", "product-demo", "Flow through the key app interactions."),
      concept("outcome", "Outcome Story", "bold", "Lead with what the app helps you do."),
      concept("problem-solution", "Problem → Solution", "problem-solution", "The friction, then the app as the fix."),
    ],
  };

  const normalizedType = type.replace("ecommerce_store", "business");
  if (ENTITY_SETS[normalizedType]) {
    return {
      concepts: ENTITY_SETS[normalizedType],
      basis: `Concepts tailored to a ${normalizedType.replace("_", " ")}.`,
    };
  }

  // Product (or unknown) → brand-style-adaptive sets.
  const style = inferStyleKey(product, brand);

  const SETS = {
    luxury: [
      concept("midnight-reveal", "Midnight Product Reveal", "luxury", `${name} emerges from shadow under controlled warm light.`),
      concept("editorial-macro", "Editorial Macro Film", "product-demo", "Macro detail beats that make the materials feel premium."),
      concept("minimal-hero", "Minimal Hero Commercial", "minimal", "Clean negative space, product design does the talking."),
      concept("story", "Ingredient / Craft Story", "problem-solution", "A refined narrative building to the hero product."),
    ],
    playful: [
      concept("color-pop", "Color Pop Product Reveal", "bold", `${name} snaps in against the brand's own colors.`),
      concept("benefit-breakdown", "Fast Benefit Breakdown", "product-demo", "Quick, punchy feature beats for paid social."),
      concept("routine", "Playful Routine", "lifestyle", "Product shown naturally in a bright, real setting."),
      concept("texture", "Texture & Detail Close-Up", "product-demo", "Satisfying close-ups of the product in action."),
    ],
    clean: [
      concept("studio-hero", "Clean Studio Hero", "minimal", `${name} centered in a crisp, trustworthy studio.`),
      concept("demo", "Product Demo", "product-demo", "Clear, credible walkthrough of the real features."),
      concept("lifestyle", "Lifestyle Context", "lifestyle", "Product in the customer's everyday environment."),
      concept("problem-solution", "Problem → Solution", "problem-solution", "Context, then the product as the clean resolution."),
    ],
  };

  const concepts = SETS[style] || SETS.clean;
  return {
    concepts,
    basis:
      brand && brand.confidence >= 0.4 && (brand.visualStyle || brand.primaryColors?.length)
        ? `Adapted to detected brand style (${style}).`
        : `Brand style not confidently detected — using balanced ${style} concepts.`,
  };
}

function inferStyleKey(product, brand) {
  const hay = [
    brand?.visualStyle,
    brand?.toneOfVoice,
    product?.category,
    (brand?.brandKeywords || []).join(" "),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (/luxur|premium|editorial|elegant|sophisticat|minimal.*gold|fragrance|perfume/.test(hay)) return "luxury";
  if (/playful|fun|bold|vibrant|gen.?z|colou?rful|youthful|energetic/.test(hay)) return "playful";
  return "clean";
}

function concept(id, title, template, rationale) {
  const t = TEMPLATES[template];
  return {
    id,
    title,
    template,
    angle: t?.label || template,
    rationale,
  };
}
