/**
 * Creative-pipeline tests — deterministic, no AI cost.
 * Focus: the quality fixes (poster -> reference, packshot -> hero) and
 * brand-aware prompt differentiation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifySourceImageHeuristic,
  isReferenceType,
} from "../lib/creative/sourceImage.js";
import { buildCreativePlan } from "../lib/creative/planner.js";
import { composeVideoPrompt } from "../lib/creative/promptComposer.js";
import { generateConcepts } from "../lib/creative/concepts.js";

test("source image: a poster/ad is classified as a reference", () => {
  const r = classifySourceImageHeuristic({ url: "https://x.com/summer-sale-poster.jpg" });
  assert.equal(r.treatAsReference, true);
  assert.ok(isReferenceType(r.type));
});

test("source image: a clean packshot is NOT a reference (product hero)", () => {
  const r = classifySourceImageHeuristic({ role: "product_packshot", url: "https://x.com/bottle-front.jpg" });
  assert.equal(r.treatAsReference, false);
  assert.equal(r.type, "packshot");
});

test("prompt: poster source does NOT produce phone/screen; forbids poster-in-frame", () => {
  const source = classifySourceImageHeuristic({ url: "https://x.com/perfume-poster.jpg" });
  const { brief, scenePlan } = buildCreativePlan({
    product: { name: "Noir Eau de Parfum", brand: "Aurelia" },
    brand: { name: "Aurelia", visualStyle: "luxury, minimal", primaryColors: ["#121212", "#C8A96A"], confidence: 0.9 },
    template: "luxury",
    sourceImage: source,
    durationSeconds: 8,
  });
  const { prompt } = composeVideoPrompt({
    brief, scenePlan,
    product: { name: "Noir Eau de Parfum", brand: "Aurelia" },
    brand: { name: "Aurelia", visualStyle: "luxury, minimal", primaryColors: ["#121212", "#C8A96A"], confidence: 0.9 },
    sourceImage: source,
    aspectRatio: "9:16",
  });
  assert.match(prompt, /REFERENCE ONLY/);
  assert.match(prompt, /do not animate or display the artwork|Do NOT animate/i);
  assert.match(prompt, /no smartphone/i);
  assert.match(prompt, /poster-in-frame/i);
  // brand palette is actively present
  assert.match(prompt, /#C8A96A/i);
});

test("prompt: two brands, same product -> different art direction", () => {
  const product = { name: "Vitamin C Serum" };
  const common = { template: "minimal", durationSeconds: 8, aspectRatio: "9:16" };

  const lux = { name: "Aurelia", visualStyle: "luxury editorial", primaryColors: ["#111111", "#C8A96A"], toneOfVoice: "refined", confidence: 0.9 };
  const genz = { name: "Glowy", visualStyle: "playful colorful", primaryColors: ["#FF5FA2", "#38E1C6"], toneOfVoice: "fun", confidence: 0.9 };

  const planA = buildCreativePlan({ product, brand: lux, ...common });
  const planB = buildCreativePlan({ product, brand: genz, ...common });
  const a = composeVideoPrompt({ ...planA, product, brand: lux, aspectRatio: "9:16" }).prompt;
  const b = composeVideoPrompt({ ...planB, product, brand: genz, aspectRatio: "9:16" }).prompt;

  assert.notEqual(a, b);
  assert.match(a, /#C8A96A/);
  assert.match(b, /#FF5FA2/i);
});

test("prompt: no brand -> avoids generic AI silver look explicitly", () => {
  const plan = buildCreativePlan({ product: { name: "Thing" }, template: "minimal", durationSeconds: 6 });
  const { prompt } = composeVideoPrompt({ ...plan, product: { name: "Thing" }, aspectRatio: "16:9" });
  assert.match(prompt, /No strong brand identity|product-focused/i);
  assert.match(prompt, /silver/i); // negative mention of generic silver
});

test("concepts: luxury vs playful brands get different concept sets", () => {
  const lux = generateConcepts({ product: { name: "Perfume" }, brand: { visualStyle: "luxury editorial", confidence: 0.9, primaryColors: ["#111"] } });
  const playful = generateConcepts({ product: { name: "Serum" }, brand: { visualStyle: "playful colorful gen-z", confidence: 0.9, primaryColors: ["#f0f"] } });
  const luxTitles = lux.concepts.map((c) => c.title).join("|");
  const playTitles = playful.concepts.map((c) => c.title).join("|");
  assert.notEqual(luxTitles, playTitles);
  assert.match(luxTitles, /Midnight|Editorial|Minimal/);
  assert.match(playTitles, /Color Pop|Playful|Breakdown/);
});
