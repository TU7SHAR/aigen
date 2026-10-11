/**
 * Veo video provider adapter (Gemini API).
 *
 * Implements the same VideoProvider contract as the Omni provider, but uses
 * Veo's LONG-RUNNING-OPERATION API shape (different from Omni's synchronous
 * Interactions API):
 *
 *   op = ai.models.generateVideos({ model, prompt, image?, config })
 *   poll ai.operations.getVideosOperation(...) until op.done
 *   video = op.response.generatedVideos[0].video   (a file ref)
 *   bytes  = video.videoBytes OR download via ai.files
 *
 * Docs: https://ai.google.dev/gemini-api/docs/veo (last updated 2026-10-08).
 *
 * The actual model id is NOT hardcoded here — it comes from the registry/env
 * (getVideoModel), and the provider only runs when the active model's
 * providerImpl is "veo". So this code is loaded/called ONLY when you select a
 * Veo model; no wasted work otherwise.
 *
 * UNVERIFIED against a live key — treat as experimental until exercised. Note
 * veo-3.1-lite's Gemini-API preview is scheduled for shutdown 2026-10-22.
 */

import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import { GoogleGenAI } from "@google/genai";
import { ProviderError } from "./provider.js";
import { getGeminiApiKey, getVideoModel } from "../config.js";
import { getModelInfo } from "./modelRegistry.js";
import { costFromUsage } from "../costs/estimate.js";

const POLL_INTERVAL_MS = 8000;
const MAX_POLLS = 30; // ~4 min ceiling

/**
 * Pull base64 MP4 bytes out of a completed Veo operation.
 *
 * IMPORTANT (SDK @google/genai v2.x): `ai.files.download()` returns `void` — it
 * does NOT return the bytes. It either writes to `downloadPath` OR mutates the
 * passed Video object to populate `.videoBytes`. The previous implementation
 * assumed a return value and so ALWAYS fell through to null → a false 502 even
 * on a successful generation. We now:
 *   1) use inline `videoBytes` if the API already provided them, else
 *   2) download to a temp file, read it back, and clean up.
 * Any failure here is surfaced with its real message (no silent catch).
 */
export async function extractVeoVideo(ai, operation) {
  const gen = operation?.response?.generatedVideos?.[0];
  const videoRef = gen?.video;
  if (!videoRef) {
    const filtered = operation?.response?.raiMediaFilteredReasons?.join("; ");
    throw new ProviderError(
      filtered
        ? `Veo returned no video — content was filtered: ${filtered}`
        : "Veo completed but returned no video object.",
      { status: 502 }
    );
  }

  // 1) Bytes already inline (common on the Gemini API).
  if (videoRef.videoBytes) {
    return { data: videoRef.videoBytes, mimeType: videoRef.mimeType || "video/mp4" };
  }

  // 2) Download to a temp file, then read it back as base64.
  const tmp = path.join(os.tmpdir(), `veo-${crypto.randomUUID()}.mp4`);
  try {
    await ai.files.download({ file: gen, downloadPath: tmp });
    // Some SDK paths populate videoBytes in-place during download.
    if (videoRef.videoBytes) {
      return { data: videoRef.videoBytes, mimeType: videoRef.mimeType || "video/mp4" };
    }
    const buf = await fs.readFile(tmp);
    if (buf?.length) {
      return { data: buf.toString("base64"), mimeType: videoRef.mimeType || "video/mp4" };
    }
  } catch (err) {
    throw new ProviderError(
      `Veo video download failed: ${err?.message || "unknown"}${videoRef.uri ? ` (uri: ${videoRef.uri})` : ""}`,
      { status: 502, cause: err }
    );
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }

  throw new ProviderError(
    "Veo returned a video reference but no downloadable bytes. Not treating this as success.",
    { status: 502 }
  );
}

export function createVeoProvider() {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    throw new ProviderError(
      "GEMINI_API_KEY is not set. Add it to .env.local before using a Veo model.",
      { status: 500 }
    );
  }

  const configuredId = getVideoModel();
  // The registry can map a friendly id (e.g. "veo-3.1-lite") to the real Gemini
  // API id (e.g. "veo-3.1-fast-generate-preview") via `apiModelId`, env-driven.
  const info = getModelInfo(configuredId);
  const apiModelId = info.apiModelId || configuredId;
  const ai = new GoogleGenAI({ apiKey });

  return {
    name: "veo",
    async generate(request) {
      const config = {};
      if (request.aspectRatio) config.aspectRatio = request.aspectRatio;
      if (request.resolution) config.resolution = request.resolution;

      // Use the `source` argument (prompt/image under source) — the top-level
      // prompt/image args are deprecated in @google/genai (removal ≥2026-07-31)
      // and emit a warning on every call.
      const source = { prompt: request.prompt };
      if (request.image) {
        source.image = { imageBytes: request.image.data, mimeType: request.image.mimeType };
      }
      const params = { model: apiModelId, source, config };

      let operation;
      try {
        operation = await ai.models.generateVideos(params);
      } catch (err) {
        throw mapVeoError(err, apiModelId);
      }

      // Poll the long-running operation until done.
      let polls = 0;
      while (!operation?.done) {
        if (polls++ >= MAX_POLLS) {
          throw new ProviderError(
            `Veo generation did not finish within the polling window (${apiModelId}).`,
            { status: 504 }
          );
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        try {
          operation = await ai.operations.getVideosOperation({ operation });
        } catch (err) {
          throw mapVeoError(err, apiModelId);
        }
      }

      if (operation.error) {
        const code = operation.error.code ? ` [${operation.error.code}]` : "";
        throw new ProviderError(
          `Veo generation failed${code}: ${operation.error.message || JSON.stringify(operation.error)}`,
          { status: 502 }
        );
      }

      // extractVeoVideo throws a descriptive ProviderError on any failure
      // (filtered content, no bytes, download error) instead of a bare 502.
      const video = await extractVeoVideo(ai, operation);

      // Veo bills per second (not per token). Report cost as unknown so we never
      // fabricate; the route's pre-call estimate (registry $/sec) is what the
      // spend guard uses, and real spend is confirmed in AI Studio billing.
      const usage = operation.response?.usageMetadata || null;
      return {
        videoBase64: video.data,
        mimeType: video.mimeType || "video/mp4",
        provider: "veo",
        model: configuredId,
        usage,
        cost: usage ? costFromUsage(usage) : { amountUsd: null, state: "unknown" },
        mock: false,
      };
    },
  };
}

function mapVeoError(err, model) {
  const status = err?.status || err?.code;
  if (status === 404 || status === 400) {
    return new ProviderError(
      `Veo model "${model}" is not accessible with this API key/tier, or the request was rejected. Verify the exact model id in Google AI Studio (set VEO_API_MODEL_ID if the id differs). (${err?.message || "no detail"})`,
      { status: 400, cause: err }
    );
  }
  if (status === 429) {
    return new ProviderError("Rate limit / quota reached on Veo.", { status: 429, cause: err });
  }
  return new ProviderError(`Veo request failed: ${err?.message || "unknown"}`, { status: 502, cause: err });
}
