/**
 * Ad renderer (ffmpeg). Turns resolved scenes + exact copy + audio stems into a
 * finished MP4.
 *
 * Per scene:
 *   - generated footage (videoPath): baked-in letterbox bars are detected and
 *     cropped, then the clip is cover-fit to the frame; its native ambient
 *     audio is kept as a stem;
 *   - tall website/app screenshot: scrolled like a phone screen recording;
 *   - other real image: fitted over a blurred fill of itself, with Ken Burns;
 *   - end card / no image: the previous shot's last frame, blurred and tinted
 *     with the brand colour (a branded gradient when there is no prior shot).
 * Then: crossfades, a legibility scrim, timed copy overlays that fade/slide in,
 * and an audio mix (voiceover over a ducked music bed + ambient stems,
 * loudness-normalised for social). Copy is always deterministic text; models
 * never draw it. Real assets are never faked: no image → no product shot.
 */

import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import sharp from "sharp";
import { runFfmpeg, probe, probeStreams } from "./ffmpeg.js";
import { renderTextPng } from "./textImage.js";

// Ken Burns moves (zoompan driven by output frame index `on`).
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

const FPS = 30;
export const XFADE = 0.35; // seconds crossfade between scenes
const X264 = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-r", String(FPS)];

/** Start time of each scene on the final (crossfaded) timeline. */
export function sceneStarts(durs) {
  const starts = [];
  let acc = 0;
  durs.forEach((d, i) => {
    starts.push(Number(Math.max(0, acc - i * XFADE).toFixed(3)));
    acc += d;
  });
  return starts;
}

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

/**
 * @returns {Promise<{ path: string, durationSec: number, audioPath: string|null, mode: string }[]>}
 */
async function renderScenes(spec) {
  const { width, height, workDir } = spec;
  const bg = normalizeHex(spec.brandColorHex) || "#0b0d10";
  const clips = [];
  const scrollOffsets = new Map(); // tall screenshot reused → continue the scroll

  for (let i = 0; i < spec.scenes.length; i++) {
    const scene = spec.scenes[i];
    const dur = Math.max(1.2, Number(scene.durationSec) || 2.5);
    const out = path.join(workDir, `scene_${i}.mp4`);
    const frames = Math.round(dur * FPS);
    let audioPath = null;
    let mode;

    if (scene.videoPath) {
      mode = "footage";
      const src = await probe(scene.videoPath);
      const box = await detectContentBox(scene.videoPath, src.width, src.height);
      const vf = [
        box ? `crop=${box.w}:${box.h}:${box.x}:${box.y}` : null,
        `scale=${width}:${height}:force_original_aspect_ratio=increase`,
        `crop=${width}:${height}`,
        "setsar=1",
        `fps=${FPS}`,
        `tpad=stop_mode=clone:stop_duration=${dur}`,
      ].filter(Boolean).join(",");
      await runFfmpeg(["-y", "-i", scene.videoPath, "-an", "-vf", vf, "-frames:v", String(frames), ...X264, out]);
      if (box) scene.cropped = box;
      const streams = await probeStreams(scene.videoPath);
      if (streams.hasAudio) {
        audioPath = path.join(workDir, `scene_${i}.wav`);
        await runFfmpeg(["-y", "-i", scene.videoPath, "-vn",
          "-af", `aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=0:${dur.toFixed(3)}`,
          audioPath]);
      }
    } else if (scene.imagePath) {
      const meta = await sharp(scene.imagePath).metadata().catch(() => ({}));
      if (isTallScreenImage(meta, width, height)) {
        // Website / app screenshot → a real screen recording feel: the page
        // scrolls (eased) inside a rounded device card floating on the brand
        // backdrop, leaving clear space above it for the caption.
        mode = "screen_scroll";
        const card = screenCardBox(width, height);
        const scaledH = Math.round((meta.height * card.w) / meta.width);
        // ~0.38 card-heights/second keeps the page readable; a second shot on
        // the same screenshot continues from where the previous one stopped.
        const from = Math.min(scrollOffsets.get(scene.imagePath) || 0, Math.max(0, scaledH - card.h));
        const travel = Math.max(0, Math.min(scaledH - card.h - from, Math.round(card.h * 0.38 * dur)));
        scrollOffsets.set(scene.imagePath, from + travel);
        const yExpr = `${from}+${travel}*(0.5-0.5*cos(PI*min(t,${dur.toFixed(3)})/${dur.toFixed(3)}))`;
        const stage = path.join(workDir, `stage_${i}.png`);
        const mask = path.join(workDir, `mask_${i}.png`);
        await renderScreenStage(stage, mask, { width, height, card, bg, accent: spec.accentHex, seed: i });
        const fc =
          `[1:v]scale=${card.w}:-2,crop=${card.w}:${card.h}:0:'${yExpr}',format=rgba[scr];` +
          `[2:v]format=gray,scale=${card.w}:${card.h}[m];` +
          `[scr][m]alphamerge[card];` +
          `[0:v][card]overlay=${card.x}:${card.y}:format=auto,setsar=1,fps=${FPS}[v]`;
        await runFfmpeg(["-y",
          "-loop", "1", "-framerate", String(FPS), "-t", String(dur), "-i", stage,
          "-loop", "1", "-framerate", String(FPS), "-t", String(dur), "-i", scene.imagePath,
          "-loop", "1", "-framerate", String(FPS), "-t", String(dur), "-i", mask,
          "-filter_complex", fc, "-map", "[v]", "-frames:v", String(frames), ...X264, out]);
      } else {
        // Real image → fitted over a blurred fill of itself + Ken Burns.
        mode = "image";
        const move = KEN_BURNS[motionForScene(scene, i)];
        const fg = `scale=${Math.round(width * 0.92)}:${Math.round(height * 0.92)}:force_original_aspect_ratio=decrease`;
        const fc =
          `[0:v]split=2[a][b];` +
          `[a]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},gblur=sigma=28,eq=brightness=-0.14[bgv];` +
          `[b]${fg}[fgv];` +
          `[bgv][fgv]overlay=(W-w)/2:(H-h)/2,setsar=1,scale=${width * 2}:${height * 2},` +
          `zoompan=z='${zoomExpr(move.z0, move.z1, frames)}':x='${move.px(frames)}':y='${move.py(frames)}':d=1:s=${width}x${height}:fps=${FPS}[v]`;
        await runFfmpeg(["-y", "-loop", "1", "-framerate", String(FPS), "-t", String(dur), "-i", scene.imagePath,
          "-filter_complex", fc, "-map", "[v]", "-frames:v", String(frames), ...X264, out]);
      }
    } else {
      // End card / text-only shot. Prefer the previous shot's last frame,
      // blurred + brand-tinted (visual continuity); else a branded gradient.
      const prev = clips[clips.length - 1];
      const backdrop = prev ? await lastFrame(prev.path, path.join(workDir, `last_${i}.png`)) : null;
      const move = KEN_BURNS[scene?.purpose === "end" ? "zoom_out" : "zoom_in"];
      const zp = `zoompan=z='${zoomExpr(move.z0, move.z1, frames)}':x='${move.px(frames)}':y='${move.py(frames)}':d=1:s=${width}x${height}:fps=${FPS}`;
      let input, vf;
      if (backdrop) {
        mode = "endcard_backdrop";
        input = backdrop;
        // Darken in proportion to how bright the last frame is, so the white
        // brand title and CTA keep their contrast on daylight footage too.
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
        await renderGradientCard(input, { width, height, bg, accent: spec.accentHex, seed: i });
        vf = [`scale=${width}:${height}`, "setsar=1", zp].join(",");
      }
      await runFfmpeg(["-y", "-loop", "1", "-framerate", String(FPS), "-t", String(dur), "-i", input,
        "-vf", vf, "-frames:v", String(frames), ...X264, out]);
    }
    clips.push({ path: out, durationSec: dur, audioPath, mode });
  }
  return clips;
}

/** Concatenate scene clips with crossfades into one silent video. */
async function concatWithXfade(clips, { workDir }) {
  if (clips.length === 1) return clips[0].path;
  const out = path.join(workDir, "concat.mp4");
  const inputs = [];
  for (const c of clips) inputs.push("-i", c.path);
  const durs = [];
  for (const c of clips) durs.push((await probe(c.path)).durationSec || c.durationSec);

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
  await runFfmpeg(["-y", ...inputs, "-filter_complex", filter, "-map", "[vout]", ...X264, out]);
  return out;
}

/** Top + bottom gradient scrim so white copy stays legible over any footage. */
async function renderScrim(outPath, { width, height }) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs>
      <linearGradient id="t" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#000" stop-opacity="0.5"/><stop offset="1" stop-color="#000" stop-opacity="0"/>
      </linearGradient>
      <linearGradient id="b" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.62"/>
      </linearGradient>
    </defs>
    <rect x="0" y="0" width="${width}" height="${Math.round(height * 0.16)}" fill="url(#t)"/>
    <rect x="0" y="${Math.round(height * 0.5)}" width="${width}" height="${height - Math.round(height * 0.5)}" fill="url(#b)"/>
  </svg>`;
  await fs.writeFile(outPath, await sharp(Buffer.from(svg)).png().toBuffer());
}

/**
 * Burn the scrim + timed copy overlays. Each overlay is a transparent PNG
 * (exact text, vendored font) that fades in/out and, for captions/CTA, slides
 * up a few pixels as it enters.
 */
async function burnOverlays(videoIn, o) {
  const { width, height, workDir, totalDur } = o;
  const list = (o.overlays || []).filter((ov) => ov.text && String(ov.text).trim());
  const out = path.join(workDir, "composited.mp4");
  const T = Math.max(0.5, totalDur).toFixed(3);
  const inputs = ["-i", videoIn];
  const scrim = path.join(workDir, "scrim.png");
  await renderScrim(scrim, { width, height });
  inputs.push("-loop", "1", "-framerate", String(FPS), "-t", T, "-i", scrim);

  let filter = `[0:v][1:v]overlay=0:0:format=auto[s0];`;
  let prev = "s0";
  let idx = 2;
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
    inputs.push("-loop", "1", "-framerate", String(FPS), "-t", T, "-i", pngPath);
    const start = Math.max(0, Number(ov.start) || 0);
    const end = Math.max(start + 0.3, Number(ov.end) || totalDur);
    const fin = 0.22;
    const fout = Math.min(0.22, (end - start) / 3);
    const x = style.xExpr(png.width, width);
    const y = style.yExpr(png.height, height);
    const yExpr = style.slide ? `${y}+${Math.round(height * 0.012)}*max(0,1-(t-${start.toFixed(2)})/0.3)` : String(y);
    const last = k === list.length - 1;
    filter +=
      `[${idx}:v]format=rgba,fade=t=in:st=${start.toFixed(2)}:d=${fin}:alpha=1,` +
      `fade=t=out:st=${(end - fout).toFixed(2)}:d=${fout.toFixed(2)}:alpha=1[t${k}];` +
      `[${prev}][t${k}]overlay=x=${x}:y='${yExpr}':eval=frame:enable='between(t,${start.toFixed(2)},${end.toFixed(2)})'` +
      `${last ? "[vout]" : `[o${k}]`};`;
    prev = last ? "vout" : `o${k}`;
    idx++;
  }
  if (!list.length) filter = filter.replace(/\[s0\];$/, "[vout];");
  filter = filter.replace(/;$/, "");
  await runFfmpeg(["-y", ...inputs, "-filter_complex", filter, "-map", "[vout]", "-t", T, ...X264, out], { timeoutMs: 240_000 });
  return out;
}

/**
 * Mix the soundtrack: voiceover on top, music bed ducked under it, ambient
 * stems from generated footage underneath; loudness-normalised (-14 LUFS).
 * Missing stems are simply absent; with nothing at all the track is silent.
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
  const ambientGain = hasVo ? 0.32 : 0.75;
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
    filter += `[${n}:a]${fmt},${tempo > 1.001 ? `atempo=${tempo.toFixed(3)},` : ""}adelay=${ms}|${ms},volume=1.0,asplit=2[vo][voside];`;
    parts.push("[vo]");
    voSide = "[voside]";
    layers.push("voiceover");
    n++;
  }

  if (musicPath) {
    inputs.push("-i", musicPath);
    const fadeOutSt = Math.max(0, T - 1.2).toFixed(2);
    filter += `[${n}:a]${fmt},atrim=0:${T.toFixed(3)},afade=t=in:d=0.5,afade=t=out:st=${fadeOutSt}:d=1.2,volume=${hasVo ? 0.42 : 0.7}[mus];`;
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
    "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-t", T.toFixed(3), "-movflags", "+faststart", out], { timeoutMs: 180_000 });
  return { file: out, layers };
}

/**
 * Visual spec per overlay kind → PNG params + ffmpeg x/y expressions.
 */
function overlayStyle(kind, { width, accent }) {
  const unit = Math.round(width / 22); // base type unit scaled to frame width
  const accentCss = normalizeHex(accent);
  // CTA pill: brand accent with legible text; neutral white pill when the brand
  // has no vivid colour (never an invented brand colour).
  const pillBg = accentCss || "#ffffff";
  // Text colour with the higher WCAG contrast against the pill.
  const lum = relLuminance(pillBg);
  const pillFg = (lum + 0.05) / 0.0556 >= 1.05 / (lum + 0.05) ? "#111111" : "#ffffff";
  const centerX = (pw, w) => Math.round((w - pw) / 2);
  switch (kind) {
    case "brand":
      return {
        fontSize: Math.round(unit * 0.95), weight: 700, color: "#ffffff", align: "left", maxWidthPct: 0.7,
        bg: null, shadow: true, slide: false,
        xExpr: () => Math.round(width * 0.055), yExpr: (ph, h) => Math.round(h * 0.04),
      };
    case "brandTitle":
      return {
        fontSize: Math.round(unit * 2.1), weight: 700, color: "#ffffff", align: "center", maxWidthPct: 0.88,
        bg: null, shadow: true, slide: true,
        xExpr: centerX, yExpr: (ph, h) => Math.round(h * 0.4 - ph / 2),
      };
    case "headline":
    case "shot":
      return {
        fontSize: Math.round(unit * 1.42), weight: 700, color: "#ffffff", align: "center", maxWidthPct: 0.86,
        bg: null, shadow: true, slide: true,
        xExpr: centerX, yExpr: (ph, h) => Math.round(h * 0.67 - ph / 2),
      };
    case "shotTop":
      // Caption for screen-footage shots: in the clear band above the device card.
      return {
        fontSize: Math.round(unit * 1.3), weight: 700, color: "#ffffff", align: "center", maxWidthPct: 0.88,
        bg: null, shadow: true, slide: true,
        xExpr: centerX, yExpr: (ph, h) => Math.round(h * 0.125 - ph / 2),
      };
    case "shotLow":
      // Caption for real product-photo shots: the lower band, clear of the product.
      return {
        fontSize: Math.round(unit * 1.35), weight: 700, color: "#ffffff", align: "center", maxWidthPct: 0.88,
        bg: null, shadow: true, slide: true,
        xExpr: centerX, yExpr: (ph, h) => Math.round(h * 0.865 - ph / 2),
      };
    case "offer":
      return {
        fontSize: Math.round(unit * 1.0), weight: 700, color: "#ffffff", align: "center", maxWidthPct: 0.84,
        bg: null, shadow: true, slide: true,
        xExpr: centerX, yExpr: (ph, h) => Math.round(h * 0.52 - ph / 2),
      };
    case "cta":
      return {
        fontSize: Math.round(unit * 1.12), weight: 700, color: pillFg, align: "center", maxWidthPct: 0.92,
        bg: pillBg, radius: 999, shadow: false, slide: true,
        xExpr: centerX, yExpr: (ph, h) => Math.round(h * 0.64 - ph / 2),
      };
    case "url":
      return {
        fontSize: Math.round(unit * 0.78), weight: 400, color: "#ffffff", align: "center", maxWidthPct: 0.8,
        bg: null, shadow: true, slide: false,
        xExpr: centerX, yExpr: (ph, h) => Math.round(h * 0.74 - ph / 2),
      };
    default:
      return {
        fontSize: unit, weight: 400, color: "#ffffff", align: "center", maxWidthPct: 0.8,
        bg: null, shadow: true, slide: false,
        xExpr: centerX, yExpr: (ph, h) => Math.round(h * 0.82),
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
 * A screenshot is "a tall screen" (scrollable page) when, fitted to the frame
 * width, it is noticeably taller than the frame. Shared with the compositor so
 * caption placement matches what the renderer does.
 */
export function isTallScreenImage(meta, width, height) {
  if (!meta?.width || !meta?.height) return false;
  return (meta.height * width) / meta.width > height * 1.25;
}

/** Device-card rectangle for screen footage (caption band stays above it). */
function screenCardBox(width, height) {
  const w = Math.round((width * 0.8) / 2) * 2;
  const h = Math.round((height * 0.73) / 2) * 2;
  return { w, h, x: Math.round((width - w) / 2), y: Math.round(height * 0.205), r: Math.round(width * 0.045) };
}

/** Backdrop (brand gradient + soft card shadow) and the card's rounded alpha mask. */
async function renderScreenStage(stagePath, maskPath, { width, height, card, bg, accent, seed }) {
  const gradient = path.join(path.dirname(stagePath), `stagebg_${seed}.png`);
  await renderGradientCard(gradient, { width, height, bg, accent, seed: seed + 7 });
  const shadow = await sharp(Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<rect x="${card.x}" y="${card.y + Math.round(height * 0.011)}" width="${card.w}" height="${card.h}" rx="${card.r}" ry="${card.r}" fill="#000" fill-opacity="0.55"/></svg>`
  )).blur(Math.max(2, Math.round(width * 0.025))).png().toBuffer();
  await sharp(gradient)
    .composite([{ input: shadow, left: 0, top: 0 }])
    .png().toFile(stagePath);
  await sharp(Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${card.w}" height="${card.h}">` +
    `<rect width="${card.w}" height="${card.h}" fill="#000"/>` +
    `<rect width="${card.w}" height="${card.h}" rx="${card.r}" ry="${card.r}" fill="#fff"/></svg>`
  )).png().toFile(maskPath);
}

/** Branded gradient background card (used only when there is no prior shot). */
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
 * }} plan
 * @returns {Promise<{ buffer: Buffer, durationSec: number, width: number, height: number,
 *   audioLayers: string[], sceneModes: string[] }>}
 */
export async function renderScreenAd(plan) {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "mac-render-"));
  try {
    const clips = await renderScenes({ ...plan, workDir });
    const concatenated = await concatWithXfade(clips, { workDir });
    const durs = clips.map((c) => c.durationSec);
    const totalDur = durs.reduce((a, d) => a + d, 0) - XFADE * (clips.length - 1);
    const composited = await burnOverlays(concatenated, {
      width: plan.width, height: plan.height, totalDur, workDir,
      overlays: plan.overlays, accentHex: plan.accentHex,
    });
    const starts = sceneStarts(durs);
    const mixed = await mixAudio(composited, {
      workDir, totalDur,
      sceneAudio: clips.map((c, i) => (c.audioPath ? { path: c.audioPath, start: starts[i], durationSec: c.durationSec } : null)).filter(Boolean),
      voiceoverPath: plan.audio?.voiceoverPath || null,
      voiceoverStart: plan.audio?.voiceoverStart ?? 0.25,
      voiceoverTempo: plan.audio?.voiceoverTempo ?? 1,
      musicPath: plan.audio?.musicPath || null,
    });
    const buffer = await fs.readFile(mixed.file);
    const p = await probe(mixed.file);
    return {
      buffer, durationSec: p.durationSec || totalDur, width: plan.width, height: plan.height,
      audioLayers: mixed.layers, sceneModes: clips.map((c) => c.mode),
    };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

export const _internal = { motionForScene, overlayStyle, normalizeHex, ffColor, sceneStarts, XFADE };
