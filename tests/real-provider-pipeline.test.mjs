/**
 * Real-provider pipeline safety tests (mock-only — NO paid calls are made).
 *
 * Verifies the fail-closed per-job budget guard, accurate provenance (mock
 * keyframes are never reported as AI output), that scene video stays off
 * unless every gate is open, that a real image provider's output IS reported
 * as ai_image, and that a generated clip is rendered as an ai_video shot.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import { createJobBudget, BudgetError } from "../lib/costs/jobBudget.js";
import { getSceneVideoProvider } from "../lib/ai/index.js";
import { getProviderStatus } from "../lib/ai/providerStatus.js";
import { _internal as comp } from "../lib/render/compositor.js";
import { renderScreenAd } from "../lib/render/screenRenderer.js";
import { probe } from "../lib/render/ffmpeg.js";

function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) { prev[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  const restore = () => { for (const k of Object.keys(prev)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } };
  try { const r = fn(); if (r?.then) return r.finally(restore); restore(); return r; } catch (e) { restore(); throw e; }
}

test("job budget refuses calls over the per-job image cap BEFORE calling", async () => {
  const b = createJobBudget({ maxUsd: 1, maxImages: 1, maxVideoClips: 0, maxRetries: 0, imageUsdPerImage: 0.04 });
  let calls = 0;
  await b.run("image", 0.04, "a", async () => { calls++; return { cost: { amountUsd: null } }; });
  await assert.rejects(b.run("image", 0.04, "b", async () => { calls++; }), BudgetError);
  assert.equal(calls, 1, "second call never executed");
  assert.equal(b.summary().paidImages, 1);
});

test("job budget refuses video when clip cap is 0 and when USD would exceed", async () => {
  const b = createJobBudget({ maxUsd: 0.1, maxImages: 4, maxVideoClips: 0, maxRetries: 0, imageUsdPerImage: 0.04 });
  assert.throws(() => b.reserve("video", 0.05, "clip"), /video-clip cap/);
  const b2 = createJobBudget({ maxUsd: 0.05, maxImages: 4, maxVideoClips: 1, maxRetries: 0, imageUsdPerImage: 0.04 });
  b2.reserve("image", 0.04, "x");
  assert.throws(() => b2.reserve("image", 0.04, "y"), /Per-job budget/);
});

test("job budget is fail-closed: unknown cost refused, failed call still charged, no silent retry", async () => {
  const b = createJobBudget({ maxUsd: 1, maxImages: 4, maxVideoClips: 0, maxRetries: 0, imageUsdPerImage: 0.04 });
  assert.throws(() => b.reserve("image", 0, "free?"), /fail-closed/);
  let calls = 0;
  await assert.rejects(b.run("image", 0.04, "boom", async () => { calls++; throw new Error("provider 500"); }));
  assert.equal(calls, 1, "no retry by default");
  assert.equal(b.summary().reservedUsd, 0.04, "failed call still counted");
});

test("scene video stays OFF unless every gate is open (kill-switch default)", async () => {
  await withEnv({ VIDEO_PROVIDER: "gemini", ENABLE_PAID_GENERATION: "true", DISABLE_PAID_GENERATION: undefined, JOB_MAX_PAID_VIDEO_CLIPS: "1" }, async () => {
    const sv = await getSceneVideoProvider({ durationSeconds: 3 });
    assert.equal(sv.provider, null);
    assert.match(sv.reason, /DISABLE_PAID_GENERATION/);
  });
  await withEnv({ VIDEO_PROVIDER: "gemini", ENABLE_PAID_GENERATION: "true", DISABLE_PAID_GENERATION: "false", JOB_MAX_PAID_VIDEO_CLIPS: "0" }, async () => {
    const sv = await getSceneVideoProvider({ durationSeconds: 3 });
    assert.equal(sv.provider, null);
  });
});

test("modal scene video never silently falls back to Gemini", async () => {
  await withEnv({
    VIDEO_PROVIDER: "gemini", ENABLE_PAID_GENERATION: "true", DISABLE_PAID_GENERATION: "false",
    JOB_MAX_PAID_VIDEO_CLIPS: "1", VIDEO_MODEL: "modal-video", MODAL_VIDEO_ENDPOINT: undefined,
  }, async () => {
    const sv = await getSceneVideoProvider({ durationSeconds: 3 });
    assert.equal(sv.provider, null);
    assert.match(sv.reason, /MODAL_VIDEO_ENDPOINT/);
  });
});

test("provider status exposes real/mock state but never secret values", async () => {
  await withEnv({ GEMINI_API_KEY: "SECRET-should-not-leak", MODAL_WORKER_SECRET: "also-secret", IMAGE_PROVIDER: undefined }, async () => {
    const s = await getProviderStatus();
    assert.equal(s.image.real, false);
    assert.equal(s.image.provider, "mock");
    const json = JSON.stringify(s);
    assert.ok(!json.includes("SECRET-should-not-leak") && !json.includes("also-secret"));
  });
});

test("real image provider output is reported as ai_image; mock as placeholder", () => {
  const plan = {
    storyboardOrigin: "ai",
    scenes: [
      { duration: 2, technique: "ai_image", generatedImagePath: "/x/a.png", keyframeProvider: "gemini", keyframeModel: "gemini-2.5-flash-image", keyframeMock: false },
      { duration: 2, technique: "ai_image", generatedImagePath: "/x/b.png", keyframeProvider: "mock", keyframeMock: true },
      { duration: 2, technique: "ai_video", generatedImagePath: "/x/c.png", generatedVideoPath: "/x/c.mp4", keyframeMock: false, videoProvider: "modal", videoModel: "LTX" },
    ],
  };
  const scenes = comp.buildScenes(plan, [], {}, []);
  assert.equal(scenes[0].executedMethod, "ai_image");
  assert.equal(scenes[0].downgradedFrom, null);
  assert.equal(scenes[1].executedMethod, "placeholder_keyframe");
  assert.equal(scenes[2].executedMethod, "ai_video");
  assert.equal(scenes[2].videoPath, "/x/c.mp4");
});

test("renderer plays a generated clip for an ai_video shot (cover-crop + hold)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mac-clip-test-"));
  try {
    const { runFfmpeg } = await import("../lib/render/ffmpeg.js");
    const clip = path.join(dir, "c.mp4");
    // 1s 16:9 test clip; the shot is 2s 9:16, so it must be cropped and held.
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=24:duration=1", "-pix_fmt", "yuv420p", clip]);
    const out = await renderScreenAd({
      scenes: [{ videoPath: clip, durationSec: 2 }, { imagePath: null, durationSec: 1.5, purpose: "end" }],
      overlays: [], width: 180, height: 320, brandColorHex: "#223366", accentHex: "#ff5a24",
    });
    const f = path.join(dir, "out.mp4");
    await fs.writeFile(f, out.buffer);
    const p = await probe(f);
    assert.ok(p.durationSec > 2.8 && p.durationSec < 3.6, `duration ${p.durationSec}`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
