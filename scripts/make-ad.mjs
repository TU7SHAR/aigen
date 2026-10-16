/**
 * End-to-end "here's my product → finished ad" runner (operator/dev tool).
 *
 *   node scripts/make-ad.mjs <url> [--seconds 14] [--clips 3] [--max-usd 2.5] [--concept 1] [--ratio 9:16]
 *   node scripts/make-ad.mjs --plan demo-output/live/<brand>.plan.json --confirm   # produce a reviewed plan
 *
 * Runs the SAME server pipeline the Studio drives:
 *   import (crawl + brand/entity understanding + real mobile screen capture)
 *   → AI concepts → AI Creative Director storyboard → per-shot production
 *   (Veo footage, real assets, end card) → voiceover + music → MP4.
 *
 * Without --confirm it stops after the storyboard (only the cheap text
 * intelligence calls the app makes on every import) and prints the plan and
 * the spend caps. With --confirm the paid calls run under in-process caps
 * (nothing in .env files changes) enforced by the fail-closed job budget.
 */
import nextEnv from "@next/env";
import { promises as fs } from "node:fs";
import path from "node:path";

nextEnv.loadEnvConfig(process.cwd(), true);

const args = process.argv.slice(2);
const url = args.find((a) => /^https?:\/\//i.test(a));
const flag = (name, d) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : d;
};
const confirmed = args.includes("--confirm");
const seconds = Math.min(15, Math.max(6, Number(flag("seconds", 14))));
const clips = Math.min(6, Math.max(0, Number(flag("clips", 3))));
const maxUsd = Math.min(10, Math.max(0.1, Number(flag("max-usd", 2.5))));
const conceptIdx = Math.max(1, Number(flag("concept", 1))) - 1;
const ratio = flag("ratio", "9:16") === "16:9" ? "16:9" : "9:16";
if (!url && !args.includes("--plan")) {
  console.log("usage: node scripts/make-ad.mjs <url> [--confirm] [--seconds 14] [--clips 3] [--max-usd 2.5] [--concept 1]");
  process.exit(2);
}

// Operator-driven capture of a TRUSTED url (see docs/SECURITY.md) + run caps.
Object.assign(process.env, {
  ENABLE_RENDERED_CAPTURE: "true", ACKNOWLEDGE_CAPTURE_UNSAFE: "true",
  IMAGE_PROVIDER: "mock", ENABLE_PAID_IMAGE_GENERATION: "false",
  VIDEO_PROVIDER: "gemini", VIDEO_MODEL: flag("video-model", "veo-3.1-fast"),
  ENABLE_PAID_GENERATION: confirmed ? "true" : "false",
  DISABLE_PAID_GENERATION: confirmed ? "false" : "true",
  ENABLE_PAID_AUDIO_GENERATION: confirmed ? "true" : "false",
  JOB_MAX_PAID_VIDEO_CLIPS: String(clips), JOB_MAX_PAID_IMAGES: "0", JOB_MAX_PAID_AUDIO: "2",
  JOB_MAX_USD: maxUsd.toFixed(2), DEV_SPEND_LIMIT_USD: maxUsd.toFixed(2), JOB_MAX_PAID_RETRIES: "0",
  // Reuse already-paid footage/audio for unchanged shots across runs.
  SCENE_MEDIA_CACHE_DIR: path.join(process.cwd(), "demo-output", "live", "cache"),
});

const outDir = path.join(process.cwd(), "demo-output", "live");
await fs.mkdir(outDir, { recursive: true });
const t0 = Date.now();
const planFile = flag("plan", null);

/** Import → concepts → storyboard (cheap text intelligence only). */
async function makePlan() {
  const { importProduct } = await import("../lib/crawl/importProduct.js");
  const { generateConceptsSmart } = await import("../lib/creative/concepts.js");
  const { directStoryboard } = await import("../lib/creative/director.js");

  const imp = await importProduct(url, { refresh: true });
  const p = imp.productProfile || {};
  const assets = (imp.assets || []).filter((a) => a.storedUrl && a.verified !== false)
    .map((a) => ({ url: a.storedUrl, role: a.role || "image" }));
  console.log(`IMPORT ${imp.finalUrl} · entity=${imp.entityType} · name=${p.name || p.brand} · ${assets.length} real assets [${assets.map((a) => a.role).join(", ")}]`);
  for (const w of imp.extractionWarnings || []) console.log(`  warn: ${w}`);

  const c = await generateConceptsSmart({
    product: { ...p, entityType: imp.entityType },
    brand: imp.brandProfile, design: imp.designProfile, entity: imp.entityProfile,
    entityType: imp.entityType, hasUsableImage: assets.length > 0,
  });
  const concept = c.concepts[Math.min(conceptIdx, c.concepts.length - 1)];
  console.log(`CONCEPTS (${c.origin}): ${c.concepts.map((x, i) => `${i + 1}. ${x.title}`).join(" | ")}`);
  console.log(`  chosen: ${concept.title} — ${concept.centralMessage || ""}`);

  // A CTA must fit a button: prefer a real call-to-action of ≤ 5 words;
  // otherwise the Director writes a short one grounded in the offer.
  const ctaCandidates = (p.callsToAction || imp.entityProfile?.callsToAction || [])
    .map((x) => String(x || "").replace(/[→»›]+/g, "").trim())
    .filter((x) => x && x.split(/\s+/).length <= 5);
  const cta = ctaCandidates[0] || undefined;
  console.log(`  offer: ${p.offer || "-"} · cta: ${cta || "-"}`);
  const product = {
    name: p.name || p.brand, brand: p.brand || imp.brandProfile?.name,
    description: p.description, offer: p.offer || undefined, cta,
    category: p.category, offering: p.offering, targetCustomer: p.targetCustomer,
    benefits: p.benefits, differentiators: imp.entityProfile?.differentiators,
  };
  const sb = await directStoryboard({
    concept, product, brand: imp.brandProfile, design: imp.designProfile,
    entityType: imp.entityType, durationSeconds: seconds, aspectRatio: ratio,
    availableAssets: assets.map((a) => ({ role: a.role, kind: "image" })),
  });
  return {
    url, finalUrl: imp.finalUrl, entityType: imp.entityType, productProfile: p,
    brandProfile: imp.brandProfile || null, designProfile: imp.designProfile || null,
    assets, concept, product, cta,
    storyboard: { ...sb.storyboard, origin: sb.origin, note: sb.note || null },
  };
}

const plan = planFile ? JSON.parse(await fs.readFile(planFile, "utf8")) : await makePlan();
const { storyboard, product, concept } = plan;
console.log(`STORYBOARD (${storyboard.origin}${storyboard.note ? ` — ${storyboard.note}` : ""}) · music: ${storyboard.music || "-"} · voice: ${storyboard.voiceStyle || "-"}`);
storyboard.shots.forEach((s, i) =>
  console.log(`  ${i + 1}. [${s.technique}${s.assetHint && s.assetHint !== "none" ? `:${s.assetHint}` : ""}] ${s.durationSec}s · ${s.intent}\n     visual: ${s.visual}\n     text: "${s.onScreenText}"  vo: "${s.voiceover}"`));
const aiShots = storyboard.shots.filter((s) => s.technique === "ai_video").length;
console.log(`CAPS: ≤${clips} Veo clip(s) (storyboard wants ${aiShots}) · ≤2 audio calls · job $${maxUsd.toFixed(2)} · retries 0`);

const slug = String(product.brand || product.name || "ad").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "ad";
if (!planFile) {
  const saved = path.join(outDir, `${slug}.plan.json`);
  await fs.writeFile(saved, JSON.stringify(plan, null, 2));
  console.log(`plan saved → ${saved} (re-run with --plan <file> --confirm to produce exactly this plan)`);
}
if (!confirmed) {
  console.log("NOT PRODUCED — add --confirm to run the paid production calls.");
  process.exit(0);
}

const { runGenerate } = await import("../lib/api/generateCore.js");
const p = plan.productProfile || {};
const body = {
  productName: product.name || product.brand, brand: product.brand || product.name,
  description: (p.description || concept.centralMessage || "").slice(0, 600),
  offer: p.offer || undefined, cta: plan.cta || undefined,
  entityType: plan.entityType, format: "screen_demo", template: concept.template || "problem-solution",
  aspectRatio: ratio, resolution: "720p", durationSeconds: seconds,
  productProfile: p, brandProfile: plan.brandProfile || undefined, designProfile: plan.designProfile || undefined,
  concept, storyboard,
  referenceAssets: plan.assets.slice(0, 8).map((a, i) => ({ url: a.url, role: a.role, primary: i === 0 })),
  galleryUrls: plan.assets.slice(0, 8).map((a) => a.url),
  clientRequestId: `make-ad-${Date.now()}`,
};
const { status, body: out } = await runGenerate(body);
if (status !== 200 || !out.video) {
  console.log(`FAILED ${status}: ${out.error || "no video"} ${JSON.stringify(out.details || out.preflight || "").slice(0, 800)}`);
  process.exit(1);
}
const file = path.join(outDir, `${slug}.mp4`);
await fs.writeFile(file, Buffer.from(out.video.split(",")[1], "base64"));
await fs.writeFile(file.replace(/\.mp4$/, ".report.json"), JSON.stringify({ render: out.render, cost: out.cost }, null, 2));
console.log(`✔ ${file} · ${out.render.durationSec}s · audio=${out.render.quality.audio} · productReady=${out.render.quality.productReady}`);
for (const s of out.render.shotReport) console.log(`  shot ${s.shot}: ${s.visualSource} [${s.renderMode}]${s.productionNotes.length ? " — " + s.productionNotes.join("; ") : ""}`);
for (const w of out.render.quality.warnings) console.log(`  warn: ${w}`);
console.log(`  reserved spend: $${out.render.budget.reservedUsd} (worst-case basis) · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
