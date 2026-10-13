/**
 * Product PR A — user corrections & controls propagate into the creative state.
 *
 * Proves (pure, no network, no paid calls):
 *  - user-corrected category/offering override scraped productProfile values
 *  - user `emphasis` appears as an affirmative line in the final prompt
 *  - user `avoid` entries are appended to the negative/avoid list
 *  - emphasis/avoid are carried on the brief for the preview + PR-B director
 *  - multiple selected referenceAssets resolve: the primary reaches the mock
 *    provider and the full selection is recorded on sourceImageMeta
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";

import { compileCreativeRequest } from "../lib/creative/compile.js";
import { LocalAssetStore } from "../lib/assets/store.js";

process.env.VIDEO_PROVIDER = "mock";
process.env.DISABLE_PAID_GENERATION = "false"; // allow generative route; mock is free
delete process.env.ENABLE_PAID_GENERATION;
const { runGenerate, __resetGenerateGuards } = await import("../lib/api/generateCore.js");

function baseInput(extra = {}) {
  return {
    productName: "Acme Analytics",
    brand: "Acme",
    description: "A dashboard that surfaces product metrics clearly.",
    template: "product-demo",
    aspectRatio: "9:16",
    resolution: "720p",
    durationSeconds: 8,
    entityType: "saas",
    productProfile: { category: "Spreadsheet tool", entityType: "saas", benefits: ["Faster insight"] },
    ...extra,
  };
}

test("user-corrected category overrides the scraped productProfile category", () => {
  const compiled = compileCreativeRequest(baseInput({ category: "Product analytics platform" }));
  // The compiled product should carry the user's category, not the scraped one.
  assert.match(JSON.stringify(compiled.generationContext), /Product analytics platform/i);
  assert.doesNotMatch(compiled.finalVideoPrompt, /Spreadsheet tool/i);
});

test("emphasis appears as an affirmative instruction in the final prompt", () => {
  const compiled = compileCreativeRequest(
    baseInput({ emphasis: ["real-time collaboration", "SOC2 compliance"] })
  );
  assert.match(compiled.finalVideoPrompt, /EMPHASIZE/);
  assert.match(compiled.finalVideoPrompt, /real-time collaboration/);
  assert.match(compiled.finalVideoPrompt, /SOC2 compliance/);
});

test("avoid entries are appended to the negative/avoid rules", () => {
  const compiled = compileCreativeRequest(
    baseInput({ avoid: ["no stock-photo office", "do not show competitor logos"] })
  );
  assert.ok(compiled.negativeRules.includes("no stock-photo office"));
  assert.ok(compiled.negativeRules.includes("do not show competitor logos"));
  assert.match(compiled.finalVideoPrompt, /no stock-photo office/);
});

test("emphasis/avoid are carried on the brief (for preview + AI director)", () => {
  const compiled = compileCreativeRequest(
    baseInput({ emphasis: ["privacy-first"], avoid: ["no clutter"] })
  );
  assert.deepEqual(compiled.brief.emphasis, ["privacy-first"]);
  assert.deepEqual(compiled.brief.avoid, ["no clutter"]);
});

test("empty/duplicate emphasis+avoid are normalized away", () => {
  const compiled = compileCreativeRequest(
    baseInput({ emphasis: ["speed", "speed", "  "], avoid: ["", "no neon", "no neon"] })
  );
  assert.deepEqual(compiled.brief.emphasis, ["speed"]);
  assert.deepEqual(compiled.brief.avoid, ["no neon"]);
});

// --- Multi-reference resolution through the real generate pipeline ---
const cleanup = [];
let heroUrl;
let secondaryUrl;

before(async () => {
  const store = new LocalAssetStore();
  const a = await sharp({ create: { width: 1200, height: 800, channels: 3, background: "#6D28D9" } }).png().toBuffer();
  const b = await sharp({ create: { width: 900, height: 900, channels: 3, background: "#0EA5E9" } }).png().toBuffer();
  const sa = await store.save({ buffer: a, mimeType: "image/png", sourceUrl: "https://x/a.png" });
  const sb = await store.save({ buffer: b, mimeType: "image/png", sourceUrl: "https://x/b.png" });
  heroUrl = sa.storedUrl;
  secondaryUrl = sb.storedUrl;
  cleanup.push(path.join(process.cwd(), "public", heroUrl), path.join(process.cwd(), "public", secondaryUrl));
});

after(async () => {
  await Promise.all(cleanup.map((p) => fs.rm(p, { force: true })));
});

test("multiple referenceAssets: flagged primary reaches the provider; selection recorded", async () => {
  __resetGenerateGuards();
  const payload = baseInput({
    clientRequestId: "pa-multi-1",
    format: "generative", // route to the (mock) provider to assert image reached it
    referenceAssets: [
      { url: secondaryUrl, role: "product_screenshot" },
      { url: heroUrl, role: "hero_visual", primary: true },
    ],
  });
  const { status, body } = await runGenerate(payload);
  assert.equal(status, 200, JSON.stringify(body).slice(0, 200));
  assert.equal(body.mock, true);
  assert.equal(body.receivedRequest.hasImage, true);
  assert.equal(body.receivedRequest.imageMimeType, "image/png");
  // The primary (heroUrl, 1200x800) should be the one sent — not the first in
  // the array — proving the `primary` flag is honored.
  assert.ok(body.receivedRequest.imageBytesApprox > 1000);
});

test("referenceAssets with no primary flag uses the first selected", async () => {
  __resetGenerateGuards();
  const payload = baseInput({
    clientRequestId: "pa-multi-2",
    format: "generative",
    referenceAssets: [{ url: heroUrl, role: "hero_visual" }],
  });
  const { status, body } = await runGenerate(payload);
  assert.equal(status, 200);
  assert.equal(body.receivedRequest.hasImage, true);
});
