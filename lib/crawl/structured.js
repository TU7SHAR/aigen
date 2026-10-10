/**
 * Deterministic structured-data extraction from HTML.
 *
 * Priority order (highest trust first):
 *   1. JSON-LD schema.org Product / Offer
 *   2. OpenGraph / Twitter / canonical meta
 *   3. Microdata (itemprop)
 *
 * Returns normalized fields with per-field provenance so structured facts can
 * outrank AI inference downstream. We never fabricate values here.
 */

import * as cheerio from "cheerio";

/** @typedef {{ value: any, source: string, confidence: number }} Field */

/**
 * @param {string} html
 * @param {string} pageUrl
 */
export function extractStructured(html, pageUrl) {
  const $ = cheerio.load(html);
  /** @type {Record<string, Field>} */
  const fields = {};
  const imageUrls = new Set();
  const warnings = [];
  let rawJsonLd = null;

  const set = (key, value, source, confidence) => {
    if (value === undefined || value === null || value === "") return;
    // Don't overwrite a higher-confidence field with a lower one.
    if (fields[key] && fields[key].confidence >= confidence) return;
    fields[key] = { value, source, confidence };
  };

  // --- 1. JSON-LD ---
  const jsonLdProducts = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const txt = $(el).contents().text();
    if (!txt) return;
    let parsed;
    try {
      parsed = JSON.parse(txt);
    } catch {
      warnings.push("Invalid JSON-LD block skipped.");
      return;
    }
    const nodes = flattenJsonLd(parsed);
    for (const node of nodes) {
      const type = typeArray(node["@type"]);
      if (type.some((t) => /product/i.test(t))) {
        jsonLdProducts.push(node);
      }
    }
  });

  if (jsonLdProducts.length) {
    rawJsonLd = jsonLdProducts[0];
    const p = jsonLdProducts[0];
    set("name", str(p.name), "json_ld", 0.98);
    set("description", str(p.description), "json_ld", 0.9);
    set("sku", str(p.sku || p.mpn), "json_ld", 0.95);
    set("category", str(p.category), "json_ld", 0.85);
    const brand = p.brand && (typeof p.brand === "string" ? p.brand : p.brand.name);
    set("brand", str(brand), "json_ld", 0.95);
    // images
    collectImages(p.image, imageUrls, pageUrl);
    // offers
    const offer = Array.isArray(p.offers) ? p.offers[0] : p.offers;
    if (offer) {
      set("price", num(offer.price || offer.lowPrice), "json_ld", 0.95);
      set("currency", str(offer.priceCurrency), "json_ld", 0.95);
      set("availability", str(offer.availability), "json_ld", 0.8);
      if (Array.isArray(p.offers) && p.offers.length > 1) {
        warnings.push("Multiple offers found; used the first.");
      }
    }
    // extra specs if present
    if (Array.isArray(p.additionalProperty)) {
      const specs = p.additionalProperty
        .map((ap) => ({ name: str(ap.name), value: str(ap.value) }))
        .filter((s) => s.name && s.value);
      if (specs.length) set("specifications", specs, "json_ld", 0.85);
    }
  } else {
    warnings.push("No product schema (JSON-LD) was found.");
  }

  // --- 2. OpenGraph / Twitter / canonical ---
  const meta = (sel, attr = "content") => $(sel).attr(attr);
  set("name", meta('meta[property="og:title"]'), "open_graph", 0.7);
  set("name", meta('meta[name="twitter:title"]'), "open_graph", 0.65);
  set("description", meta('meta[property="og:description"]'), "open_graph", 0.65);
  set("description", meta('meta[name="description"]'), "page_dom", 0.5);
  set("brand", meta('meta[property="og:site_name"]'), "open_graph", 0.5);
  const canonical = meta('link[rel="canonical"]', "href");
  if (canonical) set("canonicalUrl", abs(canonical, pageUrl), "page_dom", 0.9);

  // OG product price (some stores expose these)
  set("price", num(meta('meta[property="product:price:amount"]')), "open_graph", 0.75);
  set("currency", meta('meta[property="product:price:currency"]'), "open_graph", 0.75);

  const ogImage =
    meta('meta[property="og:image"]') || meta('meta[name="twitter:image"]');
  if (ogImage) collectImages(ogImage, imageUrls, pageUrl);

  // --- 3. Microdata ---
  if (!fields.name) {
    const miName = $('[itemprop="name"]').first().text().trim();
    if (miName) set("name", miName, "page_dom", 0.55);
  }
  if (!fields.price) {
    const miPrice = $('[itemprop="price"]').first().attr("content") ||
      $('[itemprop="price"]').first().text().trim();
    if (miPrice) set("price", num(miPrice), "page_dom", 0.6);
  }

  // Title fallback
  if (!fields.name) {
    const t = $("title").first().text().trim();
    if (t) set("name", t, "page_dom", 0.4);
  }

  return {
    fields,
    imageUrls: [...imageUrls],
    warnings,
    rawStructuredData: rawJsonLd,
    hasProductSchema: jsonLdProducts.length > 0,
  };
}

// ---------- helpers ----------

function flattenJsonLd(node, out = []) {
  if (!node) return out;
  if (Array.isArray(node)) {
    for (const n of node) flattenJsonLd(n, out);
    return out;
  }
  if (typeof node === "object") {
    out.push(node);
    if (node["@graph"]) flattenJsonLd(node["@graph"], out);
  }
  return out;
}

function typeArray(t) {
  if (!t) return [];
  return Array.isArray(t) ? t.map(String) : [String(t)];
}

function str(v) {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return v.trim() || undefined;
  if (typeof v === "number") return String(v);
  return undefined;
}

function num(v) {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number.parseFloat(String(v).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

function abs(href, base) {
  try {
    return new URL(href, base).href;
  } catch {
    return href;
  }
}

function collectImages(img, set, base) {
  if (!img) return;
  if (typeof img === "string") {
    set.add(abs(img, base));
  } else if (Array.isArray(img)) {
    for (const i of img) collectImages(i, set, base);
  } else if (typeof img === "object" && img.url) {
    set.add(abs(img.url, base));
  }
}
