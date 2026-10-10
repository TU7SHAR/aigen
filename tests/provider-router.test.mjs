/**
 * Provider router tests — whatever VIDEO_MODEL is set, the router selects the
 * correct adapter by the model's providerImpl, and ONLY that adapter is built.
 * No real API calls (we only inspect provider.name; mock makes no network call).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { getModelInfo } from "../lib/ai/modelRegistry.js";

async function withEnv(env, fn) {
  const prev = {};
  for (const k of Object.keys(env)) {
    prev[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(env)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

// Fresh import of the router each time so it re-reads env at call time.
async function routerName(env) {
  return withEnv(env, async () => {
    const mod = await import("../lib/ai/index.js?bust=" + Math.random());
    return mod.getVideoProvider().name;
  });
}

test("registry maps Veo models to providerImpl 'veo'", () => {
  assert.equal(getModelInfo("veo-3.1-lite").providerImpl, "veo");
  assert.equal(getModelInfo("veo-3.1-fast").providerImpl, "veo");
  assert.equal(getModelInfo("veo-3.1").providerImpl, "veo");
  assert.equal(getModelInfo("gemini-omni-1.1-flash").providerImpl, "gemini-omni");
});

test("Veo registry entries carry an apiModelId", () => {
  assert.ok(getModelInfo("veo-3.1-lite").apiModelId);
  assert.match(getModelInfo("veo-3.1-lite").apiModelId, /veo/);
});

test("router: mock mode always returns mock (zero cost), any model", async () => {
  assert.equal(await routerName({ VIDEO_PROVIDER: "mock", VIDEO_MODEL: "veo-3.1-lite" }), "mock");
  assert.equal(await routerName({ VIDEO_PROVIDER: "mock", VIDEO_MODEL: "gemini-omni-1.1-flash" }), "mock");
});

test("router: real mode + Veo model → veo provider", async () => {
  const name = await routerName({
    VIDEO_PROVIDER: "gemini",
    GEMINI_API_KEY: "test-key",
    VIDEO_MODEL: "veo-3.1-lite",
  });
  assert.equal(name, "veo");
});

test("router: real mode + Omni model → gemini provider", async () => {
  const name = await routerName({
    VIDEO_PROVIDER: "gemini",
    GEMINI_API_KEY: "test-key",
    VIDEO_MODEL: "gemini-omni-1.1-flash",
  });
  assert.equal(name, "gemini");
});

test("router: an unknown model id → gemini-omni adapter (safe default)", async () => {
  const name = await routerName({
    VIDEO_PROVIDER: "gemini",
    GEMINI_API_KEY: "test-key",
    VIDEO_MODEL: "some-future-model",
  });
  assert.equal(name, "gemini");
});
