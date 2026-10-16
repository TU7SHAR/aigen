/**
 * LIVE provider tests — the ONLY script that may spend money, and only with
 * an explicit `--confirm`. Without it, it prints the plan + caps and exits.
 *
 *   node scripts/live-test.mjs modal-health            # free: CPU-only probe (404 until worker is redeployed)
 *   node scripts/live-test.mjs image --confirm         # ONE Gemini keyframe for BhavishAI (cap $0.10)
 *   node scripts/live-test.mjs modal-clip --confirm    # ONE 3s Modal clip (cap $0.30)
 *   node scripts/live-test.mjs veo-clip --confirm      # ONE 4s Veo 3.1 Fast clip (cap $1.00)
 *
 * Caps are set IN-PROCESS for this run only (nothing in .env files changes),
 * and enforced by the fail-closed per-job budget guard before any request.
 * Secrets are read from .env.development via @next/env and never printed.
 */
import nextEnv from "@next/env";
import { promises as fs } from "node:fs";
import path from "node:path";

nextEnv.loadEnvConfig(process.cwd(), true);

const mode = process.argv[2];
const confirmed = process.argv.includes("--confirm");
const OUT = path.join(process.cwd(), "demo-output", "live");

const PLANS = {
  image: {
    what: "1 Gemini image keyframe (BhavishAI hook shot) → composed into a short 9:16 ad",
    env: {
      IMAGE_PROVIDER: "gemini", ENABLE_PAID_IMAGE_GENERATION: "true", DISABLE_PAID_GENERATION: "false",
      JOB_MAX_PAID_IMAGES: "1", JOB_MAX_PAID_VIDEO_CLIPS: "0", JOB_MAX_USD: "0.10", DEV_SPEND_LIMIT_USD: "0.10",
      JOB_MAX_PAID_RETRIES: "0",
    },
    shots: [
      { intent: "hook", durationSec: 3, technique: "ai_image", assetHint: "none", visual: "A young Indian woman on a rooftop at night looking up from her phone at a vast star-filled sky, soft indigo and saffron light, cinematic, photoreal, shallow depth of field, vertical composition with clear space in the lower third", onScreenText: "Stop reading generic horoscopes", motion: "slow push-in" },
      { intent: "cta", durationSec: 2.5, technique: "motion_graphic", assetHint: "none", visual: "End card", onScreenText: "Start your reading", motion: "hold" },
    ],
  },
  "veo-clip": {
    what: "1 Veo 3.1 Fast clip (4s, 9:16, image-to-video from the product photo when present) for one ai_video shot",
    env: {
      IMAGE_PROVIDER: "mock", DISABLE_PAID_GENERATION: "false", VIDEO_PROVIDER: "gemini", ENABLE_PAID_GENERATION: "true",
      VIDEO_MODEL: "veo-3.1-fast", JOB_MAX_PAID_IMAGES: "0", JOB_MAX_PAID_VIDEO_CLIPS: "1", JOB_MAX_USD: "1.00",
      DEV_SPEND_LIMIT_USD: "1.00", JOB_MAX_PAID_RETRIES: "0",
    },
    shots: [
      { intent: "hook", durationSec: 4, technique: "ai_video", assetHint: "none", visual: "A young Indian woman on a city rooftop at night lowers her phone and looks up at a vast star-filled sky, constellations softly glowing, slow cinematic push-in, photoreal, warm saffron rim light", onScreenText: "Stop reading generic horoscopes", motion: "slow push-in" },
      { intent: "cta", durationSec: 2.5, technique: "motion_graphic", assetHint: "none", visual: "End card", onScreenText: "Start your reading", motion: "hold" },
    ],
  },
  "modal-clip": {
    what: "1 Modal LTX-Video clip (3s, 9:16) for one ai_video shot — no Gemini fallback",
    env: {
      IMAGE_PROVIDER: "mock", DISABLE_PAID_GENERATION: "false", VIDEO_PROVIDER: "gemini", ENABLE_PAID_GENERATION: "true",
      VIDEO_MODEL: "modal-video", JOB_MAX_PAID_IMAGES: "0", JOB_MAX_PAID_VIDEO_CLIPS: "1", JOB_MAX_USD: "0.30",
      DEV_SPEND_LIMIT_USD: "0.30", JOB_MAX_PAID_RETRIES: "0",
    },
    shots: [
      { intent: "hook", durationSec: 3, technique: "ai_video", assetHint: "none", visual: "Slow cinematic push-in on a star-filled night sky over a quiet city rooftop, constellations faintly glowing, photoreal", onScreenText: "Your stars, read properly", motion: "slow push-in" },
      { intent: "cta", durationSec: 2.5, technique: "motion_graphic", assetHint: "none", visual: "End card", onScreenText: "Start your reading", motion: "hold" },
    ],
  },
};

async function modalHealth() {
  const ep = process.env.MODAL_VIDEO_ENDPOINT || "";
  if (!ep) return console.log("MODAL_VIDEO_ENDPOINT missing.");
  const url = process.env.MODAL_HEALTH_ENDPOINT || ep.replace(/videoworker-generate/, "health");
  const res = await fetch(url, { method: "GET" }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }));
  const text = await res.text();
  console.log(`health ${res.status}: ${text.slice(0, 300)}`);
  if (res.status === 404) console.log("→ The deployed worker predates the health endpoint. Run `modal deploy modal/video_worker.py` to deploy the i2v + auth-fixed worker.");
}

async function main() {
  if (mode === "modal-health") return modalHealth();
  const plan = PLANS[mode];
  if (!plan) {
    console.log("usage: node scripts/live-test.mjs <modal-health|veo-clip|modal-clip|image> [--confirm]");
    process.exit(2);
  }
  Object.assign(process.env, plan.env);
  const { getProviderStatus } = await import("../lib/ai/providerStatus.js");
  const status = await getProviderStatus();
  console.log(`PLAN: ${plan.what}`);
  console.log(`image: ${status.image.provider}/${status.image.model} real=${status.image.real}`);
  console.log(`scene video: ${status.sceneVideo.provider}/${status.sceneVideo.model} real=${status.sceneVideo.real}`);
  console.log(`caps: job $${status.budget.maxUsd} · ≤${status.budget.maxImages} img · ≤${status.budget.maxVideoClips} clip · retries ${status.budget.maxRetries}`);
  if (!confirmed) {
    console.log("NOT RUN — add --confirm to execute this paid test.");
    return;
  }

  const { runGenerate } = await import("../lib/api/generateCore.js");
  const body = {
    productName: "BhavishAI", brand: "BhavishAI",
    description: "Personalized Vedic astrology guidance powered by AI — precise, private, always available.",
    offer: "Guidance Membership from ₹299/month", cta: "Start your reading",
    entityType: "saas", format: "screen_demo", template: "problem-solution",
    aspectRatio: "9:16", resolution: "720p", durationSeconds: 6,
    productProfile: { canonicalUrl: "https://bhavishai.in", brandColors: ["#2b1a6e", "#ff8a3d"] },
    concept: { title: "From generic to genuinely yours", centralMessage: "Vedic precision for your life" },
    storyboard: { origin: "ai", logline: "Guidance that is actually yours.", totalDurationSec: 5.5, shots: plan.shots },
  };
  const t0 = Date.now();
  const { status: code, body: out } = await runGenerate(body);
  if (code !== 200 || !out.video) {
    console.log(`FAILED ${code}: ${out.error || "no video"}`);
    console.log(JSON.stringify(out.render?.budget || out.preflight || {}, null, 2).slice(0, 1500));
    process.exit(1);
  }
  await fs.mkdir(OUT, { recursive: true });
  const file = path.join(OUT, `bhavishai-${mode}.mp4`);
  await fs.writeFile(file, Buffer.from(out.video.split(",")[1], "base64"));
  const report = { mode, ms: Date.now() - t0, shotReport: out.render.shotReport, quality: out.render.quality, budget: out.render.budget };
  await fs.writeFile(file.replace(/\.mp4$/, ".report.json"), JSON.stringify(report, null, 2));
  console.log(`✔ ${file}`);
  for (const s of out.render.shotReport) console.log(`  shot ${s.shot}: ${s.visualSource}${s.productionNotes.length ? " — " + s.productionNotes.join("; ") : ""}`);
  console.log(`  reserved spend: $${out.render.budget.reservedUsd} (worst-case basis)`);
}

main().catch((e) => { console.error(e?.message || e); process.exit(1); });
