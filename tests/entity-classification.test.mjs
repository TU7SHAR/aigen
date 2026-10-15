/**
 * Entity classification correctness (the BhavishAI "SaaS → ecommerce" bug).
 *
 * Root cause fixed: a lone Product schema no longer dominates on a homepage
 * that ALSO shows strong SaaS/service signals. Uncertainty is surfaced.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifySource } from "../lib/crawl/classify.js";
import { mergeProfiles } from "../lib/crawl/merge.js";

const html = (body) => `<html><head><title>t</title></head><body>${body}</body></html>`;

test("homepage with Product schema BUT SaaS signals is NOT ecommerce_product", () => {
  const c = classifySource(
    html("Get your personalized report. Pricing. Sign up for a free trial. Dashboard. Platform."),
    "https://bhavishai.in/",
    { hasProductSchema: true, cleanedText: "Get your report. Pricing. Free trial. Sign up. Dashboard. Platform. API." }
  );
  assert.notEqual(c.entityType, "ecommerce_product", `got ${c.entityType} (scores ${JSON.stringify(c.scores)})`);
  assert.equal(c.entityType, "saas");
});

test("a genuine product PAGE (product path + store signals) stays ecommerce_product", () => {
  const c = classifySource(
    html("Add to cart. Free shipping. Checkout. 50ml bottle."),
    "https://shop.example/products/vitamin-c-serum",
    { hasProductSchema: true, cleanedText: "Add to cart. Free shipping. Checkout." }
  );
  assert.equal(c.entityType, "ecommerce_product");
});

test("classification surfaces ambiguity + runner-up when the margin is thin", () => {
  const c = classifySource(
    html("services and some product talk"),
    "https://x.com/",
    { hasProductSchema: false, cleanedText: "our services. contact us." }
  );
  assert.ok("ambiguous" in c && "runnerUpType" in c && "classifyConfidence" in c);
});

test("merge flags an AI-vs-deterministic entityType conflict and docks confidence", () => {
  const merged = mergeProfiles({
    deterministic: { name: "X", description: "d" },
    determSources: {},
    enriched: { entityType: "ecommerce_product", confidence: 0.8 },
    entityTypeHint: "saas",
    classifyAmbiguous: false,
  });
  // Deterministic was confident → it wins the disagreement, conflict recorded.
  assert.equal(merged.entityType, "saas");
  assert.equal(merged.entityTypeUncertainty.conflict, true);
  assert.equal(merged.entityTypeUncertainty.needsConfirmation, true);
});

test("merge defers to AI when the deterministic classifier was ambiguous", () => {
  const merged = mergeProfiles({
    deterministic: { name: "X" },
    determSources: {},
    enriched: { entityType: "service", confidence: 0.7 },
    entityTypeHint: "business",
    classifyAmbiguous: true,
  });
  assert.equal(merged.entityType, "service");
  assert.equal(merged.entityTypeUncertainty.needsConfirmation, true);
});

test("agreement between AI and deterministic → no conflict, full confidence path", () => {
  const merged = mergeProfiles({
    deterministic: { name: "X", description: "d", price: 10 },
    determSources: {},
    enriched: { entityType: "saas", confidence: 0.8 },
    entityTypeHint: "saas",
  });
  assert.equal(merged.entityType, "saas");
  assert.equal(merged.entityTypeUncertainty.conflict, false);
  assert.equal(merged.entityTypeUncertainty.needsConfirmation, false);
});
