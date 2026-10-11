/**
 * Resolve a reference-asset URL into { data(base64), mimeType } for a video
 * provider request. Extracted from the generate route so it's unit-testable
 * without pulling in Next's server runtime.
 *
 *   - Local stored asset (/imported-assets/..): read from the public dir
 *     (basename-only to prevent path traversal).
 *   - Remote http(s) URL: SSRF-safe fetch.
 *
 * Returns null on any failure (caller proceeds without a reference — honest
 * text-to-video rather than claiming an image was used).
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { safeFetch } from "../crawl/safeFetch.js";

const REF_MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

/**
 * @param {string} url
 * @returns {Promise<{ data: string, mimeType: string } | null>}
 */
export async function resolveReferenceAsset(url) {
  if (!url || typeof url !== "string") return null;
  try {
    if (url.startsWith("/imported-assets/")) {
      const safeName = path.basename(url); // prevent traversal
      const full = path.join(process.cwd(), "public", "imported-assets", safeName);
      const buf = await fs.readFile(full);
      const mime = REF_MIME[path.extname(safeName).toLowerCase()] || "image/png";
      if (mime === "image/svg+xml") return null; // raster-only for the model
      return { data: buf.toString("base64"), mimeType: mime };
    }
    if (/^https?:\/\//i.test(url)) {
      const res = await safeFetch(url, { accept: "image/*", asBuffer: true, maxBytes: 8 * 1024 * 1024, timeoutMs: 10_000 });
      const mime = (res.contentType || "").split(";")[0].trim().toLowerCase();
      if (!mime.startsWith("image/") || mime === "image/svg+xml") return null;
      if (!(res.body instanceof Buffer)) return null;
      return { data: res.body.toString("base64"), mimeType: mime };
    }
  } catch {
    return null;
  }
  return null;
}
