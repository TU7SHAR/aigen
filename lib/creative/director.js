/**
 * Creative Director orchestration + deterministic fallback.
 *
 * `directStoryboard` returns an executable storyboard for a concept:
 *   1. tries the AI director (lib/ai/director.js) — reasoned, variable-length,
 *      per-shot technique, grounded;
 *   2. if the model is unavailable/failing, falls back to a CONCEPT-DRIVEN
 *      deterministic storyboard that is clearly labeled `origin: "fallback"`.
 *
 * The fallback is deliberately NOT the old establish/detail/end formula: it
 * derives shots from the concept's own fields and the real assets available, so
 * different concepts still yield different storyboards. It never invents copy —
 * it only uses the exact brand/offer/CTA passed in.
 */

import { generateStoryboardAI, SHOT_TECHNIQUES, validateStoryboard } from "../ai/director.js";
import { normalizeLanguageProfile, describeProfile } from "../i18n/profile.js";

/**
 * @param {object} input see generateStoryboardAI; must include `concept`.
 * @returns {Promise<{ storyboard: object, origin: "ai"|"fallback", aiCost?: object, note?: string }>}
 */
export async function directStoryboard(input = {}) {
  const ai = await generateStoryboardAI(input);
  if (ai?.storyboard?.shots?.length) {
    return { storyboard: ai.storyboard, origin: "ai", aiCost: ai.cost, directorModel: ai.model };
  }
  const language = normalizeLanguageProfile(input.language);
  const storyboard = fallbackStoryboard(input);
  storyboard.language = language;
  storyboard.languageLabel = describeProfile(language);
  storyboard.validation = validateStoryboard(storyboard, { language, input });
  const nonEnglish = !/^en(-|$)/.test(language.primary) || language.mode !== "single";
  if (nonEnglish) {
    storyboard.validation.findings.push({
      level: "error", code: "LANGUAGE_FALLBACK",
      message: `The AI director was unavailable, so this fallback storyboard is NOT written in ${storyboard.languageLabel}. Retry before generating.`,
    });
    storyboard.validation.ok = false;
  }
  return {
    storyboard,
    origin: "fallback",
    aiCost: ai?.cost,
    note: ai?.skipped || ai?.error || "AI director unavailable — deterministic storyboard.",
  };
}

/**
 * Concept-driven deterministic storyboard (no model). Variable shape by the
 * concept + duration + available assets. Technique per shot is chosen from what
 * REALLY exists (real_asset when an asset is available; motion_graphic otherwise).
 */
export function fallbackStoryboard(input = {}) {
  const { concept = {}, product = {}, brand = {}, durationSeconds = 8, availableAssets = [] } = input;
  const hasAsset = Array.isArray(availableAssets) && availableAssets.length > 0;
  const primaryAssetRole = hasAsset ? availableAssets[0].role || "image" : null;
  const name = product.name || brand.name || concept.proposedSubject || "the offering";
  const offer = typeof product.offer === "string" ? product.offer.trim() : "";
  const cta = typeof product.cta === "string" ? product.cta.trim() : "";

  // Build shots from the concept's own material. Each distinct concept field
  // becomes a beat, so two concepts with different messages differ structurally.
  const beats = [];

  // Hook — the concept's angle/visual idea, as a motion-graphic or real asset.
  beats.push({
    intent: "hook",
    visual: concept.visualIdea || concept.advertisingAngle || `Open on ${name}`,
    technique: hasAsset ? "real_asset" : "motion_graphic",
    assetHint: primaryAssetRole || "none",
    motion: hasAsset ? "slow push-in" : "kinetic type reveal",
    onScreenText: concept.title || "",
    voiceover: "",
    transitionOut: "fade",
  });

  // Message — the central message. Second real asset if present, else graphic.
  if (concept.centralMessage) {
    const secondAsset = hasAsset && availableAssets[1] ? availableAssets[1].role || "image" : primaryAssetRole;
    beats.push({
      intent: "message",
      visual: concept.centralMessage,
      technique: hasAsset ? "composite" : "motion_graphic",
      assetHint: secondAsset || "none",
      motion: "subtle drift",
      onScreenText: shorten(concept.centralMessage, 60),
      voiceover: "",
      transitionOut: "cut",
    });
  }

  // Offer beat — ONLY if a real offer exists (never fabricated).
  if (offer) {
    beats.push({
      intent: "offer",
      visual: `Highlight the offer for ${name}`,
      technique: "motion_graphic",
      assetHint: "none",
      motion: "pop-in",
      onScreenText: offer,
      voiceover: "",
      transitionOut: "cut",
    });
  }

  // CTA end card — brand + CTA. Deterministic by design.
  beats.push({
    intent: "cta",
    visual: `End card: ${brand.name || name}${cta ? ` — ${cta}` : ""}`,
    technique: "motion_graphic",
    assetHint: "logo",
    motion: "hold",
    onScreenText: cta || `Discover ${brand.name || name}`,
    voiceover: "",
    transitionOut: "end",
  });

  // Distribute duration across beats (weight the hook + message slightly more).
  const weights = beats.map((b) => (b.intent === "cta" ? 0.9 : b.intent === "offer" ? 0.8 : 1.1));
  const wsum = weights.reduce((a, w) => a + w, 0);
  let acc = 0;
  beats.forEach((b, i) => {
    if (i === beats.length - 1) b.durationSec = Math.max(0.8, Number((durationSeconds - acc).toFixed(2)));
    else {
      b.durationSec = Math.max(0.8, Number(((weights[i] / wsum) * durationSeconds).toFixed(2)));
      acc += b.durationSec;
    }
    if (!SHOT_TECHNIQUES.includes(b.technique)) b.technique = "motion_graphic";
  });

  return {
    logline: concept.centralMessage || concept.title || null,
    totalDurationSec: durationSeconds,
    shots: beats,
    origin: "fallback",
  };
}

function shorten(s, n) {
  s = String(s || "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
