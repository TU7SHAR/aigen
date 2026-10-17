/**
 * Compositor orchestrator — the production engine.
 *
 * compiled plan + request → per-shot media (generated in PARALLEL through the
 * auto-switching model router) + voiceover/music (generated CONCURRENTLY with
 * the footage) → exact copy overlays → finished MP4 (lib/render/screenRenderer).
 *
 * Every paid call runs under the job's fail-closed budget. Each shot records
 * the requested technique, what was actually produced, which model made it
 * (and every model that was skipped or failed first, with the reason), and
 * whether it came from the media cache. Nothing is presented as AI output
 * unless a real provider returned it.
 */

import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import sharp from "sharp";
import { frameSize, probe, probeStreams } from "./ffmpeg.js";
import { renderScreenAd, computeTimeline, pickFps, isTallScreenImage } from "./screenRenderer.js";
import { getImageProvider } from "../ai/imageProviderIndex.js";
import { getAudioProviders } from "../ai/audioProvider.js";
import { generateSceneClip, sceneVideoBlocker } from "../ai/index.js";
import { createJobBudget } from "../costs/jobBudget.js";
import { getImageModel } from "../config.js";
import { dataPath } from "../store/fileStore.js";
import { normalizeLanguageProfile, voiceStyleFor, profileCacheKey, describeProfile } from "../i18n/profile.js";

const PUBLIC_IMPORTED = path.join(process.cwd(), "public", "imported-assets");

/** Resolve an asset url/ref to an on-disk readable image path (or null). */
async function resolveImagePath(ref) {
  if (!ref) return null;
  const url = typeof ref === "string" ? ref : ref.url || ref.storedUrl || ref.sourceUrl;
  if (!url) return null;
  // Only locally stored imported assets are rendered (no remote fetch: SSRF).
  if (!url.startsWith("/imported-assets/")) return null;
  const safe = path.basename(url);
  if (safe.toLowerCase().endsWith(".svg")) return null;
  const full = path.join(PUBLIC_IMPORTED, safe);
  try {
    await fs.access(full);
    return full;
  } catch {
    return null;
  }
}

/** User-selected real images (primary first), de-duplicated, with roles. */
async function collectImagePaths(input) {
  const entries = [];
  if (Array.isArray(input.referenceAssets) && input.referenceAssets.length) {
    const primaryFirst = [...input.referenceAssets].sort((a, b) => (b.primary ? 1 : 0) - (a.primary ? 1 : 0));
    for (const a of primaryFirst) entries.push({ url: a.url, role: a.role || null });
  } else if (input.referenceAssetUrl) {
    entries.push({ url: input.referenceAssetUrl, role: input.referenceAssetRole || null });
  }
  if (Array.isArray(input.galleryUrls)) for (const u of input.galleryUrls) entries.push({ url: u, role: null });
  const seen = new Set();
  const paths = [];
  const meta = [];
  for (const e of entries) {
    if (!e.url || seen.has(e.url)) continue;
    seen.add(e.url);
    const p = await resolveImagePath(e.url);
    if (p) {
      paths.push(p);
      meta.push({ role: e.role, url: e.url });
    }
  }
  return { paths, meta };
}

/** Legacy (non-storyboard) overlays: exact verified copy only. */
function buildOverlays(input, brief, totalDur) {
  const overlays = [];
  const brand = (input.brand || brief?.brand?.name || input.productName || "").trim();
  const headline = (brief?.conceptCentralMessage || input.offering || input.description || "").trim();
  const offer = (input.offer || "").trim();
  const url = extractUrl(input);
  const cta = (input.cta || "").trim();
  if (brand) overlays.push({ kind: "brand", text: brand, start: 0, end: totalDur });
  if (headline) overlays.push({ kind: "headline", text: headline, start: 0.3, end: Math.max(1.2, totalDur * 0.6) });
  if (offer) overlays.push({ kind: "offer", text: offer, start: totalDur * 0.45, end: totalDur });
  const endStart = Math.max(0.5, totalDur * 0.66);
  if (cta) overlays.push({ kind: "cta", text: cta, start: endStart, end: totalDur });
  if (url) overlays.push({ kind: "url", text: url, start: endStart, end: totalDur });
  return overlays;
}

function buildShotOverlays(scenes) {
  const overlays = [];
  let t = 0;
  for (const s of scenes) {
    const dur = Number(s.durationSec) || 2.5;
    const text = (s.onScreenText || "").trim();
    if (text) overlays.push({ kind: "shot", text, start: t + Math.min(0.3, dur * 0.1), end: t + dur - Math.min(0.2, dur * 0.1) });
    t += dur;
  }
  return overlays;
}

/** Readable on-screen destination (host + short path) from the verified site. */
function extractUrl(input) {
  const pp = input.productProfile || {};
  const raw = input.destinationUrl || pp.canonicalUrl || pp.sourceUrl || input.websiteUrl || null;
  if (!raw) return null;
  try {
    const u = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
    const host = u.hostname.replace(/^www\d?\./, "");
    const p = u.pathname !== "/" ? u.pathname.replace(/\/$/, "") : "";
    return p && p.length <= 14 ? host + p : host;
  } catch {
    return typeof raw === "string" ? raw.slice(0, 60) : null;
  }
}

const GENERATIVE_TECHNIQUES = new Set(["ai_image", "ai_video"]);

/** Map scenePlan scenes → render scenes, honouring each shot's technique. */
function buildScenes(scenePlan, imagePaths, brief, assetMeta = []) {
  const planned = scenePlan?.scenes?.length ? scenePlan.scenes : [{ purpose: "establish", duration: 3, motion: "controlled" }];
  const scenes = [];
  let realCursor = 0;
  for (let i = 0; i < planned.length; i++) {
    const s = planned[i];
    const requestedTechnique = s.technique || null;
    const durationSec = Number(s.duration) || Math.max(1.5, (scenePlan?.totalDuration || 6) / planned.length);
    let executedMethod;
    let imagePath = null;
    let downgradedFrom = null;
    const generated = s.generatedImagePath || null;
    const generatedVideo = s.generatedVideoPath || null;
    let videoPath = null;
    if (requestedTechnique && GENERATIVE_TECHNIQUES.has(requestedTechnique)) {
      if (generatedVideo) {
        videoPath = generatedVideo;
        imagePath = generated;
        executedMethod = "ai_video";
      } else if (generated) {
        imagePath = generated;
        executedMethod = s.keyframeMock ? "placeholder_keyframe" : "ai_image";
        if (requestedTechnique === "ai_video" || s.keyframeMock) downgradedFrom = requestedTechnique;
      } else {
        downgradedFrom = requestedTechnique;
        const pick = pickRealImage(s, imagePaths, assetMeta, realCursor);
        imagePath = pick.path;
        if (pick.path) realCursor = pick.nextCursor;
        executedMethod = pick.path ? "real_asset" : "motion_graphic";
      }
    } else if (requestedTechnique === "motion_graphic") {
      executedMethod = "motion_graphic";
    } else {
      const pick = pickRealImage(s, imagePaths, assetMeta, realCursor);
      imagePath = pick.path;
      if (pick.path) realCursor = pick.nextCursor;
      executedMethod = pick.path ? requestedTechnique || "real_asset" : "motion_graphic";
    }
    scenes.push({
      imagePath, videoPath, durationSec,
      motion: s.motion, purpose: s.purpose, kenBurns: s.kenBurns,
      intent: s.intent || s.purpose || null,
      requestedTechnique, executedMethod, downgradedFrom,
      onScreenText: typeof s.onScreenText === "string" ? s.onScreenText.trim() : "",
      voiceover: typeof s.voiceover === "string" ? s.voiceover.trim() : "",
      transitionOut: s.transitionOut || null,
      firstFrame: s.firstFrame || null,
      assetHint: s.assetHint || null,
      keyframeProvider: s.keyframeProvider || null,
      keyframeModel: s.keyframeModel || null,
      keyframeMock: s.keyframeMock ?? null,
      videoProvider: s.videoProvider || null,
      videoModel: s.videoModel || null,
      modelAttempts: s.modelAttempts || [],
      fromCache: Boolean(s.fromCache),
      productionNotes: Array.isArray(s.productionNotes) ? s.productionNotes : [],
    });
  }
  return scenes;
}

function pickRealImage(shot, imagePaths, assetMeta, cursor) {
  if (!imagePaths.length) return { path: null, nextCursor: cursor };
  const idx = roleMatchIndex(shot, assetMeta);
  if (idx !== -1 && imagePaths[idx]) return { path: imagePaths[idx], nextCursor: cursor };
  const p = imagePaths[cursor % imagePaths.length];
  return { path: p, nextCursor: cursor + 1 };
}

/** Index of the asset whose role matches the shot's assetHint (or -1). */
function roleMatchIndex(shot, assetMeta) {
  const hint = String(shot?.assetHint || "").toLowerCase().trim();
  if (!hint || hint === "none" || !Array.isArray(assetMeta)) return -1;
  return assetMeta.findIndex((m) => {
    const role = typeof m?.role === "string" ? m.role.toLowerCase() : "";
    return role && (role.includes(hint) || hint.includes(role));
  });
}

const VIDEO_NEGATIVE_PROMPT =
  "text, captions, subtitles, words, letters, watermark, logo, letterbox, black bars, borders, split screen, distorted hands, extra fingers, warped face, flicker";

const CRAFT = "Premium commercial cinematography: natural motivated light, realistic skin and material textures, shallow depth of field, smooth stabilised camera motion, clean modern colour grade.";

/** Shot → video-model prompt (English): visual + camera + craft + hard rules. */
function videoPrompt(s, aspectRatio) {
  const vertical = aspectRatio === "9:16";
  const mentionsScreen = /\b(dashboard|interface|ui|app|website|screen|laptop|tablet|monitor|phone|smartphone)\b/i.test(s.visual || "");
  return [
    s.visual || s.intent || "",
    s.camera ? `Camera: ${s.camera}.` : "",
    CRAFT,
    vertical ? "Vertical 9:16 composition that fills the frame edge to edge; no letterboxing or black bars." : "Full-frame 16:9 composition; no letterboxing or black bars.",
    mentionsScreen ? "Any device screen faces away from the camera or is completely out of focus; never show an interface." : "",
    "No readable text, captions, logos or UI in frame.",
    "Audio: natural ambient sound and subtle foley only; no speech, no dialogue, no music.",
  ].filter(Boolean).join(" ");
}

/** Rephrased prompt for ONE retry after an unbilled safety block. */
function videoPromptSafe(s, aspectRatio) {
  const visual = String(s.visual || s.intent || "")
    .replace(/\b(talk(s|ing)?|speak(s|ing)?|say(s|ing)?|shout(s|ing)?|laugh(s|ing)?|whisper(s|ing)?|nod(s|ding)?( in [a-z]+)?)\b/gi, "")
    .replace(/\s{2,}/g, " ").trim();
  return [
    visual,
    aspectRatio === "9:16" ? "Vertical 9:16 full-frame composition, no black bars." : "Full-frame composition, no black bars.",
    "Any device screen faces away from the camera or is out of focus.",
    "No text or logos in frame. Quiet scene with soft natural room tone.",
  ].join(" ");
}

/** Image-to-video from a REAL product photo: only camera/light motion. */
function productVideoPrompt(s) {
  return [
    "Animate this exact product photograph as a premium commercial product shot.",
    `Camera: ${s.camera && !/static/i.test(s.camera) ? s.camera : "slow cinematic push-in"}.`,
    "Subtle realistic motion only: a soft light sweep and reflections gliding across the product, gentle atmospheric depth, slight parallax in the background.",
    "Keep the product, packaging, label, logo and every printed word exactly as in the image; do not redraw, add or remove objects.",
    "Audio: soft ambient tone only; no speech, no music.",
  ].join(" ");
}

const sha = (data) => crypto.createHash("sha256").update(String(data)).digest("hex");
const mediaKey = (obj) => sha(JSON.stringify(obj)).slice(0, 40);

/** Media cache dir (on by default; MEDIA_CACHE=off disables). */
function cacheDir() {
  if (process.env.MEDIA_CACHE === "off") return null;
  return process.env.SCENE_MEDIA_CACHE_DIR || dataPath("media-cache", ".keep").replace(/[\\/]\.keep$/, "");
}
async function fromCache(key, ext, dest) {
  const dir = cacheDir();
  if (!dir) return null;
  try {
    await fs.copyFile(path.join(dir, `${key}.${ext}`), dest);
    const side = await fs.readFile(path.join(dir, `${key}.json`), "utf8").then(JSON.parse).catch(() => ({}));
    return side || {};
  } catch {
    return null;
  }
}
async function toCache(key, ext, src, provenance = {}) {
  const dir = cacheDir();
  if (!dir) return;
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.copyFile(src, path.join(dir, `${key}.${ext}`));
    await fs.writeFile(path.join(dir, `${key}.json`), JSON.stringify({ ...provenance, cachedAt: new Date().toISOString() }));
  } catch {
    /* cache is best-effort */
  }
}

/** Fit a real photo to the video frame as a first frame (contained over a blurred fill). */
async function firstFrameFor(file, aspectRatio) {
  try {
    const W = aspectRatio === "16:9" ? 1280 : 720;
    const H = aspectRatio === "16:9" ? 720 : 1280;
    const bg = await sharp(file).resize(W, H, { fit: "cover" }).blur(36).modulate({ brightness: 0.62 }).toBuffer();
    const fg = await sharp(file).resize(W, H, { fit: "inside" }).toBuffer();
    const out = await sharp(bg).composite([{ input: fg, gravity: "centre" }]).jpeg({ quality: 92 }).toBuffer();
    return { data: out.toString("base64"), mimeType: "image/jpeg" };
  } catch {
    return readImageForModel(file);
  }
}

async function readImageForModel(file) {
  try {
    const buf = await fs.readFile(file);
    if (buf.length > 7 * 1024 * 1024) return null;
    const ext = path.extname(file).toLowerCase();
    const mimeType = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
    return { data: buf.toString("base64"), mimeType };
  } catch {
    return null;
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

function noteAttempts(s, attempts = []) {
  s.modelAttempts = attempts;
  for (const a of attempts) {
    if (a.outcome === "skipped") s.productionNotes.push(`${a.model} skipped: ${a.reason}`);
    if (a.outcome === "failed") s.productionNotes.push(`${a.model} failed (${a.reason}${a.notCharged ? ", not billed" : ""}) — switched`);
  }
}

/**
 * Scene-media pass. Shots run in parallel (SHOT_CONCURRENCY, default 3); the
 * router serialises per-model quota so parallel shots spread across the
 * chain instead of tripping rate limits.
 */
async function generateSceneMedia(args) {
  const {
    scenePlan, imagePaths = [], assetMeta = [], width, height, brand, aspectRatio, resolution, referenceImage,
    progress = () => {}, resume = {}, onOperation, mediaDir, signal,
  } = args;
  const planned = scenePlan?.scenes || [];
  const budget = args.budget || createJobBudget();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mac-media-"));
  const cleanup = async () => { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); };
  const clonedScenes = planned.map((s) => ({ ...s, productionNotes: [] }));
  const provider = getImageProvider();
  const realImage = provider.name !== "mock";
  let generatedCount = 0;
  let generatedVideoCount = 0;
  const videoOff = sceneVideoBlocker();
  const keep = async (file, name) => {
    if (!mediaDir) return;
    try {
      await fs.mkdir(mediaDir, { recursive: true });
      await fs.copyFile(file, path.join(mediaDir, name));
    } catch { /* raw media preservation is best-effort */ }
  };

  const work = clonedScenes.map((s, i) => ({ s, i })).filter(({ s }) => s.technique === "ai_image" || s.technique === "ai_video");
  await mapLimit(work, Math.max(1, Number(process.env.SHOT_CONCURRENCY || 3)), async ({ s, i }) => {
    const label = `shot ${i + 1}`;
    const matchIdx = roleMatchIndex(s, assetMeta);
    const matchedPath = matchIdx !== -1 ? imagePaths[matchIdx] || null : null;
    if (s.technique === "ai_image" && matchedPath) {
      progress({ shot: i + 1, status: "done", message: "uses the real asset" });
      return;
    }
    progress({ shot: i + 1, status: "running", message: s.technique === "ai_video" ? "generating footage" : "generating image" });

    // Keyframe (paid image → first frame) when no real asset was pointed at.
    let kf = null;
    const needStill = s.technique === "ai_image" || (!matchedPath && realImage);
    if (needStill) {
      const kfRequest = {
        prompt: s.visual || s.intent || "", subjectText: s.onScreenText || "",
        brand, width, height, aspectRatio,
        referenceImage: referenceImage ? { data: referenceImage.data, mimeType: referenceImage.mimeType } : undefined,
        seed: i,
      };
      const kfKey = mediaKey({ kind: "kf", prompt: kfRequest.prompt, aspectRatio, ref: referenceImage ? sha(referenceImage.data).slice(0, 16) : null, real: realImage });
      const file = path.join(dir, `kf_${i}.png`);
      try {
        const cached = realImage ? await fromCache(kfKey, "png", file) : null;
        if (cached) {
          kf = { imageBase64: (await fs.readFile(file)).toString("base64"), mimeType: "image/png", provider: cached.provider || "gemini", model: cached.model || null, mock: false };
          s.fromCache = true;
          s.productionNotes.push("keyframe reused from the media cache (no new paid call)");
        } else {
          kf = await provider.generateKeyframe(kfRequest, { budget, label: `${label} keyframe`, signal });
          await fs.writeFile(file, Buffer.from(kf.imageBase64, "base64"));
          if (!kf.mock) await toCache(kfKey, "png", file, { provider: kf.provider, model: kf.model });
          if (kf.attempts) noteAttempts(s, kf.attempts);
        }
        s.generatedImagePath = file;
        s.keyframeProvider = kf.provider;
        s.keyframeModel = kf.model || null;
        s.keyframeMock = Boolean(kf.mock);
        generatedCount++;
        if (!kf.mock) await keep(file, `shot${i + 1}_keyframe.png`);
        if (provider.fallbackReason) s.productionNotes.push(provider.fallbackReason);
      } catch (err) {
        s.productionNotes.push(`keyframe failed: ${String(err?.message || err).slice(0, 200)}`);
        if (err?.attempts) noteAttempts(s, err.attempts);
      }
    }

    if (s.technique !== "ai_video") {
      progress({ shot: i + 1, status: kf ? "done" : "failed", message: kf ? "image ready" : "image failed" });
      return;
    }
    if (videoOff) {
      s.productionNotes.push(`video not generated: ${videoOff}`);
      progress({ shot: i + 1, status: "skipped", message: "paid video is off" });
      return;
    }
    const durationSeconds = Math.max(2, Math.ceil(Number(s.duration) || 3));
    let still = null;
    let productFirstFrame = false;
    if (matchedPath) {
      still = await firstFrameFor(matchedPath, aspectRatio);
      if (still) {
        s.firstFrame = "real_asset";
        productFirstFrame = true;
        s.productionNotes.push("animated from the real product photo (first frame); label fidelity is not guaranteed in motion — check the frames");
      }
    } else if (kf && !kf.mock) {
      still = { data: kf.imageBase64, mimeType: kf.mimeType };
      s.firstFrame = "ai_keyframe";
    }
    if (!still) s.firstFrame = "none (text-to-video)";
    const request = {
      prompt: productFirstFrame ? productVideoPrompt(s) : videoPrompt(s, aspectRatio),
      negativePrompt: VIDEO_NEGATIVE_PROMPT,
      image: still || undefined,
      aspectRatio,
      resolution,
      durationSeconds,
    };
    const file = path.join(dir, `clip_${i}.mp4`);
    // Model-independent key: a clip made by any model for the same request is reused.
    const cacheKey = mediaKey({ kind: "clip", prompt: request.prompt, aspectRatio, resolution, durationSeconds, image: still ? sha(still.data) : null });
    const cached = await fromCache(cacheKey, "mp4", file);
    if (cached) {
      s.generatedVideoPath = file;
      s.videoProvider = cached.provider || "cache";
      s.videoModel = cached.model || null;
      s.fromCache = true;
      s.productionNotes.push(`footage reused from the media cache (made by ${cached.model || "an earlier run"}; no new paid call)`);
      generatedVideoCount++;
      await keep(file, `shot${i + 1}_clip.mp4`);
      progress({ shot: i + 1, status: "done", message: "reused cached footage", model: cached.model || null });
      return;
    }
    try {
      const routed = await generateSceneClip({
        request,
        safePrompt: productFirstFrame ? undefined : videoPromptSafe(s, aspectRatio),
        budget,
        label,
        signal,
        resume: resume[i] || null,
        onOperation: (name, meta) => onOperation?.(i, name, meta),
        onEvent: (evt) => {
          if (evt.type === "attempt") progress({ shot: i + 1, status: "running", message: `generating with ${evt.model}${evt.safe ? " (rephrased)" : ""}`, model: evt.model });
          if (evt.type === "waiting") progress({ shot: i + 1, status: "waiting", message: `waiting ${Math.ceil(evt.waitMs / 1000)}s for ${evt.model} (${evt.reason})`, model: evt.model });
          if (evt.type === "failed") progress({ shot: i + 1, status: "running", message: `${evt.model}: ${evt.reason} — trying the next model`, model: evt.model });
        },
      });
      noteAttempts(s, routed.attempts);
      const clip = routed.clip;
      await fs.writeFile(file, Buffer.from(clip.videoBase64, "base64"));
      await toCache(cacheKey, "mp4", file, { provider: clip.provider, model: routed.model, operationName: clip.operationName || null });
      await keep(file, `shot${i + 1}_clip.mp4`);
      s.generatedVideoPath = file;
      s.videoProvider = clip.provider;
      s.videoModel = routed.model;
      s.videoCostUsd = clip.cost?.amountUsd ?? null;
      if (routed.switched) s.productionNotes.push(`made with ${routed.model} after automatic model switching`);
      if (routed.resumed) s.productionNotes.push(`recovered the already-generated clip from ${routed.model} (no new paid call)`);
      generatedVideoCount++;
      progress({ shot: i + 1, status: "done", message: `footage ready (${routed.model})`, model: routed.model });
    } catch (err) {
      if (err?.attempts) noteAttempts(s, err.attempts);
      s.productionNotes.push(`video failed: ${String(err?.message || err).slice(0, 220)}`);
      if (err?.operationName) s.pendingOperation = { operationName: err.operationName, model: err.attempts?.slice(-1)[0]?.model || null };
      progress({ shot: i + 1, status: "failed", message: String(err?.message || err).slice(0, 160) });
    }
  });

  return {
    scenePlan: { ...scenePlan, scenes: clonedScenes },
    generatedCount,
    generatedVideoCount,
    budget,
    dir,
    imageProvider: { name: provider.name, model: provider.name === "gemini" ? getImageModel() : "mock-gradient", real: realImage, fallbackReason: provider.fallbackReason || null },
    cleanup,
  };
}

/** Voiceover script from the plan (before footage exists). */
function planScript(scenePlan) {
  return (scenePlan?.scenes || []).map((s) => (typeof s.voiceover === "string" ? s.voiceover.trim() : "")).filter(Boolean).join(" ");
}

function voiceStyle(scenePlan, input, brief, language) {
  const base = scenePlan?.voiceStyle || brief?.brand?.toneOfVoice || "confident, warm, trustworthy";
  return voiceStyleFor(language, `${base}; polished social-media ad narrator with energy, brisk natural pace, no long pauses`);
}

function musicPrompt(scenePlan, input, brief, brandName, totalSec) {
  const mood = scenePlan?.music || brief?.brand?.toneOfVoice || "modern, uplifting, premium";
  const what = input.description || brief?.conceptCentralMessage || input.productName || brandName || "a product";
  return `Instrumental only, absolutely no vocals or singing. Background score for a ${Math.round(totalSec)}-second vertical social video ad for ${brandName || "a brand"} (${String(what).slice(0, 140)}). Mood: ${mood}. Strong, clean intro in the first second, steady build, polished modern production, gentle resolved ending. Leave space for a voiceover.`;
}

/**
 * Audio pass — runs CONCURRENTLY with the footage: one voiceover read of the
 * Director's script (in the language profile) and one instrumental bed.
 */
async function produceAudio({ scenePlan, input, brief, brandName, budget, dir, language, progress = () => {}, mediaDir, signal }) {
  const report = { voiceover: null, music: null, notes: [] };
  const { voice, music, reasons } = getAudioProviders({ language });
  if (!voice && !music) {
    report.notes.push(`no voiceover/music: ${reasons.join("; ")}`);
    return { report };
  }
  const totalSec = (scenePlan?.scenes || []).reduce((a, s) => a + (Number(s.duration) || 0), 0) || 12;
  const script = planScript(scenePlan);
  const keep = async (file, name) => {
    if (!mediaDir) return;
    try { await fs.mkdir(mediaDir, { recursive: true }); await fs.copyFile(file, path.join(mediaDir, name)); } catch { /* best effort */ }
  };

  const voTask = (async () => {
    if (!voice) return {};
    if (!script) {
      report.notes.push("no voiceover: the storyboard has no voiceover lines");
      return {};
    }
    progress({ stage: "audio", status: "running", message: "recording voiceover" });
    try {
      const style = voiceStyle(scenePlan, input, brief, language);
      // Language-separated key: a different language/script/voice never reuses an old take.
      const key = mediaKey({ kind: "vo", chain: voice.chain, voice: voice.voice, script, style, lang: profileCacheKey(language) });
      let file = path.join(dir, "voiceover.wav");
      let vo = null;
      const cached = await fromCache(key, "wav", file);
      if (!cached) {
        vo = await voice.generate({ text: script, style }, { budget, label: "voiceover", signal });
        if (/mpeg|mp3/.test(vo.mimeType || "")) file = path.join(dir, "voiceover.mp3");
        await fs.writeFile(file, Buffer.from(vo.audioBase64, "base64"));
        if (file.endsWith(".wav")) await toCache(key, "wav", file, { model: vo.model, voice: vo.voice });
      }
      await keep(file, path.basename(file));
      const durationSec = (await probeStreams(file)).audioDurationSec || 0;
      report.voiceover = {
        provider: "gemini-tts", model: vo?.model || cached?.model || voice.model, voice: voice.voice, script, style,
        language: describeProfile(language), durationSec: Number(durationSec.toFixed(2)), cached: Boolean(cached),
        attempts: vo?.attempts || [],
      };
      return { voiceoverPath: file, voDurationSec: durationSec };
    } catch (err) {
      report.notes.push(`voiceover failed: ${String(err?.message || err).slice(0, 200)}`);
      return {};
    }
  })();

  const musicTask = (async () => {
    if (!music) return {};
    progress({ stage: "audio", status: "running", message: "composing music" });
    try {
      const prompt = musicPrompt(scenePlan, input, brief, brandName, totalSec);
      const key = mediaKey({ kind: "music", chain: music.chain, prompt });
      let file = path.join(dir, "music.mp3");
      let mu = null;
      const cached = await fromCache(key, "mp3", file);
      if (!cached) {
        mu = await music.generate({ prompt }, { budget, label: "music", signal });
        if (/wav/.test(mu.mimeType || "")) file = path.join(dir, "music.wav");
        await fs.writeFile(file, Buffer.from(mu.audioBase64, "base64"));
        if (file.endsWith(".mp3")) await toCache(key, "mp3", file, { model: mu.model });
      }
      await keep(file, path.basename(file));
      report.music = { provider: "lyria", model: mu?.model || cached?.model || music.model, cached: Boolean(cached), attempts: mu?.attempts || [] };
      return { musicPath: file };
    } catch (err) {
      report.notes.push(`music failed: ${String(err?.message || err).slice(0, 200)}`);
      return {};
    }
  })();

  const [vo, mu] = await Promise.all([voTask, musicTask]);
  progress({ stage: "audio", status: "done", message: [vo.voiceoverPath ? "voiceover ready" : null, mu.musicPath ? "music ready" : null].filter(Boolean).join(", ") || "no audio" });
  return { ...vo, ...mu, report };
}

/** Human-readable, provenance-accurate source of a shot's visual. */
function visualSourceOf(s) {
  if (s.executedMethod === "ai_video") return `AI video (${s.videoModel || s.videoProvider}${s.firstFrame ? `, first frame: ${s.firstFrame}` : ""}${s.fromCache ? ", cached" : ""})`;
  if (s.executedMethod === "ai_image") return `AI image (${s.keyframeModel || s.keyframeProvider})`;
  if (s.executedMethod === "placeholder_keyframe") return "MOCK placeholder keyframe (not AI)";
  if (s.imagePath) return "real source asset";
  return "branded end card (deterministic)";
}

const END_INTENT = /\b(cta|call.?to.?action|end|ending|close|closing|outro|sign.?off|final)\b/i;

function hexToHsl(hex) {
  const m = String(hex || "").trim().match(/^#?([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return { hex: `#${m[1].toLowerCase()}`, s, l };
}

function darken(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const f = (v) => Math.max(0, Math.min(255, Math.round(v * (1 - k))));
  return `#${((1 << 24) + (f((n >> 16) & 255) << 16) + (f((n >> 8) & 255) << 8) + f(n & 255)).toString(16).slice(1)}`;
}

/** { base, accent } from all brand colour evidence (product photo colour wins). */
function pickBrandColors(input, brief, productColor = null) {
  const pool = [
    ...(brief?.brand?.colors || []),
    ...(input.productProfile?.brandColors || []),
    ...(input.designProfile?.palette?.accent || []),
    ...(input.designProfile?.palette?.all || []),
    ...(input.brandProfile?.primaryColors || []),
  ].map(hexToHsl).filter(Boolean);
  const seen = new Set();
  const uniq = pool.filter((c) => (seen.has(c.hex) ? false : (seen.add(c.hex), true)));
  const vivid = uniq.filter((c) => c.s >= 0.35 && c.l >= 0.25 && c.l <= 0.75).sort((a, b) => b.s - a.s);
  const accent = productColor || vivid[0]?.hex || null;
  const base = accent ? darken(accent, 0.62) : uniq[0]?.hex || null;
  return { base, accent };
}

/** Dominant vivid colour of a product photo (hue-binned), or null. */
async function vividColorFromImage(file) {
  try {
    const { data, info } = await sharp(file).resize(48, 48, { fit: "inside" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const bins = Array.from({ length: 12 }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
    let total = 0;
    for (let i = 0; i < data.length; i += info.channels) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      total++;
      const hsl = hexToHsl(`#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`);
      if (!hsl || hsl.s < 0.45 || hsl.l < 0.3 || hsl.l > 0.72) continue;
      const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min || 1;
      let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h = (h * 60 + 360) % 360;
      const bin = bins[Math.floor(h / 30) % 12];
      bin.w += hsl.s; bin.r += r * hsl.s; bin.g += g * hsl.s; bin.b += b * hsl.s;
    }
    const best = bins.reduce((a, b) => (b.w > a.w ? b : a));
    if (!total || best.w / total < 0.015) return null;
    const c = (v) => Math.round(v / best.w);
    return `#${((1 << 24) + (c(best.r) << 16) + (c(best.g) << 8) + c(best.b)).toString(16).slice(1)}`;
  } catch {
    return null;
  }
}

/** Is scene i the closing card (brand title + CTA pill + URL)? */
function isEndCard(scenes, i) {
  if (i !== scenes.length - 1 || scenes.length < 2) return false;
  const s = scenes[i];
  return !s.imagePath && !s.videoPath && (END_INTENT.test(s.intent || "") || s.executedMethod === "motion_graphic");
}

/** Minimum readable time for a caption (≈ 15 chars/s + 0.6 s). */
export function minReadSeconds(text) {
  return Number((0.6 + [...String(text || "")].length / 15).toFixed(2));
}

/**
 * Storyboard overlays timed to the composed timeline (variable transitions).
 * The closing card gets brand title + CTA pill (+ verified offer) + URL.
 */
function buildStoryboardOverlays(scenes, input, brief) {
  const brand = (input.brand || brief?.brand?.name || input.productName || "").trim();
  const url = extractUrl(input);
  const offer = (input.offer || "").trim();
  const tl = computeTimeline(scenes, pickFps(scenes));
  const overlays = [];
  const lastIdx = scenes.length - 1;
  const endCard = isEndCard(scenes, lastIdx);
  if (brand) overlays.push({ kind: "brand", text: brand, start: 0, end: endCard ? tl.starts[lastIdx] + 0.1 : tl.total });
  scenes.forEach((s, i) => {
    const inX = i === 0 ? 0.15 : (tl.xfades[i - 1]?.d || 0) * 0.6;
    const start = tl.starts[i] + inX;
    const end = i === lastIdx ? tl.total : tl.starts[i + 1] + (tl.xfades[i]?.d || 0) * 0.4;
    const text = (s.onScreenText || "").trim();
    if (i === lastIdx && endCard) {
      if (brand) overlays.push({ kind: "brandTitle", text: brand, start, end });
      if (offer && offer.toLowerCase() !== text.toLowerCase()) overlays.push({ kind: "offer", text: offer, start: start + 0.15, end });
      const cta = text || (input.cta || "").trim();
      if (cta) overlays.push({ kind: "cta", text: cta, start: start + 0.3, end });
      if (url) overlays.push({ kind: "url", text: url, start: start + 0.4, end });
      return;
    }
    if (!text) return;
    const ctaLike = i === lastIdx && END_INTENT.test(s.intent || "");
    const productFrame = s.firstFrame === "real_asset" || (s.imagePath && !s.videoPath && !s.screenStage);
    const kind = ctaLike ? "cta" : s.screenStage ? "shotTop" : productFrame ? "shotLow" : "shot";
    overlays.push({ kind, text, start, end });
    if (ctaLike && url) overlays.push({ kind: "url", text: url, start: start + 0.2, end });
  });
  return overlays;
}

/**
 * Make room for the narration (planned against the ACTUAL voiceover length):
 * a slight speed-up (≤ 1.12×) first, then lengthen shots that have real
 * material to spare, then hold the closing card. Never cuts the narration.
 */
async function fitVoiceover(scenes, voDur, { voStart = 0.25, tail = 0.6, maxTempo = 1.12 } = {}) {
  const room = () => computeTimeline(scenes).total - voStart - tail;
  if (voDur <= room()) return 1;
  const tempo = Math.min(maxTempo, voDur / Math.max(0.5, room()));
  let overflow = voDur / tempo - room();
  const grow = (s, max) => {
    const add = Math.max(0, Math.min(overflow, max));
    s.durationSec = Number((s.durationSec + add).toFixed(2));
    overflow -= add;
  };
  for (const s of scenes) {
    if (overflow <= 0.05) break;
    if (!s.videoPath) continue;
    const clipDur = (await probe(s.videoPath)).durationSec || s.durationSec;
    grow(s, clipDur - 0.1 - s.durationSec);
  }
  for (const s of scenes) if (overflow > 0.05 && s.screenStage) grow(s, 1.5);
  const last = scenes.length - 1;
  for (let i = 0; i < last; i++) if (overflow > 0.05 && !scenes[i].videoPath && !scenes[i].screenStage) grow(scenes[i], 0.8);
  if (overflow > 0.05) grow(scenes[last], 3.5);
  return tempo;
}

/**
 * Compose a finished ad from the compiled plan + request.
 * @param {{
 *   input: object, compiled: object,
 *   ctx?: { jobId?: string, mediaDir?: string, progress?: Function, resume?: object, onOperation?: Function, signal?: AbortSignal }
 * }} args
 */
export async function composeScreenAd({ input, compiled, ctx = {} }) {
  const t0 = Date.now();
  const progress = ctx.progress || (() => {});
  const { width, height } = frameSize(input.aspectRatio, input.resolution);
  const { paths: imagePaths, meta: assetMeta } = await collectImagePaths(input);
  const brief = compiled?.brief || {};
  const scenePlan = compiled?.scenePlan;
  const storyboardOrigin = scenePlan?.storyboardOrigin || null;
  const storyboardDrove = Boolean(storyboardOrigin);
  const language = normalizeLanguageProfile(input.language || scenePlan?.language);

  const productRoleIdx = assetMeta.findIndex((m) => /hero_product|product_packshot|packshot|product/i.test(m?.role || ""));
  const productColor = productRoleIdx !== -1 ? await vividColorFromImage(imagePaths[productRoleIdx]) : null;
  const { base: brandColorHex, accent: accentHex } = pickBrandColors(input, brief, productColor);
  const brandColors = [brandColorHex, accentHex].filter(Boolean);
  const brandName = input.brand || brief?.brand?.name || input.productName || "";

  let referenceImage = input.image || null;
  if (!referenceImage && imagePaths[0]) referenceImage = await readImageForModel(imagePaths[0]);

  const budget = ctx.budget || createJobBudget({ jobId: ctx.jobId || null });
  progress({ stage: "media", status: "running", message: "generating footage and audio in parallel" });

  // Footage and audio are independent until the mix — run them together.
  const mediaPromise = generateSceneMedia({
    scenePlan, imagePaths, assetMeta, width, height,
    brand: { name: brandName, colors: brandColors },
    aspectRatio: input.aspectRatio, resolution: input.resolution, referenceImage, budget,
    progress: (p) => progress({ stage: "media", ...p }),
    resume: ctx.resume || {}, onOperation: ctx.onOperation, mediaDir: ctx.mediaDir, signal: ctx.signal,
  });
  const audioDir = await fs.mkdtemp(path.join(os.tmpdir(), "mac-audio-"));
  const audioPromise = produceAudio({
    scenePlan, input, brief, brandName, budget, dir: audioDir, language,
    progress: (p) => progress({ ...p, stage: "audio" }), mediaDir: ctx.mediaDir, signal: ctx.signal,
  });
  const [media, audio] = await Promise.all([mediaPromise, audioPromise]);
  const t1 = Date.now();

  let composed;
  let scenes;
  let overlays;
  let voiceoverTempo = 1;
  try {
    scenes = buildScenes(media.scenePlan, imagePaths, brief, assetMeta);
    for (const s of scenes) {
      if (!s.imagePath || s.videoPath) continue;
      const meta = await sharp(s.imagePath).metadata().catch(() => null);
      s.screenStage = isTallScreenImage(meta, width, height);
    }
    if (audio.voiceoverPath && audio.voDurationSec) voiceoverTempo = await fitVoiceover(scenes, audio.voDurationSec);
    if (storyboardDrove) {
      overlays = buildStoryboardOverlays(scenes, input, brief);
    } else {
      const totalDur = scenes.reduce((a, s) => a + s.durationSec, 0);
      overlays = buildOverlays(input, brief, totalDur).concat(buildShotOverlays(scenes));
    }
    progress({ stage: "render", status: "running", message: "editing and rendering the final video" });
    composed = await renderScreenAd({
      scenes, overlays, width, height, brandColorHex, accentHex,
      audio: { voiceoverPath: audio.voiceoverPath || null, voiceoverStart: 0.25, voiceoverTempo, musicPath: audio.musicPath || null },
      onStage: (st) => progress({ stage: "render", status: "running", message: st.replace(/_/g, " ") }),
    });
  } finally {
    await media.cleanup();
    await fs.rm(audioDir, { recursive: true, force: true }).catch(() => {});
  }
  const t2 = Date.now();
  const { buffer, durationSec } = composed;
  const budgetSummary = budget.summary();

  const shotReport = scenes.map((s, i) => ({
    shot: i + 1,
    intent: s.intent || s.purpose || null,
    requestedTechnique: s.requestedTechnique || "(none)",
    executedMethod: s.executedMethod,
    aiGenerated: s.executedMethod === "ai_image" || s.executedMethod === "ai_video",
    visualSource: visualSourceOf(s),
    renderMode: composed.sceneModes?.[i] || null,
    fitMode: s.fitMode || null,
    letterboxCropped: Boolean(s.cropped),
    keyframeProvider: s.keyframeProvider || null,
    keyframeModel: s.keyframeModel || null,
    keyframeMock: s.keyframeMock ?? null,
    videoProvider: s.videoProvider || null,
    videoModel: s.videoModel || null,
    modelAttempts: s.modelAttempts || [],
    fromCache: Boolean(s.fromCache),
    firstFrame: s.firstFrame || null,
    downgradedFrom: s.downgradedFrom || null,
    usedRealAsset: Boolean(s.imagePath) && !s.videoPath && (s.executedMethod === "real_asset" || s.executedMethod === "composite"),
    productionNotes: s.productionNotes || [],
    onScreenText: s.onScreenText || "",
    voiceover: s.voiceover || "",
    transitionOut: s.transitionOut || null,
    durationSec: Number(Number(s.durationSec).toFixed(2)),
    pendingOperation: media.scenePlan.scenes[i]?.pendingOperation || null,
  }));

  const visualShots = scenes.filter((s) => Boolean(s.imagePath || s.videoPath)).length;
  const placeholderShots = shotReport.filter((s) => s.executedMethod === "placeholder_keyframe").length;
  const genuineVisualShots = shotReport.filter((s) => s.usedRealAsset || s.aiGenerated).length;
  const endCards = scenes.filter((s, i) => isEndCard(scenes, i)).length;
  const emptyShots = scenes.filter((s, i) => !s.imagePath && !s.videoPath && !isEndCard(scenes, i)).length;
  const requestedVideo = shotReport.filter((s) => s.requestedTechnique === "ai_video").length;
  const producedVideo = shotReport.filter((s) => s.executedMethod === "ai_video").length;
  const audioLayers = composed.audioLayers || [];
  const quality = {
    totalShots: scenes.length,
    visualShots, genuineVisualShots, placeholderShots, emptyShots, endCards,
    realAssetShots: shotReport.filter((s) => s.usedRealAsset).length,
    aiKeyframeShots: shotReport.filter((s) => s.executedMethod === "ai_image").length,
    aiVideoShots: producedVideo,
    requestedVideoShots: requestedVideo,
    audio: audioLayers.length ? audioLayers.join("+") : "silent",
    audioDetail: audio.report,
    passed: visualShots >= 1 && emptyShots === 0,
    // Coverage only — every planned shot has real or generated visuals, no
    // placeholders, a voiceover exists. NOT a judgement of creative quality.
    coverageComplete:
      genuineVisualShots >= Math.max(1, scenes.length - endCards) && placeholderShots === 0 && audioLayers.includes("voiceover"),
    warnings: [],
  };
  if (requestedVideo > producedVideo) quality.warnings.push(`${requestedVideo - producedVideo}/${requestedVideo} requested AI-video shots were NOT generated (see shot notes) — this export is a partial result.`);
  if (placeholderShots) quality.warnings.push(`${placeholderShots}/${scenes.length} shots use MOCK placeholder keyframes, not AI-generated scenes.`);
  for (const r of shotReport) {
    if (r.downgradedFrom && r.executedMethod !== r.downgradedFrom) {
      quality.warnings.push(`Shot ${r.shot}: requested ${r.downgradedFrom}, produced ${r.visualSource}.`);
    }
  }
  if (!audioLayers.includes("voiceover")) quality.warnings.push(`No voiceover. ${audio.report.notes.join("; ")}`.trim());
  if (!audioLayers.length) quality.warnings.push("Audio track is silent.");
  if (visualShots === 0) quality.warnings.push("No shot has real footage, a real asset or a generated frame — text cards only.");
  if (emptyShots) quality.warnings.push(`${emptyShots}/${scenes.length} non-closing shots have no visual.`);
  for (const ov of composed.placedOverlays || []) {
    if (["shot", "shotLow", "shotTop", "cta"].includes(ov.kind) && ov.end - ov.start < minReadSeconds(ov.text)) {
      quality.warnings.push(`Caption "${ov.text.slice(0, 40)}" is on screen ${(ov.end - ov.start).toFixed(1)}s — less than the ~${minReadSeconds(ov.text)}s needed to read it.`);
    }
  }

  return {
    videoBase64: buffer.toString("base64"),
    buffer,
    mimeType: "video/mp4",
    durationSec, width, height, fps: composed.fps,
    usedImages: imagePaths.length,
    generatedKeyframes: media.generatedCount,
    generatedVideoClips: media.generatedVideoCount,
    imageProvider: media.imageProvider,
    budget: budgetSummary,
    paidCalls: budgetSummary.calls.length,
    overlays,
    placedOverlays: composed.placedOverlays,
    timeline: composed.timeline,
    method: "screen_demo",
    quality,
    language: { profile: language, label: describeProfile(language) },
    voiceoverTempo,
    storyboardDriven: storyboardDrove,
    storyboardOrigin,
    shotReport,
    timings: { mediaAndAudioMs: t1 - t0, renderMs: t2 - t1, ...composed.timings, totalMs: Date.now() - t0 },
  };
}

// Back-compat alias.
const generateKeyframes = generateSceneMedia;

export const _internal = {
  resolveImagePath, buildOverlays, extractUrl, buildScenes, collectImagePaths, buildShotOverlays, pickRealImage,
  generateKeyframes, generateSceneMedia, buildStoryboardOverlays, isEndCard, videoPrompt, roleMatchIndex, fitVoiceover,
};
