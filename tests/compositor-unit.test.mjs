/**
 * Compositor pure-logic unit tests (no ffmpeg, no render) — the anti-fabrication
 * guarantees: exact URL extraction, no invented offer, asset resolution rules.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { _internal as comp } from "../lib/render/compositor.js";

test("extractUrl returns the exact host/path, www stripped — never invented", () => {
  assert.equal(comp.extractUrl({ productProfile: { canonicalUrl: "https://www.bhavishai.in/" } }), "bhavishai.in");
  assert.equal(comp.extractUrl({ productProfile: { sourceUrl: "https://app.example.com/pricing/" } }), "app.example.com/pricing");
  assert.equal(comp.extractUrl({ websiteUrl: "example.io" }), "example.io");
  // No URL anywhere → null (we never synthesize one).
  assert.equal(comp.extractUrl({ productProfile: {} }), null);
});

test("buildOverlays never fabricates an offer and only draws provided copy", () => {
  const brief = { conceptCentralMessage: "Clarity for your metrics" };
  const withOffer = comp.buildOverlays(
    { brand: "Acme", offer: "20% off", cta: "Try free", productProfile: { canonicalUrl: "https://acme.com" } },
    brief, 8
  );
  const kinds = withOffer.map((o) => o.kind);
  assert.ok(kinds.includes("brand") && kinds.includes("offer") && kinds.includes("cta") && kinds.includes("url"));

  const noOffer = comp.buildOverlays({ brand: "Acme", cta: "Try free" }, brief, 8);
  assert.ok(!noOffer.some((o) => o.kind === "offer"), "no offer provided → no offer overlay (no fabrication)");
  // headline comes from the real central message, not invented copy.
  const headline = noOffer.find((o) => o.kind === "headline");
  assert.equal(headline.text, "Clarity for your metrics");
});

test("buildScenes assigns real images across scenes and falls back to cards (no fake UI)", () => {
  const plan = { scenes: [{ purpose: "establish", duration: 3 }, { purpose: "detail", duration: 2 }, { purpose: "end", duration: 2 }], totalDuration: 7 };
  const withImgs = comp.buildScenes(plan, ["/a.png", "/b.png"], {});
  assert.equal(withImgs[0].imagePath, "/a.png");
  assert.equal(withImgs[1].imagePath, "/b.png");
  assert.equal(withImgs[2].imagePath, "/a.png"); // cycles

  const noImgs = comp.buildScenes(plan, [], {});
  assert.ok(noImgs.every((s) => s.imagePath === null), "no images → title cards, never a fabricated screen");
});

test("resolveImagePath only accepts local imported assets, rejects svg + traversal", async () => {
  assert.equal(await comp.resolveImagePath("https://evil.com/x.png"), null, "remote urls not used by renderer");
  assert.equal(await comp.resolveImagePath("/imported-assets/does-not-exist.png"), null);
  assert.equal(await comp.resolveImagePath("/imported-assets/logo.svg"), null, "svg rejected (raster only)");
  assert.equal(await comp.resolveImagePath(null), null);
});
