/**
 * Compositor orchestrator.
 *
 * Turns the compiled creative plan + the generation request into a concrete
 * render spec (scenes with REAL image paths + deterministically-timed text
 * overlays), then renders a finished MP4 via the ffmpeg screen renderer.
 *
 * This is the first RELIABLE, repeatable production path: it uses only real,
 * verified assets and exact approved copy, and spends ZERO paid generative
 * credits. If there are no usable real images, it still produces a clean
 * branded explainer (title cards) rather than inventing a fake UI.
 */

import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import { frameSize, probe, probeStreams } from "./ffmpeg.js";
import sharp from "sharp";
import { renderScreenAd, sceneStarts, XFADE, isTallScreenImage } from "./screenRenderer.js";
import { getImageProvider } from "../ai/imageProviderIndex.js";
import { getAudioProviders } from "../ai/audioProvider.js";
import { getSceneVideoProvider } from "../ai/index.js";
import { createJobBudget } from "../costs/jobBudget.js";
import { getImageModel } from "../config.js";

const PUBLIC_IMPORTED = path.join(process.cwd(), "public", "imported-assets");

/** Resolve an asset url/ref to an on-disk readable image path (or null). */
async function resolveImagePath(ref) {
  if (!ref) return null;
  const url = typeof ref === "string" ? ref : ref.url || ref.storedUrl || ref.sourceUrl;
  if (!url) return null;
  // Only locally-stored imported assets can be used by the renderer. Remote
  // URLs are not fetched here (SSRF + we only animate verified local assets).
  if (!url.startsWith("/imported-assets/")) return null;
  const safe = path.basename(url); // anti-traversal
  if (safe.toLowerCase().endsWith(".svg")) return null; // raster only for Ken Burns
  const full = path.join(PUBLIC_IMPORTED, safe);
  try {
    await fs.access(full);
    return full;
  } catch {
    return null;
  }
}

/**
 * Collect the user-selected real images (primary first), de-duplicated.
 * Returns parallel arrays: resolved on-disk `paths` and their `meta`
 * ({ role, url }) so the per-shot router can match a shot's assetHint to a role.
 * @param {object} input validated generate request
 */
async function collectImagePaths(input) {
  const entries = []; // { url, role }
  if (Array.isArray(input.referenceAssets) && input.referenceAssets.length) {
    const primaryFirst = [...input.referenceAssets].sort((a, b) => (b.primary ? 1 : 0) - (a.primary ? 1 : 0));
    for (const a of primaryFirst) entries.push({ url: a.url, role: a.role || null });
  } else if (input.referenceAssetUrl) {
    entries.push({ url: input.referenceAssetUrl, role: input.referenceAssetRole || null });
  }
  // Also honor an array of gallery urls if the client sent them.
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

/**
 * Build the overlay list (exact, verified copy only). Anything not provided is
 * simply omitted — we NEVER synthesize a price, discount, URL or claim.
 */
function buildOverlays(input, brief, totalDur) {
  const overlays = [];
  const brand = (input.brand || brief?.brand?.name || input.productName || "").trim();
  const headline = (brief?.conceptCentralMessage || input.offering || input.description || "").trim();
  const offer = (input.offer || "").trim();
  const url = extractUrl(input);
  const cta = (input.cta || "").trim();

  // Brand mark: whole video, top-left.
  if (brand) overlays.push({ kind: "brand", text: brand, start: 0, end: totalDur });

  // Headline / central message: first ~60%.
  if (headline) overlays.push({ kind: "headline", text: headline, start: 0.3, end: Math.max(1.2, totalDur * 0.6) });

  // Offer: only if the user actually provided one (no fabrication).
  if (offer) overlays.push({ kind: "offer", text: offer, start: totalDur * 0.45, end: totalDur });

  // CTA + URL on the final third.
  const endStart = Math.max(0.5, totalDur * 0.66);
  if (cta) overlays.push({ kind: "cta", text: cta, start: endStart, end: totalDur });
  if (url) overlays.push({ kind: "url", text: url, start: endStart, end: totalDur });

  return overlays;
}

/**
 * Build per-shot overlays from the storyboard's exact `onScreenText`, each
 * confined to its own shot's time window. These are the Creative Director's
 * copy for that beat — rendered deterministically, never by a model. The
 * global brand mark (from buildOverlays) still rides on top for the whole clip.
 * @param {object[]} scenes render scenes (carry onScreenText + durationSec)
 */
function buildShotOverlays(scenes) {
  const overlays = [];
  let t = 0;
  for (const s of scenes) {
    const dur = Number(s.durationSec) || 2.5;
    const text = (s.onScreenText || "").trim();
    if (text) {
      // small lead-in / tail so the copy doesn't flash exactly on the cut
      const start = t + Math.min(0.3, dur * 0.1);
      const end = t + dur - Math.min(0.2, dur * 0.1);
      overlays.push({ kind: "shot", text, start, end });
    }
    t += dur;
  }
  return overlays;
}
function extractUrl(input) {
  const pp = input.productProfile || {};
  const raw = pp.canonicalUrl || pp.sourceUrl || input.websiteUrl || null;
  if (!raw) return null;
  try {
    const u = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
    const host = u.hostname.replace(/^www\./, "");
    // On-screen URL must be readable at a glance: keep only a short path.
    const p = u.pathname !== "/" ? u.pathname.replace(/\/$/, "") : "";
    return p && p.length <= 14 ? host + p : host;
  } catch {
    return typeof raw === "string" ? raw.slice(0, 60) : null;
  }
}

// Which storyboard techniques the DETERMINISTIC compositor can execute itself.
// real_asset/composite animate a genuine image; motion_graphic is a branded
// type card. ai_image / ai_video require a model and are only honored when an
// image/video provider has already produced the frame (passed in as an asset);
// otherwise the compositor degrades to a deterministic card and REPORTS it.
const DETERMINISTIC_TECHNIQUES = new Set(["real_asset", "motion_graphic", "composite"]);
const GENERATIVE_TECHNIQUES = new Set(["ai_image", "ai_video"]);

/**
 * Map scenePlan scenes → render scenes.
 *
 * When the plan came from the AI Creative Director, each scene carries a
 * per-shot `technique`, `assetHint` and exact `onScreenText`. We HONOR those:
 *  - real_asset / composite → animate the hinted real asset (by role when we
 *    can match it, else the next available real image);
 *  - motion_graphic → a deterministic branded card (no image);
 *  - ai_image / ai_video → only if a generated frame was supplied for the shot
 *    (shot.generatedImagePath); otherwise a deterministic card + a downgrade
 *    note, so we never present a fabricated frame as real AI output.
 *
 * Each scene records `requestedTechnique` and the `executedMethod` actually
 * used, so the route can report AI-generated vs deterministic per shot.
 *
 * @param {object} scenePlan compiled scene plan (may carry storyboard shots)
 * @param {string[]} imagePaths resolved local real-image paths (primary first)
 * @param {object} brief
 * @param {object[]} [assetMeta] parallel to imagePaths: { role, url } for role matching
 */
function buildScenes(scenePlan, imagePaths, brief, assetMeta = []) {
  const planned = scenePlan?.scenes?.length ? scenePlan.scenes : [{ purpose: "establish", duration: 3, motion: "controlled" }];
  const scenes = [];
  let realCursor = 0; // round-robin pointer into the real images actually used
  for (let i = 0; i < planned.length; i++) {
    const s = planned[i];
    const requestedTechnique = s.technique || null;
    const durationSec = Number(s.duration) || Math.max(1.5, (scenePlan?.totalDuration || 6) / planned.length);

    // Decide how THIS shot is produced.
    let executedMethod;
    let imagePath = null;
    let downgradedFrom = null;

    const generated = s.generatedImagePath || null; // set only when a provider made a frame
    const generatedVideo = s.generatedVideoPath || null; // set only when a video provider made a clip
    let videoPath = null;

    if (requestedTechnique && GENERATIVE_TECHNIQUES.has(requestedTechnique)) {
      if (generatedVideo) {
        videoPath = generatedVideo;
        imagePath = generated; // keyframe kept as the fallback still
        executedMethod = "ai_video";
      } else if (generated) {
        imagePath = generated;
        // A MOCK keyframe is a deterministic placeholder, NOT AI output.
        executedMethod = s.keyframeMock ? "placeholder_keyframe" : "ai_image";
        if (requestedTechnique === "ai_video" || s.keyframeMock) downgradedFrom = requestedTechnique;
      } else {
        // No model frame available → honest deterministic fallback.
        downgradedFrom = requestedTechnique;
        const pick = pickRealImage(s, imagePaths, assetMeta, realCursor);
        imagePath = pick.path;
        if (pick.path) realCursor = pick.nextCursor;
        executedMethod = pick.path ? "real_asset" : "motion_graphic";
      }
    } else if (requestedTechnique === "motion_graphic") {
      executedMethod = "motion_graphic"; // branded card, no image
    } else {
      // real_asset / composite / unspecified → use a real asset if one exists.
      const pick = pickRealImage(s, imagePaths, assetMeta, realCursor);
      imagePath = pick.path;
      if (pick.path) realCursor = pick.nextCursor;
      executedMethod = pick.path ? requestedTechnique || "real_asset" : "motion_graphic";
    }

    scenes.push({
      imagePath,
      videoPath,
      durationSec,
      motion: s.motion,
      purpose: s.purpose,
      kenBurns: s.kenBurns,
      // Per-shot execution record + exact copy for a per-scene overlay.
      intent: s.intent || s.purpose || null,
      requestedTechnique,
      executedMethod,
      downgradedFrom,
      onScreenText: typeof s.onScreenText === "string" ? s.onScreenText.trim() : "",
      voiceover: typeof s.voiceover === "string" ? s.voiceover.trim() : "",
      firstFrame: s.firstFrame || null,
      assetHint: s.assetHint || null,
      // Keyframe provenance (set by the keyframe pass) rides along for the report.
      keyframeProvider: s.keyframeProvider || null,
      keyframeModel: s.keyframeModel || null,
      keyframeMock: s.keyframeMock ?? null,
      videoProvider: s.videoProvider || null,
      videoModel: s.videoModel || null,
      productionNotes: Array.isArray(s.productionNotes) ? s.productionNotes : [],
    });
  }
  return scenes;
}

/**
 * Choose a real image for a shot. Prefer one whose role matches the shot's
 * assetHint; otherwise take the next image in round-robin order so distinct
 * shots still get distinct frames. Returns the path (or null) and the advanced
 * cursor.
 */
function pickRealImage(shot, imagePaths, assetMeta, cursor) {
  if (!imagePaths.length) return { path: null, nextCursor: cursor };
  const hint = String(shot?.assetHint || "").toLowerCase();
  if (hint && hint !== "none" && Array.isArray(assetMeta) && assetMeta.length) {
    const idx = assetMeta.findIndex(
      (m) => m && typeof m.role === "string" && m.role.toLowerCase().includes(hint)
    );
    if (idx !== -1 && imagePaths[idx]) {
      return { path: imagePaths[idx], nextCursor: cursor };
    }
  }
  const path = imagePaths[cursor % imagePaths.length];
  return { path, nextCursor: cursor + 1 };
}

/**
 * Scene-media pass (runs BEFORE buildScenes).
 *
 * For each storyboard shot the Director marked ai_video / ai_image:
 *  - ai_video → a real video model clip. The FIRST FRAME is a real asset only
 *    when the Director pointed this shot at one (assetHint matches an asset
 *    role — e.g. the product photo), so a lifestyle shot is never forced to
 *    start on a website screenshot. Otherwise: a real generated keyframe when
 *    a paid image model is on, else pure text-to-video.
 *  - ai_image → a real asset wins when the hint matches; else a keyframe from
 *    the ImageProvider (mock placeholders are labelled as such).
 * Every paid call runs under the job's fail-closed budget. Failures are
 * recorded per shot (productionNotes) and fall back honestly.
 *
 * Returns a cloned scenePlan, counts, the temp dir (also used for audio stems)
 * and a cleanup().
 */
async function generateSceneMedia(args) {
  const { scenePlan, imagePaths = [], assetMeta = [], width, height, brand, aspectRatio, resolution, referenceImage } = args;
  const planned = scenePlan?.scenes || [];
  const budget = args.budget || createJobBudget();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mac-media-"));
  const cleanup = async () => { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); };
  const clonedScenes = planned.map((s) => ({ ...s, productionNotes: [] }));
  const provider = getImageProvider();
  const realImage = provider.name !== "mock";
  const imageCfg = budget.config;
  let generatedCount = 0;
  let generatedVideoCount = 0;

  for (let i = 0; i < clonedScenes.length; i++) {
    const s = clonedScenes[i];
    if (s.technique !== "ai_image" && s.technique !== "ai_video") continue;
    const matchIdx = roleMatchIndex(s, assetMeta);
    const matchedPath = matchIdx !== -1 ? imagePaths[matchIdx] || null : null;

    // ai_image with a real asset the Director pointed at → the real asset wins.
    if (s.technique === "ai_image" && matchedPath) continue;

    let kf = null;
    // ai_video with a hinted real asset uses that asset as its first frame; otherwise a still is made (paid keyframe → first frame; mock → fallback only).
    const needStill = s.technique === "ai_image" || !matchedPath;
    if (needStill) {
      const kfRequest = {
        prompt: s.visual || s.intent || "",
        subjectText: s.onScreenText || "",
        brand, width, height, aspectRatio,
        referenceImage: referenceImage ? { data: referenceImage.data, mimeType: referenceImage.mimeType } : undefined,
        seed: i,
      };
      try {
        kf = realImage
          ? await budget.run("image", imageCfg.imageUsdPerImage, `shot ${i + 1} keyframe`, () => provider.generateKeyframe(kfRequest))
          : await provider.generateKeyframe(kfRequest); // free placeholder (fallback still only)
        const ext = kf.mimeType === "image/jpeg" ? "jpg" : "png";
        const file = path.join(dir, `kf_${i}.${ext}`);
        await fs.writeFile(file, Buffer.from(kf.imageBase64, "base64"));
        s.generatedImagePath = file;
        s.keyframeProvider = kf.provider;
        s.keyframeModel = kf.model || null;
        s.keyframeMock = Boolean(kf.mock);
        generatedCount++;
        if (provider.fallbackReason) s.productionNotes.push(provider.fallbackReason);
      } catch (err) {
        s.productionNotes.push(`keyframe failed: ${String(err?.message || err).slice(0, 160)}`);
      }
    }

    if (s.technique !== "ai_video") continue;
    const durationSeconds = Math.max(2, Math.ceil(Number(s.duration) || 3));
    const sv = await getSceneVideoProvider({ durationSeconds });
    if (!sv.provider) {
      s.productionNotes.push(`video not generated: ${sv.reason}`);
      continue;
    }
    // First frame: the hinted real asset, else a REAL generated keyframe, else
    // none (text-to-video). A mock placeholder is never sent to a paid model.
    let still = null;
    let productFirstFrame = false;
    if (matchedPath) {
      still = await firstFrameFor(matchedPath, aspectRatio);
      if (still) {
        s.firstFrame = "real_asset";
        productFirstFrame = true;
        s.productionNotes.push("animated from the real product photo with fidelity-preserving motion (the product is not redrawn)");
      }
    } else if (kf && !kf.mock) {
      still = { data: kf.imageBase64, mimeType: kf.mimeType };
      s.firstFrame = "ai_keyframe";
    }
    if (!still) s.firstFrame = "none (text-to-video)";
    const file = path.join(dir, `clip_${i}.mp4`);
    const request = {
      prompt: productFirstFrame ? productVideoPrompt(s) : videoPrompt(s, aspectRatio),
      negativePrompt: VIDEO_NEGATIVE_PROMPT,
      image: still || undefined,
      aspectRatio,
      resolution,
      durationSeconds,
    };
    // Opt-in cache (SCENE_MEDIA_CACHE_DIR): an unchanged shot is never paid twice.
    const cacheKey = mediaKey({ model: sv.model, ...request, image: still ? sha(still.data) : null });
    if (await fromCache(cacheKey, "mp4", file)) {
      s.generatedVideoPath = file;
      s.videoProvider = "veo";
      s.videoModel = sv.model;
      s.productionNotes.push("footage reused from the media cache (no new paid call)");
      generatedVideoCount++;
      continue;
    }
    const attempt = (req, label) => budget.run("video", sv.worstCaseUsd, label, () => sv.provider.generate(req));
    try {
      let clip;
      try {
        clip = await attempt(request, `shot ${i + 1} clip`);
      } catch (err) {
        // Veo blocked the attempt AND said it was not billed → follow its own
        // guidance ("modify your request and try again") exactly once.
        if (!err?.filtered || !err?.notCharged) throw err;
        s.productionNotes.push(`first attempt blocked by the provider's ${err.audioFilter ? "audio " : ""}safety filter (not billed); retried once with a rephrased prompt`);
        clip = await attempt({ ...request, prompt: videoPromptSafe(s, aspectRatio) }, `shot ${i + 1} clip (rephrased)`);
      }
      if (clip?.mock) throw new Error("video provider returned mock footage");
      await fs.writeFile(file, Buffer.from(clip.videoBase64, "base64"));
      await toCache(cacheKey, "mp4", file);
      s.generatedVideoPath = file;
      s.videoProvider = clip.provider;
      s.videoModel = clip.model || sv.model;
      generatedVideoCount++;
    } catch (err) {
      s.productionNotes.push(`video failed: ${String(err?.message || err).slice(0, 160)}`);
    }
  }

  return {
    scenePlan: { ...scenePlan, scenes: clonedScenes },
    generatedCount,
    generatedVideoCount,
    budget,
    dir,
    imageProvider: { name: provider.name, model: kfModel(provider), real: realImage, fallbackReason: provider.fallbackReason || null },
    cleanup,
  };
}

const VIDEO_NEGATIVE_PROMPT =
  "text, captions, subtitles, words, letters, watermark, logo, letterbox, black bars, borders, split screen, distorted hands, extra fingers, warped face";

/** Shot → video-model prompt: the Director's visual + camera + hard rules. */
function videoPrompt(s, aspectRatio) {
  const vertical = aspectRatio === "9:16";
  // Product fidelity: a generated screen would invent the product's UI.
  const mentionsScreen = /\b(dashboard|interface|ui|app|website|screen|laptop|tablet|monitor|phone|smartphone)\b/i.test(s.visual || "");
  return [
    s.visual || s.intent || "",
    s.camera ? `Camera: ${s.camera}.` : "",
    vertical
      ? "Vertical 9:16 full-frame composition that fills the entire frame edge to edge; no letterboxing or black bars."
      : "Full-frame 16:9 composition; no letterboxing or black bars.",
    mentionsScreen ? "Any device screen faces away from the camera or is completely out of focus; never show an interface." : "",
    "No readable text, captions, logos or UI in frame.",
    "Audio: natural ambient sound and subtle foley only; no speech, no music.",
  ].filter(Boolean).join(" ");
}

/**
 * Rephrased prompt for ONE retry after an unbilled safety block. Veo's audio
 * filter usually trips on implied speech/sound, so this variant asks for a
 * quiet scene and drops the explicit sound wording.
 */
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

const sha = (data) => crypto.createHash("sha256").update(String(data)).digest("hex");
const mediaKey = (obj) => sha(JSON.stringify(obj)).slice(0, 40);

/** Copy a cached media file into place (opt-in via SCENE_MEDIA_CACHE_DIR). */
async function fromCache(key, ext, dest) {
  const dirName = process.env.SCENE_MEDIA_CACHE_DIR;
  if (!dirName) return false;
  try {
    await fs.copyFile(path.join(dirName, `${key}.${ext}`), dest);
    return true;
  } catch {
    return false;
  }
}
async function toCache(key, ext, src) {
  const dirName = process.env.SCENE_MEDIA_CACHE_DIR;
  if (!dirName) return;
  try {
    await fs.mkdir(dirName, { recursive: true });
    await fs.copyFile(src, path.join(dirName, `${key}.${ext}`));
  } catch {
    /* cache is best-effort */
  }
}

/**
 * Image-to-video from a REAL product photo: the prompt only adds camera and
 * light motion so the packaging, label and printed text stay exactly as
 * photographed (a scene description would make the model redraw the product).
 */
function productVideoPrompt(s) {
  return [
    "Animate this exact product photograph as a premium commercial product shot.",
    `Camera: ${s.camera && !/static/i.test(s.camera) ? s.camera : "slow cinematic push-in"}.`,
    "Subtle realistic motion only: a soft light sweep and reflections gliding across the product, gentle atmospheric depth, slight parallax in the background.",
    "Keep the product, packaging, label, logo and every printed word exactly as in the image; do not redraw, add or remove objects.",
    "Audio: soft ambient tone only; no speech, no music.",
  ].join(" ");
}

/**
 * Fit a real photo to the video frame for use as a first frame: the photo
 * (contained, never cropped) over a blurred, dimmed fill of itself.
 */
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

/** Index of the asset whose role matches the shot's assetHint (or -1). */
function roleMatchIndex(shot, assetMeta) {
  const hint = String(shot?.assetHint || "").toLowerCase().trim();
  if (!hint || hint === "none" || !Array.isArray(assetMeta)) return -1;
  return assetMeta.findIndex((m) => {
    const role = typeof m?.role === "string" ? m.role.toLowerCase() : "";
    return role && (role.includes(hint) || hint.includes(role));
  });
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

function kfModel(provider) {
  return provider.name === "gemini" ? getImageModel() : "mock-gradient";
}

/**
 * Audio pass: one voiceover read of the Director's per-shot VO lines (Gemini
 * TTS) and one instrumental bed (Lyria), both under the job budget. Missing or
 * failed stems are reported, never faked.
 */
async function produceAudio({ scenes, scenePlan, input, brief, brandName, budget, dir }) {
  const report = { voiceover: null, music: null, notes: [] };
  const { voice, music, reasons } = getAudioProviders();
  if (!voice && !music) {
    report.notes.push(`no voiceover/music: ${reasons.join("; ")}`);
    return { report };
  }
  const cfg = budget.config;
  let voiceoverPath = null;
  let voDurationSec = 0;
  let musicPath = null;

  const script = scenes.map((s) => (s.voiceover || "").trim()).filter(Boolean).join(" ");
  if (voice && script) {
    try {
      const style = voiceStyle(scenePlan, input, brief);
      const ext0 = "wav";
      const key = mediaKey({ kind: "vo", model: voice.model, voice: voice.voice, script, style });
      voiceoverPath = path.join(dir, `voiceover.${ext0}`);
      let vo = null;
      if (!(await fromCache(key, ext0, voiceoverPath))) {
        vo = await budget.run("audio", cfg.ttsUsdPerCall, "voiceover", () => voice.generate({ text: script, style }));
        if (/mpeg|mp3/.test(vo.mimeType || "")) voiceoverPath = path.join(dir, "voiceover.mp3");
        await fs.writeFile(voiceoverPath, Buffer.from(vo.audioBase64, "base64"));
        if (voiceoverPath.endsWith(".wav")) await toCache(key, ext0, voiceoverPath);
      }
      voDurationSec = (await probeStreams(voiceoverPath)).audioDurationSec || 0;
      report.voiceover = { provider: "gemini-tts", model: voice.model, voice: voice.voice, script, durationSec: Number(voDurationSec.toFixed(2)), cached: !vo };
    } catch (err) {
      voiceoverPath = null;
      report.notes.push(`voiceover failed: ${String(err?.message || err).slice(0, 160)}`);
    }
  } else if (voice) {
    report.notes.push("no voiceover: the storyboard has no voiceover lines");
  }

  if (music) {
    try {
      const prompt = musicPrompt(scenePlan, input, brief, brandName, scenes);
      const key = mediaKey({ kind: "music", model: music.model, prompt });
      musicPath = path.join(dir, "music.mp3");
      let mu = null;
      if (!(await fromCache(key, "mp3", musicPath))) {
        mu = await budget.run("audio", cfg.musicUsdPerCall, "music", () => music.generate({ prompt }));
        if (/wav/.test(mu.mimeType || "")) musicPath = path.join(dir, "music.wav");
        await fs.writeFile(musicPath, Buffer.from(mu.audioBase64, "base64"));
        if (musicPath.endsWith(".mp3")) await toCache(key, "mp3", musicPath);
      }
      report.music = { provider: "lyria", model: music.model, cached: !mu };
    } catch (err) {
      musicPath = null;
      report.notes.push(`music failed: ${String(err?.message || err).slice(0, 160)}`);
    }
  }
  return { voiceoverPath, voDurationSec, musicPath, report };
}

function voiceStyle(scenePlan, input, brief) {
  const base = scenePlan?.voiceStyle || brief?.brand?.toneOfVoice || "confident, warm, trustworthy";
  const evidence = `${input.offer || ""} ${input.description || ""} ${input.productProfile?.canonicalUrl || ""}`;
  const indian = /₹|\bINR\b|\.in\b/.test(evidence);
  return `${base}; polished social-media ad narrator with energy, brisk pace (about 165 words per minute), no long pauses${indian ? ", light Indian English accent" : ""}`;
}

function musicPrompt(scenePlan, input, brief, brandName, scenes) {
  const total = Math.round(scenes.reduce((a, s) => a + (Number(s.durationSec) || 0), 0));
  const mood = scenePlan?.music || brief?.brand?.toneOfVoice || "modern, uplifting, premium";
  const what = input.description || brief?.conceptCentralMessage || input.productName || brandName || "a product";
  return `Instrumental only, absolutely no vocals or singing. Background score for a ${total}-second vertical social video ad for ${brandName || "a brand"} (${String(what).slice(0, 140)}). Mood: ${mood}. Strong, clean intro in the first second, steady build, polished modern production, gentle resolved ending. Leave space for a voiceover.`;
}

/** Human-readable, provenance-accurate source of a shot's visual. */
function visualSourceOf(s) {
  if (s.executedMethod === "ai_video") return `AI video (${s.videoProvider}/${s.videoModel}${s.firstFrame ? `, first frame: ${s.firstFrame}` : ""})`;
  if (s.executedMethod === "ai_image") return `AI image (${s.keyframeProvider}/${s.keyframeModel})`;
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

/**
 * Pick { base, accent } from every brand colour the import found. accent = the
 * most saturated mid-lightness colour (null when the palette is only
 * greys/black — the renderer then uses a neutral white CTA); base = a deep
 * shade of the accent for tints, else the first real brand colour. For a
 * physical product the packaging's own dominant vivid colour (from the real
 * product photo) is the strongest evidence and wins over site CSS.
 */
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
    if (!total || best.w / total < 0.015) return null; // >= 1.5% of the photo
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

/**
 * Storyboard-mode overlays. Copy is the Director's exact onScreenText, timed
 * to each scene's real window on the crossfaded timeline; the closing card gets
 * the brand title + CTA pill (+ offer when provided) + URL; the small brand
 * mark rides on every other shot. Nothing is invented: absent copy is omitted.
 */
function buildStoryboardOverlays(scenes, input, brief) {
  const brand = (input.brand || brief?.brand?.name || input.productName || "").trim();
  const url = extractUrl(input);
  const offer = (input.offer || "").trim();
  const durs = scenes.map((s) => Number(s.durationSec) || 2.5);
  const starts = sceneStarts(durs);
  const total = durs.reduce((a, d) => a + d, 0) - XFADE * (scenes.length - 1);
  const overlays = [];
  const lastIdx = scenes.length - 1;
  const endCard = isEndCard(scenes, lastIdx);
  const brandMarkEnd = endCard ? starts[lastIdx] + 0.1 : total;
  if (brand) overlays.push({ kind: "brand", text: brand, start: 0, end: brandMarkEnd });

  scenes.forEach((s, i) => {
    const start = starts[i] + (i === 0 ? 0.15 : XFADE * 0.6);
    const end = i === lastIdx ? total : starts[i + 1] + XFADE * 0.4;
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
    // Keep copy off the product: real product photos sit centre-frame, so
    // their caption moves to the lower band; screen footage uses the top band.
    const productFrame = s.firstFrame === "real_asset" || (s.imagePath && !s.videoPath && !s.screenStage);
    const kind = ctaLike ? "cta" : s.screenStage ? "shotTop" : productFrame ? "shotLow" : "shot";
    overlays.push({ kind, text, start, end });
    if (ctaLike && url) overlays.push({ kind: "url", text: url, start: start + 0.2, end });
  });
  return overlays;
}

/**
 * Make room for the narration. Returns the atempo factor (≤ 1.18) and
 * lengthens scenes in place: generated footage up to its real clip length,
 * screen footage (+1.5 s), other shots (+0.8 s), then the closing card (+3 s).
 */
async function fitVoiceover(scenes, voDur, { voStart = 0.25, tail = 0.5, maxTempo = 1.18 } = {}) {
  const room = () => scenes.reduce((a, s) => a + s.durationSec, 0) - XFADE * (scenes.length - 1) - voStart - tail;
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
  if (overflow > 0.05) grow(scenes[last], 3);
  return tempo;
}

/**
 * Compose a finished ad from the compiled plan + request.
 * @param {{ input: object, compiled: object }} args
 */
export async function composeScreenAd({ input, compiled }) {
  const { width, height } = frameSize(input.aspectRatio, input.resolution);
  const { paths: imagePaths, meta: assetMeta } = await collectImagePaths(input);
  const brief = compiled?.brief || {};
  const scenePlan = compiled?.scenePlan;
  const storyboardOrigin = scenePlan?.storyboardOrigin || null; // "ai" | "fallback" | null
  const storyboardDrove = Boolean(storyboardOrigin);

  // Brand colours from ALL extracted evidence: the most vivid palette colour is
  // the accent (CTA pill, end-card tint); greys/black never become the accent.
  const productRoleIdx = assetMeta.findIndex((m) => /hero_product|product_packshot|packshot|product/i.test(m?.role || ""));
  const productColor = productRoleIdx !== -1 ? await vividColorFromImage(imagePaths[productRoleIdx]) : null;
  const { base: brandColorHex, accent: accentHex } = pickBrandColors(input, brief, productColor);
  const brandColors = [brandColorHex, accentHex].filter(Boolean);
  const brandName = input.brand || brief?.brand?.name || input.productName || "";

  // Product-fidelity reference for a REAL image model: the uploaded image, else
  // the primary real asset on disk.
  let referenceImage = input.image || null;
  if (!referenceImage && imagePaths[0]) referenceImage = await readImageForModel(imagePaths[0]);

  const budget = createJobBudget();
  const media = await generateSceneMedia({
    scenePlan, imagePaths, assetMeta, width, height,
    brand: { name: brandName, colors: brandColors },
    aspectRatio: input.aspectRatio,
    resolution: input.resolution,
    referenceImage,
    budget,
  });

  let composed;
  let scenes;
  let overlays;
  let audio = { report: { voiceover: null, music: null, notes: [] } };
  try {
    scenes = buildScenes(media.scenePlan, imagePaths, brief, assetMeta);
    // Screen footage (tall website/app captures) renders inside a device card;
    // its caption moves to the clear band above the card.
    for (const s of scenes) {
      if (!s.imagePath || s.videoPath) continue;
      const meta = await sharp(s.imagePath).metadata().catch(() => null);
      s.screenStage = isTallScreenImage(meta, width, height);
    }

    // Audio stems (voiceover + music) under the same job budget.
    audio = await produceAudio({ scenes, scenePlan, input, brief, brandName, budget, dir: media.dir });

    // Fit the voiceover: a slight speed-up first, then lengthen shots that have
    // real material to spare (generated clips run 4/6/8 s; pages keep
    // scrolling) before holding the closing card — never cut the narration.
    let voiceoverTempo = 1;
    if (audio.voiceoverPath && audio.voDurationSec) {
      voiceoverTempo = await fitVoiceover(scenes, audio.voDurationSec);
    }

    if (storyboardDrove) {
      overlays = buildStoryboardOverlays(scenes, input, brief);
    } else {
      const totalDur = scenes.reduce((a, s) => a + s.durationSec, 0);
      overlays = buildOverlays(input, brief, totalDur).concat(buildShotOverlays(scenes));
    }

    composed = await renderScreenAd({
      scenes, overlays, width, height, brandColorHex, accentHex,
      audio: { voiceoverPath: audio.voiceoverPath || null, voiceoverStart: 0.25, voiceoverTempo, musicPath: audio.musicPath || null },
    });
  } finally {
    await media.cleanup();
  }
  const { buffer, durationSec } = composed;
  const budgetSummary = budget.summary();

  const shotReport = scenes.map((s, i) => ({
    shot: i + 1,
    intent: s.intent || s.purpose || null,
    requestedTechnique: s.requestedTechnique || "(none)",
    executedMethod: s.executedMethod,
    // TRUE only for media a real provider returned (never for mock placeholders).
    aiGenerated: s.executedMethod === "ai_image" || s.executedMethod === "ai_video",
    visualSource: visualSourceOf(s),
    renderMode: composed.sceneModes?.[i] || null,
    letterboxCropped: Boolean(s.cropped),
    keyframeProvider: s.keyframeProvider || null,
    keyframeModel: s.keyframeModel || null,
    keyframeMock: s.keyframeMock ?? null,
    videoProvider: s.videoProvider || null,
    videoModel: s.videoModel || null,
    firstFrame: s.firstFrame || null,
    downgradedFrom: s.downgradedFrom || null,
    usedRealAsset: Boolean(s.imagePath) && !s.videoPath && (s.executedMethod === "real_asset" || s.executedMethod === "composite"),
    productionNotes: s.productionNotes || [],
    onScreenText: s.onScreenText || "",
    voiceover: s.voiceover || "",
    durationSec: Number(Number(s.durationSec).toFixed(2)),
  }));

  // QUALITY VERIFICATION — what a viewer gets, reported honestly.
  const visualShots = scenes.filter((s) => Boolean(s.imagePath || s.videoPath)).length;
  const placeholderShots = shotReport.filter((s) => s.executedMethod === "placeholder_keyframe").length;
  const genuineVisualShots = shotReport.filter((s) => s.usedRealAsset || s.aiGenerated).length;
  const endCards = scenes.filter((s, i) => isEndCard(scenes, i)).length;
  const emptyShots = scenes.filter((s, i) => !s.imagePath && !s.videoPath && !isEndCard(scenes, i)).length;
  const audioLayers = composed.audioLayers || [];
  const quality = {
    totalShots: scenes.length,
    visualShots,
    genuineVisualShots,
    placeholderShots,
    emptyShots,
    endCards,
    realAssetShots: shotReport.filter((s) => s.usedRealAsset).length,
    aiKeyframeShots: shotReport.filter((s) => s.executedMethod === "ai_image").length,
    aiVideoShots: shotReport.filter((s) => s.executedMethod === "ai_video").length,
    audio: audioLayers.length ? audioLayers.join("+") : "silent",
    audioDetail: audio.report,
    passed: visualShots >= 1 && emptyShots === 0,
    productReady:
      genuineVisualShots >= Math.max(1, scenes.length - endCards) && placeholderShots === 0 &&
      audioLayers.includes("voiceover"),
    warnings: [],
  };
  if (placeholderShots) {
    quality.warnings.push(`${placeholderShots}/${scenes.length} shots use MOCK placeholder keyframes (abstract gradients), not AI-generated scenes.`);
  }
  for (const r of shotReport) {
    if (r.downgradedFrom && r.executedMethod !== r.downgradedFrom) {
      quality.warnings.push(`Shot ${r.shot}: requested ${r.downgradedFrom}, produced ${r.visualSource}. ${r.productionNotes.join("; ")}`.trim());
    }
  }
  if (!audioLayers.includes("voiceover")) quality.warnings.push(`No voiceover. ${audio.report.notes.join("; ")}`.trim());
  if (!audioLayers.length) quality.warnings.push("Audio track is silent.");
  if (visualShots === 0) quality.warnings.push("No shot has real footage, a real asset or a generated frame — text cards only.");
  if (emptyShots) quality.warnings.push(`${emptyShots}/${scenes.length} non-closing shots have no visual.`);

  return {
    videoBase64: buffer.toString("base64"),
    mimeType: "video/mp4",
    durationSec,
    width,
    height,
    usedImages: imagePaths.length,
    generatedKeyframes: media.generatedCount,
    generatedVideoClips: media.generatedVideoCount,
    imageProvider: media.imageProvider,
    budget: budgetSummary,
    paidCalls: budgetSummary.calls.length,
    overlays,
    method: "screen_demo",
    quality,
    storyboardDriven: storyboardDrove,
    storyboardOrigin,
    shotReport,
  };
}

// Back-compat alias (tests / callers that still use the old name).
const generateKeyframes = generateSceneMedia;

export const _internal = {
  resolveImagePath, buildOverlays, extractUrl, buildScenes, collectImagePaths, buildShotOverlays, pickRealImage,
  generateKeyframes, generateSceneMedia, buildStoryboardOverlays, isEndCard, videoPrompt, roleMatchIndex,
};
