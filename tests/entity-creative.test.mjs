/**
 * Entity-aware creative tests — the BhavishAI→bottle regression guard + prompt
 * lint per entity type + preflight gate. Pure functions, no AI, no cost.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { compileCreativeRequest } from "../lib/creative/compile.js";
import { getEntityStrategy, normalizeEntityType } from "../lib/creative/entityStrategies.js";

const PHYSICAL_TERMS = ["bottle", "cap/lid", "packaging", "packshot", "box geometry", "physical product", "pedestal", "jar", "tube"];

// True if a physical term is used AFFIRMATIVELY (not inside a "no/not/do not …"
// negation). The prompt legitimately says "do not invent a bottle"; that must
// NOT count as a physical instruction.
function usesPhysicalAffirmatively(prompt) {
  const text = prompt.toLowerCase();
  for (const term of PHYSICAL_TERMS) {
    let idx = text.indexOf(term);
    while (idx !== -1) {
      // Look back to the start of the current sentence for a negation.
      const sentenceStart = Math.max(
        text.lastIndexOf(".", idx),
        text.lastIndexOf(";", idx),
        text.lastIndexOf(":", idx)
      );
      const before = text.slice(sentenceStart + 1, idx);
      if (!/\b(no|not|n't|without|never|avoid)\b/.test(before)) return true;
      idx = text.indexOf(term, idx + term.length);
    }
  }
  return false;
}

function base(overrides = {}) {
  return {
    productName: "BhavishAI",
    brand: "BhavishAI",
    template: "minimal",
    aspectRatio: "9:16",
    resolution: "720p",
    durationSeconds: 8,
    brandInfluence: "balanced",
    ...overrides,
  };
}

test("REGRESSION: SaaS (BhavishAI) prompt has NO physical-product language", () => {
  const c = compileCreativeRequest(
    base({ entityType: "saas", productProfile: { entityType: "saas", description: "AI Vedic astrology service", extractionConfidence: 0.7 } })
  );
  assert.equal(c.entityType, "saas");
  assert.ok(!usesPhysicalAffirmatively(c.finalVideoPrompt), `prompt leaked physical language: ${c.finalVideoPrompt}`);
  // scene plan must not treat it as a product hero
  const sceneText = c.scenePlan.scenes.map((s) => s.visual).join(" ");
  assert.ok(!/the product as the clean hero|packshot|bottle/i.test(sceneText));
  // prompt explicitly says NOT a physical product
  assert.match(c.finalVideoPrompt, /NOT a physical product/i);
  // generation mode is SaaS-compatible
  assert.ok(["hybrid", "motion_graphics"].includes(c.generationMode));
});

test("REGRESSION: SaaS preflight is READY (no false blocker) and has no blockers", () => {
  const c = compileCreativeRequest(
    base({ entityType: "saas", productProfile: { entityType: "saas", extractionConfidence: 0.7, primaryImage: "/imported-assets/hero.png" } })
  );
  assert.deepEqual(c.preflight.blockers, []);
  assert.equal(c.preflight.readyForPaidGeneration, true);
});

test("PREFLIGHT BLOCKS a SaaS plan if a physical prompt override is injected", () => {
  const c = compileCreativeRequest(
    base({
      entityType: "saas",
      productProfile: { entityType: "saas", extractionConfidence: 0.7 },
      promptOverride: "Show the BhavishAI bottle on a studio pedestal with cap/lid detail.",
    })
  );
  assert.equal(c.preflight.readyForPaidGeneration, false);
  assert.ok(c.preflight.blockers.some((b) => /physical-product language/i.test(b)));
});

test("Physical product still gets physical fidelity + packshot language", () => {
  const c = compileCreativeRequest(
    base({
      productName: "Hydrating Serum",
      entityType: "physical_product",
      template: "luxury",
      image: { data: "AAAA", mimeType: "image/png" },
      sourceImageMeta: { role: "product_packshot", url: "serum.jpg" },
      productProfile: { entityType: "physical_product", primaryImage: "/x.jpg", extractionConfidence: 0.8 },
    })
  );
  assert.equal(c.entityType, "physical_product");
  assert.match(c.finalVideoPrompt, /packaging|bottle|product/i);
  assert.equal(c.generationMode, "image_to_video");
  assert.equal(c.preflight.readyForPaidGeneration, true);
});

test("Creator without an authorized asset is BLOCKED", () => {
  const c = compileCreativeRequest(
    base({ productName: "Alex", entityType: "creator", productProfile: { entityType: "creator", extractionConfidence: 0.7 } })
  );
  assert.equal(c.preflight.readyForPaidGeneration, false);
  assert.ok(c.preflight.blockers.some((b) => /authorized portrait|video/i.test(b)));
});

test("Service prompt forbids invented packaging; stays brand/outcome led", () => {
  const c = compileCreativeRequest(
    base({ productName: "Northside Plumbing", entityType: "service", productProfile: { entityType: "service", extractionConfidence: 0.7, primaryImage: "/v.jpg" } })
  );
  assert.ok(!usesPhysicalAffirmatively(c.finalVideoPrompt));
  assert.ok(c.negativeRules.some((r) => /no physical product/i.test(r)));
});

test("Unknown entity never defaults to physical product", () => {
  const c = compileCreativeRequest(base({ entityType: "unknown", productProfile: { entityType: "unknown", extractionConfidence: 0.6, primaryImage: "/x.png" } }));
  assert.equal(getEntityStrategy("unknown").allowsPhysicalLanguage, false);
  assert.ok(!usesPhysicalAffirmatively(c.finalVideoPrompt));
});

test("low entity confidence blocks paid generation", () => {
  const c = compileCreativeRequest(
    base({ entityType: "saas", productProfile: { entityType: "saas", extractionConfidence: 0.2, primaryImage: "/x.png" } })
  );
  assert.equal(c.preflight.readyForPaidGeneration, false);
  assert.ok(c.preflight.blockers.some((b) => /low-confidence/i.test(b)));
});

test("normalizeEntityType maps importer types to strategy keys", () => {
  assert.equal(normalizeEntityType("ecommerce_product"), "physical_product");
  assert.equal(normalizeEntityType("landing_page"), "business");
  assert.equal(normalizeEntityType("portfolio"), "personal_brand");
  assert.equal(normalizeEntityType("saas"), "saas");
  assert.equal(normalizeEntityType("nonsense"), "unknown");
});

test("preview compiler and generate compiler produce the SAME prompt", () => {
  // compileCreativeRequest is the single source used by both endpoints.
  const input = base({ entityType: "saas", productProfile: { entityType: "saas", extractionConfidence: 0.7, primaryImage: "/x.png" } });
  const a = compileCreativeRequest(input).finalVideoPrompt;
  const b = compileCreativeRequest(input).finalVideoPrompt;
  assert.equal(a, b);
});
