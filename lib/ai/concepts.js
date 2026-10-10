/**
 * AI creative-concept generation.
 *
 * Generates a small set of GENUINELY DIFFERENT advertising concepts by reasoning
 * from the actual source evidence (entity understanding, offering, brand/design,
 * objective) — NOT by looking up a fixed per-industry list. This is the
 * de-hardcoded replacement for the old ENTITY_SETS/SETS tables.
 *
 * Uses the cheap enrichment TEXT model (no video cost). Strict JSON via
 * responseSchema. Grounded in evidence: concepts must not invent prices,
 * results, testimonials, guarantees, metrics or claims not present in the input.
 * Degrades gracefully — on no key/disabled/failure the caller falls back to a
 * clearly-labeled deterministic generator.
 */

import { GoogleGenAI, Type } from "@google/genai";
import { getGeminiApiKey, getEnrichmentModel, isEnrichmentEnabled } from "../config.js";
import { costFromUsage } from "../costs/estimate.js";

function conceptSchema() {
  const S = Type;
  const strArr = { type: S.ARRAY, items: { type: S.STRING } };
  return {
    type: S.OBJECT,
    properties: {
      concepts: {
        type: S.ARRAY,
        items: {
          type: S.OBJECT,
          properties: {
            id: { type: S.STRING },
            title: { type: S.STRING },
            objective: { type: S.STRING },
            advertisingAngle: { type: S.STRING },
            centralMessage: { type: S.STRING },
            visualIdea: { type: S.STRING },
            proposedSubject: { type: S.STRING },
            recommendedProductionMethod: {
              type: S.STRING,
              enum: ["image_to_video", "text_to_video", "hybrid", "motion_graphics"],
            },
            assetRequirements: strArr,
            sourceEvidence: strArr,
            estimatedComplexity: { type: S.STRING, enum: ["low", "medium", "high"] },
          },
          required: ["id", "title", "objective", "centralMessage", "visualIdea"],
        },
      },
    },
    required: ["concepts"],
  };
}

const SYSTEM = `You are an advertising creative strategist. Given structured evidence about a business/offering, propose 3–4 DISTINCT advertising concepts for a short video ad.
RULES:
- Ground every concept in the provided evidence. Do NOT invent prices, discounts, results, testimonials, guarantees, customer counts, certifications, medical/financial outcomes or statistics.
- Concepts must be meaningfully different in objective, angle, message and visual idea — not the same idea reworded.
- Do NOT assume a physical product unless the offering is actually a physical product. For software/services/creators, the concept must not depict invented physical packaging.
- "proposedSubject" is what the viewer literally sees (e.g. "the app's real interface", "a relatable customer situation", "the physical product as hero").
- Prefer production methods achievable from the available assets: if there is a real product image, image_to_video is reasonable; if only brand/UI references, hybrid/motion_graphics.
- sourceEvidence lists which input facts justify the concept.
- Keep each field concise.`;

/**
 * @param {{
 *   entity?: object,          // EntityUnderstanding-ish (name/type/industry/offering)
 *   product?: object,         // merged profile (name/description/benefits/offer/cta...)
 *   brand?: object, design?: object,
 *   objective?: string,       // user's advertising objective, if any
 *   hasUsableImage?: boolean,
 * }} input
 */
export async function generateConceptsAI(input = {}) {
  const model = getEnrichmentModel();
  if (!isEnrichmentEnabled() || !getGeminiApiKey()) {
    return { concepts: null, model, cost: { amountUsd: 0, state: "estimated" }, skipped: "AI concepts disabled / no key." };
  }

  const evidence = buildEvidence(input);
  if (!evidence || evidence.length < 30) {
    return { concepts: null, model, cost: { amountUsd: 0, state: "estimated" }, skipped: "Not enough evidence for AI concepts." };
  }

  const ai = new GoogleGenAI({ apiKey: getGeminiApiKey() });
  try {
    const resp = await ai.models.generateContent({
      model,
      contents: evidence,
      config: {
        systemInstruction: SYSTEM,
        responseMimeType: "application/json",
        responseSchema: conceptSchema(),
        temperature: 0.6, // some creative variety, still grounded
      },
    });
    let parsed;
    try {
      parsed = JSON.parse(resp.text);
    } catch {
      return { concepts: null, model, cost: { amountUsd: null, state: "unknown" }, error: "AI concepts returned non-JSON." };
    }
    const concepts = sanitizeConcepts(parsed.concepts);
    if (!concepts.length) {
      return { concepts: null, model, cost: { amountUsd: null, state: "unknown" }, error: "AI returned no usable concepts." };
    }
    const u = resp.usageMetadata;
    const usage = u
      ? { total_input_tokens: u.promptTokenCount, total_output_tokens: u.candidatesTokenCount, total_tokens: u.totalTokenCount, videoOutputTokens: 0 }
      : null;
    return { concepts, model, usage, cost: usage ? costFromUsage(usage) : { amountUsd: null, state: "unknown" } };
  } catch (err) {
    return { concepts: null, model, cost: { amountUsd: null, state: "unknown" }, error: `AI concepts failed: ${err?.message || "unknown"}` };
  }
}

function buildEvidence(input) {
  const { entity = {}, product = {}, brand = {}, design = {}, objective, hasUsableImage } = input;
  const lines = [];
  const push = (label, v) => {
    if (v == null || v === "" || (Array.isArray(v) && !v.length)) return;
    lines.push(`${label}: ${Array.isArray(v) ? v.slice(0, 6).join("; ") : v}`);
  };
  push("Name", product.name || entity.name);
  push("Entity type", entity.entityType || product.entityType);
  push("Industry", entity.industry);
  push("Niche", entity.niche || entity.subcategory);
  push("What it is", product.description || entity.description);
  push("Advertised offering", entity.advertisedOffering?.name || product.offer);
  push("Features", product.features);
  push("Benefits", product.benefits);
  push("Differentiators", product.differentiators);
  push("Audience", product.targetCustomer || (Array.isArray(product.targetAudience) ? product.targetAudience[0] : null));
  push("Offer", product.offer);
  push("CTA", product.cta);
  push("Brand visual style", brand.visualStyle);
  push("Brand tone", brand.toneOfVoice);
  push("Brand palette", (design?.palette?.primary || brand.primaryColors || []).slice(0, 4));
  push("Advertising objective", objective);
  push("Usable product/visual reference available", hasUsableImage ? "yes" : "no");
  return lines.join("\n");
}

function sanitizeConcepts(arr) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const out = [];
  for (const c of arr.slice(0, 5)) {
    if (!c || typeof c !== "object") continue;
    const title = str(c.title);
    if (!title) continue;
    let id = str(c.id) || title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
    if (seen.has(id)) id = id + "-" + out.length;
    seen.add(id);
    out.push({
      id,
      title,
      objective: str(c.objective),
      advertisingAngle: str(c.advertisingAngle),
      centralMessage: str(c.centralMessage),
      visualIdea: str(c.visualIdea),
      proposedSubject: str(c.proposedSubject),
      recommendedProductionMethod: ["image_to_video", "text_to_video", "hybrid", "motion_graphics"].includes(c.recommendedProductionMethod)
        ? c.recommendedProductionMethod
        : null,
      assetRequirements: list(c.assetRequirements),
      sourceEvidence: list(c.sourceEvidence),
      estimatedComplexity: ["low", "medium", "high"].includes(c.estimatedComplexity) ? c.estimatedComplexity : "medium",
      // marker so downstream + UI know this was AI-reasoned, not a template
      origin: "ai",
    });
  }
  return out;
}

function str(x) {
  return typeof x === "string" && x.trim() ? x.trim() : null;
}
function list(x) {
  return Array.isArray(x) ? x.filter((s) => typeof s === "string" && s.trim()).slice(0, 6) : [];
}
