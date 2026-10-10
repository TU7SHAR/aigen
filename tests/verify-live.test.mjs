/**
 * REAL verification tests: exercise validateImageBuffer() — the actual decode/
 * validate logic behind verifyImageUrl — with genuine good / corrupt / tiny /
 * wrong-mime / SVG / malicious-SVG bytes. (The network wrapper verifyImageUrl is
 * SSRF-guarded and refuses loopback, so we test the real validation core with
 * buffers rather than standing up a blocked localhost server.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";

import { validateImageBuffer } from "../lib/assets/verify.js";

test("validate: a real decodable PNG is READY with true dimensions", async () => {
  const png = await sharp({ create: { width: 900, height: 600, channels: 3, background: "#334455" } }).png().toBuffer();
  const v = await validateImageBuffer(png, "image/png");
  assert.equal(v.status, "ready");
  assert.equal(v.width, 900);
  assert.equal(v.height, 600);
  assert.equal(v.format, "png");
  assert.ok(v.buffer instanceof Buffer);
});

test("validate: a JPEG is accepted", async () => {
  const jpg = await sharp({ create: { width: 800, height: 800, channels: 3, background: "#aa3344" } }).jpeg().toBuffer();
  const v = await validateImageBuffer(jpg, "image/jpeg");
  assert.equal(v.status, "ready");
  assert.equal(v.format, "jpeg");
});

test("validate: a corrupt image is REJECTED (decode_failed)", async () => {
  const v = await validateImageBuffer(Buffer.from("\x89PNG\r\n\x1a\nnope not a png"), "image/png");
  assert.equal(v.status, "rejected");
  assert.match(v.reason, /decode_failed/);
});

test("validate: a non-image mime is REJECTED (not_an_image)", async () => {
  const v = await validateImageBuffer(Buffer.from("hello world"), "text/plain");
  assert.equal(v.status, "rejected");
  assert.match(v.reason, /not_an_image/);
});

test("validate: a tiny icon is REJECTED unless allowSmall", async () => {
  const tiny = await sharp({ create: { width: 48, height: 48, channels: 3, background: "#abcdef" } }).png().toBuffer();
  const rejected = await validateImageBuffer(tiny, "image/png");
  assert.equal(rejected.status, "rejected");
  assert.match(rejected.reason, /too_small/);
  const allowed = await validateImageBuffer(tiny, "image/png", { allowSmall: true });
  assert.equal(allowed.status, "ready");
});

test("validate: empty buffer REJECTED", async () => {
  const v = await validateImageBuffer(Buffer.alloc(0), "image/png");
  assert.equal(v.status, "rejected");
});

test("validate: an SVG is sanitized + rasterized to a usable PNG preview", async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="100"><rect width="300" height="100" fill="#6D28D9"/></svg>');
  const v = await validateImageBuffer(svg, "image/svg+xml", { allowSmall: true });
  assert.equal(v.status, "ready");
  assert.equal(v.isVector, true);
  assert.ok(v.rasterBuffer instanceof Buffer);
  const meta = await sharp(v.rasterBuffer).metadata();
  assert.equal(meta.format, "png");
});

test("validate: a malicious SVG has script + external refs stripped", async () => {
  const evil = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><script>fetch("http://evil")</script><image href="http://evil/x.png"/><rect width="200" height="200" fill="#111"/></svg>');
  const v = await validateImageBuffer(evil, "image/svg+xml", { allowSmall: true });
  assert.equal(v.status, "ready");
  const svgText = v.buffer.toString("utf8");
  assert.ok(!/<script/i.test(svgText), "script must be stripped");
  assert.ok(!/http:\/\/evil/i.test(svgText), "external refs must be stripped");
});
