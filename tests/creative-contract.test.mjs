/**
 * Creative contract tests (PR A): user edits win, extracted facts + offer/CTA
 * reach the prompt, and the selected concept genuinely changes the prompt.
 * Pure functions, no AI, no cost.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { compileCreativeRequest } from "../lib/creative/compile.js";

function base(over = {}) {
  return {
    productName: "BhavishAI",
    template: "minimal",
    aspectRatio: "9:16",
    resolution: "720p",
    durationSeconds: 8,
    brandInfluence: "balanced",
    entityType: "saas",
    productProfile: { entityType: "saas", extractionConfidence: 0.7, primaryImage: "/x.png" },
    ...over,
  };
}

test("user-edited name/description WIN over scraped productProfile values", () => {
  const c = compileCreativeRequest(
    base({
      productName: "BhavishAI Pro", // user edit
      description: "User-corrected description about personalized astrology.",
      productProfile: {
        entityType: "saas",
        name: "OLD SCRAPED NAME",
        description: "stale scraped description",
        extractionConfidence: 0.7,
        primaryImage: "/x.png",
      },
    })
  );
  assert.match(c.finalVideoPrompt, /BhavishAI Pro/);
  assert.ok(!c.finalVideoPrompt.includes("OLD SCRAPED NAME"));
  assert.match(c.finalVideoPrompt, /User-corrected description/);
  assert.ok(!c.finalVideoPrompt.includes("stale scraped description"));
});

test("extracted description reaches the final prompt", () => {
  const c = compileCreativeRequest(
    base({ description: "Personalized Vedic astrology from your exact birth chart." })
  );
  assert.match(c.finalVideoPrompt, /What it is:/);
  assert.match(c.finalVideoPrompt, /exact birth chart/);
});

test("offer and CTA reach the final prompt (previously discarded)", () => {
  const c = compileCreativeRequest(
    base({ offer: "Free personalized preview", cta: "Get your free report" })
  );
  assert.match(c.finalVideoPrompt, /Free personalized preview/);
  assert.match(c.finalVideoPrompt, /Get your free report/);
});

test("benefits/differentiators from profile reach the prompt (grounded)", () => {
  const c = compileCreativeRequest(
    base({
      productProfile: {
        entityType: "saas",
        extractionConfidence: 0.7,
        primaryImage: "/x.png",
        benefits: ["Guidance based on your exact chart", "Daily personalized insights"],
        differentiators: ["Not a generic sun-sign horoscope"],
      },
    })
  );
  assert.match(c.finalVideoPrompt, /exact chart|personalized insights/i);
  assert.match(c.finalVideoPrompt, /generic sun-sign horoscope/i);
});

test("selected concept genuinely changes the prompt (not just a label)", () => {
  // AI-reasoned concepts carry their own messaging; selecting a different one
  // must change the prompt.
  const howItWorks = compileCreativeRequest(
    base({ concept: { id: "a", title: "How It Works", centralMessage: "convey the step-by-step process", visualIdea: "the real interface in motion", origin: "ai" } })
  );
  const brandIntro = compileCreativeRequest(
    base({ concept: { id: "b", title: "Brand Introduction", centralMessage: "establish positioning and identity", visualIdea: "a confident brand-first reveal", origin: "ai" } })
  );
  assert.notEqual(howItWorks.finalVideoPrompt, brandIntro.finalVideoPrompt);
  assert.match(howItWorks.finalVideoPrompt, /step-by-step process|real interface/i);
  assert.match(brandIntro.finalVideoPrompt, /positioning and identity|brand-first/i);
});

test("compiler is deterministic — same input yields identical prompt (preview == generate)", () => {
  const input = base({ description: "x", offer: "y", cta: "z", concept: { id: "outcome", template: "minimal" } });
  const a = compileCreativeRequest(input).finalVideoPrompt;
  const b = compileCreativeRequest(input).finalVideoPrompt;
  assert.equal(a, b);
});

test("AI concept's own fields drive the prompt (not a hardcoded id map)", () => {
  const c = compileCreativeRequest(
    base({
      concept: {
        id: "whatever-unlisted-id",
        title: "Birth Chart Reveal",
        centralMessage: "Show how entering birth details yields personalized guidance",
        visualIdea: "An elegant celestial chart assembling from the user's inputs",
        proposedSubject: "the app's real chart interface",
        origin: "ai",
      },
    })
  );
  // The dynamic concept text must appear even though the id is unknown to any map.
  assert.match(c.finalVideoPrompt, /personalized guidance|celestial chart|chart interface/i);
});

test("financial 'trust-proof' concept forbids inventing results/guarantees", () => {
  const c = compileCreativeRequest(
    base({ entityType: "service", productProfile: { entityType: "service", extractionConfidence: 0.7, primaryImage: "/x.png" }, concept: { id: "trust-proof", template: "minimal" } })
  );
  assert.match(c.finalVideoPrompt, /do NOT invent|invent nothing|invent/i);
});
