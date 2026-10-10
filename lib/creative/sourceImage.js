/**
 * Source-image understanding.
 *
 * Before generating video, we must understand WHAT the uploaded/imported image
 * represents, because it changes the whole pipeline. The key failure we fix:
 * a static AD POSTER must NOT become "poster displayed on a phone" — it should
 * be treated as a *reference* (product + brand + art direction), and we build a
 * fresh professional product scene instead.
 *
 * Two paths:
 *  - heuristic classifier (default, no cost): hints from role/filename/aspect.
 *  - optional Gemini vision classification (lib/ai/enrich) for ambiguous cases.
 *
 * Classes:
 *   clean_product_photo | packshot | lifestyle_photo | existing_static_ad |
 *   poster | screenshot | product_on_phone | logo | multi_product_collage
 */

/**
 * Heuristic classification from available metadata (no network/AI).
 * @param {{ role?: string, url?: string, width?: number, height?: number, hintText?: string }} meta
 * @returns {{ type: string, treatAsReference: boolean, confidence: number, reason: string }}
 */
export function classifySourceImageHeuristic(meta = {}) {
  const url = (meta.url || "").toLowerCase();
  const hint = (meta.hintText || "").toLowerCase();
  const role = meta.role || "";

  const adHints = /(poster|banner|ad[-_]?creative|promo|campaign|sale|offer|hero-banner)/;
  const phoneHints = /(mockup|phone|iphone|device|screen|instagram-story|story-ad)/;
  const collageHints = /(collage|grid|bundle|set-of|lineup|range)/;
  const logoHints = /(logo|favicon|wordmark|brandmark)/;

  if (logoHints.test(url) || role === "logo") {
    return ref("logo", 0.8, "Filename/role indicates a logo, not a product scene.");
  }
  if (phoneHints.test(url) || phoneHints.test(hint)) {
    return ref("product_on_phone", 0.7, "Looks like a device/phone mockup; treat as reference.");
  }
  if (collageHints.test(url) || collageHints.test(hint)) {
    return ref("multi_product_collage", 0.65, "Multiple products detected; treat as reference.");
  }
  if (adHints.test(url) || adHints.test(hint) || role === "ad_creative" || role === "poster") {
    return ref("existing_static_ad", 0.7, "Looks like an existing ad/poster; use as reference, not literal scene.");
  }
  if (role === "lifestyle") {
    return { type: "lifestyle_photo", treatAsReference: false, confidence: 0.6, reason: "Lifestyle product photo." };
  }
  if (role === "hero_product" || role === "product_packshot") {
    return { type: "packshot", treatAsReference: false, confidence: 0.75, reason: "Clean product packshot — use the product as the hero." };
  }
  // default: assume a usable product photo
  return { type: "clean_product_photo", treatAsReference: false, confidence: 0.5, reason: "Assumed to be a product photo." };
}

function ref(type, confidence, reason) {
  return { type, treatAsReference: true, confidence, reason };
}

/**
 * Does this classification mean the image is a REFERENCE (poster/ad/collage/
 * phone/logo) rather than a literal product photo to animate?
 */
export function isReferenceType(type) {
  return [
    "existing_static_ad",
    "poster",
    "screenshot",
    "product_on_phone",
    "multi_product_collage",
    "logo",
  ].includes(type);
}
