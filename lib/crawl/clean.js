/**
 * Page content cleaning + relevance scoring.
 *
 * Goal: produce a compact, high-quality block of PRODUCT text — not the whole
 * website — so we don't feed huge duplicated nav/footer content into Gemini.
 *
 * Strategy:
 *  - strip scripts/styles/nav/header/footer/aside and common noise containers
 *  - break remaining content into blocks (headings, paragraphs, list items)
 *  - normalize whitespace; drop very short nav-like fragments
 *  - remove exact duplicates and penalize blocks repeated across the page
 *  - score blocks by proximity to the product title, product keywords, list
 *    membership and heading hierarchy; keep the top blocks within a char budget
 */

import * as cheerio from "cheerio";

const NOISE_SELECTORS = [
  "script", "style", "noscript", "template", "svg",
  "nav", "header", "footer", "aside",
  "form", "iframe",
  "[role=navigation]", "[role=banner]", "[role=contentinfo]",
  ".nav", ".navbar", ".menu", ".mega-menu", ".breadcrumb",
  ".footer", ".site-footer", ".header", ".site-header",
  ".cookie", ".cookie-banner", ".newsletter", ".subscribe",
  ".social", ".social-links", ".announcement", ".promo-bar",
  ".cart", ".minicart", ".search", ".account", ".login",
  ".recommendations", ".related-products", ".you-may-also-like",
  ".upsell", ".cross-sell", ".recently-viewed",
];

const PRODUCT_KEYWORDS = [
  "feature", "benefit", "specification", "spec", "ingredient", "material",
  "how to use", "directions", "description", "details", "what's included",
  "guarantee", "warranty", "quality", "designed", "crafted", "made",
];

const CHAR_BUDGET = 4000;

/**
 * @param {string} html
 * @param {string} [productName]
 * @returns {{ text: string, blocks: {text:string,score:number}[], removedDuplicates: number }}
 */
export function cleanProductContent(html, productName = "") {
  const $ = cheerio.load(html);
  $(NOISE_SELECTORS.join(",")).remove();

  // Prefer a product container if we can find one.
  const containerSel = [
    "[itemtype*='Product']", ".product", "#product", ".product-single",
    ".product__info", ".product-detail", "main", "article",
  ];
  let $scope = null;
  for (const sel of containerSel) {
    const found = $(sel).first();
    if (found.length && found.text().trim().length > 120) {
      $scope = found;
      break;
    }
  }
  if (!$scope) $scope = $("body");

  const nameTokens = tokenize(productName);
  const seen = new Map(); // normalized text -> count
  const raw = [];

  $scope.find("h1,h2,h3,h4,p,li").each((_, el) => {
    const tag = el.tagName?.toLowerCase();
    let text = normalize($(el).text());
    if (!text) return;
    // Drop very short nav-like fragments unless it's a heading.
    if (text.length < 12 && !/^h[1-4]$/.test(tag)) return;
    if (text.length > 600) text = text.slice(0, 600);
    const key = text.toLowerCase();
    seen.set(key, (seen.get(key) || 0) + 1);
    raw.push({ tag, text, key });
  });

  // Deduplicate (keep first occurrence) and score.
  const kept = [];
  const usedKeys = new Set();
  let removedDuplicates = 0;
  for (const b of raw) {
    if (usedKeys.has(b.key)) {
      removedDuplicates++;
      continue;
    }
    usedKeys.add(b.key);
    const repeatCount = seen.get(b.key) || 1;
    let score = 0;
    // Heading hierarchy bonus
    if (b.tag === "h1") score += 5;
    else if (b.tag === "h2") score += 3;
    else if (b.tag === "h3") score += 2;
    else if (b.tag === "li") score += 1.5; // product bullet lists are valuable
    // Product keyword bonus
    const lower = b.text.toLowerCase();
    if (PRODUCT_KEYWORDS.some((k) => lower.includes(k))) score += 3;
    // Proximity to product name (token overlap)
    const overlap = tokenOverlap(nameTokens, tokenize(b.text));
    score += overlap * 2;
    // Length sweet-spot bonus (substantial but not giant)
    if (b.text.length >= 40 && b.text.length <= 400) score += 1.5;
    // Penalize text repeated across the page (nav/footer leftovers)
    if (repeatCount > 1) score -= repeatCount;
    // Penalize ALL-CAPS short shouty banners
    if (b.text.length < 40 && b.text === b.text.toUpperCase()) score -= 2;

    kept.push({ ...b, score });
  }

  kept.sort((a, b) => b.score - a.score);

  // Assemble within the char budget, then restore rough document order.
  const chosen = [];
  let budget = CHAR_BUDGET;
  for (const b of kept) {
    if (b.score <= 0) continue;
    if (budget - b.text.length < 0) continue;
    chosen.push(b);
    budget -= b.text.length;
  }
  // Restore original order for readability.
  const order = new Map(raw.map((b, i) => [b.key, i]));
  chosen.sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));

  const text = chosen.map((b) => (b.tag.startsWith("h") ? `# ${b.text}` : b.text)).join("\n");
  return {
    text,
    blocks: chosen.map((b) => ({ text: b.text, score: Number(b.score.toFixed(2)) })),
    removedDuplicates,
  };
}

function normalize(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}
function tokenize(s) {
  return new Set(
    normalize(s)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2)
  );
}
function tokenOverlap(a, b) {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}
