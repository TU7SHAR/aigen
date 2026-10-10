/**
 * Asset storage abstraction.
 *
 * We do NOT want to depend on arbitrary remote ecommerce image URLs staying
 * alive. So imported images are downloaded (SSRF-safely) and persisted through
 * an AssetStore, which returns a stable `storedUrl` the app can rely on.
 *
 * IMPLEMENTATIONS:
 *   - LocalAssetStore (default, PROTOTYPE ONLY): writes to
 *     `public/imported-assets/` so Next.js serves them statically. This is
 *     fine for local dev but is NOT durable on ephemeral serverless disk —
 *     files written at runtime on Vercel/Lambda do not persist. See
 *     docs/ARCHITECTURE.md.
 *   - SupabaseAssetStore (STUB): the intended production path (private bucket +
 *     signed URLs). Not implemented yet; the interface is here so it can be
 *     added without touching the import workflow.
 *
 * The contract:
 *   store.save({ buffer, mimeType, sourceUrl }) -> ProductAsset-ish record
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { safeFetch, CrawlError } from "../crawl/safeFetch.js";

const MIME_EXT = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "image/svg+xml": "svg",
};

/**
 * Minimal SVG sanitization: strip <script>, event handlers, external
 * references (xlink:href/href to http(s), <foreignObject>) and entities, so a
 * stored SVG can't execute or fetch remote resources. Not a full sanitizer —
 * for production, use a vetted library (e.g. DOMPurify server-side).
 */
export function sanitizeSvg(svg) {
  return String(svg)
    .replace(/<\?xml[^>]*\?>/gi, "")
    .replace(/<!DOCTYPE[^>]*>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, "")
    .replace(/\son\w+\s*=\s*(".*?"|'.*?'|[^\s>]+)/gi, "") // on* handlers
    .replace(/(xlink:href|href)\s*=\s*(["'])\s*(?:https?:|\/\/)[^"']*\2/gi, "") // external refs
    .replace(/<!ENTITY[\s\S]*?>/gi, "");
}

export class LocalAssetStore {
  constructor(baseDir = path.join(process.cwd(), "public", "imported-assets")) {
    this.baseDir = baseDir;
    this.publicPrefix = "/imported-assets";
  }

  /**
   * @param {{ buffer: Buffer, mimeType: string, sourceUrl: string }} input
   * @returns {Promise<{ storedUrl: string, hash: string, bytes: number, mimeType: string }>}
   */
  async save({ buffer, mimeType, sourceUrl }) {
    const ext = MIME_EXT[mimeType] || "bin";
    const hash = crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 24);
    const filename = `${hash}.${ext}`;
    await fs.mkdir(this.baseDir, { recursive: true });
    const full = path.join(this.baseDir, filename);
    // content-addressed: if it exists, reuse (dedup by content hash)
    try {
      await fs.access(full);
    } catch {
      await fs.writeFile(full, buffer);
    }
    return {
      storedUrl: `${this.publicPrefix}/${filename}`,
      hash,
      bytes: buffer.byteLength,
      mimeType,
    };
  }
}

/**
 * STUB. Production target: upload to a private Supabase Storage bucket and
 * return a signed URL. Intentionally throws so it isn't silently relied upon.
 */
export class SupabaseAssetStore {
  async save() {
    throw new Error(
      "SupabaseAssetStore is not implemented yet. Configure Supabase and implement before production."
    );
  }
}

/** Choose the store based on config. */
export function getAssetStore() {
  // Only the local store is wired up today. Document switch point for Supabase.
  return new LocalAssetStore();
}

/**
 * Download an image SSRF-safely and persist it. Content-hash dedup is handled
 * by the store. Returns null on any fetch failure (caller decides whether to
 * keep the remote URL as a fallback).
 * @param {string} imageUrl
 * @param {ReturnType<typeof getAssetStore>} store
 */
export async function downloadAndStore(imageUrl, store) {
  try {
    const res = await safeFetch(imageUrl, {
      accept: "image/*",
      asBuffer: true,
      maxBytes: 8 * 1024 * 1024,
      timeoutMs: 10_000,
    });
    const mime = (res.contentType || "").split(";")[0].trim().toLowerCase();
    if (!mime.startsWith("image/")) return null;
    if (!(res.body instanceof Buffer)) return null;
    // Sanitize SVGs before persisting (strip scripts / external refs).
    let buffer = res.body;
    if (mime === "image/svg+xml") {
      buffer = Buffer.from(sanitizeSvg(res.body.toString("utf8")), "utf8");
    }
    const saved = await store.save({ buffer, mimeType: mime, sourceUrl: imageUrl });
    return { ...saved, sourceUrl: imageUrl, isVector: mime === "image/svg+xml" };
  } catch (err) {
    if (err instanceof CrawlError) return null;
    return null;
  }
}
