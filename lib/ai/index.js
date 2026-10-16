/**
 * Provider router / factory.
 *
 * Chooses the video provider adapter from the ACTIVE model's `providerImpl`
 * (declared in the model registry), so whatever VIDEO_MODEL you set in the env
 * is routed to the correct API shape — and ONLY that adapter is constructed/
 * called. No wasted work for the other providers.
 *
 *   VIDEO_PROVIDER=mock           → mock (default; no cost)
 *   VIDEO_PROVIDER=gemini (or auto) + model.providerImpl:
 *       "gemini-omni" → Gemini Omni (synchronous Interactions API)
 *       "veo"         → Veo (long-running generateVideos operation)
 *       "mock"        → mock
 *
 * Adding a new model = a registry entry (+ an adapter if it's a new API shape).
 * The route handler and UI never change.
 */

import {
  getProviderName, getVideoModel, isModalConfigured, isPaidSceneVideoEnabled,
  getModalWorstCaseGpuSeconds, getModalGpuUsdPerSecond,
} from "../config.js";
import { getModelInfo } from "./modelRegistry.js";
import { createMockProvider } from "./mockProvider.js";
import { createGeminiProvider } from "./geminiProvider.js";
import { createVeoProvider } from "./veoProvider.js";
import { createModalProvider } from "./modalProvider.js";
import { checkModalBudget } from "../costs/modalLedger.js";
import { ProviderError } from "./provider.js";

/**
 * Resolve the video provider.
 *
 * Async because the `modal` route consults the persistent monthly budget: once
 * the $30 cap is reached (or Modal isn't configured), it falls back to the
 * Gemini path so we never burn Gemini credits while Modal budget remains, and
 * never overspend Modal.
 *
 * @param {{ estimatedUsd?: number }} [opts] prospective render cost, for the
 *   Modal budget check (we fall back BEFORE calling the GPU if it would exceed).
 * @returns {Promise<{ name: string, generate: Function, fallbackReason?: string }>}
 */
export async function getVideoProvider(opts = {}) {
  // Explicit mock mode (default) short-circuits everything — zero cost.
  if (getProviderName() === "mock") {
    return createMockProvider();
  }

  // Real mode: route by the active model's providerImpl.
  const impl = getModelInfo(getVideoModel()).providerImpl;
  switch (impl) {
    case "modal": {
      // Prefer the self-hosted Modal GPU worker while it's configured AND under
      // the monthly budget; otherwise fall back to the Gemini (Veo/Omni) path.
      if (!isModalConfigured()) {
        return withFallback(createGeminiFallback(), "Modal endpoint not configured — using Gemini.");
      }
      const budget = await checkModalBudget(opts.estimatedUsd || 0);
      if (!budget.ok) {
        return withFallback(createGeminiFallback(), budget.reason);
      }
      return createModalProvider();
    }
    case "veo":
      return createVeoProvider();
    case "gemini-omni":
      return createGeminiProvider();
    case "mock":
      return createMockProvider();
    default:
      throw new ProviderError(
        `No provider adapter for model "${getVideoModel()}" (providerImpl: "${impl}"). Add an adapter or fix the model's providerImpl in the registry.`,
        { status: 500 }
      );
  }
}

/** Build the Gemini-family fallback (Veo if a Veo model is set, else Omni). */
function createGeminiFallback() {
  // The fallback uses the configured GEMINI model family. If the active model
  // is `modal`, we fall back to the default Gemini Omni provider.
  const impl = getModelInfo(getVideoModel()).providerImpl;
  if (impl === "veo") return createVeoProvider();
  return createGeminiProvider();
}

function withFallback(provider, reason) {
  return { ...provider, fallbackReason: reason };
}

export { ProviderError } from "./provider.js";

/**
 * Resolve the provider for per-shot SCENE VIDEO (storyboard `ai_video` shots).
 *
 * Unlike getVideoProvider() this is FAIL-CLOSED: it never silently swaps Modal
 * for a (pricier) Gemini model. If the configured model's route is unavailable
 * it returns { provider: null, reason } and the shot degrades — reported.
 *
 * @param {{ durationSeconds: number }} shot
 * @returns {Promise<{ provider: object|null, model: string, worstCaseUsd: number, reason?: string }>}
 */
export async function getSceneVideoProvider({ durationSeconds = 4 } = {}) {
  const model = getVideoModel();
  if (!isPaidSceneVideoEnabled()) {
    return {
      provider: null, model, worstCaseUsd: 0,
      reason: "Scene video is off (needs VIDEO_PROVIDER=gemini, ENABLE_PAID_GENERATION=true, DISABLE_PAID_GENERATION=false, JOB_MAX_PAID_VIDEO_CLIPS>0).",
    };
  }
  const info = getModelInfo(model);
  if (info.providerImpl === "modal") {
    if (!isModalConfigured()) return { provider: null, model, worstCaseUsd: 0, reason: "MODAL_VIDEO_ENDPOINT not set." };
    const worstCaseUsd = Number((getModalWorstCaseGpuSeconds() * getModalGpuUsdPerSecond()).toFixed(4));
    const budget = await checkModalBudget(worstCaseUsd);
    if (!budget.ok) return { provider: null, model, worstCaseUsd, reason: budget.reason.replace(/ Falling back to Gemini\.$/, "") };
    return { provider: createModalProvider(), model, worstCaseUsd };
  }
  const veoSeconds = durationSeconds <= 4 ? 4 : durationSeconds <= 6 ? 6 : 8;
  const worstCaseUsd = Number(((info.usdPerSecond720p || 0.4) * veoSeconds * 1.5).toFixed(4));
  if (info.providerImpl === "veo") return { provider: createVeoProvider(), model, worstCaseUsd };
  if (info.providerImpl === "gemini-omni") return { provider: createGeminiProvider(), model, worstCaseUsd };
  return { provider: null, model, worstCaseUsd: 0, reason: `Model "${model}" has no scene-video adapter.` };
}
