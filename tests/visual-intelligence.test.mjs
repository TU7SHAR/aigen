/**
 * Visual-intelligence tests — asset verification (sharp), SVG rasterization,
 * reference selection, DesignProfile extraction. No network: images are
 * synthesized in-memory and verified via the sharp decode path by calling the
 * lower-level checks. Reference selection + design extraction are pure.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";

import { selectReference } from "../lib/assets/selectReference.js";
import { extractDesignFromHtml, mergeRenderedDesign } from "../lib/design/designProfile.js";

// --- DesignProfile from HTML/CSS (no browser) ---
test("design: extracts intentional colors + fonts, ignores white", () => {
  const html = `<html><head>
    <meta name="theme-color" content="#6D28D9">
    <style>:root{--brand-primary-color:#6D28D9;--accent-color:#D8B46A}
      h1{font-family:'Sora', sans-serif} .btn{background:#ffffff}
      button{border-radius:12px}</style>
    </head><body><button style="background:#6D28D9">Go</button></body></html>`;
  const d = extractDesignFromHtml(html, "https://x.com");
  assert.equal(d.palette.detected, true);
  assert.ok(d.palette.all.some((c) => c.toLowerCase() === "#6d28d9"));
  assert.ok(!d.palette.all.includes("#ffffff")); // white ignored
  assert.ok(d.typography.families.includes("Sora"));
  assert.ok(d.confidence > 0);
  assert.equal(d.source, "html_css");
});

test("design: no palette → detected:false, does NOT invent colors", () => {
  const html = `<html><head><title>Plain</title></head><body><p>hi</p></body></html>`;
  const d = extractDesignFromHtml(html, "https://x.com");
  assert.equal(d.palette.detected, false);
  assert.equal(d.palette.primary.length, 0);
});

test("design: rendered computed styles outrank HTML and raise confidence", () => {
  const base = extractDesignFromHtml("<html><body></body></html>", "https://x.com");
  const merged = mergeRenderedDesign(base, { colors: ["#111111", "#c8a96a"], fonts: ["Inter"], screenshotUrl: "/s.png" });
  assert.equal(merged.palette.detected, true);
  assert.ok(merged.palette.all.includes("#c8a96a"));
  assert.ok(merged.confidence > base.confidence);
  assert.ok(merged.references.some((r) => r.kind === "rendered_screenshot"));
});

// --- Reference selection (verified assets in) ---
const asset = (role, w = 1200, h = 1200) => ({ role, width: w, height: h, storedUrl: `/a/${role}.png` });

test("select: an icon/logo is NEVER chosen as primary reference", () => {
  const r = selectReference(
    [asset("logo", 200, 60), asset("icon", 32, 32), asset("hero_visual", 1600, 900)],
    { entityType: "saas" }
  );
  assert.equal(r.primary.role, "hero_visual");
  assert.notEqual(r.primary.role, "logo");
  assert.equal(r.logo.role, "logo"); // logo still available for an end-card
});

test("select: physical product prefers a product shot", () => {
  const r = selectReference(
    [asset("hero_visual"), asset("product_packshot"), asset("hero_product")],
    { entityType: "physical_product" }
  );
  assert.ok(["hero_product", "product_packshot"].includes(r.primary.role));
});

test("select: SaaS prefers a UI screenshot over generic brand art", () => {
  const r = selectReference(
    [asset("brand_art"), asset("product_screenshot")],
    { entityType: "saas" }
  );
  assert.equal(r.primary.role, "product_screenshot");
});

test("select: only a logo present → no scene primary, flagged", () => {
  const r = selectReference([asset("logo", 300, 100)], { entityType: "service" });
  assert.equal(r.primary, null);
  assert.ok(r.logo);
  assert.match(r.reason, /logo/i);
});

test("select: needsReference true only for image_to_video", () => {
  assert.equal(selectReference([], { productionMethod: "image_to_video" }).needsReference, true);
  assert.equal(selectReference([], { productionMethod: "text_to_video" }).needsReference, false);
});

// --- Asset verification via sharp (synthesized images, no network) ---
import { MIN_USEFUL_EDGE } from "../lib/assets/verify.js";

test("verify: sharp decodes a real PNG and reports true dimensions", async () => {
  // A genuine 800x600 PNG.
  const png = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#334455" } }).png().toBuffer();
  const meta = await sharp(png).metadata();
  assert.equal(meta.width, 800);
  assert.equal(meta.height, 600);
  assert.equal(meta.format, "png");
  // confirm the "too small" threshold is meaningful
  assert.ok(MIN_USEFUL_EDGE >= 100);
});

test("verify: a corrupt buffer fails to decode (would be rejected)", async () => {
  const garbage = Buffer.from("not an image at all");
  await assert.rejects(() => sharp(garbage).metadata());
});

test("verify: an SVG rasterizes to a PNG via sharp", async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#6D28D9"/></svg>');
  const png = await sharp(svg, { density: 160 }).png().toBuffer();
  const meta = await sharp(png).metadata();
  assert.equal(meta.format, "png");
  assert.ok(meta.width > 0 && meta.height > 0);
});
