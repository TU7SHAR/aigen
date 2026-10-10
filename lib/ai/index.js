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

import { getProviderName, getVideoModel } from "../config.js";
import { getModelInfo } from "./modelRegistry.js";
import { createMockProvider } from "./mockProvider.js";
import { createGeminiProvider } from "./geminiProvider.js";
import { createVeoProvider } from "./veoProvider.js";
import { ProviderError } from "./provider.js";

/** @returns {{ name: string, generate: Function }} */
export function getVideoProvider() {
  // Explicit mock mode (default) short-circuits everything — zero cost.
  if (getProviderName() === "mock") {
    return createMockProvider();
  }

  // Real mode: route by the active model's providerImpl.
  const impl = getModelInfo(getVideoModel()).providerImpl;
  switch (impl) {
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

export { ProviderError } from "./provider.js";
