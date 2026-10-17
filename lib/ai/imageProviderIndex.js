/**
 * Image provider router — picks how per-shot keyframes are produced.
 *
 * Default is the MOCK keyframe provider (deterministic, labelled placeholder,
 * zero cost). The real path is returned only when IMAGE_PROVIDER=gemini, paid
 * image generation is enabled and a key exists; it then routes each keyframe
 * across the image chain (getChain("image"), cheapest current model first)
 * with automatic switching, under the job budget.
 */

import { getImageProviderName, isPaidImageGenerationEnabled, getGeminiApiKey } from "../config.js";
import { createMockImageProvider } from "./mockImageProvider.js";
import { createGeminiImageProvider } from "./geminiImageProvider.js";
import { getChain, getModelInfo } from "./modelRegistry.js";
import { routeCall } from "./router.js";

function routedGeminiProvider() {
  const chain = getChain("image");
  return {
    name: "gemini",
    model: chain[0],
    chain,
    /**
     * @param {object} request keyframe request (lib/ai/imageProvider.js)
     * @param {{ budget?: object, label?: string, onEvent?: Function, signal?: AbortSignal }} [ctx]
     */
    async generateKeyframe(request, ctx = {}) {
      const routed = await routeCall({
        purpose: "image",
        chain,
        label: ctx.label || "keyframe",
        budget: ctx.budget || null,
        budgetKind: "image",
        onEvent: ctx.onEvent,
        signal: ctx.signal,
        eligible: (info) => (info.family === "image" ? { ok: true } : { ok: false, reason: "not an image model" }),
        worstCaseUsd: (info) => Math.max(0.001, Number(info.usdPerUnit || 0.07)),
        attempt: (info) => createGeminiImageProvider(info.id).generateKeyframe(request),
      });
      return { ...routed.result, model: routed.model, attempts: routed.attempts, switched: routed.switched };
    },
  };
}

/**
 * @returns {{ name: string, generateKeyframe: Function, mockFallback: boolean, fallbackReason?: string, model?: string, chain?: string[] }}
 */
export function getImageProvider() {
  if (getImageProviderName() !== "gemini") return { ...createMockImageProvider(), mockFallback: false };
  if (!isPaidImageGenerationEnabled()) {
    return {
      ...createMockImageProvider(),
      mockFallback: true,
      fallbackReason: "Paid image generation is off (needs ENABLE_PAID_IMAGE_GENERATION=true and DISABLE_PAID_GENERATION=false). Using a mock placeholder keyframe.",
    };
  }
  if (!getGeminiApiKey()) {
    return { ...createMockImageProvider(), mockFallback: true, fallbackReason: "GEMINI_API_KEY not set. Using mock keyframe." };
  }
  return { ...routedGeminiProvider(), mockFallback: false };
}

/** Label for status UIs. */
export function imageModelLabel() {
  const head = getChain("image")[0];
  return getModelInfo(head).label || head;
}

export { ImageProviderError } from "./imageProvider.js";
