/**
 * Video provider routing.
 *
 * Every paid scene clip goes through generateSceneClip(): the ordered video
 * chain (getChain("video"), cheapest first) is walked by the auto-switching
 * router, each model only when it can produce THIS shot (aspect ratio,
 * image-to-video, configured), fits the job budget, and has quota left. The
 * result says which model actually ran and why earlier ones were skipped.
 *
 *   VIDEO_PROVIDER=mock (default) → no paid video at all (zero cost)
 *   VIDEO_PROVIDER=gemini + paid gates → routed real generation
 *
 * Adding a model = a registry entry (+ an adapter for a new API shape).
 */

import {
  getProviderName, isModalConfigured, isPaidSceneVideoEnabled,
  getModalWorstCaseGpuSeconds, getModalGpuUsdPerSecond,
} from "../config.js";
import { getModelInfo, getChain, videoUsdPerSecond, isAutoSwitchEnabled } from "./modelRegistry.js";
import { createMockProvider } from "./mockProvider.js";
import { createGeminiProvider } from "./geminiProvider.js";
import { createVeoProvider, veoDurationFor } from "./veoProvider.js";
import { createModalProvider } from "./modalProvider.js";
import { checkModalBudget } from "../costs/modalLedger.js";
import { ProviderError } from "./provider.js";
import { routeCall, RoutingError } from "./router.js";

export { ProviderError } from "./provider.js";
export { RoutingError } from "./router.js";

/** Build the adapter for one model id. */
export function createVideoAdapter(modelId) {
  const info = getModelInfo(modelId);
  switch (info.providerImpl) {
    case "veo": return createVeoProvider(info.id);
    case "gemini-omni": return createGeminiProvider(info.id);
    case "modal": return createModalProvider();
    case "mock": return createMockProvider();
    default:
      throw new ProviderError(`No adapter for model "${modelId}" (providerImpl "${info.providerImpl}").`, { status: 500, category: "invalid_request", notCharged: true });
  }
}

/** Seconds of video a model will generate (and bill) for a shot. */
export function billedSeconds(info, durationSeconds) {
  if (info.providerImpl === "veo") return veoDurationFor(durationSeconds, info.durations?.length ? info.durations : [4, 6, 8]);
  return info.maxDurationSeconds || 10; // Omni/modal choose the length → worst case
}

/** Worst-case USD for one clip on `info` (reserved before sending). */
export function clipWorstCaseUsd(info, { durationSeconds = 4, resolution = "720p" } = {}) {
  if (info.providerImpl === "modal") return Number((getModalWorstCaseGpuSeconds() * getModalGpuUsdPerSecond()).toFixed(4));
  const res = info.providerImpl === "veo" && !(resolution === "1080p" && billedSeconds(info, durationSeconds) === 8) ? "720p" : resolution;
  const rate = videoUsdPerSecond(info, res);
  const margin = info.providerImpl === "veo" ? 1 : 1.25; // token-billed models get headroom
  return Number((rate * billedSeconds(info, durationSeconds) * margin).toFixed(4));
}

/**
 * Legacy single-call path (format "generative"): the chain head, no routing.
 * @returns {Promise<{ name: string, generate: Function, fallbackReason?: string }>}
 */
export async function getVideoProvider(opts = {}) {
  if (getProviderName() === "mock") return createMockProvider();
  const head = getChain("video")[0];
  const info = getModelInfo(head);
  if (info.providerImpl === "modal") {
    const next = getChain("video").find((m) => getModelInfo(m).providerImpl !== "modal") || "gemini-omni-1.1-flash";
    if (!isModalConfigured()) return { ...createVideoAdapter(next), fallbackReason: `Modal endpoint not configured — using ${next}.` };
    const budget = await checkModalBudget(opts.estimatedUsd || 0);
    if (!budget.ok) return { ...createVideoAdapter(next), fallbackReason: budget.reason };
  }
  return createVideoAdapter(head);
}

/** Why paid scene video is off (or null when it is on). */
export function sceneVideoBlocker() {
  return isPaidSceneVideoEnabled()
    ? null
    : "Scene video is off (needs VIDEO_PROVIDER=gemini, ENABLE_PAID_GENERATION=true, DISABLE_PAID_GENERATION=false, JOB_MAX_PAID_VIDEO_CLIPS>0).";
}

/**
 * Back-compat probe used by status/tests: is scene video available, which
 * model heads the chain and the head's worst case per clip.
 */
export async function getSceneVideoProvider({ durationSeconds = 4 } = {}) {
  const chain = getChain("video");
  const model = chain[0];
  const blocker = sceneVideoBlocker();
  if (blocker) return { provider: null, model, chain, worstCaseUsd: 0, reason: blocker };
  const usable = chain.filter((m) => getModelInfo(m).providerImpl !== "modal" || isModalConfigured());
  if (!usable.length) {
    return { provider: null, model, chain, worstCaseUsd: 0, reason: "MODAL_VIDEO_ENDPOINT not set and no other model in VIDEO_MODEL_CHAIN." };
  }
  return {
    provider: { name: "router", chain: usable },
    model: usable[0],
    chain: usable,
    autoSwitch: isAutoSwitchEnabled("video"),
    worstCaseUsd: clipWorstCaseUsd(getModelInfo(usable[0]), { durationSeconds }),
  };
}

/**
 * Generate one scene clip through the auto-switching chain.
 *
 * @param {{
 *   request: object,                 // provider request (prompt, image?, aspectRatio, resolution, durationSeconds, negativePrompt)
 *   safePrompt?: string,             // rephrased prompt for one retry after a safety block
 *   budget: object,                  // JobBudget
 *   label?: string,
 *   onEvent?: Function,              // router events (attempt/waiting/failed/succeeded)
 *   onOperation?: Function,          // (name, meta) for resumable long-running ops
 *   resume?: { model: string, operationName: string } | null,
 *   signal?: AbortSignal,
 * }} args
 * @returns {Promise<{ clip: object, model: string, attempts: object[], switched: boolean, resumed?: boolean }>}
 */
export async function generateSceneClip(args) {
  const { request, safePrompt, budget, label = "scene clip", onEvent, onOperation, resume = null, signal } = args;
  const blocker = sceneVideoBlocker();
  if (blocker) throw new RoutingError(blocker, { category: "disabled" });

  // A crashed/restarted job recorded an accepted operation: fetch it instead
  // of paying for a new generation.
  if (resume?.operationName && resume?.model) {
    const adapter = createVideoAdapter(resume.model);
    if (typeof adapter.resume === "function") {
      try {
        const clip = await adapter.resume(resume.operationName, { signal });
        return { clip, model: resume.model, attempts: [{ model: resume.model, outcome: "ok", resumed: true }], switched: false, resumed: true };
      } catch (err) {
        onEvent?.({ type: "failed", model: resume.model, label, reason: `resume failed: ${String(err?.message || err).slice(0, 160)}` });
        if (err?.category === "timeout_uncertain") throw new RoutingError(err.message, { category: "timeout_uncertain", uncertain: true, operationName: resume.operationName });
        // A finished-with-error or expired operation was not billed → regenerate.
      }
    }
  }

  const chain = getChain("video");
  let modalBudgetOk = true;
  if (chain.some((m) => getModelInfo(m).providerImpl === "modal")) {
    const worst = Number((getModalWorstCaseGpuSeconds() * getModalGpuUsdPerSecond()).toFixed(4));
    modalBudgetOk = (await checkModalBudget(worst)).ok;
  }
  const needsImage = Boolean(request.image);
  const routed = await routeCall({
    purpose: "video",
    chain,
    label,
    budget,
    budgetKind: "video",
    signal,
    onEvent,
    eligible: (info) => {
      if (info.family && info.family !== "video") return { ok: false, reason: "not a video model" };
      if (info.providerImpl === "mock") return { ok: false, reason: "mock model is never billed footage" };
      if (info.providerImpl === "modal" && !isModalConfigured()) return { ok: false, reason: "MODAL_VIDEO_ENDPOINT not set" };
      if (info.providerImpl === "modal" && !modalBudgetOk) return { ok: false, reason: "Modal monthly budget reached" };
      if (request.aspectRatio && info.aspectRatios?.length && !info.aspectRatios.includes(request.aspectRatio)) {
        return { ok: false, reason: `no ${request.aspectRatio} output` };
      }
      if (needsImage && info.supportsImageToVideo === false) return { ok: false, reason: "no image-to-video" };
      return { ok: true };
    },
    worstCaseUsd: (info) => clipWorstCaseUsd(info, request),
    attempt: async (info, { safe }) => {
      const adapter = createVideoAdapter(info.id);
      const req = safe && safePrompt ? { ...request, prompt: safePrompt } : request;
      const clip = await adapter.generate(req, { signal, onOperation: (name, meta) => onOperation?.(name, { ...meta, model: info.id }) });
      if (clip?.mock) throw new ProviderError("Video provider returned mock footage.", { category: "invalid_request", notCharged: true });
      // Estimated actual (published per-second rate × billed seconds) when the
      // provider reported no usage; never an invoice.
      if (!Number.isFinite(clip?.cost?.amountUsd)) {
        const secs = clip.durationSeconds || billedSeconds(info, request.durationSeconds);
        const est = Number((videoUsdPerSecond(info, clip.resolution || "720p") * secs).toFixed(4));
        clip.cost = { amountUsd: est, state: "estimated", basis: `${secs}s × $${videoUsdPerSecond(info, clip.resolution || "720p")}/s (published rate)` };
      }
      return clip;
    },
  });
  return { clip: routed.result, model: routed.model, attempts: routed.attempts, switched: routed.switched };
}
