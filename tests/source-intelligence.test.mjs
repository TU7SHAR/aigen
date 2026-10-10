/**
 * Source Intelligence tests — URL normalization, classification, context
 * reduction, merge priority, generation context, entity-aware concepts.
 * Pure functions on fixtures. No network, no Gemini, no cost.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeInputUrl } from "../lib/crawl/normalizeUrl.js";
import { classifySource, discoverInternalPages } from "../lib/crawl/classify.js";
import { reduceContext } from "../lib/crawl/contextReducer.js";
import { mergeProfiles } from "../lib/crawl/merge.js";
import { extractStructured } from "../lib/crawl/structured.js";
import { cleanProductContent } from "../lib/crawl/clean.js";
import { compileGenerationContext, contextSize } from "../lib/creative/generationContext.js";
import { generateConcepts } from "../lib/creative/concepts.js";
import {
  SAAS_HOMEPAGE_HTML,
  SERVICE_HTML,
  STRUCTURED_PRODUCT_HTML,
} from "./fixtures.mjs";

// --- URL normalization (the bhavishai.in 422 bug) ---
test("normalizeInputUrl: bare domain gets https scheme", () => {
  for (const inp of ["bhavishai.in", "www.bhavishai.in", "https://bhavishai.in", "http://bhavishai.in", " https://bhavishai.in/ "]) {
    const r = normalizeInputUrl(inp);
    assert.equal(r.ok, true, `expected ok for ${inp}`);
    assert.match(r.url, /^https?:\/\//);
  }
});

test("normalizeInputUrl: rejects non-http schemes and junk", () => {
  assert.equal(normalizeInputUrl("file:///etc/passwd").ok, false);
  assert.equal(normalizeInputUrl("javascript:alert(1)").ok, false);
  assert.equal(normalizeInputUrl("notaurl").ok, false);
  assert.equal(normalizeInputUrl("").ok, false);
});

test("normalizeInputUrl: strips tracking params + fragment", () => {
  const r = normalizeInputUrl("example.com/x?utm_source=a&id=5#frag");
  assert.equal(r.ok, true);
  assert.ok(!r.url.includes("utm_source"));
  assert.ok(!r.url.includes("#frag"));
  assert.ok(r.url.includes("id=5"));
});

// --- Classification: a SaaS homepage is NOT an ecommerce product ---
test("classifySource: SaaS homepage classified as saas/business, not product", () => {
  const struct = extractStructured(SAAS_HOMEPAGE_HTML, "https://bhavishai.in/");
  const clean = cleanProductContent(SAAS_HOMEPAGE_HTML, struct.fields.name?.value || "");
  const c = classifySource(SAAS_HOMEPAGE_HTML, "https://bhavishai.in/", {
    hasProductSchema: struct.hasProductSchema,
    cleanedText: clean.text,
  });
  assert.notEqual(c.entityType, "ecommerce_product");
  assert.ok(["saas", "business", "service", "landing_page"].includes(c.entityType));
});

test("classifySource: ecommerce product page still classified as product", () => {
  const struct = extractStructured(STRUCTURED_PRODUCT_HTML, "https://shop.example.com/products/x");
  const c = classifySource(STRUCTURED_PRODUCT_HTML, "https://shop.example.com/products/hydrating-serum", {
    hasProductSchema: struct.hasProductSchema,
  });
  assert.equal(c.entityType, "ecommerce_product");
});

test("discoverInternalPages: ranks pricing/get-report over privacy/terms", () => {
  const pages = discoverInternalPages(SAAS_HOMEPAGE_HTML, "https://bhavishai.in/", 3);
  assert.ok(pages.length >= 1);
  assert.ok(pages.some((u) => /pricing|get-report/.test(u)));
  assert.ok(!pages.some((u) => /privacy|terms/.test(u)));
});

// --- Context reduction ---
test("reduceContext: compresses to within budget and keeps structured facts", () => {
  const big = "word ".repeat(20000); // ~100k chars
  const r = reduceContext({
    finalUrl: "https://x.com",
    title: "Big Co",
    structuredFacts: { name: { value: "Big Co" }, price: { value: 10 } },
    cleanedText: big,
    budget: 5000,
  });
  assert.ok(r.chars <= 5200, `expected <=~5000, got ${r.chars}`);
  assert.match(r.text, /Big Co/);
  assert.match(r.text, /STRUCTURED FACTS/);
});

// --- Merge priority: AI must not overwrite structured facts ---
test("mergeProfiles: json_ld price beats AI price (no overwrite)", () => {
  const merged = mergeProfiles({
    deterministic: { name: "Serum", price: 39, currency: "USD" },
    determSources: { price: { source: "json_ld", confidence: 0.95 }, name: { source: "json_ld", confidence: 0.98 } },
    enriched: { entityType: "ecommerce_product", name: "WRONG", pricing: { value: 999, currency: "EUR" }, confidence: 0.8, benefits: ["b1"] },
  });
  assert.equal(merged.profile.price, 39); // structured wins
  assert.equal(merged.profile.name, "Serum"); // structured name not overwritten
  assert.deepEqual(merged.profile.benefits, ["b1"]); // AI fills a gap
  assert.equal(merged.sources.price.source, "json_ld");
});

test("mergeProfiles: AI fills gaps when deterministic is empty", () => {
  const merged = mergeProfiles({
    deterministic: { name: null, price: null },
    determSources: {},
    enriched: {
      entityType: "saas", name: "BhavishAI",
      description: "Personalized AI astrology guidance.",
      primaryOffer: "Personalized astrology report",
      targetAudience: ["people interested in astrology"],
      confidence: 0.8,
    },
  });
  assert.equal(merged.profile.name, "BhavishAI");
  assert.equal(merged.entityType, "saas");
  assert.equal(merged.sources.name.source, "ai_extracted");
  assert.ok(merged.profile.description.length > 0);
});

// --- Generation context: minimal, excludes crawl junk ---
test("compileGenerationContext: small + excludes raw crawl data", () => {
  const ctx = compileGenerationContext({
    entityType: "saas",
    profile: { name: "BhavishAI", offer: "Astrology report", features: ["a", "b", "c", "d", "e", "f"], cleanedContent: "x".repeat(50000) },
    brand: { name: "BhavishAI", primaryColors: ["#6D28D9"], visualStyle: "modern mystical" },
    heroAsset: "/imported-assets/hero.jpg",
    concept: { title: "Product Reveal" },
    brief: { objective: "Introduce", environment: "studio", cameraLanguage: "push-in", lighting: "soft" },
  });
  const size = contextSize(ctx);
  assert.ok(size < 1500, `generation context should be small, got ${size}`);
  const blob = JSON.stringify(ctx);
  assert.ok(!blob.includes("xxxxx")); // cleanedContent not leaked
  assert.equal(ctx.offer.importantFeatures.length, 4); // trimmed
  assert.equal(ctx.identity.name, "BhavishAI");
});

// --- Entity-aware concepts ---
test("generateConcepts: SaaS gets non-product concepts", () => {
  const r = generateConcepts({ product: { name: "BhavishAI" }, entityType: "saas" });
  const titles = r.concepts.map((c) => c.title).join("|");
  assert.ok(!/Packshot|Lifestyle Context/.test(titles));
  assert.match(titles, /Product Reveal|Feature Flow|Outcome|Problem/);
});

test("generateConcepts: creator gets creator concepts", () => {
  const r = generateConcepts({ product: { name: "Alex" }, entityType: "creator" });
  const titles = r.concepts.map((c) => c.title).join("|");
  assert.match(titles, /Authority|Social Proof|Offer|Transformation/);
});

test("generateConcepts: product still gets product/brand concepts", () => {
  const r = generateConcepts({ product: { name: "Serum" }, entityType: "ecommerce_product", brand: { visualStyle: "luxury", confidence: 0.9, primaryColors: ["#111"] } });
  assert.ok(r.concepts.length >= 3);
});
