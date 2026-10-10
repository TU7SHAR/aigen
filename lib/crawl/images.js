/**
 * Image discovery, classification, scoring and deduplication.
 *
 * Finds candidate images from JSON-LD/OG (passed in), <img src>, srcset,
 * <picture>, and common lazy-load attributes. Picks the largest sensible
 * candidate from responsive sets. Classifies by role, scores by relevance +
 * resolution + source bonuses, and deduplicates by normalized URL.
 *
 * NOTE: dimensions are inferred from URL/attribute hints here (no network
 * fetch of each image during discovery — that would be slow and costly). The
 * asset store can refine real dimensions when images are actually downloaded.
 */

import * as cheerio from "cheerio";

const LAZY_ATTRS = ["data-src", "data-original", "data-lazy", "data-image", "data-zoom-image", "data-large_image"];
const ICON_HINTS = /(sprite|icon|logo|favicon|badge|payment|visa|mastercard|paypal|stars?|rating|flag|social|pixel|spacer|placeholder|loader|arrow|chevron)/i;
const PRODUCT_HINTS = /(product|packshot|bottle|gallery|zoom|detail|front|pack)/i;
const LIFESTYLE_HINTS = /(lifestyle|model|wear|using|scene|context)/i;
const HERO_HINTS = /(hero|banner|cover|header-image|og-image|opengraph|social-?card|feature-image|main-visual)/i;
const SCREENSHOT_HINTS = /(screenshot|dashboard|app-?screen|interface|ui-|-ui|product-shot|mockup|preview)/i;

/**
 * @param {string} html
 * @param {string} pageUrl
 * @param {string[]} structuredImageUrls  images already found via JSON-LD/OG
 * @param {string} [productName]
 */
export function discoverImages(html, pageUrl, structuredImageUrls = [], productName = "") {
  const $ = cheerio.load(html);
  /** @type {Map<string, any>} */
  const byUrl = new Map();

  const add = (url, hints = {}) => {
    if (!url) return;
    const abs = absUrl(url, pageUrl);
    if (!abs || !/^https?:/i.test(abs)) return;
    if (/\.svg(\?|$)/i.test(abs)) hints.isSvg = true;
    const norm = normalizeUrl(abs);
    const existing = byUrl.get(norm);
    const w = hints.width ?? guessWidthFromUrl(abs);
    if (existing) {
      // keep the larger width hint / merge source bonuses
      existing.width = Math.max(existing.width || 0, w || 0);
      existing.structured = existing.structured || hints.structured;
      existing.gallery = existing.gallery || hints.gallery;
    } else {
      byUrl.set(norm, {
        url: abs,
        normUrl: norm,
        width: w || 0,
        structured: !!hints.structured,
        gallery: !!hints.gallery,
        isSvg: !!hints.isSvg,
      });
    }
  };

  // 1. Structured images (highest trust)
  for (const u of structuredImageUrls) add(u, { structured: true });

  // 2. <img>, srcset, lazy attrs
  $("img").each((_, el) => {
    const $el = $(el);
    const inGallery = isInGallery($, el);
    // choose largest from srcset if present
    const srcset = $el.attr("srcset") || $el.attr("data-srcset");
    if (srcset) {
      const best = pickLargestFromSrcset(srcset);
      if (best) add(best.url, { width: best.width, gallery: inGallery });
    }
    add($el.attr("src"), { gallery: inGallery });
    for (const a of LAZY_ATTRS) add($el.attr(a), { gallery: inGallery });
  });

  // 3. <picture><source srcset>
  $("picture source").each((_, el) => {
    const srcset = $(el).attr("srcset");
    if (srcset) {
      const best = pickLargestFromSrcset(srcset);
      if (best) add(best.url, { width: best.width });
    }
  });

  // Classify + score
  const nameLower = (productName || "").toLowerCase();
  const candidates = [...byUrl.values()].map((c) => {
    const role = classify(c, nameLower);
    const score = scoreImage(c, role);
    return { ...c, role, score: Number(score.toFixed(2)) };
  });

  // Drop obvious junk, sort by score. Keep useful SVGs (logo/illustration/
  // brand art) — only tiny SVG icons are dropped (handled by the icon role).
  const filtered = candidates
    .filter((c) => c.role !== "icon" && c.role !== "navigation_asset")
    .map((c) => ({ ...c, isVector: Boolean(c.isSvg) }))
    .sort((a, b) => b.score - a.score);

  return {
    images: filtered,
    totalCandidates: candidates.length,
    kept: filtered.length,
    removedDuplicates: countDuplicatesRemoved($, byUrl.size),
  };
}

/**
 * @returns {"hero_product"|"product_packshot"|"alternate_angle"|"lifestyle"
 *   |"hero_visual"|"product_screenshot"|"brand_art"|"logo"|"icon"
 *   |"navigation_asset"|"unrelated"}
 */
function classify(c, nameLower) {
  const u = c.url.toLowerCase();
  if (/favicon|logo|wordmark|brandmark/.test(u)) return "logo";
  if (ICON_HINTS.test(u)) return "icon";
  if ((c.width || 0) > 0 && c.width < 100) return "icon";
  // SaaS / web app visuals
  if (SCREENSHOT_HINTS.test(u)) return "product_screenshot";
  if (LIFESTYLE_HINTS.test(u)) return "lifestyle";
  if (c.structured) return "hero_product";
  if (HERO_HINTS.test(u)) return "hero_visual";
  if (PRODUCT_HINTS.test(u) || c.gallery) return "product_packshot";
  if (nameLower && slugMatch(u, nameLower)) return "alternate_angle";
  // SVGs that aren't icons are usually brand illustrations/vectors — keep them.
  if (c.isSvg) {
    if (/illustration|hero|graphic|art|scene|pattern/.test(u)) return "illustration";
    if ((c.width || 0) === 0 || c.width >= 200) return "illustration";
    return "logo";
  }
  // A large standalone raster image with no product cues is likely brand/hero art.
  if ((c.width || 0) >= 800) return "brand_art";
  return "unrelated";
}

function scoreImage(c, role) {
  let s = 0;
  // relevance by role
  const roleScore = {
    hero_product: 10, product_packshot: 7, alternate_angle: 5,
    hero_visual: 8, product_screenshot: 7, brand_art: 4, illustration: 5,
    lifestyle: 4, logo: 1, unrelated: 1, icon: -10, navigation_asset: -10,
  }[role] ?? 0;
  s += roleScore;
  // resolution score
  const w = c.width || 0;
  if (w >= 1200) s += 5;
  else if (w >= 800) s += 4;
  else if (w >= 500) s += 2.5;
  else if (w >= 300) s += 1;
  else if (w > 0 && w < 150) s -= 4; // tiny-image penalty
  // bonuses
  if (c.structured) s += 4; // structured-data bonus
  if (c.gallery) s += 2; // gallery bonus
  return s;
}

// ---------- helpers ----------

function isInGallery($, el) {
  let p = el.parent;
  let depth = 0;
  while (p && depth < 5) {
    const cls = ($(p).attr("class") || "") + " " + ($(p).attr("id") || "");
    if (/(gallery|carousel|slider|product-media|product-images|thumbnails|swiper)/i.test(cls)) return true;
    p = p.parent;
    depth++;
  }
  return false;
}

function pickLargestFromSrcset(srcset) {
  // "url1 320w, url2 640w, url3 1280w" or with pixel densities "url 2x"
  const parts = srcset.split(",").map((s) => s.trim()).filter(Boolean);
  let best = null;
  for (const part of parts) {
    const [url, descriptor] = part.split(/\s+/);
    if (!url) continue;
    let width = 0;
    if (descriptor) {
      const wm = descriptor.match(/(\d+)w/);
      const xm = descriptor.match(/([\d.]+)x/);
      if (wm) width = Number(wm[1]);
      else if (xm) width = Number(xm[1]) * 1000; // treat density as proxy
    }
    if (!best || width > best.width) best = { url, width };
  }
  return best;
}

function guessWidthFromUrl(url) {
  // Common patterns: _1200x, -800x800, width=1024, w_1500, /1200/
  const patterns = [
    /[_-](\d{3,4})x\d{0,4}/i,
    /[?&](?:w|width)=(\d{3,4})/i,
    /[_/]w_(\d{3,4})/i,
    /\/(\d{3,4})\/(?:[^/]+)$/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return Number(m[1]);
  }
  return 0;
}

function slugMatch(url, nameLower) {
  const slug = nameLower.replace(/[^a-z0-9]+/g, "-").split("-").filter((w) => w.length > 3);
  return slug.some((w) => url.includes(w));
}

function absUrl(href, base) {
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    // strip common cache-busting / sizing query params for dedup
    ["v", "ver", "version", "cache", "quality", "format"].forEach((k) => u.searchParams.delete(k));
    u.hash = "";
    // normalize Shopify/CDN size suffixes to dedup variants of the same asset
    let path = u.pathname.replace(/[_-]\d{2,4}x\d{0,4}(?=\.\w+$)/i, "");
    return u.origin + path + (u.search || "");
  } catch {
    return url;
  }
}

function countDuplicatesRemoved($, uniqueCount) {
  const totalImgs = $("img").length;
  return Math.max(0, totalImgs - uniqueCount);
}
