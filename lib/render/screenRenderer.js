/**
 * Screen-based ad renderer (deterministic, NO paid generative model).
 *
 * Produces a finished MP4 from REAL source visuals (website screenshots,
 * uploaded interface shots, product photos) by:
 *   - fitting each real image onto the ad frame (letterboxed on a brand-tinted
 *     backdrop — never stretched, never cropped-to-lie),
 *   - applying controlled Ken Burns motion (pan / zoom) chosen per scene,
 *   - rendering EXACT deterministic text (brand, offering, URL, price/offer,
 *     CTA) as overlays via ffmpeg drawtext (NOT model pixels),
 *   - concatenating scene clips with short crossfades,
 *   - (audio/voiceover is a later priority; silent track is added for
 *     container validity).
 *
 * It NEVER fabricates UI: it only animates images that were actually provided.
 * If no real image is available for a scene, it renders a clean branded title
 * card (text only) rather than inventing a screen.
 */

import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import sharp from "sharp";
import { runFfmpeg, frameSize, probe } from "./ffmpeg.js";
import { renderTextPng } from "./textImage.js";

// Ken Burns moves. With `-loop 1 -t dur -r FPS` the input is `n` identical
// frames; we run zoompan with d=1 so each input frame produces exactly one
// output frame (total = n, correct duration). Zoom/pan progress is driven by
// `on` (output frame index 0..n-1). z = z0 + (z1-z0)*on/(n-1); pans interpolate
// the top-left across the available slack.
const KEN_BURNS = {
  zoom_in: { z0: 1.0, z1: 1.12, px: () => "iw/2-(iw/zoom/2)", py: () => "ih/2-(ih/zoom/2)" },
  zoom_out: { z0: 1.12, z1: 1.0, px: () => "iw/2-(iw/zoom/2)", py: () => "ih/2-(ih/zoom/2)" },
  pan_right: { z0: 1.08, z1: 1.08, px: (n) => `(iw-iw/zoom)*on/${Math.max(1, n - 1)}`, py: () => "ih/2-(ih/zoom/2)" },
  pan_down: { z0: 1.08, z1: 1.08, px: () => "iw/2-(iw/zoom/2)", py: (n) => `(ih-ih/zoom)*on/${Math.max(1, n - 1)}` },
  hold: { z0: 1.0, z1: 1.0, px: () => "iw/2-(iw/zoom/2)", py: () => "ih/2-(ih/zoom/2)" },
};

/** zoom expression as a linear ramp z0→z1 across n output frames. */
function zoomExpr(z0, z1, n) {
  if (z0 === z1) return String(z0.toFixed(4));
  const span = Math.max(1, n - 1);
  return `${z0.toFixed(4)}+(${(z1 - z0).toFixed(4)})*on/${span}`;
}

/** Map a scene's purpose/motion to a Ken Burns move (deterministic, not random). */
function motionForScene(scene, index) {
  const explicit = scene?.kenBurns;
  if (explicit && KEN_BURNS[explicit]) return explicit;
  const m = (scene?.motion || "").toLowerCase();
  if (m === "minimal") return "hold";
  if (scene?.purpose === "establish") return "zoom_in";
  if (scene?.purpose === "end") return "zoom_out";
  // alternate pans for detail beats
  return index % 2 === 0 ? "pan_right" : "pan_down";
}

const FPS = 30;
const XFADE = 0.4; // seconds crossfade between scenes

/**
 * @param {{
 *   scenes: { imagePath?: string|null, durationSec: number, motion?: string,
 *             purpose?: string, title?: string, caption?: string, kenBurns?: string }[],
 *   width: number, height: number,
 *   brandColorHex?: string,  // backdrop tint, e.g. "#101317"
 *   workDir: string,
 * }} spec
 * @returns {Promise<string[]>} per-scene clip file paths
 */
async function renderScenes(spec) {
  const { width, height, workDir } = spec;
  const bg = normalizeHex(spec.brandColorHex) || "#0b0d10";
  const clips = [];

  for (let i = 0; i < spec.scenes.length; i++) {
    const scene = spec.scenes[i];
    const dur = Math.max(1.2, Number(scene.durationSec) || 2.5);
    const out = path.join(workDir, `scene_${i}.mp4`);
    const frames = Math.round(dur * FPS);

    if (scene.imagePath) {
      // Real image → fit onto frame (contain) over brand backdrop, Ken Burns.
      const move = KEN_BURNS[motionForScene(scene, i)];
      // scale to cover a slightly larger canvas so zoompan has room, keeping AR.
      const vf = [
        // pad source to the frame AR without cropping (contain), on bg color
        `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${ffColor(bg)}`,
        `setsar=1`,
        // Ken Burns via zoompan. d=1 → one output frame per input frame, so
        // the clip length equals the input length (`frames`), not frames².
        `zoompan=z='${zoomExpr(move.z0, move.z1, frames)}':` +
          `x='${move.px(frames)}':y='${move.py(frames)}':d=1:s=${width}x${height}:fps=${FPS}`,
      ].join(",");
      await runFfmpeg([
        "-y", "-loop", "1", "-framerate", String(FPS), "-t", String(dur), "-i", scene.imagePath,
        "-vf", vf, "-frames:v", String(frames), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", String(FPS),
        out,
      ]);
    } else {
      // No real image → BRANDED GRADIENT card (not flat black). We render a
      // gradient+light+motif background PNG and apply a gentle Ken Burns so the
      // shot has real visual depth and motion, then overlays carry the copy.
      const bgPng = path.join(workDir, `cardbg_${i}.png`);
      await renderGradientCard(bgPng, { width, height, bg, accent: spec.accentHex, seed: i });
      const move = KEN_BURNS[scene?.purpose === "end" ? "zoom_out" : "zoom_in"];
      const vf = [
        `scale=${width}:${height}`,
        `setsar=1`,
        `zoompan=z='${zoomExpr(move.z0, move.z1, frames)}':x='${move.px(frames)}':y='${move.py(frames)}':d=1:s=${width}x${height}:fps=${FPS}`,
      ].join(",");
      await runFfmpeg([
        "-y", "-loop", "1", "-framerate", String(FPS), "-t", String(dur), "-i", bgPng,
        "-vf", vf, "-frames:v", String(frames), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", String(FPS),
        out,
      ]);
    }
    clips.push(out);
  }
  return clips;
}

/** Concatenate scene clips with crossfades into one silent video. */
async function concatWithXfade(clips, { width, height, workDir }) {
  if (clips.length === 1) return clips[0];
  const out = path.join(workDir, "concat.mp4");
  // Build an xfade chain. Need per-input durations.
  const inputs = [];
  for (const c of clips) inputs.push("-i", c);

  // Probe durations to compute xfade offsets.
  const durs = [];
  for (const c of clips) durs.push((await probe(c)).durationSec || 2.5);

  let filter = "";
  let prev = "0:v";
  let acc = durs[0];
  for (let i = 1; i < clips.length; i++) {
    const off = Math.max(0, acc - XFADE);
    const label = i === clips.length - 1 ? "vout" : `v${i}`;
    filter += `[${prev}][${i}:v]xfade=transition=fade:duration=${XFADE}:offset=${off.toFixed(3)}[${label}];`;
    prev = label;
    acc = acc + durs[i] - XFADE;
  }
  filter = filter.replace(/;$/, "");

  await runFfmpeg([
    "-y", ...inputs, "-filter_complex", filter, "-map", "[vout]",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", String(FPS), out,
  ]);
  return out;
}

/**
 * Burn deterministic overlays (brand/headline/offer/url/cta) onto the video.
 *
 * Each overlay is rendered to a transparent PNG (sharp/SVG, vendored font) and
 * composited with ffmpeg's `overlay` filter, timed via enable='between(t,...)'.
 * This avoids depending on a drawtext/libfreetype-enabled ffmpeg build and
 * yields crisp, exact typography. The model never draws this copy.
 *
 * @param {string} videoIn
 * @param {{
 *   width: number, height: number, workDir: string,
 *   overlays: { text: string, kind: "brand"|"headline"|"offer"|"url"|"cta",
 *               start: number, end: number }[],
 *   accentHex?: string,
 * }} o
 */
async function burnOverlays(videoIn, o) {
  const { width, height, workDir } = o;
  const list = (o.overlays || []).filter((ov) => ov.text && String(ov.text).trim());
  if (!list.length) return videoIn;

  const out = path.join(workDir, "composited.mp4");
  const inputs = ["-i", videoIn];
  const placements = [];
  let inputIdx = 1;

  for (const ov of list) {
    const style = overlayStyle(ov.kind, { width, height, accent: o.accentHex });
    const png = await renderTextPng({
      text: ov.text, width: Math.round(width * style.maxWidthPct), fontSize: style.fontSize,
      weight: style.weight, color: style.color, align: style.align,
      bg: style.bg, radius: style.radius,
      stroke: style.stroke, strokeWidth: style.strokeWidth,
    });
    const pngPath = path.join(workDir, `ov_${inputIdx}.png`);
    await fs.writeFile(pngPath, png.buffer);
    inputs.push("-i", pngPath);
    placements.push({ idx: inputIdx, x: style.xExpr(png.width, width), y: style.yExpr(png.height, height), ov });
    inputIdx++;
  }

  // Build the overlay chain.
  let filter = "";
  let prev = "0:v";
  placements.forEach((p, i) => {
    const label = i === placements.length - 1 ? "vout" : `o${i}`;
    filter += `[${prev}][${p.idx}:v]overlay=x=${p.x}:y=${p.y}:enable='between(t,${p.ov.start.toFixed(2)},${p.ov.end.toFixed(2)})'[${label}];`;
    prev = label;
  });
  filter = filter.replace(/;$/, "");

  await runFfmpeg([
    "-y", ...inputs, "-filter_complex", filter, "-map", "[vout]",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", out,
  ]);
  return out;
}

/** Add a silent stereo audio track so players/containers are happy. */
async function addSilentAudio(videoIn, { workDir }) {
  const out = path.join(workDir, "final.mp4");
  await runFfmpeg([
    "-y", "-i", videoIn, "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
    "-c:v", "copy", "-c:a", "aac", "-shortest", "-movflags", "+faststart", out,
  ]);
  return out;
}

/**
 * Visual spec per overlay kind. Returns PNG-render params + ffmpeg `overlay`
 * x/y position expressions (functions of the rendered png size and frame size).
 */
function overlayStyle(kind, { width, accent }) {
  const unit = Math.round(width / 22); // base type unit scaled to frame width
  const accentCss = normalizeHex(accent) || "#ff5a24";
  const centerX = (pw, w) => Math.round((w - pw) / 2);
  switch (kind) {
    case "brand":
      return {
        fontSize: Math.round(unit * 1.1), weight: 700, color: "#ffffff", align: "left",
        maxWidthPct: 0.8, bg: null, stroke: "#000000", strokeWidth: 3,
        xExpr: () => Math.round(width * 0.06), yExpr: (ph, h) => Math.round(h * 0.055),
      };
    case "headline":
      return {
        fontSize: Math.round(unit * 1.25), weight: 700, color: "#ffffff", align: "center",
        maxWidthPct: 0.86, bg: "rgba(10,12,16,0.45)", radius: 18, stroke: "#000000", strokeWidth: 2,
        xExpr: centerX, yExpr: (ph, h) => Math.round(h * 0.64 - ph / 2),
      };
    case "offer":
      return {
        fontSize: Math.round(unit * 1.0), weight: 700, color: accentCss, align: "center",
        maxWidthPct: 0.8, bg: null, stroke: "#000000", strokeWidth: 3,
        xExpr: centerX, yExpr: (ph, h) => Math.round(h * 0.5 - ph / 2),
      };
    case "cta":
      return {
        fontSize: Math.round(unit * 0.95), weight: 700, color: "#ffffff", align: "center",
        maxWidthPct: 0.7, bg: accentCss, radius: 999, stroke: null,
        xExpr: centerX, yExpr: (ph, h) => Math.round(h * 0.8),
      };
    case "shot":
      // Per-shot storyboard copy — mid-lower band, boxed for legibility over
      // any image, kept clear of the brand mark (top) and CTA (bottom).
      return {
        fontSize: Math.round(unit * 1.1), weight: 700, color: "#ffffff", align: "center",
        maxWidthPct: 0.84, bg: "rgba(10,12,16,0.5)", radius: 16, stroke: "#000000", strokeWidth: 2,
        xExpr: centerX, yExpr: (ph, h) => Math.round(h * 0.7 - ph / 2),
      };
    case "url":
      return {
        fontSize: Math.round(unit * 0.7), weight: 400, color: "#ffffff", align: "center",
        maxWidthPct: 0.7, bg: "rgba(10,12,16,0.5)", radius: 10, stroke: null,
        xExpr: centerX, yExpr: (ph, h) => Math.round(h * 0.9),
      };
    default:
      return {
        fontSize: unit, weight: 400, color: "#ffffff", align: "center",
        maxWidthPct: 0.8, bg: null, stroke: "#000000", strokeWidth: 2,
        xExpr: centerX, yExpr: (ph, h) => Math.round(h * 0.85),
      };
  }
}

function normalizeHex(h) {
  if (!h) return null;
  const m = String(h).trim().match(/^#?([0-9a-fA-F]{6})$/);
  return m ? `#${m[1].toLowerCase()}` : null;
}
// ffmpeg color: "0xRRGGBB" form is safest in filtergraphs.
function ffColor(hex) {
  const h = normalizeHex(hex) || "#0b0d10";
  return `0x${h.slice(1)}`;
}

/** Darken/lighten a hex toward black(−)/white(+) by factor k (0..1). */
function shadeHex(hex, f) {
  const h = normalizeHex(hex) || "#1a1d24";
  const n = parseInt(h.slice(1), 16);
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const t = f < 0 ? 0 : 255, k = Math.abs(f);
  r = clamp(r + (t - r) * k); g = clamp(g + (t - g) * k); b = clamp(b + (t - b) * k);
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

/**
 * Render a BRANDED gradient background card to a PNG (replaces the old flat
 * near-black card). A diagonal brand gradient + soft radial light + faint
 * geometric motif — real visual depth for a text-only shot, deterministic per
 * seed so distinct cards differ. Copy is drawn separately as overlays.
 */
async function renderGradientCard(outPath, { width, height, bg, accent, seed = 0 }) {
  const W = Math.round(width), H = Math.round(height);
  const c1 = normalizeHex(bg) || "#1a1d24";
  const ac = normalizeHex(accent) || "#ff5a24";
  const h01 = (salt) => crypto.createHash("sha256").update(`${c1}:${seed}:${salt}`).digest().readUInt32BE(0) / 0xffffffff;
  const ang = Math.round(h01(1) * 110 + 25);
  const lx = Math.round((0.3 + h01(2) * 0.4) * 100);
  const ly = Math.round((0.2 + h01(3) * 0.35) * 100);
  const circles = [];
  for (let i = 0; i < 3; i++) {
    const r = Math.round((0.14 + h01(10 + i) * 0.2) * Math.min(W, H));
    const cx = Math.round(h01(20 + i) * W), cy = Math.round(h01(30 + i) * H);
    circles.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${i % 2 ? ac : shadeHex(c1, 0.4)}" opacity="0.1"/>`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs>
      <linearGradient id="g" gradientTransform="rotate(${ang})">
        <stop offset="0%" stop-color="${shadeHex(c1, 0.08)}"/>
        <stop offset="100%" stop-color="${shadeHex(c1, -0.4)}"/>
      </linearGradient>
      <radialGradient id="l" cx="${lx}%" cy="${ly}%" r="80%">
        <stop offset="0%" stop-color="${shadeHex(c1, 0.4)}" stop-opacity="0.5"/>
        <stop offset="100%" stop-color="${c1}" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#g)"/>
    ${circles.join("")}
    <rect width="${W}" height="${H}" fill="url(#l)"/>
  </svg>`;
  await fs.writeFile(outPath, await sharp(Buffer.from(svg)).png().toBuffer());
}

/**
 * Render a complete screen-based ad.
 *
 * @param {{
 *   scenes: object[],      // from buildScreenScenes (imagePath resolved)
 *   overlays: object[],    // deterministic copy with timing
 *   width: number, height: number,
 *   brandColorHex?: string, accentHex?: string,
 * }} plan
 * @returns {Promise<{ buffer: Buffer, durationSec: number, width: number, height: number }>}
 */
export async function renderScreenAd(plan) {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "mac-render-"));
  try {
    const clips = await renderScenes({ ...plan, workDir });
    const concatenated = await concatWithXfade(clips, { ...plan, workDir });
    const totalDur = plan.scenes.reduce((a, s) => a + (Number(s.durationSec) || 2.5), 0)
      - XFADE * (plan.scenes.length - 1);
    const composited = await burnOverlays(concatenated, {
      width: plan.width, height: plan.height, totalDur, workDir,
      overlays: plan.overlays, accentHex: plan.accentHex,
    });
    const finalFile = await addSilentAudio(composited, { workDir });
    const buffer = await fs.readFile(finalFile);
    const p = await probe(finalFile);
    return { buffer, durationSec: p.durationSec || totalDur, width: plan.width, height: plan.height };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

export const _internal = { motionForScene, overlayStyle, normalizeHex, ffColor };
