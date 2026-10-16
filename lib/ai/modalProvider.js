/**
 * Modal self-hosted video provider adapter.
 *
 * Calls a Modal web endpoint (a GPU function you deploy with `modal deploy`)
 * that runs an open-source video model and returns base64 MP4 footage. The
 * footage is FOOTAGE ONLY — exact brand/URL/price/CTA copy is still rendered
 * deterministically by the ffmpeg compositor, never by the model.
 *
 * COST CONTROL (per-second GPU billing):
 *  - The worker reports the GPU wall-time it actually used (`gpuSeconds`); we
 *    estimate USD = gpuSeconds × MODAL_GPU_USD_PER_SECOND and record it in the
 *    persistent monthly ledger.
 *  - The provider ROUTER (lib/ai/index.js) checks the budget BEFORE calling us
 *    and falls back to Gemini once the monthly cap ($30 default) is hit, so we
 *    never silently overspend.
 *  - We keep GPU time minimal by: a warm/kept-alive worker (model loaded once),
 *    a short default clip, and a hard request timeout.
 */

import { ProviderError } from "./provider.js";
import {
  getModalEndpoint,
  getModalWorkerSecret,
  getModalGpuUsdPerSecond,
} from "../config.js";
import { recordModalSpend } from "../costs/modalLedger.js";

const REQUEST_TIMEOUT_MS = 180_000; // worker should be far faster; hard ceiling.

export function createModalProvider() {
  const endpoint = getModalEndpoint();
  if (!endpoint) {
    throw new ProviderError(
      "Modal video endpoint not configured. Set MODAL_VIDEO_ENDPOINT (from `modal deploy`).",
      { status: 500 }
    );
  }
  const secret = getModalWorkerSecret();
  const usdPerSec = getModalGpuUsdPerSecond();

  return {
    name: "modal",
    async generate(request) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let res;
      try {
        res = await fetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(secret ? { "x-worker-secret": secret } : {}),
          },
          body: JSON.stringify({
            prompt: request.prompt,
            // base64 image reference (optional) for image→video models.
            image: request.image?.data || null,
            imageMimeType: request.image?.mimeType || null,
            aspectRatio: request.aspectRatio,
            durationSeconds: request.durationSeconds,
            resolution: request.resolution,
          }),
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        if (err?.name === "AbortError") {
          throw new ProviderError("Modal worker timed out.", { status: 504 });
        }
        throw new ProviderError(`Modal worker request failed: ${err?.message || err}`, { status: 502 });
      }
      clearTimeout(timer);

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new ProviderError(
          `Modal worker HTTP ${res.status}: ${detail.slice(0, 300) || res.statusText}`,
          { status: res.status === 401 ? 401 : 502 }
        );
      }

      let data;
      try {
        data = await res.json();
      } catch {
        throw new ProviderError("Modal worker returned non-JSON.", { status: 502 });
      }

      if (!data?.videoBase64) {
        // The worker returns {error, gpuSeconds} with HTTP 200 on a pipeline
        // failure — that GPU time was still billed, so record it.
        const burnt = Number(data?.gpuSeconds) || 0;
        if (burnt > 0) await recordModalSpend({ gpuSeconds: burnt, usd: Number((burnt * usdPerSec).toFixed(4)) });
        throw new ProviderError(
          `Modal worker returned no video${data?.error ? `: ${data.error}` : ""}.`,
          { status: 502 }
        );
      }

      // Estimate + record spend from the GPU time the worker reports.
      const gpuSeconds = Number(data.gpuSeconds) || 0;
      const usd = Number((gpuSeconds * usdPerSec).toFixed(4));
      const ledger = await recordModalSpend({ gpuSeconds, usd });

      return {
        videoBase64: data.videoBase64,
        mimeType: data.mimeType || "video/mp4",
        provider: "modal",
        model: data.model || "modal-video",
        usage: { gpuSeconds },
        cost: {
          amountUsd: usd,
          state: "estimated", // GPU-seconds × rate — NOT Modal's invoice
          gpuSeconds,
          monthlySpentUsd: ledger.spentUsd,
        },
        mock: false,
      };
    },
  };
}
