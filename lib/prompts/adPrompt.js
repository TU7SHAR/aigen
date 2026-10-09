/**
 * Advertisement prompt generation.
 *
 * Turns structured product fields + a chosen template into a single video-gen
 * prompt. Prompts strongly discourage altering the product's packaging, logo,
 * shape and color — but note that generative models can still change products,
 * so we do NOT promise perfect fidelity.
 */

/** @typedef {"luxury"|"bold"|"minimal"|"product-demo"|"problem-solution"} TemplateId */

const TEMPLATE_DIRECTION = {
  luxury:
    "Elegant, premium cinematic ad. Slow push-in, soft volumetric lighting, shallow depth of field, tasteful reflections. Mood: aspirational, refined.",
  bold:
    "High-energy, punchy ad. Quick dynamic camera moves, vivid saturated color, strong contrast, confident pacing. Mood: exciting, attention-grabbing.",
  minimal:
    "Clean studio ad. Seamless neutral background, even soft lighting, steady controlled motion, lots of negative space. Mood: modern, trustworthy.",
  "product-demo":
    "Clear product demonstration. Show the product from flattering angles and highlight key physical features with smooth orbiting / rotating motion.",
  "problem-solution":
    "Narrative problem-then-solution ad. Open on the relatable problem context, then reveal the product as the resolution with an uplifting shift in tone.",
};

export const TEMPLATE_LABELS = {
  luxury: "Luxury Reveal",
  bold: "Bold & Punchy",
  minimal: "Clean Studio",
  "product-demo": "Product Demo",
  "problem-solution": "Problem → Solution",
};

/**
 * @param {{
 *   productName?: string,
 *   brand?: string,
 *   description?: string,
 *   offer?: string,
 *   cta?: string,
 *   template: TemplateId,
 *   durationSeconds?: number,
 *   hasImage?: boolean,
 * }} input
 * @returns {string}
 */
export function buildAdPrompt(input) {
  const {
    productName = "the product",
    brand = "",
    description = "",
    offer = "",
    cta = "",
    template,
    durationSeconds = 8,
    hasImage = false,
  } = input;

  const direction =
    TEMPLATE_DIRECTION[template] || TEMPLATE_DIRECTION.minimal;

  const lines = [
    `Create a ${durationSeconds}-second product advertisement video for ${productName}${
      brand ? ` by ${brand}` : ""
    }.`,
    direction,
  ];

  if (description) lines.push(`Product context: ${description}.`);
  if (offer) lines.push(`Highlight this offer visually (no on-screen text needed): ${offer}.`);

  // Product-fidelity guardrails.
  lines.push(
    hasImage
      ? "Use the provided reference image as the exact product. Keep the product's packaging, logo, label text, shape, proportions and colors unchanged. Do not redesign, rebrand, or restyle the product. Animate the scene and camera around it."
      : "Keep any depicted product plausible and consistent; do not invent brand logos or fake label text."
  );

  // We prefer compositing precise text/logo/price later, so avoid baked-in text.
  lines.push(
    "Avoid rendering readable marketing text, prices, logos or captions inside the footage; those will be added later in post. Focus on clean footage with space for overlays."
  );

  if (cta) {
    lines.push(
      `Leave a visually calm final beat suitable for a call-to-action overlay ("${cta}").`
    );
  }

  return lines.join(" ");
}
