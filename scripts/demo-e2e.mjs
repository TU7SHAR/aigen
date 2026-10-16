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
    slug: "bhavishai",
    label: "BhavishAI (Vedic astrology SaaS) — the one that failed",
    sourceImage: null,
    sourceRole: null,
    body: {
      productName: "BhavishAI",
      brand: "BhavishAI",
      description: "Personalized Vedic astrology guidance powered by AI — precise, private, always available.",
      offer: "Guidance Membership from ₹299/month",
      cta: "Start your reading",
      entityType: "saas",
      format: "screen_demo",
      template: "problem-solution",
      aspectRatio: "9:16",
      resolution: "360p",
      durationSeconds: 12,
      productProfile: { canonicalUrl: "https://bhavishai.in", brandColors: ["#2b1a6e", "#ff8a3d"] },
      concept: { title: "From generic to genuinely yours", centralMessage: "Vedic precision for your life, not a generic horoscope" },
      // AI-shaped storyboard: NO real asset available → ai_image shots must
      // produce real keyframes, not black cards. This is the failure case.
      storyboard: {
        origin: "ai",
        logline: "Stop reading generic horoscopes — get guidance that is actually yours.",
        totalDurationSec: 12,
        shots: [
          { intent: "hook", durationSec: 2.5, technique: "ai_image", assetHint: "none", visual: "A lone person looking at a phone under a vast night sky full of stars, dawn light on the horizon", onScreenText: "Stop reading generic horoscopes", motion: "slow push-in", transitionOut: "fade" },
          { intent: "turn", durationSec: 3, technique: "ai_image", assetHint: "none", visual: "Abstract constellation lines resolving into a focused, personal chart; warm brand-colored glow", onScreenText: "Vedic precision for your life", motion: "drift", transitionOut: "cut" },
          { intent: "offer", durationSec: 3, technique: "motion_graphic", assetHint: "none", visual: "Offer card on a deep indigo gradient", onScreenText: "Guidance Membership from ₹299/month", motion: "pop-in", transitionOut: "cut" },
          { intent: "cta", durationSec: 3.5, technique: "ai_image", assetHint: "none", visual: "Sunrise over calm mountains, a sense of clarity and new beginning, brand mark space", onScreenText: "Start your reading", motion: "zoom-out", transitionOut: "end" },
        ],
      },
    },
  },
  {
    slug: "lumen-serum",
    label: "Lumen Hydrating Serum (physical product) — real asset + keyframes",
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
      durationSeconds: 12,
      productProfile: { brandColors: ["#0f6e5a", "#ffd166"] },
      concept: { title: "Everyday glow", centralMessage: "Hydration you can feel all day" },
      referenceAssets: [{ url: "/imported-assets/417560aac4790393eb39b186.png", role: "product", primary: true }],
      galleryUrls: ["/imported-assets/417560aac4790393eb39b186.png"],
      storyboard: {
        origin: "ai",
        logline: "A serum that keeps up with your whole day.",
        totalDurationSec: 12,
        shots: [
          { intent: "hook", durationSec: 2.5, technique: "ai_image", assetHint: "none", visual: "Dewy morning light, water droplets on a leaf, fresh and clean", onScreenText: "Meet Lumen", motion: "ease-in", transitionOut: "fade" },
          { intent: "hero", durationSec: 4, technique: "real_asset", assetHint: "product", visual: "The real product photo, gentle push-in", onScreenText: "Hydration you can feel all day", motion: "slow push-in", transitionOut: "cut" },
          { intent: "offer", durationSec: 2.5, technique: "motion_graphic", assetHint: "none", visual: "Offer card", onScreenText: "20% off this week", motion: "pop-in", transitionOut: "cut" },
          { intent: "cta", durationSec: 3, technique: "motion_graphic", assetHint: "logo", visual: "End card", onScreenText: "Shop now", motion: "hold", transitionOut: "end" },
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
      generatedKeyframes: body.render?.generatedKeyframes,
      quality: body.render?.quality,
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
      `  ✔ ${mp4}\n    ${buf.length} bytes · ${report.dimensions} · ${report.durationSec}s · storyboardOrigin=${report.storyboardOrigin} · realImages=${report.usedImages} · keyframes=${report.generatedKeyframes}\n    shots: ${ai} AI-generated / ${det} deterministic · quality.passed=${report.quality?.passed} · visualShots=${report.quality?.visualShots}/${report.quality?.totalShots}\n`
    );
    for (const s of body.render?.shotReport || []) {
      const kf = s.keyframeProvider ? ` · keyframe:${s.keyframeProvider}${s.keyframeMock ? "(mock)" : ""}` : "";
      process.stdout.write(
        `      shot ${s.shot} [${s.executedMethod}${s.aiGenerated ? " · AI" : ""}${s.usedRealAsset ? " · real asset" : ""}${kf}] "${s.onScreenText}"\n`
      );
    }
    for (const w of report.quality?.warnings || []) process.stdout.write(`      ⚠ ${w}\n`);
  }
  await fs.writeFile(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
  process.stdout.write(`\n✔ demo-output/summary.json written\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
