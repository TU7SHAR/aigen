/**
 * Campaign focus — WHAT exactly the ad is about, chosen before any paid media.
 *
 * A homepage can show many unrelated products and promotions (the H&M case:
 * a bodysuit, a beaded slip dress, trousers, an editorial look and a brushed
 * gold texture). Mixing them produces an incoherent ad. This step picks one
 * defensible focus — a single product, a coherent collection with a shared
 * theme, or the brand/service itself — names the images that belong to it,
 * rejects the ones that do not (with reasons), and asks ONE concise question
 * when the evidence is too ambiguous to choose responsibly.
 *
 * Uses the creative text model with image thumbnails (≈ $0.003). Falls back
 * to a deterministic choice that is clearly labelled low-confidence.
 */

import sharp from "sharp";
import { Type } from "@google/genai";
import { getGeminiApiKey, isEnrichmentEnabled } from "../config.js";
import { generateJson } from "../ai/textModel.js";

const PRODUCT_ROLES = new Set(["hero_product", "product_packshot", "alternate_angle", "lifestyle", "hero_visual"]);
const NEVER_FOCUS = new Set(["logo", "icon", "navigation_asset", "unrelated", "texture_background"]);

/** Deterministic fallback focus (low confidence, labelled). */
export function heuristicFocus({ assets = [], entityType, name }) {
  const usable = assets.filter((a) => !NEVER_FOCUS.has(a.role) && a.quality?.verdict !== "blank");
  const single = /ecommerce_product|physical_product/.test(entityType || "");
  const products = usable.filter((a) => PRODUCT_ROLES.has(a.role));
  const pick = single ? usable.slice(0, 3) : (products.length ? products : usable).slice(0, 4);
  return {
    type: single ? "single_product" : /saas|app/.test(entityType || "") ? "software" : /service|business/.test(entityType || "") ? "brand" : "collection",
    title: name || null,
    rationale: single ? "Product page: the page's own product." : "Chosen without visual understanding — please confirm the focus.",
    assetUrls: pick.map((a) => a.storedUrl || a.sourceUrl),
    rejected: assets.filter((a) => NEVER_FOCUS.has(a.role) || a.quality?.verdict !== "ok").map((a) => ({ url: a.storedUrl || a.sourceUrl, reason: a.quality?.verdict === "texture" ? "decorative texture" : a.quality?.verdict === "blank" ? "blank or error page" : a.role })),
    confidence: single ? 0.7 : 0.35,
    question: single ? null : "Which product or collection should this ad focus on?",
    source: "heuristic",
  };
}

async function thumb(file) {
  const buf = await sharp(file).resize(384, 384, { fit: "inside" }).jpeg({ quality: 70 }).toBuffer();
  return buf.toString("base64");
}

/**
 * @param {{ assets: object[], resolveFile: (a: object) => string|null, entityType?: string,
 *   name?: string, description?: string, pageTitle?: string, url?: string }} args
 */
export async function selectCampaignFocus(args) {
  const { assets = [], resolveFile, entityType, name, description, pageTitle, url } = args;
  const candidates = assets.filter((a) => a.quality?.verdict !== "blank").slice(0, 8);
  if (!isEnrichmentEnabled() || !getGeminiApiKey() || candidates.length < 2) return heuristicFocus({ assets, entityType, name });
  const parts = [{
    text:
      `Website: ${url || ""}\nPage title: ${pageTitle || ""}\nDetected type: ${entityType || "unknown"}\nName: ${name || ""}\n` +
      `Description: ${String(description || "").slice(0, 600)}\n\nImages (index: role):`,
  }];
  const indexed = [];
  for (const [i, a] of candidates.entries()) {
    const file = resolveFile(a);
    if (!file) continue;
    try {
      parts.push({ text: `Image ${i}: role=${a.role}${a.source === "rendered_screenshot" ? " (website screenshot)" : ""}` });
      parts.push({ inlineData: { mimeType: "image/jpeg", data: await thumb(file) } });
      indexed.push(i);
    } catch { /* unreadable image: skip */ }
  }
  if (indexed.length < 2) return heuristicFocus({ assets, entityType, name });
  try {
    const res = await generateJson({
      purpose: "creative",
      label: "campaign focus",
      temperature: 0.2,
      systemInstruction:
        "You choose the campaign focus for ONE short video ad from a website import. Use only the evidence and images. " +
        "Pick exactly one focus: a single product, a coherent collection with an explicit shared theme, the software product, or the business/service. " +
        "Never mix unrelated items; reject images that are error/bot-block pages, cookie/consent banners, textures or backgrounds, logos used as heroes, navigation graphics, or items outside the focus. " +
        "List the images that belong to the focus, best first. If the input is too ambiguous to choose responsibly, still propose the most defensible focus, set confidence below 0.5 and write ONE concise question for the user.",
      contents: [{ role: "user", parts }],
      schema: {
        type: Type.OBJECT,
        properties: {
          focusType: { type: Type.STRING, enum: ["single_product", "collection", "software", "brand", "service"] },
          title: { type: Type.STRING },
          rationale: { type: Type.STRING },
          imageIndexes: { type: Type.ARRAY, items: { type: Type.INTEGER } },
          rejected: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { index: { type: Type.INTEGER }, reason: { type: Type.STRING } } } },
          confidence: { type: Type.NUMBER },
          question: { type: Type.STRING },
        },
        required: ["focusType", "title", "imageIndexes", "confidence"],
      },
    });
    const j = res.json || {};
    const pickIdx = (j.imageIndexes || []).filter((i) => indexed.includes(i));
    const urlOf = (i) => candidates[i]?.storedUrl || candidates[i]?.sourceUrl;
    return {
      type: j.focusType || "collection",
      title: String(j.title || name || "").slice(0, 120),
      rationale: String(j.rationale || "").slice(0, 400),
      assetUrls: pickIdx.map(urlOf).filter(Boolean),
      rejected: (j.rejected || []).filter((r) => indexed.includes(r.index)).map((r) => ({ url: urlOf(r.index), reason: String(r.reason || "").slice(0, 120) })),
      confidence: Math.max(0, Math.min(1, Number(j.confidence) || 0)),
      question: j.question && Number(j.confidence) < 0.5 ? String(j.question).slice(0, 200) : null,
      source: "ai",
      model: res.model,
      cost: res.cost,
    };
  } catch (err) {
    return { ...heuristicFocus({ assets, entityType, name }), note: `AI focus unavailable: ${String(err?.message || err).slice(0, 120)}` };
  }
}
