/**
 * Real Gemini Omni Flash video provider.
 *
 * Built against the official Interactions API documented at
 * https://ai.google.dev/gemini-api/docs/omni (model: gemini-omni-1.1-flash).
 *
 * The Interactions API is SYNCHRONOUS: `interactions.create(...)` blocks until
 * the video is ready and returns the base64 MP4 directly in
 * `interaction.output_video.data`. There is no separate poll loop.
 *
 * Because the call can be long-running, callers must account for serverless
 * execution time limits (see docs/ARCHITECTURE / route handler maxDuration).
 *
 * This integration is implemented but should be treated as UNVERIFIED until it
 * has been exercised once with a real key in a safe, low-cost test.
 */

import { GoogleGenAI } from "@google/genai";
import { ProviderError } from "./provider.js";
import { getGeminiApiKey, getVideoModel } from "../config.js";
import { costFromUsage } from "../costs/estimate.js";

/**
 * Extract base64 video data from an interaction response, tolerating both the
 * SDK convenience field and the raw steps array shape.
 * @param {any} interaction
 * @returns {{ data: string, mimeType: string } | null}
 */
function extractVideo(interaction) {
  if (!interaction) return null;

  // SDK convenience field (snake_case per docs; also try camelCase).
  const ov = interaction.output_video || interaction.outputVideo;
  if (ov?.data) {
    return { data: ov.data, mimeType: ov.mimeType || ov.mime_type || "video/mp4" };
  }

  // Raw steps array fallback.
  const steps = interaction.steps;
  if (Array.isArray(steps)) {
    for (const step of steps) {
      const content = step?.content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (part?.type === "video" && part?.data) {
          return { data: part.data, mimeType: part.mime_type || part.mimeType || "video/mp4" };
        }
      }
    }
  }
  return null;
}

/**
 * Extract the token usage block the Interactions API returns.
 * Per https://ai.google.dev/gemini-api/docs/tokens the interaction response
 * exposes `usage` with total_input_tokens, total_output_tokens,
 * total_thought_tokens, total_cached_tokens, total_tool_use_tokens, total_tokens.
 * We normalize snake_case/camelCase so costFromUsage can read it.
 * @param {any} interaction
 * @returns {object | null}
 */
function extractUsage(interaction) {
  const u = interaction?.usage || interaction?.usageMetadata;
  if (!u || typeof u !== "object") return null;
  const pick = (snake, camel) =>
    u[snake] !== undefined ? Number(u[snake]) : u[camel] !== undefined ? Number(u[camel]) : undefined;
  return {
    total_input_tokens: pick("total_input_tokens", "totalInputTokens"),
    total_output_tokens: pick("total_output_tokens", "totalOutputTokens"),
    total_thought_tokens: pick("total_thought_tokens", "totalThoughtTokens"),
    total_cached_tokens: pick("total_cached_tokens", "totalCachedTokens"),
    total_tool_use_tokens: pick("total_tool_use_tokens", "totalToolUseTokens"),
    total_tokens: pick("total_tokens", "totalTokens"),
  };
}

export function createGeminiProvider() {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    throw new ProviderError(
      "GEMINI_API_KEY is not set. Add it to .env.local before enabling the Gemini provider.",
      { status: 500 }
    );
  }

  const model = getVideoModel();
  const ai = new GoogleGenAI({ apiKey });

  return {
    name: "gemini",
    /**
     * @param {{
     *   prompt: string,
     *   image?: { data: string, mimeType: string },
     *   aspectRatio: "16:9"|"9:16",
     *   resolution: "360p"|"720p"|"1080p",
     *   durationSeconds: number,
     * }} request
     */
    async generate(request) {
      // Build the `input` payload. Image-to-video takes an array of parts;
      // text-only can be a plain string.
      const input = request.image
        ? [
            {
              type: "image",
              data: request.image.data,
              mime_type: request.image.mimeType,
            },
            { type: "text", text: request.prompt },
          ]
        : request.prompt;

      let interaction;
      try {
        interaction = await ai.interactions.create({
          model,
          input,
          response_format: {
            type: "video",
            aspect_ratio: request.aspectRatio,
            resolution: request.resolution,
          },
        });
      } catch (err) {
        const status = err?.status || err?.code;
        if (status === 404 || status === 400) {
          throw new ProviderError(
            `Model "${model}" is not accessible with this API key/tier, or the request was rejected. Verify the model is enabled in Google AI Studio. (${err?.message || "no detail"})`,
            { status: 400, cause: err }
          );
        }
        if (status === 429) {
          throw new ProviderError(
            "Rate limit / quota reached on Gemini. Try again later or check your tier limits.",
            { status: 429, cause: err }
          );
        }
        throw new ProviderError(
          `Gemini generation failed: ${err?.message || "unknown error"}`,
          { status: 502, cause: err }
        );
      }

      const video = extractVideo(interaction);
      if (!video?.data) {
        throw new ProviderError(
          "Gemini returned no video data. Not treating this as success.",
          { status: 502 }
        );
      }

      // Read the REAL usage block the Interactions API returns and compute the
      // billed cost from it. We do NOT fabricate a figure: if usage is absent
      // the cost comes back as state "unknown".
      const usage = extractUsage(interaction);
      const cost = costFromUsage(usage);

      return {
        videoBase64: video.data,
        mimeType: video.mimeType || "video/mp4",
        provider: "gemini",
        model,
        usage,
        cost,
        mock: false,
      };
    },
  };
}
