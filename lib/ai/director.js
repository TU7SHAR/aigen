/**
 * AI Creative Director — generates an EXECUTABLE, variable-length storyboard
 * for a chosen advertising concept.
 *
 * This is the step that was missing: concepts (lib/ai/concepts.js) propose an
 * idea; the Director turns ONE chosen concept into a concrete shot-by-shot plan
 * that different production techniques can execute. It replaces the old fixed
 * establish/detail/end formula — the number of shots, their intent, visuals,
 * motion and chosen technique are REASONED per request, not templated.
 *
 * Design rules (match the product vision):
 *  - No hardcoded concepts, no per-industry template. Entity type is only an
 *    INPUT signal + a safety constraint (allowsPhysicalLanguage), never a
 *    selector that picks a canned storyboard.
 *  - Grounded: shots may only use facts/assets present in the evidence. No
 *    invented prices, claims, UI or packaging.
 *  - Each shot declares a production TECHNIQUE so the per-scene router can
 *    execute it with the right tool:
 *      real_asset     — animate an actual crawled/uploaded image (deterministic)
 *      motion_graphic — brand-colored type/graphics card (deterministic)
 *      ai_image       — generate a brand-aligned still, then animate it (needs image model)
 *      ai_video       — generate footage with a video model (needs video provider; paid-gated)
 *      composite      — real asset + deterministic overlays combined
 *  - Uses the cheap enrichment TEXT model (no video cost). Degrades gracefully:
 *    on no key / disabled / failure the caller falls back to a deterministic
 *    storyboard that is clearly labeled.
 */

import { GoogleGenAI, Type } from "@google/genai";
import { getGeminiApiKey, getEnrichmentModel, isEnrichmentEnabled } from "../config.js";
import { costFromUsage } from "../costs/estimate.js";

export const SHOT_TECHNIQUES = ["real_asset", "motion_graphic", "ai_image", "ai_video", "composite"];

function storyboardSchema() {
  const S = Type;
  return {
    type: S.OBJECT,
    properties: {
      logline: { type: S.STRING },
      totalDurationSec: { type: S.NUMBER },
      shots: {
        type: S.ARRAY,
        items: {
          type: S.OBJECT,
          properties: {
            intent: { type: S.STRING },           // narrative purpose of THIS shot
            durationSec: { type: S.NUMBER },
            visual: { type: S.STRING },            // what the viewer literally sees
            technique: { type: S.STRING, enum: SHOT_TECHNIQUES },
            assetHint: { type: S.STRING },         // which available asset/role, or "none"
            motion: { type: S.STRING },            // camera/subject movement
            onScreenText: { type: S.STRING },      // exact copy to render deterministically ("" if none)
            voiceover: { type: S.STRING },         // VO/narration line ("" if none)
            transitionOut: { type: S.STRING },     // cut/fade/slide/etc. into next shot
          },
          required: ["intent", "durationSec", "visual", "technique"],
        },
      },
    },
    required: ["shots"],
  };
}

const SYSTEM = `You are an AI creative director for short video advertisements. Given a chosen advertising concept plus evidence about the business and its available assets, produce an EXECUTABLE storyboard.

RULES:
- Design the storyboard to express THIS specific concept. Shot count, pacing and structure must fit the idea and the total duration — do NOT force a fixed establish/detail/end formula. A tight 5s ad might be 1–2 shots; a 15s ad might be 4–6.
- Ground every shot in the evidence. Never invent prices, discounts, metrics, testimonials, guarantees, product packaging, or UI that isn't described as available.
- For each shot choose the TECHNIQUE that best serves the intent AND is honest about available assets:
    real_asset: when a genuine product photo / UI screenshot exists and fidelity matters.
    motion_graphic: brand-colored kinetic typography / graphics (great for hooks, stats-free messages, CTAs).
    ai_image: a brand-aligned generated still when no real asset fits and exact fidelity is not required.
    ai_video: generated footage for cinematic/B-roll moments where no real asset exists.
    composite: a real asset plus deterministic overlays.
- onScreenText and voiceover must be exact, publishable copy grounded in evidence. Use the real brand name, offer and CTA when provided; otherwise leave them empty rather than inventing.
- If the entity is NOT a physical product, do NOT depict physical packaging or a product-as-hero.
- Keep each field concise and concrete (a production engine must act on it).`;

/**
 * Generate a storyboard for one concept.
 * @param {{
 *   concept: object,                    // a chosen concept (from concepts.js)
 *   entityType?: string,
 *   allowsPhysicalLanguage?: boolean,   // safety constraint, NOT a template selector
 *   durationSeconds?: number,
 *   aspectRatio?: string,
 *   availableAssets?: { role?: string, kind?: string }[], // what real assets exist
 *   product?: object, brand?: object, design?: object,
 *   emphasis?: string[], avoid?: string[],
 * }} input
 */
export async function generateStoryboardAI(input = {}) {
  const model = getEnrichmentModel();
  if (!isEnrichmentEnabled() || !getGeminiApiKey()) {
    return { storyboard: null, model, cost: { amountUsd: 0, state: "estimated" }, skipped: "AI director disabled / no key." };
  }
  const evidence = buildEvidence(input);
  if (!evidence || evidence.length < 30) {
    return { storyboard: null, model, cost: { amountUsd: 0, state: "estimated" }, skipped: "Not enough evidence for a storyboard." };
  }

  const ai = new GoogleGenAI({ apiKey: getGeminiApiKey() });
  try {
    const resp = await ai.models.generateContent({
      model,
      contents: evidence,
      config: {
        systemInstruction: SYSTEM,
        responseMimeType: "application/json",
        responseSchema: storyboardSchema(),
        temperature: 0.7, // creative variety across concepts, still grounded
      },
    });
    let parsed;
    try {
      parsed = JSON.parse(resp.text);
    } catch {
      return { storyboard: null, model, cost: { amountUsd: null, state: "unknown" }, error: "Director returned non-JSON." };
    }
    const storyboard = sanitizeStoryboard(parsed, input);
    if (!storyboard?.shots?.length) {
      return { storyboard: null, model, cost: { amountUsd: null, state: "unknown" }, error: "Director returned no usable shots." };
    }
    const u = resp.usageMetadata;
    const usage = u
      ? { total_input_tokens: u.promptTokenCount, total_output_tokens: u.candidatesTokenCount, total_tokens: u.totalTokenCount, videoOutputTokens: 0 }
      : null;
    return { storyboard, model, usage, cost: usage ? costFromUsage(usage) : { amountUsd: null, state: "unknown" } };
  } catch (err) {
    return { storyboard: null, model, cost: { amountUsd: null, state: "unknown" }, error: `Director failed: ${err?.message || "unknown"}` };
  }
}

function buildEvidence(input) {
  const { concept = {}, product = {}, brand = {}, design = {}, availableAssets = [], emphasis = [], avoid = [] } = input;
  const lines = [];
  const push = (label, v) => {
    if (v == null || v === "" || (Array.isArray(v) && !v.length)) return;
    lines.push(`${label}: ${Array.isArray(v) ? v.slice(0, 8).join("; ") : v}`);
  };
  push("CONCEPT title", concept.title);
  push("CONCEPT central message", concept.centralMessage);
  push("CONCEPT visual idea", concept.visualIdea);
  push("CONCEPT angle", concept.advertisingAngle);
  push("CONCEPT subject (what the viewer sees)", concept.proposedSubject);
  push("Entity type", input.entityType);
  push("Physical product allowed", input.allowsPhysicalLanguage ? "yes" : "no — do not depict physical packaging");
  push("Target duration (seconds)", input.durationSeconds);
  push("Aspect ratio", input.aspectRatio);
  push("Product/brand name", product.name || brand.name);
  push("What it is", product.description);
  push("Benefits", product.benefits);
  push("Differentiators", product.differentiators);
  push("Audience", product.targetCustomer);
  push("Exact offer (use verbatim or omit)", product.offer);
  push("Exact CTA (use verbatim or omit)", product.cta);
  push("Brand palette", (design?.palette?.primary || brand.primaryColors || []).slice(0, 4));
  push("Brand tone", brand.toneOfVoice);
  push(
    "Available real assets (role:kind)",
    availableAssets.map((a) => `${a.role || "image"}:${a.kind || "image"}`)
  );
  push("Must EMPHASIZE", emphasis);
  push("Must NOT appear", avoid);
  return lines.join("\n");
}

/** Clamp + normalize the model's storyboard; scale shot durations to the target. */
function sanitizeStoryboard(parsed, input) {
  const rawShots = Array.isArray(parsed?.shots) ? parsed.shots : [];
  const shots = [];
  for (const s of rawShots.slice(0, 8)) {
    if (!s || typeof s !== "object") continue;
    const visual = str(s.visual);
    const intent = str(s.intent);
    if (!visual && !intent) continue;
    shots.push({
      intent: intent || "shot",
      visual: visual || intent,
      durationSec: num(s.durationSec, 2.5),
      technique: SHOT_TECHNIQUES.includes(s.technique) ? s.technique : "motion_graphic",
      assetHint: str(s.assetHint) || "none",
      motion: str(s.motion) || "subtle",
      onScreenText: typeof s.onScreenText === "string" ? s.onScreenText.trim() : "",
      voiceover: typeof s.voiceover === "string" ? s.voiceover.trim() : "",
      transitionOut: str(s.transitionOut) || "cut",
    });
  }
  if (!shots.length) return null;

  // Scale shot durations to the requested total (keep relative weighting).
  const target = num(input.durationSeconds, num(parsed.totalDurationSec, 8));
  const sum = shots.reduce((a, s) => a + s.durationSec, 0) || shots.length;
  let acc = 0;
  shots.forEach((s, i) => {
    if (i === shots.length - 1) {
      s.durationSec = Math.max(0.8, Number((target - acc).toFixed(2)));
    } else {
      s.durationSec = Math.max(0.8, Number(((s.durationSec / sum) * target).toFixed(2)));
      acc += s.durationSec;
    }
  });

  return {
    logline: str(parsed.logline) || null,
    totalDurationSec: target,
    shots,
    origin: "ai",
  };
}

function str(x) {
  return typeof x === "string" && x.trim() ? x.trim() : null;
}
function num(x, d) {
  const n = Number(x);
  return Number.isFinite(n) && n > 0 ? n : d;
}
