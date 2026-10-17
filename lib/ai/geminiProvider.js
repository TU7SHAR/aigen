/**
 * Gemini Omni Flash video provider (Interactions API, synchronous).
 *
 * Docs: https://ai.google.dev/gemini-api/docs/omni (checked 2026-10-17).
 *  - `interactions.create` blocks until the video is ready; the MP4 comes back
 *    in `interaction.output_video.data`.
 *  - No duration or negative-prompt parameters: length is model-chosen (the
 *    prompt asks for a single continuous shot of about N seconds) and
 *    exclusions go in the prompt text.
 *  - By default Omni cuts between several shots; a storyboard shot needs ONE
 *    continuous shot, so the prompt says so explicitly.
 *  - `store: false` + `background: false` is the fastest unary path.
 *  - Billing is token based (≈ $0.10 per second of 720p video).
 */

import { GoogleGenAI } from "@google/genai";
import { ProviderError } from "./provider.js";
import { classifyProviderError } from "./errors.js";
import { getGeminiApiKey } from "../config.js";
import { getModelInfo, getDefaultModelId } from "./modelRegistry.js";
import { costFromUsage } from "../costs/estimate.js";

function extractVideo(interaction) {
  if (!interaction) return null;
  const ov = interaction.output_video || interaction.outputVideo;
  if (ov?.data) return { data: ov.data, mimeType: ov.mimeType || ov.mime_type || "video/mp4" };
  for (const list of [interaction.steps, interaction.outputs].filter(Array.isArray)) {
    for (const step of list) {
      const content = Array.isArray(step?.content) ? step.content : [step];
      for (const part of content) {
        if (part?.type === "video" && part?.data) return { data: part.data, mimeType: part.mime_type || part.mimeType || "video/mp4" };
      }
    }
  }
  return null;
}

function extractUsage(interaction) {
  const u = interaction?.usage || interaction?.usageMetadata;
  if (!u || typeof u !== "object") return null;
  const pick = (snake, camel) => (u[snake] !== undefined ? Number(u[snake]) : u[camel] !== undefined ? Number(u[camel]) : undefined);
  return {
    total_input_tokens: pick("total_input_tokens", "totalInputTokens"),
    total_output_tokens: pick("total_output_tokens", "totalOutputTokens"),
    total_thought_tokens: pick("total_thought_tokens", "totalThoughtTokens"),
    total_cached_tokens: pick("total_cached_tokens", "totalCachedTokens"),
    total_tokens: pick("total_tokens", "totalTokens"),
  };
}

/** Prompt adapted to Omni: one continuous shot, length hint, exclusions inline. */
export function omniPrompt(request) {
  const secs = Math.max(2, Math.round(Number(request.durationSeconds) || 4));
  const parts = [
    request.image ? "Use the provided image as the first frame of the video." : "",
    request.prompt,
    `A single continuous, unbroken shot of about ${secs} seconds. No scene cuts.`,
    request.negativePrompt ? `Do not show: ${String(request.negativePrompt).slice(0, 400)}.` : "",
  ];
  return parts.filter(Boolean).join(" ");
}

/** @param {string} [modelId] registry id; defaults to the chain head */
export function createGeminiProvider(modelId) {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    throw new ProviderError("GEMINI_API_KEY is not set. Add it to .env.local before enabling the Gemini provider.", { status: 500, category: "auth" });
  }
  const id = modelId || getDefaultModelId();
  const info = getModelInfo(id);
  const apiModelId = info.apiModelId || id;
  const ai = new GoogleGenAI({ apiKey });

  return {
    name: "gemini",
    model: id,
    async generate(request, ctx = {}) {
      const text = omniPrompt(request);
      const input = request.image
        ? [{ type: "image", data: request.image.data, mime_type: request.image.mimeType }, { type: "text", text }]
        : text;
      const resolution = ["360p", "720p", "1080p"].includes(request.resolution) ? request.resolution : "720p";
      let interaction;
      try {
        interaction = await ai.interactions.create({
          model: apiModelId,
          input,
          store: false,
          background: false,
          response_format: { type: "video", aspect_ratio: request.aspectRatio || "9:16", resolution },
          ...(request.image ? { generation_config: { video_config: { task: "image_to_video" } } } : {}),
        });
      } catch (err) {
        const cls = classifyProviderError(err, { stage: "submit" });
        throw new ProviderError(`Omni ${apiModelId} request failed: ${String(err?.message || "unknown").slice(0, 300)}`, {
          status: cls.status || 502, cause: err, stage: "submit", category: cls.category, scope: cls.scope,
          retryAfterMs: cls.retryAfterMs,
          // A synchronous call that returned an HTTP error produced no output
          // tokens; a dropped connection/timeout may still have been billed.
          notCharged: cls.category !== "timeout_uncertain" && cls.category !== "provider_error",
          uncertain: cls.category === "timeout_uncertain" || cls.category === "provider_error",
        });
      }
      const video = extractVideo(interaction);
      if (!video?.data) {
        throw new ProviderError("Omni returned no video data (not treated as success; tokens may have been billed).", {
          status: 502, category: "provider_error", notCharged: false, uncertain: true, stage: "result",
        });
      }
      const usage = extractUsage(interaction);
      return {
        videoBase64: video.data,
        mimeType: video.mimeType || "video/mp4",
        provider: "gemini-omni",
        model: id,
        apiModelId,
        usage,
        cost: costFromUsage(usage),
        mock: false,
      };
    },
  };
}
