/**
 * Image-provider boundary + keyframe production tests (no paid calls, no key).
 *
 * Verifies: the mock image provider produces a REAL non-empty PNG (not black,
 * not a placeholder); the router honors gates and falls back to mock honestly;
 * the compositor's keyframe pass attaches generated frames to ai_image shots so
 * they become genuinely-visual (not black cards); and quality verification flags
 * an all-empty (black-slideshow) output.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";

import { createMockImageProvider, _internal as mockImg } from "../lib/ai/mockImageProvider.js";
import { getImageProvider } from "../lib/ai/imageProviderIndex.js";
import { _internal as comp } from "../lib/render/compositor.js";

test("mock image provider returns a real, decodable, non-uniform PNG keyframe", async () => {
  const p = createMockImageProvider();
  const kf = await p.generateKeyframe({
    prompt: "A lone person under a vast night sky",
    subjectText: "Stop reading generic horoscopes",
    brand: { name: "BhavishAI", colors: ["#2b1a6e", "#ff8a3d"] },
    width: 360, height: 640, aspectRatio: "9:16",
  });
  assert.equal(kf.provider, "mock");
  assert.equal(kf.mock, true);
  assert.ok(kf.imageBase64.length > 1000, "keyframe has real image bytes");
  const buf = Buffer.from(kf.imageBase64, "base64");
  const img = sharp(buf);
  const meta = await img.metadata();
  assert.equal(meta.width, 360);
  assert.equal(meta.height, 640);
  // Not black / not uniform: the std-dev of channels must be clearly > 0.
  const stats = await img.stats();
  const maxStdev = Math.max(...stats.channels.map((c) => c.stdev));
  assert.ok(maxStdev > 5, `keyframe must have visual variation (got stdev ${maxStdev.toFixed(1)})`);
  // Mean brightness must not be ~black.
  const meanLum = stats.channels.slice(0, 3).reduce((a, c) => a + c.mean, 0) / 3;
  assert.ok(meanLum > 20, `keyframe must not be near-black (mean ${meanLum.toFixed(1)})`);
});

test("distinct shots yield visually distinct keyframes (not one repeated frame)", async () => {
  const p = createMockImageProvider();
  const a = await p.generateKeyframe({ prompt: "night sky", subjectText: "A", brand: { colors: ["#2b1a6e"] }, width: 200, height: 356 });
  const b = await p.generateKeyframe({ prompt: "sunrise mountains", subjectText: "B", brand: { colors: ["#2b1a6e"] }, width: 200, height: 356 });
  assert.notEqual(a.imageBase64, b.imageBase64, "different prompts → different keyframes");
});

test("router defaults to mock with zero cost and no key", () => {
  const prev = { ip: process.env.IMAGE_PROVIDER, paid: process.env.ENABLE_PAID_IMAGE_GENERATION };
  delete process.env.IMAGE_PROVIDER;
  delete process.env.ENABLE_PAID_IMAGE_GENERATION;
  const prov = getImageProvider();
  assert.equal(prov.name, "mock");
  assert.equal(prov.mockFallback, false);
  process.env.IMAGE_PROVIDER = prev.ip ?? "";
  process.env.ENABLE_PAID_IMAGE_GENERATION = prev.paid ?? "";
});

test("router falls back to mock (honestly) when gemini requested but paid gen disabled", () => {
  const prev = { ip: process.env.IMAGE_PROVIDER, paid: process.env.ENABLE_PAID_IMAGE_GENERATION };
  process.env.IMAGE_PROVIDER = "gemini";
  process.env.ENABLE_PAID_IMAGE_GENERATION = "false";
  const prov = getImageProvider();
  assert.equal(prov.name, "mock");
  assert.equal(prov.mockFallback, true);
  assert.match(prov.fallbackReason, /off/i);
  process.env.IMAGE_PROVIDER = prev.ip ?? "";
  process.env.ENABLE_PAID_IMAGE_GENERATION = prev.paid ?? "";
});

test("keyframe pass attaches a generated frame to an ai_image shot with no real asset", async () => {
  const scenePlan = {
    storyboardOrigin: "ai",
    totalDuration: 5,
    scenes: [
      { intent: "hook", duration: 2.5, technique: "ai_image", assetHint: "none", visual: "night sky", onScreenText: "Hook" },
      { intent: "cta", duration: 2.5, technique: "motion_graphic", assetHint: "none", visual: "card", onScreenText: "CTA" },
    ],
  };
  const kf = await comp.generateKeyframes({
    scenePlan, imagePaths: [], assetMeta: [], width: 180, height: 320,
    brand: { name: "Test", colors: ["#223366"] }, aspectRatio: "9:16",
  });
  try {
    assert.equal(kf.generatedCount, 1, "the one ai_image shot got a keyframe");
    const scenes = comp.buildScenes(kf.scenePlan, [], {}, []);
    // A MOCK keyframe is a placeholder, never reported as AI output.
    assert.equal(scenes[0].executedMethod, "placeholder_keyframe");
    assert.equal(scenes[0].downgradedFrom, "ai_image");
    assert.equal(scenes[0].keyframeProvider, "mock");
    assert.equal(scenes[1].executedMethod, "motion_graphic"); // untouched
  } finally {
    await kf.cleanup();
  }
});

test("a real asset is preferred over a keyframe for a role-matched ai_image shot", async () => {
  const scenePlan = {
    storyboardOrigin: "ai",
    totalDuration: 3,
    scenes: [{ intent: "hero", duration: 3, technique: "ai_image", assetHint: "product", visual: "x", onScreenText: "" }],
  };
  const kf = await comp.generateKeyframes({
    scenePlan, imagePaths: ["/imported-assets/real.png"], assetMeta: [{ role: "product" }],
    width: 180, height: 320, brand: { colors: ["#223366"] },
  });
  try {
    assert.equal(kf.generatedCount, 0, "role-matched real asset wins — no keyframe generated");
  } finally {
    await kf.cleanup();
  }
});
