/**
 * Gemini image provider — per-shot KEYFRAMES (first frames for image-to-video).
 *
 * Current models (docs/image-generation, 2026-10-17) use the Interactions API:
 *   ai.interactions.create({ model, input, response_format: { type: "image",
 *     aspect_ratio, image_size } }) → interaction.output_image { data, mime_type }
 * A legacy generateContent path is kept as an in-model fallback for models
 * that reject the Interactions shape.
 *
 * One instance per model; lib/ai/imageProviderIndex.js routes across the
 * image chain. Throws ImageProviderError (typed for the router) on failure —
 * never a fake success.
 */

import { GoogleGenAI } from "@google/genai";
import { ImageProviderError } from "./imageProvider.js";
import { classifyProviderError } from "./errors.js";
import { getGeminiApiKey, getImageModel } from "../config.js";
import { getModelInfo } from "./modelRegistry.js";

/** Pull inline image bytes from a generateContent response (tolerant shapes). */
function extractImage(resp) {
  for (const c of resp?.candidates || []) {
    for (const p of c?.content?.parts || []) {
      const inline = p?.inlineData || p?.inline_data;
      if (inline?.data) return { data: inline.data, mimeType: inline.mimeType || inline.mime_type || "image/png" };
    }
  }
  return null;
}

function extractInteractionImage(interaction) {
  const oi = interaction?.output_image || interaction?.outputImage;
  if (oi?.data) return { data: oi.data, mimeType: oi.mime_type || oi.mimeType || "image/png" };
  for (const list of [interaction?.steps, interaction?.outputs].filter(Array.isArray)) {
    for (const item of list) {
      for (const b of Array.isArray(item?.content) ? item.content : [item]) {
        if (b?.type === "image" && b?.data) return { data: b.data, mimeType: b.mime_type || b.mimeType || "image/png" };
      }
    }
  }
  return null;
}

/** Grounded keyframe prompt with explicit fidelity rules. */
export function keyframePrompt(request) {
  const brandLine = request.brand?.name ? ` for the brand "${request.brand.name}"` : "";
  return [
    `A single photorealistic advertising film still${brandLine}, ${request.aspectRatio || "9:16"} composition that fills the frame.`,
    request.prompt || "",
    "Cinematic lighting, natural textures, shallow depth of field.",
    "No text, captions, logos, watermarks or UI anywhere in the image.",
    "Do not invent product packaging, labels, prices or claims.",
    request.referenceImage?.data ? "Keep the real product in the attached reference exactly as it is (shape, colour, label)." : "",
  ].filter(Boolean).join(" ");
}

function typedError(err, model) {
  const cls = classifyProviderError(err, { stage: "submit" });
  return new ImageProviderError(`Image ${model} failed: ${String(err?.message || "unknown").slice(0, 240)}`, {
    status: cls.status || 502, cause: err, category: cls.category, scope: cls.scope,
    retryAfterMs: cls.retryAfterMs, notCharged: cls.notCharged || cls.category !== "provider_error", stage: "submit",
  });
}

/** @param {string} [modelId] registry id; defaults to the image chain head */
export function createGeminiImageProvider(modelId) {
  const apiKey = getGeminiApiKey();
  const id = modelId || getImageModel();
  const apiModelId = getModelInfo(id).apiModelId || id;
  return {
    name: "gemini",
    model: id,
    async generateKeyframe(request) {
      if (!apiKey) throw new ImageProviderError("GEMINI_API_KEY is not set — cannot generate a real keyframe.", { status: 503, category: "auth" });
      const ai = new GoogleGenAI({ apiKey });
      const text = keyframePrompt(request);
      const ref = request.referenceImage?.data ? { type: "image", data: request.referenceImage.data, mime_type: request.referenceImage.mimeType || "image/png" } : null;
      let img = null;
      try {
        const interaction = await ai.interactions.create({
          model: apiModelId,
          input: ref ? [ref, { type: "text", text }] : text,
          response_format: { type: "image", mime_type: "image/png", aspect_ratio: request.aspectRatio || "9:16", image_size: "1K" },
        });
        img = extractInteractionImage(interaction);
      } catch (err) {
        const cls = classifyProviderError(err);
        if (cls.category !== "invalid_request") throw typedError(err, apiModelId);
        // Model rejected the Interactions shape → legacy generateContent.
        try {
          const parts = [{ text }];
          if (ref) parts.push({ inlineData: { data: ref.data, mimeType: ref.mime_type } });
          const resp = await ai.models.generateContent({
            model: apiModelId,
            contents: [{ role: "user", parts }],
            config: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: request.aspectRatio || "9:16" } },
          });
          img = extractImage(resp);
        } catch (err2) {
          throw typedError(err2, apiModelId);
        }
      }
      if (!img?.data) {
        throw new ImageProviderError(`Image ${apiModelId} returned no image data.`, { status: 502, category: "provider_error", notCharged: false, uncertain: false });
      }
      return {
        imageBase64: img.data,
        mimeType: img.mimeType,
        width: request.width || null,
        height: request.height || null,
        provider: "gemini",
        model: id,
        cost: { amountUsd: getModelInfo(id).usdPerUnit ?? null, state: "estimated", basis: "published per-image price" },
        mock: false,
      };
    },
  };
}

export const _internal = { extractImage, extractInteractionImage };
