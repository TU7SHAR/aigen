/**
 * AI Creative Director — storyboard generation (deterministic fallback path).
 *
 * These run with NO Gemini key, so they exercise the deterministic fallback
 * (directStoryboard → fallbackStoryboard). They prove the core vision claims:
 *  - a storyboard is EXECUTABLE: variable shots, each with a production technique
 *  - DIFFERENT concepts produce DIFFERENT storyboards (not just different text)
 *  - exact copy (offer/CTA) is used verbatim and never fabricated
 *  - the storyboard DRIVES the compiled scene plan (replaces establish/detail/end)
 */
import { test } from "node:test";
import assert from "node:assert/strict";

// Ensure the AI path is OFF so we test the deterministic director fallback.
process.env.ENABLE_SOURCE_ENRICHMENT = "false";
delete process.env.GEMINI_API_KEY;

const { directStoryboard, fallbackStoryboard } = await import("../lib/creative/director.js");
const { SHOT_TECHNIQUES } = await import("../lib/ai/director.js");
const { compileCreativeRequest } = await import("../lib/creative/compile.js");

test("fallback storyboard is executable: variable shots, each with a valid technique", () => {
  const sb = fallbackStoryboard({
    concept: { title: "Problem → Relief", centralMessage: "Clarity without the clutter", visualIdea: "a tense moment resolving into calm" },
    product: { name: "Acme", cta: "Start free" },
    brand: { name: "Acme" },
    durationSeconds: 8,
    availableAssets: [{ role: "product_screenshot", kind: "image" }],
  });
  assert.ok(sb.shots.length >= 2);
  for (const s of sb.shots) {
    assert.ok(SHOT_TECHNIQUES.includes(s.technique), `bad technique ${s.technique}`);
    assert.ok(s.durationSec > 0 && s.visual);
  }
  // durations sum ~ to the target
  const total = sb.shots.reduce((a, s) => a + s.durationSec, 0);
  assert.ok(Math.abs(total - 8) < 0.5, `sum ${total}`);
});

test("DIFFERENT concepts produce structurally DIFFERENT storyboards", () => {
  const base = { product: { name: "Acme", cta: "Try it" }, brand: { name: "Acme" }, durationSeconds: 8, availableAssets: [] };
  const a = fallbackStoryboard({ ...base, concept: { title: "Hook A", centralMessage: "Save hours every week", visualIdea: "fast montage of tasks vanishing" } });
  const b = fallbackStoryboard({ ...base, concept: { title: "Hook B", visualIdea: "one calm hero shot, minimal" } }); // no centralMessage → fewer beats
  const aVisuals = a.shots.map((s) => s.visual).join("|");
  const bVisuals = b.shots.map((s) => s.visual).join("|");
  assert.notEqual(aVisuals, bVisuals, "different concepts must yield different shot visuals");
  // Concept A has a central message → it gets a message beat B lacks.
  assert.notEqual(a.shots.length, b.shots.length);
});

test("offer beat appears ONLY when a real offer exists (no fabrication)", () => {
  const withOffer = fallbackStoryboard({ concept: { title: "x", centralMessage: "m" }, product: { name: "Acme", offer: "20% off", cta: "Buy" }, brand: { name: "Acme" }, durationSeconds: 8, availableAssets: [] });
  const noOffer = fallbackStoryboard({ concept: { title: "x", centralMessage: "m" }, product: { name: "Acme", cta: "Buy" }, brand: { name: "Acme" }, durationSeconds: 8, availableAssets: [] });
  assert.ok(withOffer.shots.some((s) => s.onScreenText === "20% off"), "exact offer rendered");
  assert.ok(!noOffer.shots.some((s) => s.intent === "offer"), "no offer → no offer beat");
});

test("technique honors available assets: real_asset when an asset exists, else motion_graphic", () => {
  const withAsset = fallbackStoryboard({ concept: { title: "x", visualIdea: "hero" }, product: { name: "A" }, brand: { name: "A" }, durationSeconds: 6, availableAssets: [{ role: "hero_product", kind: "image" }] });
  const noAsset = fallbackStoryboard({ concept: { title: "x", visualIdea: "hero" }, product: { name: "A" }, brand: { name: "A" }, durationSeconds: 6, availableAssets: [] });
  assert.equal(withAsset.shots[0].technique, "real_asset");
  assert.equal(noAsset.shots[0].technique, "motion_graphic");
});

test("directStoryboard with no key returns a labeled fallback (never throws)", async () => {
  const r = await directStoryboard({ concept: { title: "x", centralMessage: "m", visualIdea: "v" }, product: { name: "A" }, brand: { name: "A" }, durationSeconds: 8, availableAssets: [] });
  assert.equal(r.origin, "fallback");
  assert.ok(r.storyboard.shots.length >= 1);
  assert.ok(r.note);
});

test("a storyboard DRIVES the compiled scene plan (replaces establish/detail/end)", () => {
  const sb = fallbackStoryboard({
    concept: { title: "Three-beat idea", centralMessage: "it just works", visualIdea: "open on chaos" },
    product: { name: "Acme", offer: "Free trial", cta: "Start" }, brand: { name: "Acme" },
    durationSeconds: 10, availableAssets: [{ role: "product_screenshot", kind: "image" }],
  });
  const compiled = compileCreativeRequest({
    productName: "Acme", brand: "Acme", description: "A tool.", template: "product-demo",
    aspectRatio: "9:16", resolution: "720p", durationSeconds: 10, entityType: "saas",
    concept: { title: "Three-beat idea", centralMessage: "it just works" },
    storyboard: sb,
  });
  // The scene plan must reflect the storyboard's shot count + carry techniques.
  assert.equal(compiled.scenePlan.scenes.length, sb.shots.length);
  assert.equal(compiled.scenePlan.storyboardOrigin, "fallback");
  assert.ok(compiled.scenePlan.scenes.every((s) => s.technique));
});
