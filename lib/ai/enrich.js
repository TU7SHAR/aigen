/**
 * AI semantic enrichment — turns the compact reduced context into a structured
 * EntityProfile using a cheap Gemini text model (NOT the video model).
 *
 * Principles:
 *  - Strict JSON output via responseSchema; every field nullable.
 *  - "If not supported by the source content, return null or [] — never guess."
 *  - Facts are NOT fabricated: no invented prices/discounts/guarantees/claims.
 *  - Degrades gracefully: if no key / disabled / failure, returns
 *    { enriched: null, ... } rather than throwing, so import still works.
 *  - Reports token usage + a billed-cost estimate so enrichment cost is tracked
 *    separately from video cost.
 */

import { Type } from "@google/genai";
import {
  getGeminiApiKey,
  getEnrichmentModel,
  isEnrichmentEnabled,
} from "../config.js";
import { generateJson } from "./textModel.js";

const ENTITY_TYPES = [
  "ecommerce_product", "ecommerce_store", "saas", "service",
  "business", "creator", "portfolio", "course", "app",
  "landing_page", "unknown",
];

/** Zod-free JSON schema for the Gemini SDK responseSchema. */
function responseSchema() {
  const S = Type;
  const strOrNull = { type: S.STRING, nullable: true };
  const strArr = { type: S.ARRAY, items: { type: S.STRING } };
  return {
    type: S.OBJECT,
    properties: {
      entityType: { type: S.STRING, enum: ENTITY_TYPES },
      name: strOrNull,
      brandName: strOrNull,
      shortDescription: strOrNull,
      description: strOrNull,
      primaryOffer: strOrNull,
      offers: strArr,
      category: strOrNull,
      features: strArr,
      benefits: strArr,
      targetAudience: strArr,
      useCases: strArr,
      differentiators: strArr,
      pricing: {
        type: S.OBJECT,
        nullable: true,
        properties: {
          value: { type: S.NUMBER, nullable: true },
          currency: strOrNull,
          billingPeriod: strOrNull,
        },
      },
      callsToAction: strArr,
      socialProof: strArr,
      brand: {
        type: S.OBJECT,
        properties: {
          tagline: strOrNull,
          tone: strOrNull,
          visualStyle: strOrNull,
          positioning: strOrNull,
          keywords: strArr,
        },
      },
      confidence: { type: S.NUMBER },
    },
    required: ["entityType", "confidence"],
  };
}

const SYSTEM_INSTRUCTION = `You convert cleaned website evidence into a strict structured profile for building an advertisement.
RULES:
- Only use information SUPPORTED by the provided content. If a field is not supported, return null (or [] for lists). Never guess.
- NEVER invent prices, discounts, guarantees, statistics, audience claims or features that aren't in the content.
- "description"/"shortDescription" must paraphrase what the site actually says.
- "targetAudience", "differentiators", "benefits" may be reasonable interpretations of the content, but must be grounded in it.
- Pick the single best entityType.
- confidence (0..1) reflects how well the content let you understand the entity.`;

/**
 * @param {{ context: string, hintEntityType?: string }} input
 * @returns {Promise<{
 *   enriched: object | null,
 *   model: string,
 *   usage: object | null,
 *   cost: object,
 *   skipped?: string,
 *   error?: string,
 * }>}
 */
export async function enrichFromContext({ context, hintEntityType } = {}) {
  const model = getEnrichmentModel();

  if (!isEnrichmentEnabled() || !getGeminiApiKey()) {
    return {
      enriched: null,
      model,
      usage: null,
      cost: { amountUsd: 0, state: "estimated" },
      skipped: "AI enrichment disabled or no GEMINI_API_KEY — using deterministic extraction only.",
    };
  }
  if (!context || context.length < 40) {
    return {
      enriched: null,
      model,
      usage: null,
      cost: { amountUsd: 0, state: "estimated" },
      skipped: "Not enough crawled content to enrich.",
    };
  }

  const prompt = `${hintEntityType ? `Likely entity type hint: ${hintEntityType}.\n\n` : ""}EVIDENCE:\n${context}`;

  try {
    const res = await generateJson({
      purpose: "enrichment",
      label: "source enrichment",
      systemInstruction: SYSTEM_INSTRUCTION,
      contents: prompt,
      schema: responseSchema(),
      temperature: 0.2,
    });
    return { enriched: sanitize(res.json), model: res.model, usage: res.usage, cost: res.cost, attempts: res.attempts };
  } catch (err) {
    return {
      enriched: null,
      model,
      usage: null,
      cost: { amountUsd: null, state: "unknown" },
      error: `Enrichment failed (${err?.message || "unknown"}); using deterministic data only.`,
    };
  }
}

/** Clamp/trim AI output defensively. */
function sanitize(p) {
  if (!p || typeof p !== "object") return null;
  const arr = (x) => (Array.isArray(x) ? x.filter((s) => typeof s === "string" && s.trim()).slice(0, 12) : []);
  const str = (x) => (typeof x === "string" && x.trim() ? x.trim() : null);
  return {
    entityType: ENTITY_TYPES.includes(p.entityType) ? p.entityType : "unknown",
    name: str(p.name),
    brandName: str(p.brandName),
    shortDescription: str(p.shortDescription),
    description: str(p.description),
    primaryOffer: str(p.primaryOffer),
    offers: arr(p.offers),
    category: str(p.category),
    features: arr(p.features),
    benefits: arr(p.benefits),
    targetAudience: arr(p.targetAudience),
    useCases: arr(p.useCases),
    differentiators: arr(p.differentiators),
    pricing:
      p.pricing && typeof p.pricing === "object"
        ? {
            value: typeof p.pricing.value === "number" ? p.pricing.value : null,
            currency: str(p.pricing.currency),
            billingPeriod: str(p.pricing.billingPeriod),
          }
        : null,
    callsToAction: arr(p.callsToAction),
    socialProof: arr(p.socialProof),
    brand:
      p.brand && typeof p.brand === "object"
        ? {
            tagline: str(p.brand.tagline),
            tone: str(p.brand.tone),
            visualStyle: str(p.brand.visualStyle),
            positioning: str(p.brand.positioning),
            keywords: arr(p.brand.keywords),
          }
        : null,
    confidence: typeof p.confidence === "number" ? Math.max(0, Math.min(1, p.confidence)) : 0.5,
  };
}
