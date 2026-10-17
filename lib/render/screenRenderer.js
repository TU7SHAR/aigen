/**
 * Ad renderer (ffmpeg). Turns resolved scenes + exact copy + audio stems into a
 * finished MP4.
 *
 * Per scene:
 *   - generated footage (videoPath): baked-in letterbox bars are detected and
 *     cropped; the clip is cover-fit (or, when its shape differs a lot from the
 *     frame, fitted over a blurred fill so the subject is never cut off) and
 *     upscaled with lanczos + light sharpening; native ambient audio is kept;
 *   - tall website/app screenshot: scrolled inside a device card;
 *   - other real image: fitted over a blurred fill of itself, with Ken Burns;
 *   - end card / no image: the previous shot's last frame, blurred and tinted
 *     with the brand colour (a branded gradient when there is no prior shot).
 * Then ONE composite pass: storyboard-directed transitions (cut / dissolve /
 * whip / zoom / fade), a legibility scrim and timed copy overlays inside
 * platform safe areas; then the audio mix (voiceover over a ducked music bed
 * + ambient stems, loudness-normalised for social).
 *
 * The frame rate follows generated footage (Veo/Omni are 24 fps) so motion is
 * not judder-converted; image-only ads render at 30 fps.
 */

import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import sharp from "sharp";
import { runFfmpeg, probe, probeStreams } from "./ffmpeg.js";
import { renderTextPng } from "./textImage.js";

const KEN_BURNS = {
  zoom_in: { z0: 1.0, z1: 1.1, px: () => "iw/2-(iw/zoom/2)", py: () => "ih/2-(ih/zoom/2)" },
  zoom_out: { z0: 1.1, z1: 1.0, px: () => "iw/2-(iw/zoom/2)", py: () => "ih/2-(ih/zoom/2)" },
  pan_right: { z0: 1.08, z1: 1.08, px: (n) => `(iw-iw/zoom)*on/${Math.max(1, n - 1)}`, py: () => "ih/2-(ih/zoom/2)" },
  pan_down: { z0: 1.08, z1: 1.08, px: () => "iw/2-(iw/zoom/2)", py: (n) => `(ih-ih/zoom)*on/${Math.max(1, n - 1)}` },
  hold: { z0: 1.0, z1: 1.0, px: () => "iw/2-(iw/zoom/2)", py: () => "ih/2-(ih/zoom/2)" },
};

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
  if (m === "minimal" || m === "hold") return "hold";
  if (/zoom.?out|pull/.test(m)) return "zoom_out";
  if (/push|zoom/.test(m)) return "zoom_in";
  if (scene?.purpose === "establish") return "zoom_in";
  if (scene?.purpose === "end") return "zoom_out";
  return index % 2 === 0 ? "pan_right" : "pan_down";
}

/** Legacy constant: the default dissolve length (seconds). */
export const XFADE = 0.35;

// Storyboard transition → xfade transition + duration (seconds).
const TRANSITIONS = {
  cut: { xf: "fade", d: null },          // one frame: an editorial cut
  dissolve: { xf: "dissolve", d: 0.4 },
  fade: { xf: "fade", d: 0.45 },
  whip: { xf: "smoothleft", d: 0.25 },
  slide: { xf: "slideleft", d: 0.3 },
  zoom: { xf: "zoomin", d: 0.3 },
};

/** Frame rate for a set of scenes: follow generated footage (24 fps). */
export function pickFps(scenes) {
  return (scenes || []).some((s) => s?.videoPath) ? 24 : 30;
}

/**
 * Transition between scene i and i+1. The cut into a closing card is always a
 * short fade so the CTA does not slam in. Legacy scenes without a
 * transitionOut keep the old dissolve.
 */
export function transitionAfter(scenes, i, fps = 30) {
  const s = scenes[i] || {};
  const next = scenes[i + 1] || {};
  const intoEnd = i + 1 === scenes.length - 1 && !next.imagePath && !next.videoPath;
  const key = intoEnd ? "fade" : String(s.transitionOut || "").toLowerCase();
  const t = TRANSITIONS[key] || (s.transitionOut ? TRANSITIONS.cut : { xf: "fade", d: XFADE });
  return { xf: t.xf, d: t.d ?? Number((1 / fps).toFixed(4)) };
}

/** Timeline of the composed ad: per-scene starts, transition lengths, total. */
export function computeTimeline(scenes, fps = pickFps(scenes)) {
  const durs = scenes.map((s) => Math.max(1.2, Number(s.durationSec) || 2.5));
  const xfades = scenes.slice(0, -1).map((_, i) => transitionAfter(scenes, i, fps));
  const starts = [];
  let acc = 0;
  durs.forEach((d, i) => {
    starts.push(Number(acc.toFixed(3)));
    acc += d - (xfades[i]?.d || 0);
  });
  const total = durs.reduce((a, d) => a + d, 0) - xfades.reduce((a, x) => a + x.d, 0);
  return { starts, durs, xfades, total: Number(total.toFixed(3)), fps };
}

/** Back-compat: starts with a uniform dissolve. */
export function sceneStarts(durs) {
  const starts = [];
  let acc = 0;
  durs.forEach((d, i) => {
    starts.push(Number(Math.max(0, acc - i * XFADE).toFixed(3)));
    acc += d;
  });
  return starts;
}

const x264 = (fps, { final = false } = {}) => [
  "-c:v", "libx264",
  "-preset", final ? (process.env.RENDER_FINAL_PRESET || "medium") : "veryfast",
  "-crf", final ? (process.env.RENDER_FINAL_CRF || "18") : "14",
  "-pix_fmt", "yuv420p",
  ...(final ? ["-profile:v", "high", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"] : []),
  "-r", String(fps),
];

/**
 * Detect baked-in black bars in generated footage via cropdetect. Returns the
 * content box, or null when there are no meaningful bars (or the "bars" are
 * just a dark scene — the box must keep >= 60% of each dimension).
 */
async function detectContentBox(file, srcW, srcH) {
  if (!srcW || !srcH) return null;
  let stderr = "";
  try {
    ({ stderr } = await runFfmpeg(["-hide_banner", "-ss", "0.3", "-t", "2.4", "-i", file,
      "-an", "-vf", "cropdetect=limit=24:round=2:reset=0", "-f", "null", "-"], { timeoutMs: 60_000 }));
  } catch {
    return null;
  }
  const all = [...String(stderr).matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
  if (!all.length) return null;
  const [w, h, x, y] = all[all.length - 1].slice(1).map(Number);
  if (w >= srcW * 0.975 && h >= srcH * 0.975) return null;
  if (w < srcW * 0.6 || h < srcH * 0.6) return null;
  return { w, h, x, y };
}

/** Extract the last frame of a clip (for end-card backdrops). */
async function lastFrame(clip, out) {
  try {
    await runFfmpeg(["-y", "-sseof", "-0.12", "-i", clip, "-frames:v", "1", "-update", "1", out]);
    await fs.access(out);
    return out;
  } catch {
    return null;
  }
}

/** Run async tasks with bounded concurrency, preserving order. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

async function renderFootage(scene, i, ctx) {
  const { width, height, fps, workDir } = ctx;
  const dur = Math.max(1.2, Number(scene.durationSec) || 2.5);
  const frames = Math.round(dur * fps);
  const out = path.join(workDir, `scene_${i}.mp4`);
  const src = await probe(scene.videoPath);
  const box = await detectContentBox(scene.videoPath, src.width, src.height);
  const cw = box?.w || src.width || width;
  const ch = box?.h || src.height || height;
  const srcAspect = cw / ch;
  const dstAspect = width / height;
  const upscale = ch < height * 0.9 ? ",unsharp=5:5:0.35:5:5:0" : "";
  const crop = box ? `crop=${box.w}:${box.h}:${box.x}:${box.y},` : "";
  let fc;
  if (Math.abs(srcAspect - dstAspect) / dstAspect > 0.12) {
    // Shape mismatch (e.g. a 16:9 clip in a 9:16 ad): never centre-crop the
    // subject away — fit it over a blurred fill of itself.
    fc =
      `[0:v]${crop}split=2[a][b];` +
      `[a]scale=${width}:${height}:force_original_aspect_ratio=increase:flags=bilinear,crop=${width}:${height},gblur=sigma=30,eq=brightness=-0.12[bg];` +
      `[b]scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos${upscale}[fg];` +
      `[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1,fps=${fps},tpad=stop_mode=clone:stop_duration=${dur}[v]`;
    scene.fitMode = "fit_over_blur";
  } else {
    fc =
      `[0:v]${crop}scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${width}:${height}${upscale},` +
      `setsar=1,fps=${fps},tpad=stop_mode=clone:stop_duration=${dur}[v]`;
    scene.fitMode = "cover";
  }
  await runFfmpeg(["-y", "-i", scene.videoPath, "-an", "-filter_complex", fc, "-map", "[v]", "-frames:v", String(frames), ...x264(fps), out]);
  if (box) scene.cropped = box;
  let audioPath = null;
  const streams = await probeStreams(scene.videoPath);
  if (streams.hasAudio) {
    audioPath = path.join(workDir, `scene_${i}.wav`);
    await runFfmpeg(["-y", "-i", scene.videoPath, "-vn",
      "-af", `aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=0:${dur.toFixed(3)}`, audioPath]);
  }
  return { path: out, durationSec: dur, audioPath, mode: "footage" };
}

async function renderImage(scene, i, ctx, scrollOffsets) {
  const { width, height, fps, workDir, bg, accentHex } = ctx;
  const dur = Math.max(1.2, Number(scene.durationSec) || 2.5);
  const frames = Math.round(dur * fps);
  const out = path.join(workDir, `scene_${i}.mp4`);
  const meta = await sharp(scene.imagePath).metadata().catch(() => ({}));
  if (isTallScreenImage(meta, width, height)) {
    const card = screenCardBox(width, height);
    const scaledH = Math.round((meta.height * card.w) / meta.width);
    const from = Math.min(scrollOffsets.get(scene.imagePath) || 0, Math.max(0, scaledH - card.h));
    const travel = Math.max(0, Math.min(scaledH - card.h - from, Math.round(card.h * 0.38 * dur)));
    scrollOffsets.set(scene.imagePath, from + travel);
    const yExpr = `${from}+${travel}*(0.5-0.5*cos(PI*min(t,${dur.toFixed(3)})/${dur.toFixed(3)}))`;
    const stage = path.join(workDir, `stage_${i}.png`);
    const mask = path.join(workDir, `mask_${i}.png`);
    await renderScreenStage(stage, mask, { width, height, card, bg, accent: accentHex, seed: i });
    const fc =
      `[1:v]scale=${card.w}:-2:flags=lanczos,crop=${card.w}:${card.h}:0:'${yExpr}',format=rgba[scr];` +
      `[2:v]format=gray,scale=${card.w}:${card.h}[m];[scr][m]alphamerge[card];` +
      `[0:v][card]overlay=${card.x}:${card.y}:format=auto,setsar=1,fps=${fps}[v]`;
    await runFfmpeg(["-y",
      "-loop", "1", "-framerate", String(fps), "-t", String(dur), "-i", stage,
      "-loop", "1", "-framerate", String(fps), "-t", String(dur), "-i", scene.imagePath,
      "-loop", "1", "-framerate", String(fps), "-t", String(dur), "-i", mask,
      "-filter_complex", fc, "-map", "[v]", "-frames:v", String(frames), ...x264(fps), out]);
    return { path: out, durationSec: dur, audioPath: null, mode: "screen_scroll" };
  }
  const move = KEN_BURNS[motionForScene(scene, i)];
  const fg = `scale=${Math.round(width * 0.92)}:${Math.round(height * 0.92)}:force_original_aspect_ratio=decrease:flags=lanczos`;
  const fc =
    `[0:v]split=2[a][b];` +
    `[a]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},gblur=sigma=28,eq=brightness=-0.14[bgv];` +
    `[b]${fg}[fgv];` +
    `[bgv][fgv]overlay=(W-w)/2:(H-h)/2,setsar=1,scale=${width * 2}:${height * 2}:flags=lanczos,` +
    `zoompan=z='${zoomExpr(move.z0, move.z1, frames)}':x='${move.px(frames)}':y='${move.py(frames)}':d=1:s=${width}x${height}:fps=${fps}[v]`;
  await runFfmpeg(["-y", "-loop", "1", "-framerate", String(fps), "-t", String(dur), "-i", scene.imagePath,
    "-filter_complex", fc, "-map", "[v]", "-frames:v", String(frames), ...x264(fps), out]);
  return { path: out, durationSec: dur, audioPath: null, mode: "image" };
}

async function renderCard(scene, i, ctx, prevClip) {
  const { width, height, fps, workDir, bg, accentHex } = ctx;
  const dur = Math.max(1.2, Number(scene.durationSec) || 2.5);
  const frames = Math.round(dur * fps);
  const out = path.join(workDir, `scene_${i}.mp4`);
  const backdrop = prevClip ? await lastFrame(prevClip.path, path.join(workDir, `last_${i}.png`)) : null;
  const move = KEN_BURNS[scene?.purpose === "end" ? "zoom_out" : "zoom_in"];
  const zp = `zoompan=z='${zoomExpr(move.z0, move.z1, frames)}':x='${move.px(frames)}':y='${move.py(frames)}':d=1:s=${width}x${height}:fps=${fps}`;
  let input;
  let vf;
  let mode;
  if (backdrop) {
    mode = "endcard_backdrop";
    input = backdrop;
    const st = await sharp(backdrop).stats().catch(() => null);
    const mean = st ? (st.channels[0].mean + st.channels[1].mean + st.channels[2].mean) / (3 * 255) : 0.4;
    const darkenBy = Math.min(0.5, Math.max(0.14, 0.14 + (mean - 0.2) * 0.95));
    vf = [
      `scale=${width}:${height}:force_original_aspect_ratio=increase`, `crop=${width}:${height}`,
      "gblur=sigma=26", `eq=brightness=-${darkenBy.toFixed(3)}:saturation=1.1`,
      `drawbox=x=0:y=0:w=iw:h=ih:color=${ffColor(bg)}@0.45:t=fill`,
      "setsar=1", `scale=${width * 2}:${height * 2}`, zp,
    ].join(",");
  } else {
    mode = "gradient";
    input = path.join(workDir, `cardbg_${i}.png`);
    await renderGradientCard(input, { width, height, bg, accent: accentHex, seed: i });
    vf = [`scale=${width}:${height}`, "setsar=1", zp].join(",");
  }
  await runFfmpeg(["-y", "-loop", "1", "-framerate", String(fps), "-t", String(dur), "-i", input,
    "-vf", vf, "-frames:v", String(frames), ...x264(fps), out]);
  return { path: out, durationSec: dur, audioPath: null, mode };
}

/**
 * Render every scene. Independent scenes run in parallel (bounded by
 * RENDER_CONCURRENCY); text-only cards wait for the shot before them because
 * they reuse its last frame as their backdrop.
 */
async function renderScenes(spec) {
  const ctx = {
    width: spec.width, height: spec.height, fps: spec.fps, workDir: spec.workDir,
    bg: normalizeHex(spec.brandColorHex) || "#0b0d10", accentHex: spec.accentHex,
  };
  const scrollOffsets = new Map();
  const clips = new Array(spec.scenes.length);
  const media = spec.scenes.map((s, i) => ({ s, i })).filter(({ s }) => s.videoPath || s.imagePath);
  const limit = Math.max(1, Number(process.env.RENDER_CONCURRENCY || 2));
  // Screen scrolls share an offset map, so render those in order.
  const screenFirst = media.filter(({ s }) => !s.videoPath);
  const footage = media.filter(({ s }) => s.videoPath);
  await mapLimit(footage, limit, async ({ s, i }) => { clips[i] = await renderFootage(s, i, ctx); });
  for (const { s, i } of screenFirst) clips[i] = await renderImage(s, i, ctx, scrollOffsets);
  for (let i = 0; i < spec.scenes.length; i++) {
    if (!clips[i]) clips[i] = await renderCard(spec.scenes[i], i, ctx, clips[i - 1] || null);
  }
  return clips;
}

/** Top + bottom gradient scrim so white copy stays legible over any footage. */
async function renderScrim(outPath, { width, height }) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs>
      <linearGradient id="t" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#000" stop-opacity="0.45"/><stop offset="1" stop-color="#000" stop-opacity="0"/>
      </linearGradient>
      <linearGradient id="b" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.6"/>
      </linearGradient>
    </defs>
    <rect x="0" y="0" width="${width}" height="${Math.round(height * 0.16)}" fill="url(#t)"/>
    <rect x="0" y="${Math.round(height * 0.52)}" width="${width}" height="${height - Math.round(height * 0.52)}" fill="url(#b)"/>
  </svg>`;
  await fs.writeFile(outPath, await sharp(Buffer.from(svg)).png().toBuffer());
}

/**
 * ONE pass: storyboard transitions between the rendered scenes, the scrim and
 * the timed copy overlays (each a transparent PNG that fades in/out and, for
 * captions/CTA, slides up a few pixels). Saves a full re-encode versus
 * concatenating first and compositing after.
 */
async function composeVideo(clips, o) {
  const { width, height, workDir, timeline, fps } = o;
  const out = path.join(workDir, "composited.mp4");
  const T = Math.max(0.5, timeline.total).toFixed(3);
  const inputs = [];
  for (const c of clips) inputs.push("-i", c.path);
  let filter = "";
  let prev = "0:v";
  if (clips.length > 1) {
    const durs = [];
    for (const c of clips) durs.push((await probe(c.path)).durationSec || c.durationSec);
    let acc = durs[0];
    for (let i = 1; i < clips.length; i++) {
      const xf = timeline.xfades[i - 1];
      const off = Math.max(0, acc - xf.d);
      const label = `x${i}`;
      filter += `[${prev}][${i}:v]xfade=transition=${xf.xf}:duration=${xf.d}:offset=${off.toFixed(3)}[${label}];`;
      prev = label;
      acc = acc + durs[i] - xf.d;
    }
  }
  const scrim = path.join(workDir, "scrim.png");
  await renderScrim(scrim, { width, height });
  const scrimIdx = clips.length;
  inputs.push("-loop", "1", "-framerate", String(fps), "-t", T, "-i", scrim);
  filter += `[${prev}][${scrimIdx}:v]overlay=0:0:format=auto[s0];`;
  prev = "s0";

  const list = (o.overlays || []).filter((ov) => ov.text && String(ov.text).trim());
  let idx = scrimIdx + 1;
  const placed = [];
  for (let k = 0; k < list.length; k++) {
    const ov = list[k];
    const style = overlayStyle(ov.kind, { width, height, accent: o.accentHex });
    const png = await renderTextPng({
      text: ov.text, width: Math.round(width * style.maxWidthPct), fontSize: style.fontSize,
      weight: style.weight, color: style.color, align: style.align,
      bg: style.bg, radius: style.radius, shadow: style.shadow,
    });
    const pngPath = path.join(workDir, `ov_${k}.png`);
    await fs.writeFile(pngPath, png.buffer);
    inputs.push("-loop", "1", "-framerate", String(fps), "-t", T, "-i", pngPath);
    const start = Math.max(0, Number(ov.start) || 0);
    const end = Math.max(start + 0.3, Number(ov.end) || timeline.total);
    const fin = 0.22;
    const fout = Math.min(0.22, (end - start) / 3);
    const x = style.xExpr(png.width, width);
    const y = style.yExpr(png.height, height);
    placed.push({ kind: ov.kind, text: ov.text, x, y, w: png.width, h: png.height, start, end });
    const yExpr = style.slide ? `${y}+${Math.round(height * 0.012)}*max(0,1-(t-${start.toFixed(2)})/0.3)` : String(y);
    filter +=
      `[${idx}:v]format=rgba,fade=t=in:st=${start.toFixed(2)}:d=${fin}:alpha=1,` +
      `fade=t=out:st=${(end - fout).toFixed(2)}:d=${fout.toFixed(2)}:alpha=1[t${k}];` +
      `[${prev}][t${k}]overlay=x=${x}:y='${yExpr}':eval=frame:enable='between(t,${start.toFixed(2)},${end.toFixed(2)})'[o${k}];`;
    prev = `o${k}`;
    idx++;
  }
  filter += `[${prev}]null[vout]`;
  await runFfmpeg(["-y", ...inputs, "-filter_complex", filter, "-map", "[vout]", "-t", T, ...x264(fps, { final: true }), out], { timeoutMs: 300_000 });
  return { file: out, placed };
}

/**
 * Mix the soundtrack: voiceover on top (cleaned + lightly compressed), music
 * bed ducked under it, ambient stems from generated footage underneath;
 * loudness-normalised (-14 LUFS, -1.5 dBTP). Missing stems are absent.
 * @returns {Promise<{ file: string, layers: string[] }>}
 */
async function mixAudio(videoIn, { workDir, totalDur, sceneAudio = [], voiceoverPath = null, voiceoverStart = 0.25, voiceoverTempo = 1, musicPath = null }) {
  const out = path.join(workDir, "final.mp4");
  const T = Math.max(0.5, totalDur);
  const inputs = ["-i", videoIn];
  const parts = [];
  const layers = [];
  let filter = "";
  let n = 1;
  const fmt = "aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo";

  const hasVo = Boolean(voiceoverPath);
  const ambientGain = hasVo ? 0.28 : 0.75;
  const ambLabels = [];
  for (const a of sceneAudio) {
    if (!a?.path) continue;
    inputs.push("-i", a.path);
    const ms = Math.round(a.start * 1000);
    const d = Math.max(0.3, a.durationSec);
    filter += `[${n}:a]${fmt},afade=t=in:d=0.2,afade=t=out:st=${Math.max(0, d - 0.35).toFixed(2)}:d=0.35,adelay=${ms}|${ms},volume=${ambientGain}[amb${n}];`;
    ambLabels.push(`[amb${n}]`);
    n++;
  }
  if (ambLabels.length) {
    filter += ambLabels.length > 1 ? `${ambLabels.join("")}amix=inputs=${ambLabels.length}:normalize=0[amb];` : `${ambLabels[0]}anull[amb];`;
    parts.push("[amb]");
    layers.push("ambient");
  }

  let voSide = null;
  if (hasVo) {
    inputs.push("-i", voiceoverPath);
    const ms = Math.round(voiceoverStart * 1000);
    const tempo = Math.min(1.2, Math.max(1, voiceoverTempo));
    filter += `[${n}:a]${fmt},highpass=f=80,acompressor=threshold=0.125:ratio=2.5:attack=5:release=120:makeup=1.5,` +
      `${tempo > 1.001 ? `atempo=${tempo.toFixed(3)},` : ""}adelay=${ms}|${ms},volume=1.0,asplit=2[vo][voside];`;
    parts.push("[vo]");
    voSide = "[voside]";
    layers.push("voiceover");
    n++;
  }

  if (musicPath) {
    inputs.push("-i", musicPath);
    const fadeOutSt = Math.max(0, T - 1.2).toFixed(2);
    filter += `[${n}:a]${fmt},atrim=0:${T.toFixed(3)},afade=t=in:d=0.5,afade=t=out:st=${fadeOutSt}:d=1.2,volume=${hasVo ? 0.4 : 0.7}[mus];`;
    if (voSide) {
      filter += `[mus]${voSide}sidechaincompress=threshold=0.03:ratio=6:attack=20:release=400[musd];`;
      parts.push("[musd]");
      voSide = null;
    } else {
      parts.push("[mus]");
    }
    layers.push("music");
    n++;
  }
  if (voSide) filter += `${voSide}anullsink;`;

  if (!parts.length) {
    await runFfmpeg(["-y", "-i", videoIn, "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
      "-c:v", "copy", "-c:a", "aac", "-shortest", "-movflags", "+faststart", out]);
    return { file: out, layers };
  }
  filter += `${parts.join("")}${parts.length > 1 ? `amix=inputs=${parts.length}:normalize=0:duration=longest,` : ""}` +
    `apad,atrim=0:${T.toFixed(3)},loudnorm=I=-14:TP=-1.5:LRA=11,aresample=44100[aout]`;
  await runFfmpeg(["-y", ...inputs, "-filter_complex", filter, "-map", "0:v", "-map", "[aout]",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-t", T.toFixed(3), "-movflags", "+faststart", out], { timeoutMs: 180_000 });
  return { file: out, layers };
}

/**
 * Visual spec per overlay kind → PNG params + ffmpeg x/y expressions.
 * Positions stay inside the 9:16 platform safe area (top ~6%, bottom ~20%
 * and the right-hand action rail are covered by app UI on Reels/TikTok/Shorts).
 */
function overlayStyle(kind, { width, accent }) {
  const unit = Math.round(width / 22);
  const accentCss = normalizeHex(accent);
  const pillBg = accentCss || "#ffffff";
  const lum = relLuminance(pillBg);
  const pillFg = (lum + 0.05) / 0.0556 >= 1.05 / (lum + 0.05) ? "#111111" : "#ffffff";
  const centerX = (pw, w) => Math.round((w - pw) / 2);
  switch (kind) {
    case "brand":
      return {
        fontSize: Math.round(unit * 0.95), weight: 700, color: "#ffffff", align: "left", maxWidthPct: 0.6,
        bg: null, shadow: true, slide: false,
        xExpr: () => Math.round(width * 0.06), yExpr: (ph, h) => Math.round(h * 0.065),
      };
    case "brandTitle":
      return {
        fontSize: Math.round(unit * 2.0), weight: 700, color: "#ffffff", align: "center", maxWidthPct: 0.84,
        bg: null, shadow: true, slide: true,
        xExpr: centerX, yExpr: (ph, h) => Math.round(h * 0.4 - ph / 2),
      };
    case "headline":
    case "shot":
      return {
        fontSize: Math.round(unit * 1.38), weight: 700, color: "#ffffff", align: "center", maxWidthPct: 0.8,
        bg: null, shadow: true, slide: true,
        xExpr: centerX, yExpr: (ph, h) => Math.round(Math.min(h * 0.64, h * 0.78 - ph)),
      };
    case "shotTop":
      return {
        fontSize: Math.round(unit * 1.25), weight: 700, color: "#ffffff", align: "center", maxWidthPct: 0.84,
        bg: null, shadow: true, slide: true,
        xExpr: centerX, yExpr: (ph, h) => Math.max(Math.round(h * 0.075), Math.round(h * 0.13 - ph / 2)),
      };
    case "shotLow":
      return {
        fontSize: Math.round(unit * 1.3), weight: 700, color: "#ffffff", align: "center", maxWidthPct: 0.8,
        bg: null, shadow: true, slide: true,
        xExpr: centerX, yExpr: (ph, h) => Math.round(h * 0.79 - ph),
      };
    case "offer":
      return {
        fontSize: Math.round(unit * 1.0), weight: 700, color: "#ffffff", align: "center", maxWidthPct: 0.8,
        bg: null, shadow: true, slide: true,
        xExpr: centerX, yExpr: (ph, h) => Math.round(h * 0.52 - ph / 2),
      };
    case "cta":
      return {
        fontSize: Math.round(unit * 1.12), weight: 700, color: pillFg, align: "center", maxWidthPct: 0.84,
        bg: pillBg, radius: 999, shadow: false, slide: true,
        xExpr: centerX, yExpr: (ph, h) => Math.round(h * 0.62 - ph / 2),
      };
    case "url":
      return {
        fontSize: Math.round(unit * 0.8), weight: 400, color: "#ffffff", align: "center", maxWidthPct: 0.78,
        bg: null, shadow: true, slide: false,
        xExpr: centerX, yExpr: (ph, h) => Math.round(h * 0.71 - ph / 2),
      };
    default:
      return {
        fontSize: unit, weight: 400, color: "#ffffff", align: "center", maxWidthPct: 0.78,
        bg: null, shadow: true, slide: false,
        xExpr: centerX, yExpr: (ph, h) => Math.round(h * 0.76 - ph),
      };
  }
}

function normalizeHex(h) {
  if (!h) return null;
  const m = String(h).trim().match(/^#?([0-9a-fA-F]{6})$/);
  return m ? `#${m[1].toLowerCase()}` : null;
}
/** WCAG relative luminance of a #rrggbb colour (0 = black, 1 = white). */
function relLuminance(hex) {
  const h = normalizeHex(hex) || "#000000";
  const n = parseInt(h.slice(1), 16);
  const ch = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * ch((n >> 16) & 255) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255);
}
function ffColor(hex) {
  const h = normalizeHex(hex) || "#0b0d10";
  return `0x${h.slice(1)}`;
}
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
 * A screenshot is "a tall screen" (scrollable page) when, fitted to the frame
 * width, it is noticeably taller than the frame.
 */
export function isTallScreenImage(meta, width, height) {
  if (!meta?.width || !meta?.height) return false;
  return (meta.height * width) / meta.width > height * 1.25;
}

function screenCardBox(width, height) {
  const w = Math.round((width * 0.8) / 2) * 2;
  const h = Math.round((height * 0.7) / 2) * 2;
  return { w, h, x: Math.round((width - w) / 2), y: Math.round(height * 0.2), r: Math.round(width * 0.045) };
}

async function renderScreenStage(stagePath, maskPath, { width, height, card, bg, accent, seed }) {
  const gradient = path.join(path.dirname(stagePath), `stagebg_${seed}.png`);
  await renderGradientCard(gradient, { width, height, bg, accent, seed: seed + 7 });
  const shadow = await sharp(Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<rect x="${card.x}" y="${card.y + Math.round(height * 0.011)}" width="${card.w}" height="${card.h}" rx="${card.r}" ry="${card.r}" fill="#000" fill-opacity="0.55"/></svg>`
  )).blur(Math.max(2, Math.round(width * 0.025))).png().toBuffer();
  await sharp(gradient).composite([{ input: shadow, left: 0, top: 0 }]).png().toFile(stagePath);
  await sharp(Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${card.w}" height="${card.h}">` +
    `<rect width="${card.w}" height="${card.h}" fill="#000"/>` +
    `<rect width="${card.w}" height="${card.h}" rx="${card.r}" ry="${card.r}" fill="#fff"/></svg>`
  )).png().toFile(maskPath);
}

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
 * Render a complete ad.
 *
 * @param {{
 *   scenes: object[], overlays: object[], width: number, height: number,
 *   brandColorHex?: string, accentHex?: string,
 *   audio?: { voiceoverPath?: string|null, voiceoverStart?: number, voiceoverTempo?: number, musicPath?: string|null },
 *   onStage?: (stage: string) => void,
 * }} plan
 * @returns {Promise<{ buffer: Buffer, durationSec: number, width: number, height: number, fps: number,
 *   audioLayers: string[], sceneModes: string[], timeline: object, placedOverlays: object[], timings: object }>}
 */
export async function renderScreenAd(plan) {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "mac-render-"));
  const t0 = Date.now();
  try {
    const fps = pickFps(plan.scenes);
    plan.onStage?.("render_scenes");
    const clips = await renderScenes({ ...plan, fps, workDir });
    const t1 = Date.now();
    const timeline = computeTimeline(plan.scenes, fps);
    plan.onStage?.("composite");
    const composed = await composeVideo(clips, {
      width: plan.width, height: plan.height, workDir, timeline, fps,
      overlays: plan.overlays, accentHex: plan.accentHex,
    });
    const t2 = Date.now();
    plan.onStage?.("mix_audio");
    const mixed = await mixAudio(composed.file, {
      workDir, totalDur: timeline.total,
      sceneAudio: clips.map((c, i) => (c.audioPath ? { path: c.audioPath, start: timeline.starts[i], durationSec: c.durationSec } : null)).filter(Boolean),
      voiceoverPath: plan.audio?.voiceoverPath || null,
      voiceoverStart: plan.audio?.voiceoverStart ?? 0.25,
      voiceoverTempo: plan.audio?.voiceoverTempo ?? 1,
      musicPath: plan.audio?.musicPath || null,
    });
    const buffer = await fs.readFile(/*turbopackIgnore: true*/ mixed.file);
    const p = await probe(mixed.file);
    return {
      buffer, durationSec: p.durationSec || timeline.total, width: plan.width, height: plan.height, fps,
      audioLayers: mixed.layers, sceneModes: clips.map((c) => c.mode), timeline, placedOverlays: composed.placed,
      timings: { scenesMs: t1 - t0, compositeMs: t2 - t1, audioMs: Date.now() - t2 },
    };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

export const _internal = { motionForScene, overlayStyle, normalizeHex, ffColor, sceneStarts, XFADE, transitionAfter, computeTimeline };
