/**
 * Entity-aware prompt composer.
 *
 * Turns a CreativeBrief + ScenePlan + Entity Strategy into the single canonical
 * video prompt. Physical-product language appears ONLY for physical products;
 * SaaS/service/creator/etc. get their own fidelity + negatives + quality cues.
 * Also encodes reference-vs-hero handling (fixes "poster -> phone mockup").
 */

import { getEntityStrategy } from "./entityStrategies.js";

const SHARED_NEGATIVES = [
  "no smartphone, tablet, laptop or any screen/device in frame unless explicitly requested",
  "do not display the uploaded poster, screenshot, frame, monitor or phone",
  "no poster-in-frame or picture-in-picture of the source image",
  "no generic silver/chrome futuristic background unless the brand actually uses it",
  "no random neon, holograms or sci-fi UI",
  "no floating or illegible AI-generated text, no invented logos",
  "no human hands unless explicitly requested",
  "no gratuitous particles, liquid splashes or meaningless camera spins",
  "no unrelated props or clutter",
];

/**
 * @param {{
 *   brief: object, scenePlan: object,
 *   entityType?: string,
 *   product: object, brand?: object, design?: object,
 *   sourceImage?: { type: string, treatAsReference: boolean },
 *   aspectRatio?: "16:9"|"9:16",
 *   offer?: string, cta?: string,
 * }} input
 * @returns {{ prompt: string, negativePrompt: string, negativeRules: string[] }}
 */
export function composeVideoPrompt(input) {
  const { brief, scenePlan, product = {}, brand, sourceImage } = input;
  const strategy = getEntityStrategy(input.entityType || brief.entityType || product.entityType);
  const subjectNoun = strategy.subjectNoun;
  const name = product.name || `the ${subjectNoun}`;
  const lines = [];

  // Entity-appropriate opening (NOT "product-film" for non-physical entities).
  if (strategy.allowsPhysicalLanguage) {
    lines.push(
      `Create a premium commercial product-film scene: a professional ${scenePlan.totalDuration}-second advertisement for ${name}${product.brand ? ` by ${product.brand}` : ""}.`
    );
  } else {
    lines.push(
      `Create a professional ${scenePlan.totalDuration}-second brand advertisement for ${name}${product.brand ? ` by ${product.brand}` : ""}, a ${subjectNoun}. This is NOT a physical product — do not depict any physical object, package or container.`
    );
  }

  // --- Extracted facts actually drive the message (previously discarded) ---
  // What it is.
  if (product.description) {
    lines.push(`What it is: ${truncate(product.description, 220)}`);
  }
  // The selected concept's communication intent (makes concepts meaningfully
  // different, not just a style label).
  const conceptIntent = conceptMessage(input.concept, product, subjectNoun);
  if (conceptIntent) lines.push(`Ad message / angle: ${conceptIntent}`);
  // Strongest benefits / differentiators, grounded in the source.
  const benefits = list(product.benefits).slice(0, 2);
  if (benefits.length) lines.push(`Convey these benefits (do not invent others): ${benefits.join("; ")}.`);
  const diffs = list(product.differentiators).slice(0, 2);
  if (diffs.length) lines.push(`Differentiators to imply visually: ${diffs.join("; ")}.`);
  if (product.targetCustomer) lines.push(`Intended audience: ${truncate(product.targetCustomer, 120)}.`);

  // Reference-vs-hero handling.
  if (sourceImage?.treatAsReference) {
    lines.push(
      `The provided image is a REFERENCE ONLY (${humanType(sourceImage.type)}). Extract the ${subjectNoun}'s identity, branding and color language from it. Do NOT animate or display the artwork, poster, frame, device or screen; build a fresh scene.`
    );
  } else if (sourceImage) {
    lines.push(
      strategy.allowsPhysicalLanguage
        ? "Use the provided image as the EXACT hero product; keep it clearly recognizable and build the scene around it."
        : "Use the provided image as an accurate visual reference for the brand/interface; keep it recognizable."
    );
  }

  // Entity-specific fidelity.
  lines.push(strategy.fidelityRule);

  // Brand / design art direction.
  const b = brief.brand;
  if (b && (b.visualStyle || b.colors?.length)) {
    const parts = [`Brand identity — ${b.name || "the brand"}`];
    if (b.visualStyle) parts.push(`visual style: ${b.visualStyle}`);
    if (b.tone) parts.push(`tone: ${b.tone}`);
    if (b.colors?.length) parts.push(`palette: ${b.colors.join(", ")}`);
    if (b.motifs?.length) parts.push(`motifs: ${b.motifs.join(", ")}`);
    lines.push(parts.join("; ") + ".");
    lines.push(
      `Keep the look consistent with this existing brand identity (influence: ${b.influence}). Do not invent a different personality or change the brand colors without reason.`
    );
  } else {
    lines.push(
      "No strong brand identity was detected — use clean, brand-neutral art direction and avoid a generic 'AI silver' look."
    );
  }

  // Scene direction from the plan.
  lines.push(`Art direction: ${brief.visualStyle}. Lighting: ${brief.lighting}. Environment: ${brief.environment}. Camera: ${brief.cameraLanguage}. Pacing: ${brief.pacing}.`);
  lines.push(
    "Scene plan: " +
      scenePlan.scenes.map((s, i) => `(${i + 1}) ${s.purpose}: ${s.visual}, ${s.camera}.`).join(" ")
  );

  // Offer + CTA shape the final beat (reserved for exact overlays in post).
  const offer = input.offer || product.offer;
  const cta = input.cta || product.cta;
  if (offer) {
    lines.push(
      `Reserve the final beat to feature this offer (added as an exact overlay in post, NOT drawn by the model): "${truncate(offer, 100)}".`
    );
  }
  if (cta) {
    lines.push(
      `End on a clear call-to-action moment for "${truncate(cta, 60)}" with calm negative space reserved for the exact CTA overlay.`
    );
  }

  // Overlays handled in post.
  lines.push(
    "Produce clean footage and reserve calm negative space for exact logo, text and CTA overlays, which are composited separately — do not draw promotional text or logos inside the footage."
  );

  // Entity-specific quality cues.
  lines.push(strategy.quality);

  if (input.aspectRatio) lines.push(`Compose for a ${input.aspectRatio} frame.`);

  const negativeRules = [...SHARED_NEGATIVES, ...(strategy.extraNegatives || [])];
  lines.push(`Avoid: ${negativeRules.join("; ")}.`);

  return {
    prompt: lines.join(" "),
    negativePrompt: negativeRules.join(", "),
    negativeRules,
  };
}

function humanType(type) {
  return (
    {
      existing_static_ad: "an existing static ad",
      poster: "a poster",
      screenshot: "a screenshot",
      product_on_phone: "a device/phone mockup",
      multi_product_collage: "a multi-product collage",
      logo: "a logo",
    }[type] || "a reference image"
  );
}

function truncate(s, n) {
  s = String(s || "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
}
function list(x) {
  return Array.isArray(x) ? x.filter((v) => typeof v === "string" && v.trim()) : [];
}

/**
 * Translate the SELECTED concept into a concrete communication intent, so two
 * concepts for the same entity yield genuinely different prompts. Falls back to
 * the concept's own rationale, then null.
 */
function conceptMessage(concept, product, subjectNoun) {
  if (!concept) return null;
  const name = product.name || `the ${subjectNoun}`;
  const byId = {
    "how-it-works": `clearly convey HOW ${name} works, step by step, from the user's first action to the result they receive`,
    "feature-flow": `walk through ${name}'s key capabilities as a confident flow`,
    "problem-solution": `establish the problem the audience faces, then present ${name} as the resolution`,
    "problem-workflow": `show the friction the audience faces, then ${name} resolving it`,
    outcome: `lead with the concrete outcome / result users get from ${name}`,
    "outcome-story": `tell a short outcome story centered on what users achieve with ${name}`,
    "brand-intro": `introduce ${name} and its positioning with a confident brand-first tone`,
    "product-reveal": `reveal ${name} cleanly and establish what it is`,
    "app-reveal": `reveal ${name}'s core experience/screen clearly`,
    "service-story": `tell a concise story of the service ${name} provides and who it helps`,
    "trust-proof": `project credibility and trust (only using evidence actually present — do NOT invent results, returns, testimonials or guarantees)`,
    transformation: `show a before→after transformation the audience can achieve`,
    authority: `establish authority and credibility`,
    "social-proof": `lead with momentum/credibility (only real, provided proof — invent nothing)`,
    offer: `center the specific, verified offer and drive the call-to-action`,
    story: `tell a short relatable story that leads to ${name}`,
  };
  return byId[concept.id] || concept.rationale || null;
}

export { SHARED_NEGATIVES, conceptMessage };
