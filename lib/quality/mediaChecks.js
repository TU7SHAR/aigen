/**
 * Automated checks on the EXPORTED file (not the JSON plan).
 *
 * Kept separate on purpose:
 *   technical — decodes, format/duration, black frames, unintended freezes,
 *               loudness, clipping, dead air during narration, truncation
 *   factual   — CTA destination, requested footage actually produced,
 *               numeric claims vs evidence (from the plan check)
 *   language  — captions/voiceover script and language vs the profile,
 *               glyph coverage of every rendered caption
 *   creative  — NOT judged here (needs watching/listening; see review)
 * Passing these checks is necessary, not sufficient, for a good ad.
 */

import { runFfmpeg, probe, probeStreams } from "../render/ffmpeg.js";
import { checkGlyphCoverage } from "../i18n/scripts.js";
import { checkCopyLanguage, normalizeLanguageProfile } from "../i18n/profile.js";
import { isAdOrTrackerHost } from "../creative/destination.js";

const finding = (level, code, message, extra = {}) => ({ level, code, message, ...extra });

/** One decode pass: blackdetect + freezedetect + silencedetect + ebur128. */
export async function analyzeMedia(file) {
  let stderr = "";
  try {
    ({ stderr } = await runFfmpeg([
      "-hide_banner", "-nostats", "-i", file,
      "-vf", "blackdetect=d=0.4:pix_th=0.08,freezedetect=n=-55dB:d=1.3",
      "-af", "silencedetect=n=-42dB:d=0.9,ebur128=peak=true",
      "-f", "null", "-",
    ], { timeoutMs: 180_000 }));
  } catch (err) {
    return { error: String(err?.message || err).slice(0, 300) };
  }
  const s = String(stderr);
  const black = [...s.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)/g)].map((m) => ({ start: +m[1], end: +m[2] }));
  const freezes = [];
  const fs = [...s.matchAll(/freeze_start:\s*([\d.]+)/g)].map((m) => +m[1]);
  const fe = [...s.matchAll(/freeze_end:\s*([\d.]+)/g)].map((m) => +m[1]);
  fs.forEach((start, i) => freezes.push({ start, end: fe[i] ?? null }));
  const silences = [];
  const ss = [...s.matchAll(/silence_start:\s*(-?[\d.]+)/g)].map((m) => Math.max(0, +m[1]));
  const se = [...s.matchAll(/silence_end:\s*([\d.]+)/g)].map((m) => +m[1]);
  ss.forEach((start, i) => silences.push({ start, end: se[i] ?? null }));
  const summary = s.slice(s.lastIndexOf("Summary:"));
  const lufs = summary.match(/I:\s*(-?[\d.]+)\s*LUFS/);
  const peak = summary.match(/Peak:\s*(-?[\d.]+|-inf)\s*dBFS/);
  return {
    black, freezes, silences,
    integratedLufs: lufs ? +lufs[1] : null,
    truePeakDb: peak && peak[1] !== "-inf" ? +peak[1] : null,
  };
}

/**
 * @param {{ file: string, composed: object, input: object, compiled: object }} args
 */
export async function runMediaChecks({ file, composed, input, compiled }) {
  const technical = [];
  const factual = [];
  const language = [];
  const p = await probe(file);
  const streams = await probeStreams(file);
  if (!streams.hasVideo) technical.push(finding("error", "NO_VIDEO_STREAM", "The export has no video stream."));
  if (p.width !== composed.width || p.height !== composed.height) {
    technical.push(finding("error", "WRONG_SIZE", `Export is ${p.width}x${p.height}, expected ${composed.width}x${composed.height}.`));
  }
  const expected = composed.timeline?.total || composed.durationSec;
  if (p.durationSec && expected && Math.abs(p.durationSec - expected) > 0.6) {
    technical.push(finding("warning", "DURATION_MISMATCH", `Export is ${p.durationSec.toFixed(2)}s; the edit timeline is ${expected.toFixed(2)}s.`));
  }

  const a = await analyzeMedia(file);
  if (a.error) technical.push(finding("warning", "ANALYSIS_FAILED", `Media analysis failed: ${a.error}`));
  const tl = composed.timeline || { starts: [], durs: [] };
  const lastStart = tl.starts?.[tl.starts.length - 1] ?? expected;
  for (const b of a.black || []) {
    if (b.end - b.start >= 0.4 && b.start < lastStart - 0.2) technical.push(finding("error", "BLACK_FRAMES", `Black/blank picture from ${b.start.toFixed(1)}s to ${b.end.toFixed(1)}s.`));
  }
  for (const f of a.freezes || []) {
    const end = f.end ?? expected;
    if (end - f.start >= 1.3 && f.start < lastStart - 0.3) {
      const shot = (tl.starts || []).findIndex((st, i) => f.start >= st && f.start < st + (tl.durs?.[i] || 0)) + 1;
      technical.push(finding("warning", "FROZEN_PICTURE", `Picture is frozen for ${(end - f.start).toFixed(1)}s from ${f.start.toFixed(1)}s${shot ? ` (shot ${shot})` : ""} — watch that shot; generated footage may have stalled or the shot is missing.`, { shot: shot || null }));
    }
  }
  const assembly = composed.assembly || null;
  if (assembly?.fallbackFrom?.length) {
    technical.push(finding("warning", "TRANSITIONS_REPLACED", `Shot ${assembly.fallbackFrom.map((m) => m.shot).join(", ")} was missing from the first assembly, so the edit was rebuilt with hard cuts; every shot was then verified on screen.`));
  }
  const audioDetail = composed.quality?.audioDetail || {};
  const vo = audioDetail.voiceover;
  if (!streams.hasAudio) technical.push(finding("error", "NO_AUDIO_STREAM", "The export has no audio stream."));
  if (a.integratedLufs != null) {
    if (a.integratedLufs < -20) technical.push(finding("warning", "TOO_QUIET", `Loudness ${a.integratedLufs} LUFS is far below the -14 LUFS target.`));
    if (a.integratedLufs > -10) technical.push(finding("warning", "TOO_LOUD", `Loudness ${a.integratedLufs} LUFS is above the -14 LUFS target.`));
  }
  if (a.truePeakDb != null && a.truePeakDb > -0.5) technical.push(finding("warning", "CLIPPING_RISK", `Peak ${a.truePeakDb} dBFS — risk of clipping.`));
  if (vo?.durationSec) {
    const voStart = 0.25;
    const voEnd = voStart + vo.durationSec / Math.max(1, composed.voiceoverTempo || 1);
    if (voEnd > (p.durationSec || expected) + 0.05) technical.push(finding("error", "NARRATION_TRUNCATED", `Narration runs to ${voEnd.toFixed(1)}s but the video ends at ${(p.durationSec || expected).toFixed(1)}s.`));
    for (const sil of a.silences || []) {
      const end = sil.end ?? expected;
      if (sil.start > voStart + 0.3 && end < voEnd - 0.3 && end - sil.start > 1.2) {
        technical.push(finding("warning", "DEAD_AIR", `Near-silence for ${(end - sil.start).toFixed(1)}s at ${sil.start.toFixed(1)}s during the narration.`));
      }
    }
    if ((composed.voiceoverTempo || 1) > 1.08) technical.push(finding("warning", "FAST_NARRATION", `Narration was sped up ${(composed.voiceoverTempo).toFixed(2)}× to fit; consider a shorter script.`));
  } else if (input.narration !== false) {
    technical.push(finding("warning", "NO_NARRATION", `No voiceover in the export. ${(audioDetail.notes || []).join("; ")}`.trim()));
  }

  // Captions as actually placed in the frame.
  const H = composed.height;
  for (const ov of composed.placedOverlays || []) {
    const cov = checkGlyphCoverage(ov.text);
    if (!cov.ok) language.push(finding("error", "MISSING_GLYPHS", `Caption "${ov.text.slice(0, 40)}" has characters no font can draw: ${cov.missing.join(" ")}`));
    if (ov.y < 0 || ov.y + ov.h > H) technical.push(finding("error", "CAPTION_OUT_OF_FRAME", `Caption "${ov.text.slice(0, 40)}" extends outside the frame.`));
    else if (["shot", "shotLow", "headline"].includes(ov.kind) && ov.y + ov.h > H * 0.82) technical.push(finding("warning", "CAPTION_UNSAFE_AREA", `Caption "${ov.text.slice(0, 40)}" sits in the bottom area covered by app UI.`));
  }

  // Language of the copy that was rendered/spoken.
  const profile = normalizeLanguageProfile(input.language);
  const lang = checkCopyLanguage(profile, {
    voiceover: (composed.shotReport || []).map((s) => s.voiceover),
    captions: (composed.shotReport || []).map((s) => s.onScreenText),
  });
  for (const f of lang.findings) language.push(finding(f.level, "LANGUAGE", `${f.message} (confidence: ${f.confidence})`));

  // Factual: requested footage, destination, plan claims.
  const q = composed.quality || {};
  if ((q.requestedVideoShots || 0) > (q.aiVideoShots || 0)) {
    factual.push(finding("error", "FOOTAGE_MISSING", `${q.requestedVideoShots - q.aiVideoShots} requested AI-video shot(s) were not generated; the export substitutes other visuals.`));
  }
  try {
    if (input.destinationUrl && isAdOrTrackerHost(new URL(input.destinationUrl).hostname)) factual.push(finding("error", "BAD_DESTINATION", "The CTA destination is an ad/tracking host."));
  } catch { /* no destination */ }
  for (const f of compiled?.scenePlan?.validation?.findings || []) {
    if (f.code === "UNSUPPORTED_CLAIM") factual.push(finding("error", "UNSUPPORTED_CLAIM", f.message));
  }

  const status = (list) => (list.some((f) => f.level === "error") ? "fail" : list.length ? "warn" : "pass");
  return {
    basis: "automated checks on the exported MP4; they do not judge persuasiveness, product accuracy in motion or polish",
    technical: { status: status(technical), findings: technical, measurements: { durationSec: p.durationSec, width: p.width, height: p.height, integratedLufs: a.integratedLufs ?? null, truePeakDb: a.truePeakDb ?? null, shotsVerifiedOnScreen: assembly?.checkedShots ?? null, joinMode: assembly?.joinMode ?? null } },
    factual: { status: status(factual), findings: factual },
    language: { status: status(language), findings: language, profile },
    creative: { status: "not_reviewed", note: "Watch and listen before publishing; an optional model-assisted review can be requested from the job page." },
  };
}
