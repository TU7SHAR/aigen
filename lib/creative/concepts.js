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
 * @param {{ product?: object, brand?: object }} input
 * @returns {{ concepts: {id,title,template,angle,rationale}[], basis: string }}
 */
export function generateConcepts({ product = {}, brand = null } = {}) {
  const style = inferStyleKey(product, brand);
  const name = product.name || "your product";

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
