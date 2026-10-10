/**
 * Crawler + extraction tests — pure functions on HTML fixtures. No network, no
 * Firecrawl, no Gemini, no cost.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { extractStructured } from "../lib/crawl/structured.js";
import { cleanProductContent } from "../lib/crawl/clean.js";
import { discoverImages } from "../lib/crawl/images.js";
import { extractBrandSignals } from "../lib/crawl/brand.js";
import { isBlockedIp, assertSafeUrl, CrawlError } from "../lib/crawl/safeFetch.js";
import {
  STRUCTURED_PRODUCT_HTML,
  NO_STRUCTURED_HTML,
  DUPLICATE_HEAVY_HTML,
} from "./fixtures.mjs";

const BASE = "https://shop.example.com/products/hydrating-serum";

test("structured: JSON-LD populates product fields with provenance", () => {
  const r = extractStructured(STRUCTURED_PRODUCT_HTML, BASE);
  assert.equal(r.fields.name.value, "Hydrating Serum");
  assert.equal(r.fields.name.source, "json_ld");
  assert.equal(r.fields.brand.value, "Lumière");
  assert.equal(r.fields.price.value, 39);
  assert.equal(r.fields.currency.value, "USD");
  assert.equal(r.hasProductSchema, true);
});

test("structured: no JSON-LD still extracts from DOM/meta + warns", () => {
  const r = extractStructured(NO_STRUCTURED_HTML, "https://cdn.shopco.com/p");
  assert.ok(r.fields.name.value.includes("Cool"));
  assert.equal(r.hasProductSchema, false);
  assert.ok(r.warnings.some((w) => /JSON-LD/.test(w)));
});

test("clean: removes nav/footer noise, keeps product bullets", () => {
  const r = cleanProductContent(DUPLICATE_HEAVY_HTML, "Mega Widget");
  // Product bullets survive.
  assert.ok(/Durable aluminum body/.test(r.text));
  // Repeated nav/footer "Shop now" / newsletter noise is stripped entirely.
  assert.ok(!/Shop now/.test(r.text));
  assert.ok(!/newsletter/i.test(r.text));
});

test("clean: dedupes repeated in-content blocks", () => {
  const html = `<html><body><main>
    <h1>Gadget</h1>
    <p>This durable gadget solves your problem beautifully.</p>
    <p>This durable gadget solves your problem beautifully.</p>
    <p>This durable gadget solves your problem beautifully.</p>
    <ul><li>Water resistant to 50m</li></ul>
  </main></body></html>`;
  const r = cleanProductContent(html, "Gadget");
  assert.ok(r.removedDuplicates >= 2);
  const occurrences = (r.text.match(/solves your problem/g) || []).length;
  assert.equal(occurrences, 1);
});

test("images: high-res gallery image outranks a tiny icon; icons dropped", () => {
  const struct = extractStructured(STRUCTURED_PRODUCT_HTML, BASE);
  const r = discoverImages(STRUCTURED_PRODUCT_HTML, BASE, struct.imageUrls, "Hydrating Serum");
  assert.ok(r.images.length >= 1);
  // top image should be a product/hero, not an icon/badge
  assert.ok(["hero_product", "product_packshot"].includes(r.images[0].role));
  // no payment/star icons survive
  assert.ok(!r.images.some((i) => /badge-visa|icon-star/.test(i.url)));
});

test("images: duplicate size variants of same asset are deduped", () => {
  const html = `<html><body>
    <img src="https://cdn.x.com/p_400x400.jpg"/>
    <img src="https://cdn.x.com/p_1600x1600.jpg"/>
  </body></html>`;
  const r = discoverImages(html, "https://cdn.x.com/", [], "p");
  // Both normalize to the same asset path -> deduped to one candidate.
  const productish = r.images.filter((i) => i.url.includes("/p_"));
  assert.ok(productish.length <= 1);
});

test("brand: extracts intentional colors (ignores white), logo, confidence", () => {
  const r = extractBrandSignals(STRUCTURED_PRODUCT_HTML, BASE);
  assert.ok(r.colors.length >= 1);
  assert.ok(r.primaryColors.some((c) => c.toLowerCase() === "#c8a96a" || c.toLowerCase() === "#121212"));
  assert.ok(r.logo && r.logo.includes("logo"));
  assert.ok(r.confidence > 0.2);
});

// --- SSRF ---
test("ssrf: isBlockedIp blocks private/loopback/metadata ranges", () => {
  assert.equal(isBlockedIp("127.0.0.1"), true);
  assert.equal(isBlockedIp("10.0.0.5"), true);
  assert.equal(isBlockedIp("192.168.1.1"), true);
  assert.equal(isBlockedIp("172.16.5.5"), true);
  assert.equal(isBlockedIp("169.254.169.254"), true); // cloud metadata
  assert.equal(isBlockedIp("::1"), true);
  assert.equal(isBlockedIp("8.8.8.8"), false);
});

test("ssrf: assertSafeUrl rejects non-http and localhost", async () => {
  await assert.rejects(() => assertSafeUrl("file:///etc/passwd"), CrawlError);
  await assert.rejects(() => assertSafeUrl("http://localhost/admin"), CrawlError);
  await assert.rejects(() => assertSafeUrl("http://127.0.0.1:8080"), CrawlError);
});

test("ssrf: assertSafeUrl allows a normal public https URL", async () => {
  const u = await assertSafeUrl("https://example.com/products/x");
  assert.equal(u.hostname, "example.com");
});
