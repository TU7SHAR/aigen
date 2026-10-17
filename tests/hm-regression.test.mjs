/**
 * H&M regression (2026-10-17): the import stored an Akamai "Access Denied"
 * capture as website footage and a brushed-gold texture as a product image.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

import { detectBlockedPage } from "../lib/crawl/blockDetect.js";
import { analyzeImageQuality } from "../lib/crawl/assetQuality.js";
import { heuristicFocus } from "../lib/crawl/focus.js";

const AKAMAI = `Access Denied
You don't have permission to access "http://www2.hm.com/en_in/index.html" on this server.
Reference #18.a5014017.1792210219.23999aff
https://errors.edgesuite.net/18.a5014017.1792210219.23999aff`;

test("Akamai / Cloudflare / HTTP-error pages are detected as blocked, real pages are not", () => {
  assert.equal(detectBlockedPage({ text: AKAMAI }).blocked, true);
  assert.equal(detectBlockedPage({ status: 403, text: "" }).blocked, true);
  assert.equal(detectBlockedPage({ text: "Just a moment... Checking your browser before accessing" }).blocked, true);
  const longStore = "H&M offers fashion and quality at the best price. ".repeat(80) + " Please complete the captcha in our contest rules.";
  assert.equal(detectBlockedPage({ text: longStore }).blocked, false, "a real page mentioning captcha in passing is fine");
});

test("decorative textures and near-blank captures are classified (synthetic)", async () => {
  const gradient = await sharp({ create: { width: 800, height: 450, channels: 3, background: "#b8995a" } })
    .composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450"><defs><linearGradient id="g"><stop offset="0" stop-color="#7a6236"/><stop offset="0.5" stop-color="#e6d9b8"/><stop offset="1" stop-color="#7a6236"/></linearGradient></defs><rect width="800" height="450" fill="url(#g)"/></svg>`) }])
    .png().toBuffer();
  assert.equal((await analyzeImageQuality(gradient)).verdict, "texture");
  const blank = await sharp({ create: { width: 1280, height: 800, channels: 3, background: "#ffffff" } })
    .composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800"><text x="20" y="60" font-size="40">Access Denied</text></svg>`) }])
    .png().toBuffer();
  assert.equal((await analyzeImageQuality(blank)).verdict, "blank");
  const product = await sharp({ create: { width: 600, height: 900, channels: 3, background: "#ffffff" } })
    .composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900"><rect x="150" y="120" width="300" height="640" rx="40" fill="#3b2418"/><path d="M150 300 Q300 360 450 300 M150 420 Q300 480 450 420 M150 540 Q300 600 450 540" stroke="#6b4a37" stroke-width="10" fill="none"/></svg>`) }])
    .png().toBuffer();
  assert.equal((await analyzeImageQuality(product)).verdict, "ok");
});

test("real H&M import assets (when present locally) classify as observed", async () => {
  const dir = path.join(process.cwd(), "public", "imported-assets");
  const cases = { "0aa26912d6ca701d377a5a3c.jpg": "texture", "537246e41a4ab384605721d2.png": "blank", "b20e38e2468b496efe98a0dd.jpg": "ok" };
  for (const [f, want] of Object.entries(cases)) {
    const file = path.join(dir, f);
    if (!fs.existsSync(file)) continue; // fixtures are local-only (imported-assets is not committed)
    assert.equal((await analyzeImageQuality(fs.readFileSync(file))).verdict, want, f);
  }
});

test("heuristic focus never selects textures/logos and asks a question on a multi-product homepage", () => {
  const f = heuristicFocus({
    entityType: "ecommerce_store", name: "H&M",
    assets: [
      { storedUrl: "/imported-assets/a.jpg", role: "hero_product", quality: { verdict: "ok" } },
      { storedUrl: "/imported-assets/b.jpg", role: "texture_background", quality: { verdict: "texture" } },
      { storedUrl: "/imported-assets/c.png", role: "logo", quality: { verdict: "ok" } },
    ],
  });
  assert.deepEqual(f.assetUrls, ["/imported-assets/a.jpg"]);
  assert.ok(f.question);
  assert.ok(f.confidence < 0.5);
});
