/**
 * Veo video provider adapter (Gemini API, long-running operation).
 *
 *   op = ai.models.generateVideos({ model, source: { prompt, image? }, config })
 *   poll ai.operations.getVideosOperation({ operation }) until op.done
 *   bytes = op.response.generatedVideos[0].video (inline bytes or a file to download)
 *
 * One instance per MODEL (the router decides which). The operation name is
 * reported through ctx.onOperation the moment Google accepts the request, so
 * a crashed/restarted job can RESUME polling the same operation instead of
 * paying for a second generation (generated videos stay retrievable 2 days).
 *
 * Billing facts used for routing (docs/pricing, docs/veo, 2026-10-17): Veo
 * charges only for successfully generated videos, and safety-blocked attempts
 * are not charged. A poll timeout is UNCERTAIN (it may still finish and bill),
 * so it is never auto-retried on another model.
 */

import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import { GoogleGenAI, GenerateVideosOperation } from "@google/genai";
import { ProviderError } from "./provider.js";
import { classifyProviderError } from "./errors.js";
import { getGeminiApiKey } from "../config.js";
import { getModelInfo, getDefaultModelId } from "./modelRegistry.js";
import { costFromUsage } from "../costs/estimate.js";

const FIRST_POLL_MS = 8000;
const POLL_INTERVAL_MS = 5000;
const pollWindowMs = () => Number(process.env.VEO_POLL_TIMEOUT_MS || 420_000); // Veo max latency ≈ 6 min

/** Smallest Veo duration that covers the shot (4/6/8). */
export function veoDurationFor(seconds, allowed = [4, 6, 8]) {
  const d = Number(seconds) || 4;
  const sorted = [...allowed].sort((a, b) => a - b);
  return sorted.find((x) => x >= d) ?? sorted[sorted.length - 1];
}

/**
 * Prompt + negativePrompt for one Veo model. Models that reject the
 * negativePrompt parameter (Veo 3.1 Lite: 400 "isn't supported by this
 * model") get the negatives appended to the prompt text instead, so the
 * cheapest model is not skipped over a parameter.
 * @param {{ prompt: string, negativePrompt?: string }} request
 * @param {{ supportsNegativePrompt?: boolean }} [info]
 * @returns {{ prompt: string, negativePrompt: string|null }}
 */
export function veoPromptFor(request, info = {}) {
  const prompt = String(request?.prompt || "");
  const negatives = String(request?.negativePrompt || "").trim().slice(0, 500);
  if (!negatives) return { prompt, negativePrompt: null };
  if (info?.supportsNegativePrompt === false) {
    return { prompt: `${prompt}\n\nAvoid: ${negatives.replace(/[.\s]+$/, "")}.`, negativePrompt: null };
  }
  return { prompt, negativePrompt: negatives };
}

/**
 * Pull MP4 bytes out of a completed operation (inline bytes, SDK download, or
 * a direct authenticated GET of the file URI). Throws a descriptive error.
 */
export async function extractVeoVideo(ai, operation, apiKey) {
  const gen = operation?.response?.generatedVideos?.[0];
  const videoRef = gen?.video;
  if (!videoRef) {
    const filtered = operation?.response?.raiMediaFilteredReasons?.join("; ");
    if (filtered) {
      throw new ProviderError(`Veo returned no video — content was filtered: ${filtered}`, {
        status: 422, category: "safety_blocked", filtered: true, notCharged: true,
        audioFilter: /audio/i.test(filtered), stage: "result",
      });
    }
    throw new ProviderError("Veo completed but returned no video object.", {
      status: 502, category: "provider_error", notCharged: true, stage: "result",
    });
  }
  if (videoRef.videoBytes) return { data: videoRef.videoBytes, mimeType: videoRef.mimeType || "video/mp4" };

  const mimeType = videoRef.mimeType || "video/mp4";
  const errors = [];
  const tmp = path.join(os.tmpdir(), `veo-${crypto.randomUUID()}.mp4`);
  try {
    await ai.files.download({ file: gen, downloadPath: tmp });
    if (videoRef.videoBytes) return { data: videoRef.videoBytes, mimeType };
    const buf = await fs.readFile(tmp).catch(() => null);
    if (buf?.length) return { data: buf.toString("base64"), mimeType };
    errors.push("sdk download wrote no bytes");
  } catch (err) {
    errors.push(`sdk download: ${err?.message || err}`);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
  if (videoRef.uri && apiKey) {
    try {
      const bytes = await fetchVeoUri(videoRef.uri, apiKey);
      if (bytes?.length) return { data: bytes.toString("base64"), mimeType };
      errors.push("direct uri fetch returned no bytes");
    } catch (err) {
      errors.push(`direct uri fetch: ${err?.message || err}`);
    }
  }
  // The video WAS generated (and billed) — retrieval failed. Never treat this
  // as an unbilled failure; the operation can be resumed to fetch it again.
  throw new ProviderError(`Veo generated the video but it could not be downloaded (${errors.join("; ") || "no bytes"}).`, {
    status: 502, category: "retrieval_failed", billed: true, uncertain: true, notCharged: false, stage: "download",
  });
}

async function fetchVeoUri(uri, apiKey) {
  let url;
  if (/^https?:\/\//i.test(uri)) url = uri;
  else url = `https://generativelanguage.googleapis.com/v1beta/${uri.startsWith("files/") ? uri : `files/${uri}`}:download?alt=media`;
  if (/:download(\?|$)/.test(url) && !/[?&]alt=media/.test(url)) url += (url.includes("?") ? "&" : "?") + "alt=media";
  const res = await fetch(url, { headers: { "x-goog-api-key": apiKey } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function submitError(err, apiModelId) {
  const cls = classifyProviderError(err, { stage: "submit" });
  const detail = String(err?.message || "no detail").slice(0, 300);
  const msg =
    cls.category === "rate_limited" ? `Veo ${apiModelId}: ${cls.scope === "day" ? "daily" : "per-minute"} quota reached.`
      : cls.category === "model_unavailable" ? `Veo ${apiModelId} is not available to this API key/tier (${detail}).`
        : `Veo ${apiModelId} request failed: ${detail}`;
  return new ProviderError(msg, {
    status: cls.status || (cls.category === "rate_limited" ? 429 : 502), cause: err, stage: "submit",
    category: cls.category, scope: cls.scope, retryAfterMs: cls.retryAfterMs,
    // A rejected submit created no operation, so nothing can be billed.
    notCharged: true, uncertain: false,
  });
}

/**
 * @param {string} [modelId] registry id (e.g. "veo-3.1-lite"); defaults to the chain head
 */
export function createVeoProvider(modelId) {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    throw new ProviderError("GEMINI_API_KEY is not set. Add it to .env.local before using a Veo model.", { status: 500, category: "auth" });
  }
  const id = modelId || getDefaultModelId();
  const info = getModelInfo(id);
  const apiModelId = info.apiModelId || id;
  const ai = new GoogleGenAI({ apiKey, httpOptions: { timeout: 120_000 } });

  async function pollUntilDone(operation, ctx = {}) {
    const deadline = Date.now() + pollWindowMs();
    let wait = FIRST_POLL_MS;
    let transient = 0;
    while (!operation?.done) {
      if (ctx.signal?.aborted) {
        throw new ProviderError("Cancelled while Veo was generating (the remote job may still finish and be billed).", {
          status: 499, category: "timeout_uncertain", uncertain: true, notCharged: false, operationName: operation?.name, stage: "poll",
        });
      }
      if (Date.now() > deadline) {
        throw new ProviderError(`Veo ${apiModelId} did not finish within ${Math.round(pollWindowMs() / 1000)}s; it may still complete — resume operation ${operation?.name || "?"}.`, {
          status: 504, category: "timeout_uncertain", uncertain: true, notCharged: false, operationName: operation?.name, stage: "poll",
        });
      }
      await new Promise((r) => setTimeout(r, wait));
      wait = POLL_INTERVAL_MS;
      try {
        operation = await ai.operations.getVideosOperation({ operation });
        transient = 0;
      } catch (err) {
        // Polling is idempotent: tolerate transient failures inside the window.
        if (++transient > 6) {
          throw new ProviderError(`Veo polling kept failing (${err?.message || err}); resume operation ${operation?.name || "?"}.`, {
            status: 502, category: "timeout_uncertain", uncertain: true, notCharged: false, operationName: operation?.name, stage: "poll", cause: err,
          });
        }
      }
    }
    if (operation.error) {
      const code = operation.error.code ? ` [${operation.error.code}]` : "";
      const message = operation.error.message || JSON.stringify(operation.error);
      const cls = classifyProviderError({ message, status: operation.error.code === 8 ? 429 : undefined }, { stage: "result" });
      throw new ProviderError(`Veo generation failed${code}: ${message}`, {
        status: 502, category: cls.category === "provider_error" ? "provider_error" : cls.category,
        // Veo bills only successfully generated videos.
        notCharged: true, uncertain: false, operationName: operation.name, stage: "result",
      });
    }
    return operation;
  }

  async function finish(operation) {
    let video;
    try {
      video = await extractVeoVideo(ai, operation, apiKey);
    } catch (err) {
      if (err instanceof ProviderError) err.operationName = err.operationName || operation?.name;
      throw err;
    }
    const usage = operation.response?.usageMetadata || null;
    return {
      videoBase64: video.data,
      mimeType: video.mimeType || "video/mp4",
      provider: "veo",
      model: id,
      apiModelId,
      operationName: operation?.name || null,
      usage,
      // Veo bills per output second; the router/budget record the estimate.
      cost: usage ? costFromUsage(usage) : { amountUsd: null, state: "unknown" },
      mock: false,
    };
  }

  return {
    name: "veo",
    model: id,
    /**
     * @param {object} request see lib/ai/provider.js
     * @param {{ onOperation?: (name: string) => void, signal?: AbortSignal }} [ctx]
     */
    async generate(request, ctx = {}) {
      const config = { numberOfVideos: 1 };
      if (request.aspectRatio) config.aspectRatio = request.aspectRatio;
      const { prompt, negativePrompt } = veoPromptFor(request, info);
      if (negativePrompt) config.negativePrompt = negativePrompt;
      const duration = veoDurationFor(request.durationSeconds, info.durations?.length ? info.durations : [4, 6, 8]);
      config.durationSeconds = duration;
      // 1080p is only valid for 8s Veo clips; otherwise generate 720p and let
      // the compositor upscale (lanczos) to the export size.
      config.resolution = request.resolution === "1080p" && duration === 8 && info.resolutions?.includes("1080p") ? "1080p" : "720p";

      const source = { prompt };
      if (request.image) source.image = { imageBytes: request.image.data, mimeType: request.image.mimeType };

      let operation;
      try {
        operation = await ai.models.generateVideos({ model: apiModelId, source, config });
      } catch (err) {
        throw submitError(err, apiModelId);
      }
      if (operation?.name) ctx.onOperation?.(operation.name, { model: id, durationSeconds: duration, resolution: config.resolution });
      operation = await pollUntilDone(operation, ctx);
      const out = await finish(operation);
      return { ...out, durationSeconds: duration, resolution: config.resolution };
    },
    /** Resume a previously accepted operation by name (no new generation). */
    async resume(operationName, ctx = {}) {
      const op = new GenerateVideosOperation();
      op.name = operationName;
      let operation;
      try {
        operation = await ai.operations.getVideosOperation({ operation: op });
      } catch (err) {
        throw new ProviderError(`Could not resume Veo operation ${operationName}: ${err?.message || err}`, {
          status: 502, category: "timeout_uncertain", uncertain: true, notCharged: false, operationName, stage: "poll", cause: err,
        });
      }
      operation = await pollUntilDone(operation, ctx);
      return finish(operation);
    },
  };
}
