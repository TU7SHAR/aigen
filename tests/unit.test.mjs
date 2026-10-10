/**
 * Unit tests — run with: npm test
 * These use the MOCK provider and pure functions only. No API calls, no cost.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildAdPrompt } from "../lib/prompts/adPrompt.js";
import { generateRequestSchema } from "../lib/validation.js";
import {
  estimateCost,
  checkSpendBudget,
  costFromUsage,
} from "../lib/costs/estimate.js";
import { createMockProvider } from "../lib/ai/mockProvider.js";

test("buildAdPrompt includes product + fidelity guardrail (image case)", () => {
  const p = buildAdPrompt({
    productName: "Face Serum",
    brand: "Lumière",
    template: "luxury",
    durationSeconds: 8,
    hasImage: true,
  });
  assert.match(p, /Face Serum/);
  assert.match(p, /Lumière/);
  assert.match(p, /unchanged/i); // keep packaging/logo unchanged
  assert.match(p, /8-second/);
});

test("buildAdPrompt without image avoids inventing logos", () => {
  const p = buildAdPrompt({ productName: "Mug", template: "minimal" });
  assert.match(p, /do not invent brand logos/i);
});

test("validation rejects missing product name", () => {
  const r = generateRequestSchema.safeParse({
    template: "bold",
    aspectRatio: "9:16",
  });
  assert.equal(r.success, false);
});

test("validation rejects unknown template / ratio", () => {
  const r = generateRequestSchema.safeParse({
    productName: "X",
    template: "nope",
    aspectRatio: "4:5",
  });
  assert.equal(r.success, false);
});

test("validation accepts a well-formed payload with defaults", () => {
  const r = generateRequestSchema.safeParse({
    productName: "Serum",
    template: "luxury",
    aspectRatio: "16:9",
  });
  assert.equal(r.success, true);
  assert.equal(r.data.resolution, "720p");
  assert.equal(r.data.durationSeconds, 8);
});

test("estimateCost scales with duration and resolution", () => {
  const a = estimateCost({ durationSeconds: 8, resolution: "720p" });
  const b = estimateCost({ durationSeconds: 8, resolution: "1080p" });
  const c = estimateCost({ durationSeconds: 4, resolution: "720p" });
  assert.equal(a.state, "estimated");
  assert.ok(b.amountUsd > a.amountUsd); // higher res costs more
  assert.ok(c.amountUsd < a.amountUsd); // shorter costs less
});

test("checkSpendBudget blocks when over the cap", () => {
  const ok = checkSpendBudget(1, 5);
  const blocked = checkSpendBudget(10, 5);
  assert.equal(ok.ok, true);
  assert.equal(blocked.ok, false);
});

test("costFromUsage returns billed cost from reported tokens", () => {
  // 8s of 720p video ≈ 5792 tok/s ≈ 46336 video output tokens.
  const r = costFromUsage({
    total_input_tokens: 1200,
    total_output_tokens: 46336,
    total_tokens: 47536,
  });
  assert.equal(r.state, "billed");
  // input: 1200/1e6*1.5 = 0.0018 ; video: 46336/1e6*17.5 = 0.810...
  assert.ok(r.amountUsd > 0.8 && r.amountUsd < 0.9);
  assert.equal(r.tokens.total, 47536);
});

test("costFromUsage returns unknown when no usage reported", () => {
  const r = costFromUsage(null);
  assert.equal(r.state, "unknown");
  assert.equal(r.amountUsd, null);
});

test("mock provider returns a flagged placeholder MP4, no cost", async () => {
  const provider = createMockProvider();
  const res = await provider.generate({
    durationSeconds: 8,
    resolution: "720p",
  });
  assert.equal(res.mock, true);
  assert.equal(res.provider, "mock");
  assert.equal(res.cost.amountUsd, 0);
  assert.equal(res.mimeType, "video/mp4");
  // base64 decodes to bytes starting with an ftyp box signature.
  const buf = Buffer.from(res.videoBase64, "base64");
  assert.ok(buf.length > 8);
  assert.equal(buf.toString("ascii", 4, 8), "ftyp");
});
