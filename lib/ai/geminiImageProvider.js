/**
 * Real Gemini image provider — per-shot KEYFRAME generation.
 *
 * Built against the official @google/genai image-generation shape: a
 * `generateContent` call to an image-capable model returns the image inline as
 * `candidates[0].content.parts[].inlineData` ({ data: base64, mimeType }). A
 * reference image (product/site screenshot) is passed as an inlineData part so
 * the generated keyframe stays faithful to the real product (fidelity guard).
 *
 * This integration is implemented but is UNVERIFIED until exercised once with a
 * real key in a safe, low-cost test. It is gated by isPaidImageGenerationEnabled
 * at the router; this adapter assumes the gate already passed and THROWS
 * ImageProviderError on any failure rather than returning a fake success.
 */

import { GoogleGenAI } from "@google/genai";
import { ImageProviderError } from "./imageProvider.js";
import { getGeminiApiKey, getImageModel } from "../config.js";

/** Pull inline image bytes from a generateContent response (tolerant shapes). */
function extractImage(resp) {
  const cands = resp?.candidates || [];
  for (const c of cands) {
    const parts = c?.content?.parts || [];
    for (const p of parts) {
      const inline = p?.inlineData || p?.inline_data;
      if (inline?.data) {
        return { data: inline.data, mimeType: inline.mimeType || inline.mime_type || "image/png" };
      }
    }
  }
  return null;
}

/** Rough token→USD for image output; actuals must be reconciled in AI Studio. */
function estimateImageCost(resp) {
  const u = resp?.usageMetadata;
  if (!u) return { amountUsd: null, state: "unknown" };
  // Image models bill per output image / token; we cannot authoritatively
  // compute it here, so report usage-known-but-amount-unknown honestly.
  return { amountUsd: null, state: "unknown" };
}

export function createGeminiImageProvider() {
  const apiKey = getGeminiApiKey();
  const model = getImageModel();
  return {
    name: "gemini",
    /** @param {object} request see ImageProvider contract */
    async generateKeyframe(request) {
      if (!apiKey) {
        throw new ImageProviderError("GEMINI_API_KEY is not set — cannot generate a real keyframe.", { status: 503 });
      }
      const ai = new GoogleGenAI({ apiKey });

      // Build a grounded prompt. The product-fidelity instruction is explicit:
      // never invent product UI/packaging; keep any real reference faithful.
      const parts = [];
      const brandLine = request.brand?.name ? ` for the brand "${request.brand.name}"` : "";
      const subjectLine = request.subjectText ? ` Focal subject: "${request.subjectText}".` : "";
      parts.push({
        text:
          `Generate a single high-quality advertising keyframe${brandLine}, ${request.aspectRatio || "9:16"} aspect ratio. ` +
          `${request.prompt || ""}.${subjectLine} ` +
          `Do NOT invent product packaging, UI, logos, prices or claims that are not provided. ` +
          `If a reference image is attached, stay faithful to the real product shown.`,
      });
      if (request.referenceImage?.data) {
        parts.push({ inlineData: { data: request.referenceImage.data, mimeType: request.referenceImage.mimeType || "image/png" } });
      }

      let resp;
      try {
        resp = await ai.models.generateContent({
          model,
          contents: [{ role: "user", parts }],
          config: { responseModalities: ["IMAGE"] },
        });
      } catch (err) {
        throw new ImageProviderError(`Gemini image generation failed: ${err?.message || "unknown"}`, { status: 502, cause: err });
      }

      const img = extractImage(resp);
      if (!img?.data) {
        throw new ImageProviderError("Gemini returned no image data for the keyframe.", { status: 502 });
      }
      return {
        imageBase64: img.data,
        mimeType: img.mimeType,
        width: request.width || null,
        height: request.height || null,
        provider: "gemini",
        model,
        cost: estimateImageCost(resp),
        mock: false,
      };
    },
  };
}

export const _internal = { extractImage };
