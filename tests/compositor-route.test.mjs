/**
 * Deterministic compositor route + dry-run gate (Priority 0, 1, 2).
 *
 * Proves, with NO paid call:
 *  - default/screen_demo format renders a REAL finished MP4 via ffmpeg from a
 *    real stored asset + exact overlays (not the mock placeholder, not a model),
 *  - the output is a valid, non-trivial MP4 with the requested dimensions,
 *  - generative format with paid HARD-disabled returns a DRY RUN (full plan,
 *    no video, zero cost) — never a paid call,
 *  - exact copy (brand/offer/cta) appears in the render overlay list.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import sharp from "sharp";

import { LocalAssetStore } from "../lib/assets/store.js";
import { probe } from "../lib/render/ffmpeg.js";

// Deterministic route needs no provider; keep paid HARD-disabled (the safe
// default) so the dry-run test is meaningful.
process.env.VIDEO_PROVIDER = "mock";
delete process.env.DISABLE_PAID_GENERATION; // default → paid hard-disabled
const { runGenerate, __resetGenerateGuards } = await import("../lib/api/generateCore.js");

const cleanup = [];
let shotUrl;

before(async () => {
  const png = await sharp({ create: { width: 1280, height: 800, channels: 3, background: "#6D28D9" } }).png().toBuffer();
  const saved = await new LocalAssetStore().save({ buffer: png, mimeType: "image/png", sourceUrl: "https://x/shot.png" });
  shotUrl = saved.storedUrl;
  cleanup.push(path.join(process.cwd(), "public", shotUrl));
});

after(async () => {
  await Promise.all(cleanup.map((p) => fs.rm(p, { force: true })));
});

function baseInput(extra = {}) {
  return {
    productName: "BhavishAI",
    brand: "BhavishAI",
    description: "AI-powered Vedic astrology from your real birth chart.",
    offering: "personalized astrology readings",
    offer: "", // intentionally empty → must NOT be fabricated
    cta: "Start your reading",
    template: "product-demo",
    aspectRatio: "9:16",
    resolution: "360p", // small = fast test render
    durationSeconds: 6,
    entityType: "saas",
    clientRequestId: `c-${Math.random().toString(36).slice(2)}`,
    ...extra,
  };
}

test("screen_demo (default) renders a REAL finished MP4 from a real asset — no paid call", async () => {
  __resetGenerateGuards();
  const { status, body } = await runGenerate(
    baseInput({ referenceAssets: [{ url: shotUrl, role: "product_screenshot", primary: true }] })
  );
  assert.equal(status, 200, JSON.stringify(body).slice(0, 300));
  assert.equal(body.ok, true);
  assert.equal(body.deterministic, true);
  assert.equal(body.provider, "compositor");
  assert.equal(body.mock, false);
  assert.equal(body.cost.reported.amountUsd, 0, "deterministic render costs nothing");
  assert.ok(body.video?.startsWith("data:video/mp4;base64,"), "returns a playable mp4 data URL");
  assert.equal(body.render.usedImages, 1, "used the real asset");

  // Decode the mp4 and probe it — must be a valid, non-trivial video.
  const b64 = body.video.split(",")[1];
  const buf = Buffer.from(b64, "base64");
  assert.ok(buf.length > 20_000, `mp4 should be substantial, got ${buf.length} bytes`);
  const tmp = path.join(os.tmpdir(), `ctest-${Date.now()}.mp4`);
  await fs.writeFile(tmp, buf);
  const p = await probe(tmp);
  await fs.rm(tmp, { force: true });
  assert.ok(p.durationSec > 3, `duration should be ~6s, got ${p.durationSec}`);
  assert.equal(p.width, body.render.width);
});

test("exact brand + CTA appear as deterministic overlays; empty offer is NOT fabricated", async () => {
  __resetGenerateGuards();
  const { body } = await runGenerate(
    baseInput({ referenceAssets: [{ url: shotUrl, role: "hero_visual", primary: true }] })
  );
  const kinds = body.render.overlays.map((o) => `${o.kind}:${o.text}`);
  assert.ok(kinds.some((k) => k === "brand:BhavishAI"), `brand overlay present: ${kinds}`);
  assert.ok(kinds.some((k) => k.startsWith("cta:Start your reading")), `cta overlay present: ${kinds}`);
  // No offer was provided → there must be NO offer overlay (no invented discount).
  assert.ok(!body.render.overlays.some((o) => o.kind === "offer"), "must not fabricate an offer");
});

test("no real images → still renders (branded cards), never invents a UI", async () => {
  __resetGenerateGuards();
  const { status, body } = await runGenerate(baseInput()); // no referenceAssets
  assert.equal(status, 200);
  assert.equal(body.deterministic, true);
  assert.equal(body.render.usedImages, 0);
  assert.ok(body.video?.startsWith("data:video/mp4;base64,"));
});

test("generative format with paid HARD-disabled → DRY RUN plan, no video, zero cost", async () => {
  __resetGenerateGuards();
  const { status, body } = await runGenerate(baseInput({ format: "generative" }));
  assert.equal(status, 200);
  assert.equal(body.dryRun, true);
  assert.equal(body.video, null, "dry run must not return a video");
  assert.equal(body.cost.reported.amountUsd, 0);
  // The plan the user reviews before authorizing a paid call.
  assert.ok(body.plan, "dry run returns a plan");
  assert.equal(body.plan.offering.brand, "BhavishAI");
  assert.ok(Array.isArray(body.plan.storyboard) && body.plan.storyboard.length > 0);
  assert.ok(body.plan.finalModelRequest.prompt.length > 0);
  assert.ok(/DRY RUN/i.test(body.note));
});
