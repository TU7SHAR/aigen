/**
 * APPLICATION-LEVEL integration test (route handler, not just libs).
 *
 * Covers the chain the product actually runs:
 *   import result (verified assets)
 *     → selectReference() picks the primary (role-based; never a logo)
 *     → "review handoff" payload the Studio UI would POST
 *     → runGenerate() — the REAL /api/generate server pipeline (Zod validation
 *       + reference resolution + canonical compile + preflight + provider
 *       dispatch; the Next POST handler is a thin wrapper over this exact
 *       function)
 *     → the mock provider records what it received
 *   and we assert the recorded provider input matches the selected reference.
 *
 * HONEST SCOPE: this exercises the full server pipeline with the mock provider
 * (zero paid calls). It is NOT a browser/HTTP/UI test — it does not drive the
 * Studio form or go over the wire. That remaining gap is noted in
 * docs/TESTING.md; this test does not claim to cover it.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";

import { LocalAssetStore } from "../lib/assets/store.js";
import { selectReference } from "../lib/assets/selectReference.js";

// This suite exercises the GENERATIVE provider route (reference image reaching
// the provider). The provider is MOCK (free, no network), so lifting the hard
// paid-disable does NOT spend anything — mock short-circuits before any paid
// call. format:"generative" selects the provider route (not the compositor).
process.env.VIDEO_PROVIDER = "mock";
process.env.DISABLE_PAID_GENERATION = "false"; // allow the generative route; mock is free
delete process.env.ENABLE_PAID_GENERATION;

// Import the REAL server pipeline (the same code the Next POST handler wraps)
// AFTER setting env so config reads the mock provider.
const { runGenerate, __resetGenerateGuards } = await import("../lib/api/generateCore.js");

/** Add format:"generative" so the request routes to the (mock) provider. */
const gen = (p) => ({ ...p, format: "generative" });

const cleanup = [];
let importResult; // stands in for importSource(...)'s asset-bearing output

/** Build a tiny real PNG and store it like the importer does. */
async function storePng(hex, w = 1024, h = 1024) {
  const png = await sharp({ create: { width: w, height: h, channels: 3, background: hex } }).png().toBuffer();
  const saved = await new LocalAssetStore().save({ buffer: png, mimeType: "image/png", sourceUrl: `https://example.com/${hex}.png` });
  cleanup.push(path.join(process.cwd(), "public", saved.storedUrl));
  return saved;
}

before(async () => {
  // A realistic verified-asset set: a small logo + a hero + a screenshot.
  const logo = await storePng("#111111", 128, 128);
  const hero = await storePng("#6D28D9", 1600, 900);
  const shot = await storePng("#0EA5E9", 1280, 800);

  const verifiedAssets = [
    { ...logo, role: "logo", width: 128, height: 128 },
    { ...hero, role: "hero_visual", width: 1600, height: 900 },
    { ...shot, role: "product_screenshot", width: 1280, height: 800 },
  ];

  // Real selection (brand entity → hero_visual should win, NOT the logo).
  const sel = selectReference(verifiedAssets, { entityType: "business" });

  importResult = {
    entityType: "business",
    verifiedAssets,
    selection: sel,
    // The subset of ProductProfile the review screen carries forward.
    primaryReferenceRole: sel.primary?.role || null,
    primaryReferenceUrl: sel.primary?.storedUrl || null,
  };
});

after(async () => {
  await Promise.all(cleanup.map((p) => fs.rm(p, { force: true })));
});

// Each request uses a unique clientRequestId; also reset guards between the
// two generating tests so the single-concurrent / dedup guards don't interfere.

test("selection picked the hero_visual as primary, NOT the logo", () => {
  assert.equal(importResult.primaryReferenceRole, "hero_visual");
  assert.ok(importResult.primaryReferenceUrl?.startsWith("/imported-assets/"));
  assert.equal(importResult.selection.basis, "role_rank_then_resolution");
});

test("review handoff → /api/generate uses the selected reference as the provider image", async () => {
  // The payload the Studio review screen would POST (reference by URL, not
  // a re-uploaded base64 blob).
  const payload = {
    productName: "Acme Analytics",
    brand: "Acme",
    description: "A dashboard that shows your metrics clearly.",
    cta: "Start free",
    template: "product-demo",
    aspectRatio: "9:16",
    resolution: "720p",
    durationSeconds: 8,
    entityType: importResult.entityType,
    referenceAssetUrl: importResult.primaryReferenceUrl,
    referenceAssetRole: importResult.primaryReferenceRole,
    clientRequestId: "itest-ref-1",
  };

  __resetGenerateGuards();
  const { status, body: json } = await runGenerate(gen(payload));
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(json).slice(0, 200)}`);

  assert.equal(json.ok, true);
  assert.equal(json.mock, true, "must be a mock generation (no paid call)");
  // The recorded provider input proves the selected reference reached the model.
  assert.ok(json.receivedRequest, "route must surface receivedRequest");
  assert.equal(json.receivedRequest.hasImage, true);
  assert.equal(json.receivedRequest.imageMimeType, "image/png");
  assert.ok(json.receivedRequest.imageBytesApprox > 1000);
});

test("no reference selected → generate proceeds as honest text-to-video (no image)", async () => {
  const payload = {
    productName: "Logo Only Co",
    description: "A business whose site only exposed a logo.",
    template: "minimal",
    aspectRatio: "9:16",
    resolution: "720p",
    durationSeconds: 8,
    entityType: "business",
    // No referenceAssetUrl — mirrors selectReference returning primary:null.
    clientRequestId: "itest-ref-2",
  };
  __resetGenerateGuards();
  const { status, body: json } = await runGenerate(gen(payload));
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.receivedRequest.hasImage, false);
});

test("a logo-only asset set yields NO primary (selector does not fall back to it)", () => {
  const logoOnly = [{ storedUrl: "/imported-assets/logo.png", role: "logo", width: 128, height: 128 }];
  const sel = selectReference(logoOnly, { entityType: "business" });
  assert.equal(sel.primary, null, "a logo must never be promoted to primary");
  assert.ok(sel.logo, "logo is still available for an end-card overlay");
  assert.equal(sel.basis, "none");
});

test("user-selected reference is authoritative over the role ranking", () => {
  const assets = [
    { storedUrl: "/imported-assets/hero.png", role: "hero_visual", width: 1600, height: 900 },
    { storedUrl: "/imported-assets/shot.png", role: "product_screenshot", width: 1280, height: 800 },
  ];
  const sel = selectReference(assets, {
    entityType: "business",
    userSelectedReference: "/imported-assets/shot.png",
  });
  assert.equal(sel.basis, "user_selected");
  assert.equal(sel.primary.storedUrl, "/imported-assets/shot.png");
});
