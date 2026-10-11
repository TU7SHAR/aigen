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
import * as cheerio from "cheerio";
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
 * SVG sanitization via a real XML parse + strict allowlist (NOT regex).
 *
 * Regex-based SVG stripping is known-fragile (nested/obfuscated tags, attribute
 * splitting, CDATA, entity tricks all defeat it). Here we parse the document
 * with cheerio (htmlparser2, XML mode), then walk the tree and keep ONLY an
 * allowlisted set of presentational elements and attributes — everything else
 * (scripts, event handlers, external references, foreignObject, embedded HTML,
 * animation that can call scripts, external url(...) refs) is dropped. This is
 * an allowlist, so unknown/novel constructs fail closed.
 *
 * Defense in depth: the rasterizer in lib/assets/verify.js then renders the
 * sanitized SVG with sharp (librsvg) which does not execute scripts or fetch
 * remote resources, and the stored vector is served as a static file (no inline
 * execution in our own origin). This function is the first layer.
 *
 * It still is not a browser-grade sanitizer; we deliberately keep the surface
 * tiny (presentational SVG only) rather than trying to safely allow the full
 * SVG spec.
 */

// Presentational SVG elements we allow through. Anything else is removed.
const SVG_ALLOWED_TAGS = new Set([
  "svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
  "defs", "lineargradient", "radialgradient", "stop", "clippath", "mask",
  "title", "desc", "text", "tspan", "symbol", "use", "pattern",
]);

// Attributes allowed on any element. href/xlink:href handled specially below.
const SVG_ALLOWED_ATTRS = new Set([
  "d", "fill", "fill-rule", "fill-opacity", "stroke", "stroke-width",
  "stroke-linecap", "stroke-linejoin", "stroke-dasharray", "stroke-opacity",
  "opacity", "transform", "viewbox", "width", "height", "x", "y", "x1", "y1",
  "x2", "y2", "cx", "cy", "r", "rx", "ry", "points", "offset", "stop-color",
  "stop-opacity", "gradientunits", "gradienttransform", "spreadmethod",
  "clip-path", "clip-rule", "mask", "id", "class", "style", "preserveaspectratio",
  "font-family", "font-size", "font-weight", "text-anchor", "dx", "dy",
  "xmlns", "xmlns:xlink", "version",
]);

// style values must not reference external resources or scripts.
function sanitizeStyleValue(v) {
  const s = String(v);
  if (/url\s*\(/i.test(s)) return ""; // no url(...) refs (could pull remote/data)
  if (/expression\s*\(|javascript:|@import|behavior\s*:/i.test(s)) return "";
  return s;
}

export function sanitizeSvg(svg) {
  // Strip the XML prolog and any DOCTYPE/internal-subset (DTD) BEFORE parsing.
  // These carry XXE / entity-expansion vectors and the parser keeps them as
  // raw prefix text in the serialized output otherwise. We only want element
  // content, so remove declarations up front — fail closed.
  const input = String(svg)
    .replace(/<\?xml[\s\S]*?\?>/gi, "")
    // DOCTYPE with an optional bracketed internal subset ([ ... ]) — consume
    // the whole declaration including the subset, then the closing '>'.
    .replace(/<!DOCTYPE[^>[]*(\[[\s\S]*?\])?[^>]*>/gi, "")
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/gi, "")
    .trimStart();
  let $;
  try {
    $ = cheerio.load(input, { xml: { xmlMode: true, decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true } });
  } catch {
    // If it won't parse as XML, treat as hostile → empty, safe SVG.
    return "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>";
  }

  // Drop DOCTYPE/entities (XXE/billion-laughs vectors) — htmlparser2 doesn't
  // expand them, but strip any declaration nodes that slipped through.
  $("*").contents().each(function () {
    if (this.type === "directive" || this.type === "comment") $(this).remove();
  });

  $("*").each(function () {
    const el = this;
    const tag = (el.tagName || el.name || "").toLowerCase();

    if (!SVG_ALLOWED_TAGS.has(tag)) {
      $(el).remove();
      return;
    }

    const attribs = { ...(el.attribs || {}) };
    for (const [name, value] of Object.entries(attribs)) {
      const lower = name.toLowerCase();

      // Event handlers (onload, onclick, …) — always drop.
      if (lower.startsWith("on")) { delete el.attribs[name]; continue; }

      // href / xlink:href: allow ONLY internal fragment refs (#id) for <use>.
      if (lower === "href" || lower === "xlink:href") {
        if (!/^#[\w:.-]+$/.test(String(value).trim())) delete el.attribs[name];
        continue;
      }

      // style: scrub url()/expression()/javascript:/@import.
      if (lower === "style") {
        const cleaned = sanitizeStyleValue(value);
        if (cleaned) el.attribs[name] = cleaned;
        else delete el.attribs[name];
        continue;
      }

      // Any other attribute referencing a URL scheme → drop.
      if (/(javascript|data|vbscript):/i.test(String(value))) { delete el.attribs[name]; continue; }

      if (!SVG_ALLOWED_ATTRS.has(lower)) delete el.attribs[name];
    }
  });

  const out = $.xml();
  // Must still contain an <svg> root; otherwise return an empty safe doc.
  if (!/<svg[\s>]/i.test(out)) return "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>";
  return out;
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
