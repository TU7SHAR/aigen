/**
 * Verified asset lifecycle.
 *
 *   discovered → downloaded → decoded → validated → (classified) → stored → ready
 *
 * A discovered URL is NOT a usable image. This module actually downloads the
 * bytes (SSRF-safe), decodes them with sharp to confirm they're a real image,
 * reads true dimensions/format, rejects tiny/broken/irrelevant assets, and only
 * then marks an asset "generation-ready". SVGs are sanitized + rasterized to a
 * PNG preview so they're usable by raster-only video models.
 *
 * No network calls happen for assets the caller doesn't ask to verify.
 */

import sharp from "sharp";
import { safeFetch, CrawlError } from "../crawl/safeFetch.js";
import { sanitizeSvg } from "./store.js";

const MAX_BYTES = 8 * 1024 * 1024;
// Below this, an image is too small to be a useful video reference (icons,
// favicons, trackers, spacers). Logos are allowed smaller (handled by role).
const MIN_USEFUL_EDGE = 200;
const RASTER_FORMATS = new Set(["jpeg", "jpg", "png", "webp", "gif", "avif"]);

/**
 * @typedef {{
 *   sourceUrl: string,
 *   status: "ready" | "rejected",
 *   reason?: string,
 *   mimeType?: string,
 *   format?: string,
 *   width?: number,
 *   height?: number,
 *   bytes?: number,
 *   isVector?: boolean,
 *   buffer?: Buffer,        // decoded/raster bytes (ready assets only)
 *   rasterBuffer?: Buffer,  // PNG raster for SVGs
 * }} VerifiedAsset
 */

/**
 * Download + verify a single image URL. Returns a VerifiedAsset; never throws
 * for ordinary failures (returns status "rejected" with a reason).
 * @param {string} url
 * @param {{ allowSmall?: boolean }} [opts]
 * @returns {Promise<VerifiedAsset>}
 */
export async function verifyImageUrl(url, opts = {}) {
  let res;
  try {
    res = await safeFetch(url, { accept: "image/*", asBuffer: true, maxBytes: MAX_BYTES, timeoutMs: 10_000 });
  } catch (err) {
    return { sourceUrl: url, status: "rejected", reason: err instanceof CrawlError ? err.code : "fetch_failed" };
  }
  const mime = (res.contentType || "").split(";")[0].trim().toLowerCase();
  if (!mime.startsWith("image/")) {
    return { sourceUrl: url, status: "rejected", reason: `not_an_image (${mime || "unknown"})` };
  }
  const raw = res.body;
  if (!(raw instanceof Buffer) || raw.length === 0) {
    return { sourceUrl: url, status: "rejected", reason: "empty_body" };
  }
  return { ...(await validateImageBuffer(raw, mime, opts)), sourceUrl: url };
}

/**
 * Pure validation of downloaded bytes (no network) — the real decode/validate
 * logic, separated so it's directly testable with buffers. Decodes with sharp,
 * checks format/dimensions/size; sanitizes + rasterizes SVGs.
 * @param {Buffer} raw
 * @param {string} mime
 * @param {{ allowSmall?: boolean }} [opts]
 * @returns {Promise<VerifiedAsset>}
 */
export async function validateImageBuffer(raw, mime, opts = {}) {
  if (!(raw instanceof Buffer) || raw.length === 0) {
    return { status: "rejected", reason: "empty_body" };
  }
  mime = (mime || "").toLowerCase();

  // SVG: sanitize, then rasterize to PNG (so raster-only models can use it).
  if (mime === "image/svg+xml") {
    const clean = Buffer.from(sanitizeSvg(raw.toString("utf8")), "utf8");
    try {
      const png = await sharp(clean, { density: 160 }).png().resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true }).toBuffer();
      const meta = await sharp(png).metadata();
      return {
        status: "ready", mimeType: "image/svg+xml", format: "svg",
        isVector: true, bytes: clean.length, width: meta.width, height: meta.height,
        buffer: clean, rasterBuffer: png,
      };
    } catch (err) {
      return { status: "rejected", reason: `svg_rasterize_failed: ${err?.message || "?"}` };
    }
  }

  if (mime && !mime.startsWith("image/")) {
    return { status: "rejected", reason: `not_an_image (${mime})` };
  }

  let meta;
  try {
    meta = await sharp(raw, { failOn: "truncated" }).metadata();
  } catch {
    return { status: "rejected", reason: "decode_failed" };
  }
  const format = (meta.format || "").toLowerCase();
  if (!RASTER_FORMATS.has(format)) {
    return { status: "rejected", reason: `unsupported_format (${format})` };
  }
  const w = meta.width || 0;
  const h = meta.height || 0;
  if (!w || !h) return { status: "rejected", reason: "no_dimensions" };
  if (!opts.allowSmall && Math.max(w, h) < MIN_USEFUL_EDGE) {
    return { status: "rejected", reason: `too_small (${w}x${h})`, width: w, height: h, format, mimeType: mime };
  }
  return {
    status: "ready", mimeType: mime || `image/${format}`, format,
    width: w, height: h, bytes: raw.length, isVector: false, buffer: raw,
  };
}

/**
 * Verify a ranked list of candidate URLs (best-first), stopping once `limit`
 * usable assets are found. Returns both ready and rejected (for debugging).
 * @param {{ url: string, role?: string, allowSmall?: boolean }[]} candidates
 * @param {{ limit?: number }} [opts]
 */
export async function verifyCandidates(candidates, opts = {}) {
  const limit = opts.limit ?? 8;
  const ready = [];
  const rejected = [];
  for (const c of candidates) {
    if (ready.length >= limit) break;
    const v = await verifyImageUrl(c.url, { allowSmall: c.allowSmall || c.role === "logo" });
    if (v.status === "ready") ready.push({ ...v, role: c.role });
    else rejected.push({ url: c.url, role: c.role, reason: v.reason });
  }
  return { ready, rejected };
}

export { MIN_USEFUL_EDGE };
