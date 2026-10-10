/**
 * Professional prompt composer.
 *
 * Turns a CreativeBrief + ScenePlan into a detailed, product- and brand-
 * specific video prompt. Crucially it encodes:
 *   - reference-vs-hero handling (fixes "poster -> phone mockup")
 *   - product fidelity rules
 *   - brand palette/tone as active constraints
 *   - a strong negative-rules block (no phones/posters/silver sci-fi/etc.)
 *   - "leave negative space for exact overlays" so text/logo are composited
 */

const NEGATIVE_RULES = [
  "no smartphone, tablet, laptop or any screen/device in frame",
  "do not display the uploaded poster, screenshot, frame, monitor or phone",
  "no poster-in-frame or picture-in-picture of the source image",
  "no generic silver/chrome futuristic background unless the brand actually uses it",
  "no random neon, holograms or sci-fi UI",
  "no floating or illegible AI-generated text, no invented logos",
  "no human hands unless explicitly requested",
  "do not mutate, melt, explode or redesign the product",
  "no gratuitous particles, liquid splashes or meaningless camera spins",
  "no unrelated props or clutter",
];

/**
 * @param {{
 *   brief: object, scenePlan: object,
 *   product: object, brand?: object,
 *   sourceImage?: { type: string, treatAsReference: boolean },
 *   aspectRatio?: "16:9"|"9:16",
 *   offer?: string, cta?: string,
 * }} input
 * @returns {{ prompt: string, negativePrompt: string }}
 */
export function composeVideoPrompt(input) {
  const { brief, scenePlan, product = {}, brand, sourceImage } = input;
  const productName = product.name || "the product";
  const lines = [];

  lines.push(
    `Create a premium commercial product-film scene: a professional ${scenePlan.totalDuration}-second advertisement for ${productName}${
      product.brand ? ` by ${product.brand}` : ""
    }.`
  );

  // Reference-vs-hero handling (the core quality fix).
  if (sourceImage?.treatAsReference) {
    lines.push(
      `The uploaded image is a REFERENCE ONLY (${humanType(sourceImage.type)}). Extract the actual physical product, its branding and color language from it. Do NOT animate or display the artwork, poster, frame, device or screen. Build a brand-new real-world scene featuring the physical product itself as the hero object.`
    );
  } else if (sourceImage) {
    lines.push(
      "Use the uploaded image as the EXACT hero product. Keep it clearly recognizable and build the scene around it."
    );
  }

  // Product fidelity.
  lines.push(
    `Preserve the product's exact shape, packaging proportions, bottle/box geometry, cap/lid, label placement, colors, logo and distinctive features. Do not redesign or rebrand the package.`
  );

  // Brand-aware art direction (active input).
  const b = brief.brand;
  if (b) {
    const parts = [`Brand identity — ${b.name || "the brand"}`];
    if (b.visualStyle) parts.push(`visual style: ${b.visualStyle}`);
    if (b.tone) parts.push(`tone: ${b.tone}`);
    if (b.colors?.length) parts.push(`palette: ${b.colors.join(", ")}`);
    lines.push(parts.join("; ") + ".");
    lines.push(
      `Keep the look consistent with this existing brand identity (influence: ${b.influence}). Do not invent a different personality or change the brand colors without reason.`
    );
  } else {
    lines.push(
      "No strong brand identity was detected — use clean, product-focused art direction and avoid imposing a generic 'AI luxury' silver look."
    );
  }

  // Scene direction from the plan.
  lines.push(`Art direction: ${brief.visualStyle}. Lighting: ${brief.lighting}. Environment: ${brief.environment}. Camera: ${brief.cameraLanguage}. Pacing: ${brief.pacing}.`);
  const sceneDesc = scenePlan.scenes
    .map((s, i) => `(${i + 1}) ${s.purpose}: ${s.visual}, ${s.camera}.`)
    .join(" ");
  lines.push(`Scene plan: ${sceneDesc}`);

  // Overlays handled in post.
  lines.push(
    `Produce clean footage and reserve calm negative space for exact logo, price, offer and CTA overlays, which are composited separately — do not draw promotional text or logos inside the footage.`
  );

  // Quality cues.
  lines.push(
    "Professional ecommerce commercial photography, realistic materials, natural reflections and contact shadows, controlled depth of field."
  );

  // Aspect ratio intent.
  if (input.aspectRatio) {
    lines.push(`Compose for a ${input.aspectRatio} frame.`);
  }

  // Negative rules inline (for models without a separate negative field).
  lines.push(`Avoid: ${NEGATIVE_RULES.join("; ")}.`);

  return {
    prompt: lines.join(" "),
    negativePrompt: NEGATIVE_RULES.join(", "),
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

export { NEGATIVE_RULES };
