/**
 * Template system with real creative meaning.
 *
 * A template is NOT a one-line prompt tweak. It defines lighting, camera
 * language, pacing, environment and product treatment that flow into the scene
 * plan and prompt. These are art-direction defaults the brand can override.
 */

export const TEMPLATES = {
  luxury: {
    id: "luxury",
    label: "Luxury Studio",
    lighting: "soft dramatic key light with a warm rim light; deep controlled shadows",
    camera: "slow cinematic push-in and a gentle 3/4 orbit",
    environment: "minimal premium studio with a pedestal and clean negative space",
    pacing: "slow and deliberate",
    productTreatment: "hero object emerging from shadow with tasteful reflections",
    style: "editorial, high-end commercial",
    mood: "aspirational, refined",
  },
  bold: {
    id: "bold",
    label: "Bold Performance",
    lighting: "high-contrast punchy lighting with crisp highlights",
    camera: "dynamic, confident moves with quick reframes",
    environment: "brand-colored seamless backdrop",
    pacing: "energetic",
    productTreatment: "product snaps into frame as the hero with strong presence",
    style: "high-impact paid-social commercial",
    mood: "exciting, attention-grabbing",
  },
  minimal: {
    id: "minimal",
    label: "Minimal Product Hero",
    lighting: "even, soft, shadow-light studio lighting",
    camera: "steady, controlled, minimal movement",
    environment: "clean seamless neutral background with lots of negative space",
    pacing: "calm and steady",
    productTreatment: "product centered, design-forward, nothing competing for attention",
    style: "modern, trustworthy, design-led",
    mood: "clean, confident",
  },
  "product-demo": {
    id: "product-demo",
    label: "Product Demo",
    lighting: "clear, even lighting that reveals material and detail",
    camera: "smooth orbit and macro detail inserts on key features",
    environment: "neutral surface that keeps focus on the product",
    pacing: "measured, informative",
    productTreatment: "flattering angles that highlight real physical features",
    style: "clean explanatory commercial",
    mood: "informative, credible",
  },
  "problem-solution": {
    id: "problem-solution",
    label: "Problem → Solution",
    lighting: "lighting shifts from muted/cool context to warm resolution",
    camera: "contextual open, then a confident reveal of the product",
    environment: "relatable context that resolves to a clean product beat",
    pacing: "narrative build",
    productTreatment: "product arrives as the resolution and takes the hero beat",
    style: "narrative DTC commercial",
    mood: "relatable then uplifting",
  },
  lifestyle: {
    id: "lifestyle",
    label: "Lifestyle",
    lighting: "natural, soft daylight consistent with a real environment",
    camera: "handheld-feel but stable; natural framing",
    environment: "the target customer's real-world setting",
    pacing: "relaxed, authentic",
    productTreatment: "product shown naturally in use, still clearly recognizable",
    style: "authentic lifestyle commercial",
    mood: "warm, aspirational-real",
  },
};

export const TEMPLATE_IDS = Object.keys(TEMPLATES);

export function getTemplate(id) {
  return TEMPLATES[id] || TEMPLATES.minimal;
}
