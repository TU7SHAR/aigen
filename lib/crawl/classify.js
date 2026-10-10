/**
 * Deterministic source/entity classification + internal-page discovery.
 *
 * Decides what KIND of thing a URL represents (product vs business/SaaS vs
 * service vs creator…) from signals we already have, and — when the root page
 * is thin — ranks a few high-value internal pages worth also reading.
 *
 * This is deterministic + cheap. AI classification can refine it later, but we
 * must never *assume* a homepage is an ecommerce Product.
 */

import * as cheerio from "cheerio";

/** @typedef {"ecommerce_product"|"ecommerce_store"|"saas"|"service"|"business"|"creator"|"portfolio"|"course"|"app"|"landing_page"|"unknown"} EntityType */

const SAAS_HINTS = /\b(sign up|get started|free trial|pricing|dashboard|api|integrations?|platform|app|login|log in|saas|per month|\/mo\b)\b/i;
const SERVICE_HINTS = /\b(book|appointment|consultation|our services|hire|contact us|get a quote|clients?)\b/i;
const COURSE_HINTS = /\b(course|curriculum|enroll|lessons?|modules?|students?|masterclass)\b/i;
const CREATOR_HINTS = /\b(subscribe|my channel|follow me|creator|influencer|link in bio|portfolio|my work)\b/i;
const PRODUCT_PATH = /\/(products?|p|item|shop|store)\//i;
const STORE_HINTS = /\b(add to cart|collections?|shop all|free shipping|checkout)\b/i;

const DISCOVERY_PATTERNS = [
  { re: /\/(products?|shop|store)\b/i, w: 5, kind: "product" },
  { re: /\/pricing\b/i, w: 5, kind: "pricing" },
  { re: /\/(services?|solutions?)\b/i, w: 4, kind: "service" },
  { re: /\/(features?|how-it-works|product)\b/i, w: 4, kind: "features" },
  { re: /\/(about|about-us|story|company)\b/i, w: 3, kind: "about" },
  { re: /\/(app|download|get-started|get-report|report)\b/i, w: 4, kind: "app" },
  { re: /\/(courses?|programs?)\b/i, w: 4, kind: "course" },
];

const NOISE_PATH = /\/(privacy|terms|legal|cookie|refund|returns?|shipping-policy|blog|news|press|careers?|jobs|sitemap|cart|account|login|signin|wishlist|faq\/.+)\b/i;

/**
 * @param {string} html
 * @param {string} pageUrl
 * @param {{ hasProductSchema?: boolean, title?: string, cleanedText?: string }} ctx
 */
export function classifySource(html, pageUrl, ctx = {}) {
  const $ = cheerio.load(html);
  const text = (ctx.cleanedText || $("body").text() || "").slice(0, 20000);
  const title = ctx.title || $("title").first().text() || "";
  const ogType = $('meta[property="og:type"]').attr("content") || "";
  const path = safePath(pageUrl);
  const isRoot = path === "/" || path === "";

  const scores = {
    ecommerce_product: 0, ecommerce_store: 0, saas: 0, service: 0,
    business: 0, creator: 0, course: 0, app: 0, landing_page: 0,
  };

  if (ctx.hasProductSchema) scores.ecommerce_product += 6;
  if (/product/i.test(ogType)) scores.ecommerce_product += 3;
  if (PRODUCT_PATH.test(path)) scores.ecommerce_product += 4;
  if (STORE_HINTS.test(text)) scores.ecommerce_store += 3;
  if (SAAS_HINTS.test(text)) scores.saas += 3;
  if (SERVICE_HINTS.test(text)) scores.service += 2;
  if (COURSE_HINTS.test(text)) scores.course += 3;
  if (CREATOR_HINTS.test(text)) scores.creator += 2;
  if (/profile|website/i.test(ogType)) scores.business += 1;

  // A root URL without product signals leans business/landing, NOT product.
  if (isRoot && !ctx.hasProductSchema && !PRODUCT_PATH.test(path)) {
    scores.business += 2;
    scores.landing_page += 1;
  }

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  let [type, top] = ranked[0];
  if (top === 0) type = isRoot ? "business" : "unknown";

  return {
    entityType: /** @type {EntityType} */ (type),
    scores,
    title: title.trim(),
    isRoot,
  };
}

/**
 * Rank internal links worth also reading. Returns absolute URLs on the same
 * host, deduped, best-first, capped.
 * @param {string} html
 * @param {string} pageUrl
 * @param {number} limit
 */
export function discoverInternalPages(html, pageUrl, limit = 3) {
  const $ = cheerio.load(html);
  let origin;
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    return [];
  }
  const seen = new Set();
  const scored = [];

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    let abs;
    try {
      abs = new URL(href, pageUrl);
    } catch {
      return;
    }
    if (abs.origin !== origin) return; // same-site only
    abs.hash = "";
    const path = abs.pathname;
    if (path === "/" || path === safePath(pageUrl)) return;
    if (NOISE_PATH.test(path)) return;
    const key = abs.origin + path;
    if (seen.has(key)) return;

    let w = 0;
    for (const p of DISCOVERY_PATTERNS) if (p.re.test(path)) w = Math.max(w, p.w);
    // anchor-text boost
    const anchor = ($(el).text() || "").toLowerCase();
    if (/pricing|services?|features?|how it works|get started|products?|about/i.test(anchor)) {
      w += 1;
    }
    if (w <= 0) return;
    seen.add(key);
    scored.push({ url: abs.href, weight: w });
  });

  scored.sort((a, b) => b.weight - a.weight);
  return scored.slice(0, limit).map((s) => s.url);
}

function safePath(u) {
  try {
    return new URL(u).pathname;
  } catch {
    return "";
  }
}
