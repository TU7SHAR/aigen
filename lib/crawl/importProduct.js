/**
 * Product import orchestrator.
 *
 * Pipeline (cheap/deterministic first; AI is optional and separate):
 *   1. crawl provider -> raw HTML (SSRF-safe)
 *   2. structured extraction (JSON-LD / OG / microdata)  [facts, with provenance]
 *   3. content cleaning (dedup + relevance scoring)       [compact product text]
 *   4. image discovery + classification + ranking + dedup
 *   5. brand-signal extraction (colors/logo/tagline)
 *   6. (optionally) download + persist top images via the AssetStore
 *   7. assemble a normalized ProductProfile + BrandProfile + warnings
 *
 * This step performs NO paid video generation and (by default) NO Gemini call.
 * Semantic enrichment via Gemini is a separate, explicit step (lib/ai/enrich).
 */

import { getCrawlProvider } from "./providers.js";
import { assertSafeUrl, CrawlError } from "./safeFetch.js";
import { extractStructured } from "./structured.js";
import { cleanProductContent } from "./clean.js";
import { discoverImages } from "./images.js";
import { extractBrandSignals } from "./brand.js";
import { getAssetStore, downloadAndStore } from "../assets/store.js";

// --- tiny in-memory crawl cache (prototype-only; resets on restart) ---
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min
const cache = new Map(); // canonicalKey -> { at, result }

function cacheKey(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    // drop tracking params for a stable key
    ["utm_source", "utm_medium", "utm_campaign", "fbclid", "gclid"].forEach((k) =>
      u.searchParams.delete(k)
    );
    return u.origin + u.pathname + (u.search || "");
  } catch {
    return url;
  }
}

/**
 * @param {string} rawUrl
 * @param {{ refresh?: boolean, persistImages?: boolean, maxImages?: number }} [opts]
 */
export async function importProduct(rawUrl, opts = {}) {
  const { refresh = false, persistImages = true, maxImages = 8 } = opts;
  const started = Date.now();

  // Validate URL (SSRF) up front.
  await assertSafeUrl(rawUrl);

  const key = cacheKey(rawUrl);
  if (!refresh) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      return { ...hit.result, cached: true };
    }
  }

  const provider = getCrawlProvider();
  const warnings = [];

  // 1. crawl
  let page;
  try {
    page = await provider.fetchPage(rawUrl);
  } catch (err) {
    const code = err instanceof CrawlError ? err.code : "CRAWL_FAILED";
    throw new CrawlError(
      `Could not read the product page (${err?.message || code}).`,
      code
    );
  }

  const html = page.html;
  if (!html || html.length < 200) {
    throw new CrawlError("The page returned little or no content.", "EMPTY_PAGE");
  }

  // 2. structured
  const structured = extractStructured(html, page.finalUrl);
  warnings.push(...structured.warnings);
  const name = structured.fields.name?.value;

  // 3. clean content
  const cleaned = cleanProductContent(html, name || "");

  // 4. images
  const imgResult = discoverImages(html, page.finalUrl, structured.imageUrls, name || "");
  if (!imgResult.images.length) warnings.push("No useful product images were found.");
  else if (imgResult.images.every((i) => (i.width || 0) < 500)) {
    warnings.push("Only low-resolution product images were available.");
  }

  // 5. brand
  const brandSignals = extractBrandSignals(html, page.finalUrl);

  // 6. persist top images (download SSRF-safely; keep remote URL as fallback)
  let assets = imgResult.images.slice(0, maxImages).map((img) => ({
    id: img.normUrl,
    sourceUrl: img.url,
    storedUrl: null,
    mimeType: null,
    width: img.width || null,
    height: null,
    role: img.role,
    relevanceScore: img.score,
    source: img.structured ? "json_ld/og" : img.gallery ? "gallery" : "page_dom",
    hash: null,
  }));

  if (persistImages) {
    const store = getAssetStore();
    assets = await Promise.all(
      assets.map(async (a) => {
        const saved = await downloadAndStore(a.sourceUrl, store);
        if (saved) {
          return { ...a, storedUrl: saved.storedUrl, mimeType: saved.mimeType, hash: saved.hash };
        }
        return a; // keep remote fallback
      })
    );
    if (assets.some((a) => !a.storedUrl)) {
      warnings.push("Some images could not be saved locally and use their remote URL as a fallback.");
    }
  }

  const productImages = assets.filter((a) => ["hero_product", "product_packshot", "alternate_angle"].includes(a.role));
  const lifestyleImages = assets.filter((a) => a.role === "lifestyle");
  const logoAsset = assets.find((a) => a.role === "logo") || null;

  // 7. assemble ProductProfile (facts only; unknown stays unknown)
  const f = structured.fields;
  const productProfile = {
    sourceUrl: rawUrl,
    canonicalUrl: f.canonicalUrl?.value || page.finalUrl,
    name: f.name?.value ?? null,
    brand: f.brand?.value ?? brandSignals.name ?? null,
    description: f.description?.value ?? null,
    shortDescription: null,
    price: f.price?.value ?? null,
    currency: f.currency?.value ?? null,
    originalPrice: null,
    category: f.category?.value ?? null,
    sku: f.sku?.value ?? null,
    availability: f.availability?.value ?? null,
    features: [], // populated by optional AI enrichment
    benefits: [],
    specifications: f.specifications?.value ?? [],
    ingredients: [],
    materials: [],
    targetCustomer: null,
    useCases: [],
    offer: null,
    primaryImage: productImages[0]?.storedUrl || productImages[0]?.sourceUrl || null,
    productImages: productImages.map((a) => a.storedUrl || a.sourceUrl),
    lifestyleImages: lifestyleImages.map((a) => a.storedUrl || a.sourceUrl),
    logo: brandSignals.logo || logoAsset?.sourceUrl || null,
    brandColors: brandSignals.primaryColors,
    cleanedContent: cleaned.text,
    rawStructuredData: structured.rawStructuredData,
    extractionConfidence: computeConfidence(structured, imgResult),
    // provenance: where key fields came from
    sources: Object.fromEntries(
      Object.entries(f).map(([k, v]) => [k, { source: v.source, confidence: v.confidence }])
    ),
  };

  const brandProfile = {
    name: productProfile.brand,
    logo: productProfile.logo,
    tagline: brandSignals.tagline,
    primaryColors: brandSignals.primaryColors,
    secondaryColors: brandSignals.secondaryColors,
    colors: brandSignals.colors,
    // interpretive fields filled by AI enrichment; unknown by default
    visualStyle: null,
    toneOfVoice: null,
    positioning: null,
    photographyStyle: null,
    brandKeywords: [],
    sourceEvidence: brandSignals.sourceEvidence,
    confidence: brandSignals.confidence,
  };

  const result = {
    productProfile,
    brandProfile,
    assets,
    extractionWarnings: warnings,
    observability: {
      crawlProvider: provider.name,
      rendered: page.rendered,
      pageStatus: page.status,
      canonicalUrl: productProfile.canonicalUrl,
      hasProductSchema: structured.hasProductSchema,
      candidateImageCount: imgResult.totalCandidates,
      keptImageCount: imgResult.kept,
      removedDuplicateImages: imgResult.removedDuplicates,
      removedDuplicateTextBlocks: cleaned.removedDuplicates,
      extractionDurationMs: Date.now() - started,
    },
    cached: false,
  };

  cache.set(key, { at: Date.now(), result });
  return result;
}

function computeConfidence(structured, imgResult) {
  let c = 0.2;
  if (structured.hasProductSchema) c += 0.4;
  if (structured.fields.name) c += 0.15;
  if (structured.fields.price) c += 0.1;
  if (imgResult.images.length) c += 0.15;
  return Number(Math.min(0.98, c).toFixed(2));
}
