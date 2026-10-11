/**
 * END-TO-END (lib level): a selected imported reference actually reaches the
 * generation provider. We store a real image via the asset store, resolve it
 * with the SAME resolveReferenceAsset() the /api/generate route uses, hand it to
 * the mock provider (no paid call), and assert the provider received the image
 * bytes. This proves the request contract: selected reference → provider input.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";

import { LocalAssetStore } from "../lib/assets/store.js";
import { resolveReferenceAsset } from "../lib/assets/resolveReference.js";
import { createMockProvider } from "../lib/ai/mockProvider.js";

let storedUrl;
let storedPath;

before(async () => {
  const png = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#6D28D9" } }).png().toBuffer();
  const store = new LocalAssetStore();
  const saved = await store.save({ buffer: png, mimeType: "image/png", sourceUrl: "https://example.com/hero.png" });
  storedUrl = saved.storedUrl;
  storedPath = path.join(process.cwd(), "public", storedUrl);
});

after(async () => {
  if (storedPath) await fs.rm(storedPath, { force: true });
});

test("stored asset exists on disk", async () => {
  await assert.doesNotReject(fs.access(storedPath));
});

test("resolveReferenceAsset reads a stored /imported-assets/ URL into base64", async () => {
  const ref = await resolveReferenceAsset(storedUrl);
  assert.ok(ref, "should resolve the stored asset");
  assert.equal(ref.mimeType, "image/png");
  assert.ok(ref.data.length > 1000);
  // round-trips to a real PNG
  const meta = await sharp(Buffer.from(ref.data, "base64")).metadata();
  assert.equal(meta.format, "png");
  assert.equal(meta.width, 1024);
});

test("resolveReferenceAsset rejects path traversal and SVG", async () => {
  assert.equal(await resolveReferenceAsset("/imported-assets/../../etc/passwd"), null);
  // SVG is not sent as a raster reference
  const store = new LocalAssetStore();
  const svgSaved = await store.save({ buffer: Buffer.from("<svg/>"), mimeType: "image/svg+xml", sourceUrl: "x" });
  assert.equal(await resolveReferenceAsset(svgSaved.storedUrl), null);
  await fs.rm(path.join(process.cwd(), "public", svgSaved.storedUrl), { force: true });
});

test("E2E: resolved reference reaches the (mock) provider request", async () => {
  const ref = await resolveReferenceAsset(storedUrl);
  const provider = createMockProvider();
  const result = await provider.generate({
    prompt: "A professional ad for Hydrating Serum.",
    image: ref,
    aspectRatio: "9:16",
    durationSeconds: 8,
    resolution: "720p",
  });
  // The mock echoes what it received — prove the image propagated.
  assert.equal(result.receivedRequest.hasImage, true);
  assert.equal(result.receivedRequest.imageMimeType, "image/png");
  assert.ok(result.receivedRequest.imageBytesApprox > 1000);
  assert.match(result.receivedRequest.promptPreview, /Hydrating Serum/);
});

test("E2E: no reference → provider receives NO image (honest text-to-video)", async () => {
  const provider = createMockProvider();
  const result = await provider.generate({ prompt: "x", aspectRatio: "9:16", durationSeconds: 8, resolution: "720p" });
  assert.equal(result.receivedRequest.hasImage, false);
});
