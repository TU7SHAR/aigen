/**
 * Provider factory. Chooses the active video provider based on configuration.
 *
 * Default is the mock provider (no cost). The real Gemini provider is only
 * selected when VIDEO_PROVIDER=gemini.
 */

import { getProviderName } from "../config.js";
import { createMockProvider } from "./mockProvider.js";
import { createGeminiProvider } from "./geminiProvider.js";

/** @returns {{ name: string, generate: Function }} */
export function getVideoProvider() {
  if (getProviderName() === "gemini") {
    return createGeminiProvider();
  }
  return createMockProvider();
}

export { ProviderError } from "./provider.js";
