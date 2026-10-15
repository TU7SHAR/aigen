/**
 * Image provider router / factory — picks the per-shot keyframe generator.
 *
 * Default is the MOCK keyframe provider: a real, on-brand, non-empty image at
 * ZERO cost, so the compositor always has genuine visual content to animate
 * even before any paid provider is wired. The real Gemini image provider is
 * returned ONLY when BOTH IMAGE_PROVIDER=gemini AND paid image generation is
 * enabled AND a key is present — otherwise we fall back to mock and tell the
 * caller WHY (so the shot report can say "deterministic keyframe", honestly).
 */

import { getImageProviderName, isPaidImageGenerationEnabled, getGeminiApiKey } from "../config.js";
import { createMockImageProvider } from "./mockImageProvider.js";
import { createGeminiImageProvider } from "./geminiImageProvider.js";

/**
 * @returns {{ name: string, generateKeyframe: Function, mockFallback: boolean, fallbackReason?: string }}
 */
export function getImageProvider() {
  const want = getImageProviderName();
  if (want !== "gemini") {
    return { ...createMockImageProvider(), mockFallback: false };
  }
  // Real path requested — enforce the paid gate + key before returning it.
  if (!isPaidImageGenerationEnabled()) {
    return {
      ...createMockImageProvider(),
      mockFallback: true,
      fallbackReason: "Paid image generation is disabled (set ENABLE_PAID_IMAGE_GENERATION=true). Using mock keyframe.",
    };
  }
  if (!getGeminiApiKey()) {
    return {
      ...createMockImageProvider(),
      mockFallback: true,
      fallbackReason: "GEMINI_API_KEY not set. Using mock keyframe.",
    };
  }
  return { ...createGeminiImageProvider(), mockFallback: false };
}

export { ImageProviderError } from "./imageProvider.js";
