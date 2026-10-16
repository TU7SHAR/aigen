/**
 * Thin wrapper around the bundled static ffmpeg/ffprobe binaries.
 *
 * We use `ffmpeg-static` / `ffprobe-static` so the compositor works with NO
 * system ffmpeg install (portable across the user's machine and CI). This is
 * the DETERMINISTIC rendering backend — it composes real assets + exact text
 * overlays into a finished MP4. It never calls a paid generative video model.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

/**
 * Resolve a bundled static binary robustly at RUNTIME.
 *
 * `ffmpeg-static`/`ffprobe-static` export an absolute path computed at import
 * time. Next's build (output tracing/standalone) can rewrite that string to a
 * placeholder like `/ROOT/node_modules/...` that does not exist at runtime →
 * ENOENT. So we don't trust the exported path blindly: we try it, then fall
 * back to resolving the real file under node_modules via require.resolve, then
 * to an explicit env override.
 *
 * @param {string|undefined} exportedPath value from the *-static package
 * @param {string} pkg package name to resolve against
 * @param {string} binRel binary filename ("ffmpeg"/"ffmpeg.exe")
 * @param {string|undefined} envOverride explicit path from env
 */
function resolveStaticBinary(exportedPath, pkg, binRel, envOverride) {
  if (envOverride && existsSync(envOverride)) return envOverride;
  if (exportedPath && existsSync(exportedPath)) return exportedPath;
  // Fall back: locate the package on disk and join the binary name.
  try {
    const pkgJson = require.resolve(`${pkg}/package.json`);
    const dir = path.dirname(pkgJson);
    const candidates = [
      exportedPath ? path.join(dir, path.basename(exportedPath)) : null,
      path.join(dir, binRel),
      path.join(dir, "bin", binRel),
    ].filter(Boolean);
    for (const c of candidates) if (existsSync(c)) return c;
  } catch {
    /* ignore */
  }
  return null;
}

export function ffmpegBinary() {
  const isWin = process.platform === "win32";
  const bin = resolveStaticBinary(ffmpegPath, "ffmpeg-static", isWin ? "ffmpeg.exe" : "ffmpeg", process.env.FFMPEG_PATH);
  if (!bin) {
    throw new Error(
      "ffmpeg binary not found (ffmpeg-static). Run `npm install`, or set FFMPEG_PATH to a valid ffmpeg binary."
    );
  }
  return bin;
}

export function ffprobeBinary() {
  const isWin = process.platform === "win32";
  const bin = resolveStaticBinary(ffprobeStatic?.path, "ffprobe-static", isWin ? "ffprobe.exe" : "ffprobe", process.env.FFPROBE_PATH);
  if (!bin) {
    throw new Error(
      "ffprobe binary not found (ffprobe-static). Run `npm install`, or set FFPROBE_PATH to a valid ffprobe binary."
    );
  }
  return bin;
}

/**
 * Run ffmpeg with the given args. Rejects with stderr tail on non-zero exit.
 * @param {string[]} args
 * @param {{ timeoutMs?: number }} [opts]
 */
export async function runFfmpeg(args, opts = {}) {
  try {
    const { stderr } = await execFileAsync(ffmpegBinary(), args, {
      timeout: opts.timeoutMs ?? 120_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { stderr };
  } catch (err) {
    const tail = String(err?.stderr || err?.message || "").split("\n").slice(-12).join("\n");
    throw new Error(`ffmpeg failed: ${tail}`);
  }
}

/** Which stream types a media file has → { hasVideo, hasAudio, audioDurationSec }. */
export async function probeStreams(file) {
  try {
    const { stdout } = await execFileAsync(
      ffprobeBinary(),
      ["-v", "error", "-show_entries", "stream=codec_type,duration:format=duration", "-of", "json", file],
      { timeout: 20_000 }
    );
    const j = JSON.parse(stdout);
    const streams = Array.isArray(j.streams) ? j.streams : [];
    const a = streams.find((s) => s.codec_type === "audio");
    return {
      hasVideo: streams.some((s) => s.codec_type === "video"),
      hasAudio: Boolean(a),
      audioDurationSec: a ? Number(a.duration) || Number(j.format?.duration) || null : null,
    };
  } catch {
    return { hasVideo: false, hasAudio: false, audioDurationSec: null };
  }
}

/** Probe a media file → { durationSec, width, height } (best-effort). */
export async function probe(file) {
  try {
    const { stdout } = await execFileAsync(
      ffprobeBinary(),
      ["-v", "error", "-select_streams", "v:0", "-show_entries",
        "stream=width,height:format=duration", "-of", "json", file],
      { timeout: 20_000 }
    );
    const j = JSON.parse(stdout);
    const s = j.streams?.[0] || {};
    return { durationSec: Number(j.format?.duration) || null, width: s.width || null, height: s.height || null };
  } catch {
    return { durationSec: null, width: null, height: null };
  }
}

/** Frame size for an aspect ratio at a given short-edge resolution. */
export function frameSize(aspectRatio, resolution = "720p") {
  const shortEdge = resolution === "1080p" ? 1080 : resolution === "360p" ? 360 : 720;
  // 9:16 portrait → width is the short edge; 16:9 → height is the short edge.
  if (aspectRatio === "16:9") {
    const h = shortEdge, w = Math.round((h * 16) / 9);
    return { width: even(w), height: even(h) };
  }
  // default 9:16
  const w = shortEdge, h = Math.round((w * 16) / 9);
  return { width: even(w), height: even(h) };
}

function even(n) {
  n = Math.round(n);
  return n % 2 === 0 ? n : n + 1;
}
