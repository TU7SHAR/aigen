/**
 * Model registry tests — comparison/switching metadata, deprecation guard, and
 * that the cost estimate reads the registry. No API calls.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  VIDEO_MODELS,
  getModelInfo,
  listModels,
  deprecationWarning,
  getDefaultModelId,
} from "../lib/ai/modelRegistry.js";
import { estimateCost } from "../lib/costs/estimate.js";

test("default model is a GA (non-deprecated) model", () => {
  const info = getModelInfo(getDefaultModelId());
  assert.notEqual(info.status, "deprecated");
});

test("Veo 3.1 Lite is present but flagged deprecated and NOT recommended", () => {
  const veo = VIDEO_MODELS["veo-3.1-lite"];
  assert.ok(veo);
  assert.equal(veo.status, "deprecated");
  assert.equal(veo.recommended, false);
  assert.equal(veo.shutdownDate, "2026-10-22");
});

test("Omni is the recommended default and supports image-to-video", () => {
  const omni = VIDEO_MODELS["gemini-omni-1.1-flash"];
  assert.equal(omni.recommended, true);
  assert.equal(omni.supportsImageToVideo, true);
  assert.equal(omni.status, "ga");
});

test("unknown model id falls back to a usable gemini-omni record", () => {
  const info = getModelInfo("some-future-model");
  assert.equal(info.providerImpl, "gemini-omni");
  assert.ok(info.usdPerSecond720p >= 0);
});

test("deprecationWarning fires only for a deprecated default", () => {
  // default (Omni) → no warning
  assert.equal(deprecationWarning(), null);
  const prev = process.env.VIDEO_MODEL;
  process.env.VIDEO_MODEL = "veo-3.1-lite";
  assert.match(deprecationWarning() || "", /deprecated/i);
  if (prev === undefined) delete process.env.VIDEO_MODEL;
  else process.env.VIDEO_MODEL = prev;
});

test("cost estimate reflects the registry rate when no env override", () => {
  const prev = process.env.VIDEO_USD_PER_SECOND;
  delete process.env.VIDEO_USD_PER_SECOND;
  const est = estimateCost({ durationSeconds: 8, resolution: "720p" });
  const expected = Number((getModelInfo().usdPerSecond720p * 8).toFixed(4));
  assert.equal(est.amountUsd, expected);
  if (prev !== undefined) process.env.VIDEO_USD_PER_SECOND = prev;
});

test("listModels returns all registry entries", () => {
  assert.equal(listModels().length, Object.keys(VIDEO_MODELS).length);
});
