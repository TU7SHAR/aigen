/**
 * Tests: the selected concept drives the scene plan (not just the message), and
 * recommendedProductionMethod is only honored when actually implemented.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveProductionMethod } from "../lib/creative/productionMethods.js";
import { compileCreativeRequest } from "../lib/creative/compile.js";

function base(over = {}) {
  return {
    productName: "BhavishAI",
    aspectRatio: "9:16",
    resolution: "720p",
    durationSeconds: 8,
    entityType: "saas",
    productProfile: { entityType: "saas", extractionConfidence: 0.7, primaryImage: "/x.png" },
    ...over,
  };
}

// --- resolveProductionMethod ---
test("implemented methods are honored (image_to_video with an image)", () => {
  const r = resolveProductionMethod("image_to_video", { hasUsableImage: true });
  assert.equal(r.method, "image_to_video");
  assert.equal(r.honored, true);
});

test("image_to_video without an image falls back to text_to_video (not honored)", () => {
  const r = resolveProductionMethod("image_to_video", { hasUsableImage: false });
  assert.equal(r.method, "text_to_video");
  assert.equal(r.honored, false);
});

test("unimplemented 'motion_graphics' falls back with a note, not a lie", () => {
  const r = resolveProductionMethod("motion_graphics", { hasUsableImage: false });
  assert.equal(r.method, "text_to_video");
  assert.equal(r.honored, false);
  assert.match(r.note, /not implemented/i);
  assert.equal(r.blocker, null);
});

test("unimplemented 'hybrid' resolves to a real executable method", () => {
  const withImg = resolveProductionMethod("hybrid", { hasUsableImage: true });
  assert.equal(withImg.method, "image_to_video");
  assert.equal(withImg.honored, false);
});

test("'avatar_presenter' has no fallback → hard blocker (we don't fake presenters)", () => {
  const r = resolveProductionMethod("avatar_presenter", { hasUsableImage: true });
  assert.ok(r.blocker);
  assert.match(r.blocker, /not available/i);
});

// --- concept drives the scene plan ---
test("concept's visualIdea/subject appears in the scene plan + prompt", () => {
  const c = compileCreativeRequest(
    base({
      concept: {
        id: "x",
        title: "Birth Chart Reveal",
        centralMessage: "entering birth details yields personalized guidance",
        visualIdea: "an elegant celestial chart assembling from inputs",
        proposedSubject: "the app's real chart interface",
        origin: "ai",
      },
    })
  );
  const scene0 = c.scenePlan.scenes[0].visual.toLowerCase();
  assert.match(scene0, /celestial chart|chart interface/);
  assert.match(c.finalVideoPrompt, /celestial chart|chart interface/i);
});

test("two different concepts produce different scene plans", () => {
  const a = compileCreativeRequest(base({ concept: { id: "a", title: "Reveal", visualIdea: "a clean logo reveal in brand color", proposedSubject: "the brand mark", origin: "ai" } }));
  const b = compileCreativeRequest(base({ concept: { id: "b", title: "Workflow", visualIdea: "a step-by-step interface walkthrough", proposedSubject: "the real UI in motion", origin: "ai" } }));
  assert.notEqual(
    a.scenePlan.scenes.map((s) => s.visual).join("|"),
    b.scenePlan.scenes.map((s) => s.visual).join("|")
  );
});

test("compile surfaces productionMethod and blocks an avatar concept", () => {
  const c = compileCreativeRequest(
    base({ concept: { id: "p", title: "Presenter Pitch", recommendedProductionMethod: "avatar_presenter", origin: "ai" } })
  );
  assert.ok(c.productionMethod);
  assert.equal(c.preflight.readyForPaidGeneration, false);
  assert.ok(c.preflight.blockers.some((b) => /not available/i.test(b)));
});

test("short duration (<=6s) yields fewer scene beats than longer", () => {
  const short = compileCreativeRequest(base({ durationSeconds: 5 }));
  const long = compileCreativeRequest(base({ durationSeconds: 10 }));
  assert.ok(short.scenePlan.scenes.length < long.scenePlan.scenes.length);
});
