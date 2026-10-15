/**
 * End-to-end pipeline DEMO (deterministic path, zero paid calls, no key).
 *
 * Drives the REAL server pipeline — runGenerate() → compileCreativeRequest →
 * composeScreenAd (ffmpeg) — for TWO distinct brands, each with:
 *   - a distinct AI-shaped storyboard (per-shot technique + exact copy), as if
 *     returned by /api/creative/storyboard, so the per-shot production router
 *     is exercised exactly as it is in the live app;
 *   - a real authorized local source image (from public/imported-assets).
 *
 * Writes real .mp4 files + a per-shot report JSON so we can show which shots
 * were AI-generated vs deterministic. Run: node scripts/demo-e2e.mjs
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { runGenerate } from "../lib/api/generateCore.js";
import { __resetGenerateGuards } from "../lib/api/generateCore.js";

const OUT = path.join(process.cwd(), "demo-output");

/** Two brands, two different concepts → structurally different storyboards. */
const BRANDS = [
  {
    slug: "northwind-saas",
    label: "Northwind Analytics (SaaS)",
    sourceImage: "/imported-assets/361b26a86f3ee951bdf92c14.png",
    sourceRole: "screenshot",
    body: {
      productName: "Northwind Analytics",
      brand: "Northwind",
      description: "Real-time product analytics that turn raw events into decisions.",
      offer: "First 14 days free",
      cta: "Start free",
      entityType: "saas",
      format: "screen_demo",
      template: "product-demo",
      aspectRatio: "16:9",
      resolution: "360p",
      durationSeconds: 8,
      concept: { title: "From noise to clarity", centralMessage: "See what your product data is really telling you" },
      referenceAssets: [{ url: "/imported-assets/361b26a86f3ee951bdf92c14.png", role: "screenshot", primary: true }],
      galleryUrls: ["/imported-assets/361b26a86f3ee951bdf92c14.png"],
      // AI-shaped storyboard (as /api/creative/storyboard would return).
      storyboard: {
        origin: "ai",
        logline: "Turn scattered metrics into one clear signal.",
        totalDurationSec: 8,
        shots: [
          { intent: "hook", durationSec: 2, technique: "motion_graphic", assetHint: "none", visual: "Kinetic type: data points converging", onScreenText: "Drowning in dashboards?", motion: "kinetic", transitionOut: "cut" },
          { intent: "proof", durationSec: 3.5, technique: "real_asset", assetHint: "screenshot", visual: "Animate the live analytics dashboard", onScreenText: "See what your data is telling you", motion: "slow push-in", transitionOut: "fade" },
          { intent: "cta", durationSec: 2.5, technique: "motion_graphic", assetHint: "logo", visual: "Brand end card with CTA", onScreenText: "Start free", motion: "hold", transitionOut: "end" },
        ],
      },
    },
  },
  {
    slug: "lumen-serum",
    label: "Lumen Hydrating Serum (physical product)",
    sourceImage: "/imported-assets/417560aac4790393eb39b186.png",
    sourceRole: "product",
    body: {
      productName: "Lumen Hydrating Serum",
      brand: "Lumen",
      description: "A lightweight hyaluronic serum for all-day hydration.",
      offer: "20% off this week",
      cta: "Shop now",
      entityType: "physical_product",
      format: "screen_demo",
      template: "minimal",
      aspectRatio: "9:16",
      resolution: "360p",
      durationSeconds: 9,
      concept: { title: "Everyday glow", centralMessage: "Hydration you can feel all day" },
      referenceAssets: [{ url: "/imported-assets/417560aac4790393eb39b186.png", role: "product", primary: true }],
      galleryUrls: ["/imported-assets/417560aac4790393eb39b186.png"],
      storyboard: {
        origin: "ai",
        logline: "A serum that keeps up with your whole day.",
        totalDurationSec: 9,
        shots: [
          { intent: "hook", durationSec: 2, technique: "motion_graphic", assetHint: "none", visual: "Soft gradient, brand word mark fades up", onScreenText: "Meet Lumen", motion: "ease-in", transitionOut: "fade" },
          { intent: "hero", durationSec: 3.5, technique: "real_asset", assetHint: "product", visual: "Animate the real product photo, gentle push-in", onScreenText: "Hydration you can feel all day", motion: "slow push-in", transitionOut: "cut" },
          { intent: "offer", durationSec: 2, technique: "motion_graphic", assetHint: "none", visual: "Offer card", onScreenText: "20% off this week", motion: "pop-in", transitionOut: "cut" },
          { intent: "cta", durationSec: 1.5, technique: "motion_graphic", assetHint: "logo", visual: "End card", onScreenText: "Shop now", motion: "hold", transitionOut: "end" },
        ],
      },
    },
  },
];

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const summary = [];
  for (const brand of BRANDS) {
    __resetGenerateGuards();
    process.stdout.write(`\n▶ ${brand.label}\n`);
    const t0 = Date.now();
    const { status, body } = await runGenerate(brand.body);
    const ms = Date.now() - t0;
    if (status !== 200 || !body?.video) {
      process.stdout.write(`  ✖ FAILED status=${status} error=${body?.error || "no video"}\n`);
      summary.push({ brand: brand.slug, ok: false, status, error: body?.error });
      continue;
    }
    const b64 = body.video.split(",")[1];
    const buf = Buffer.from(b64, "base64");
    const mp4 = path.join(OUT, `${brand.slug}.mp4`);
    await fs.writeFile(mp4, buf);
    const report = {
      brand: brand.label,
      file: mp4,
      bytes: buf.length,
      renderMs: ms,
      deterministic: body.deterministic,
      provider: body.provider,
      model: body.model,
      storyboardDriven: body.render?.storyboardDriven,
      storyboardOrigin: body.render?.storyboardOrigin,
      usedImages: body.render?.usedImages,
      durationSec: body.render?.durationSec,
      dimensions: `${body.render?.width}x${body.render?.height}`,
      shotReport: body.render?.shotReport,
    };
    await fs.writeFile(path.join(OUT, `${brand.slug}.report.json`), JSON.stringify(report, null, 2));
    summary.push({ brand: brand.slug, ok: true, ...report });
    const ai = (body.render?.shotReport || []).filter((s) => s.aiGenerated).length;
    const det = (body.render?.shotReport || []).filter((s) => !s.aiGenerated).length;
    process.stdout.write(
      `  ✔ ${mp4}\n    ${buf.length} bytes · ${report.dimensions} · ${report.durationSec}s · storyboardDriven=${report.storyboardDriven} · usedImages=${report.usedImages}\n    shots: ${ai} AI-generated / ${det} deterministic · provider=${report.provider}/${report.model}\n`
    );
    for (const s of body.render?.shotReport || []) {
      process.stdout.write(
        `      shot ${s.shot} [${s.executedMethod}${s.aiGenerated ? " · AI" : ""}${s.usedRealAsset ? " · real asset" : ""}] "${s.onScreenText}"\n`
      );
    }
  }
  await fs.writeFile(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
  process.stdout.write(`\n✔ demo-output/summary.json written\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
