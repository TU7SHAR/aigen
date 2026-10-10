/**
 * Source Intelligence orchestrator.
 *
 * Gathers enough reliable evidence to UNDERSTAND what the user is advertising —
 * product, SaaS, service, business, creator, etc. — not just scrape HTML.
 *
 * Pipeline:
 *   1. normalize URL (forgiving) + SSRF validation
 *   2. crawl root (direct fetch; Firecrawl fallback on poor extraction)
 *   3. deterministic structured extraction + content cleaning + classification
 *   4. if root is thin, discover + crawl a few high-value internal pages (budgeted)
 *   5. image discovery/ranking/dedup (+ non-product roles) + persist top images
 *   6. brand-signal extraction
 *   7. ContextReducer -> AI semantic enrichment (cheap Gemini) -> merge layer
 *   8. assemble EntityProfile + ProductProfile(-shaped) + BrandProfile +
 *      provenance + confidence + observability
 *
 * No paid VIDEO generation here. AI enrichment is cheap TEXT and tracked
 * separately; it degrades gracefully when disabled/no key.
 */

import crypto from "node:crypto";
import { getCrawlProvider, FirecrawlProvider } from "./providers.js";
import { normalizeInputUrl } from "./normalizeUrl.js";
import { assertSafeUrl, CrawlError } from "./safeFetch.js";
import { extractStructured } from "./structured.js";
import { cleanProductContent } from "./clean.js";
import { discoverImages } from "./images.js";
import { extractBrandSignals } from "./brand.js";
import { classifySource, discoverInternalPages } from "./classify.js";
import { reduceContext } from "./contextReducer.js";
import { enrichFromContext } from "../ai/enrich.js";
import { mergeProfiles } from "./merge.js";
import { getAssetStore, downloadAndStore } from "../assets/store.js";
import { recordEnrichmentSpend } from "../costs/estimate.js";

const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_SITE_PAGES = 5;
const cache = new Map(); // key -> { at, result }

function cacheKey(url, fingerprint) {
  return `${url}::${fingerprint || ""}`;
}

/** Quick signal of whether deterministic extraction was "poor". */
function isPoorExtraction(structured, cleaned, imgResult) {
  const hasName = Boolean(structured.fields.name?.value);
  const shortText = (cleaned.text || "").length < 400;
  const noImages = imgResult.images.length === 0;
  return (!hasName && shortText) || (shortText && noImages);
}

/**
 * @param {string} rawInput
 * @param {{ refresh?: boolean, persistImages?: boolean, maxImages?: number }} [opts]
 */
export async function importSource(rawInput, opts = {}) {
  const { refresh = false, persistImages = true, maxImages = 8 } = opts;
  const started = Date.now();
  const warnings = [];
  const sizeTrace = {};

  // 1. normalize + SSRF
  const norm = normalizeInputUrl(rawInput);
  if (!norm.ok) throw new CrawlError(norm.reason, "INVALID_URL");
  const normalizedInputUrl = norm.url;
  await assertSafeUrl(normalizedInputUrl);

  // 2. crawl root (with provider + possible Firecrawl fallback)
  let provider = getCrawlProvider();
  let page;
  try {
    page = await provider.fetchPage(normalizedInputUrl);
  } catch (err) {
    const code = err instanceof CrawlError ? err.code : "CRAWL_FAILED";
    throw new CrawlError(`Could not open the website (${err?.message || code}).`, code);
  }
  if (!page.html || page.html.length < 200) {
    throw new CrawlError("The page returned little or no content.", "EMPTY_PAGE");
  }
  sizeTrace.rawHtmlChars = page.html.length;

  // 3. deterministic extraction + cleaning + classification (root)
  let structured = extractStructured(page.html, page.finalUrl);
  let cleaned = cleanProductContent(page.html, structured.fields.name?.value || "");
  let imgResult = discoverImages(page.html, page.finalUrl, structured.imageUrls, structured.fields.name?.value || "");

  // 3b. Firecrawl fallback: only if extraction is poor AND Firecrawl available
  //     AND we didn't already use it. Avoids double-crawling when unnecessary.
  let usedFirecrawl = provider.name === "firecrawl";
  if (!usedFirecrawl && isPoorExtraction(structured, cleaned, imgResult) && process.env.FIRECRAWL_API_KEY) {
    try {
      const fc = new FirecrawlProvider(process.env.FIRECRAWL_API_KEY);
      const fcPage = await fc.fetchPage(normalizedInputUrl);
      if (fcPage.html && fcPage.html.length > page.html.length / 2) {
        page = fcPage;
        provider = fc;
        usedFirecrawl = true;
        structured = extractStructured(page.html, page.finalUrl);
        cleaned = cleanProductContent(page.html, structured.fields.name?.value || "");
        imgResult = discoverImages(page.html, page.finalUrl, structured.imageUrls, structured.fields.name?.value || "");
        warnings.push("Used rendered crawl (Firecrawl) because direct extraction was thin.");
      }
    } catch {
      warnings.push("Rendered-crawl fallback was unavailable; used direct extraction.");
    }
  }
  sizeTrace.cleanedChars = (cleaned.text || "").length;

  const classification = classifySource(page.html, page.finalUrl, {
    hasProductSchema: structured.hasProductSchema,
    title: structured.fields.name?.value,
    cleanedText: cleaned.text,
  });

  // 4. page discovery — only when the root is thin / not a product page
  const pagesUsed = [page.finalUrl];
  const secondaryPages = [];
  const rootThin = (cleaned.text || "").length < 1200 || !structured.fields.description?.value;
  if (classification.isRoot && rootThin) {
    const candidates = discoverInternalPages(page.html, page.finalUrl, MAX_SITE_PAGES - 1);
    for (const link of candidates) {
      if (pagesUsed.length >= MAX_SITE_PAGES) break;
      try {
        await assertSafeUrl(link);
        const sub = await provider.fetchPage(link);
        if (!sub.html || sub.html.length < 200) continue;
        const subStruct = extractStructured(sub.html, sub.finalUrl);
        const subClean = cleanProductContent(sub.html, subStruct.fields.name?.value || "");
        // merge any missing structured facts up from the sub-page
        for (const [k, v] of Object.entries(subStruct.fields)) {
          if (!structured.fields[k]) structured.fields[k] = { ...v, source: "internal_page" };
        }
        // pull sub-page images into the candidate set
        const subImgs = discoverImages(sub.html, sub.finalUrl, subStruct.imageUrls, subStruct.fields.name?.value || "");
        imgResult.images = dedupeImages([...imgResult.images, ...subImgs.images]);
        secondaryPages.push({ url: sub.finalUrl, title: subStruct.fields.name?.value, cleanedText: subClean.text });
        pagesUsed.push(sub.finalUrl);
      } catch {
        // ignore individual sub-page failures
      }
    }
  }

  // 5. images (persist top)
  if (!imgResult.images.length) warnings.push("No useful images were found — you can upload one manually.");
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
  if (persistImages && assets.length) {
    const store = getAssetStore();
    assets = await Promise.all(
      assets.map(async (a) => {
        const saved = await downloadAndStore(a.sourceUrl, store);
        return saved ? { ...a, storedUrl: saved.storedUrl, mimeType: saved.mimeType, hash: saved.hash } : a;
      })
    );
  }

  // 6. brand signals
  const brandSignals = extractBrandSignals(page.html, page.finalUrl);

  // 7. ContextReducer -> AI enrichment -> merge
  const headings = extractHeadings(cleaned.text);
  const reduced = reduceContext({
    finalUrl: page.finalUrl,
    title: structured.fields.name?.value,
    metaDescription: structured.fields.description?.value,
    structuredFacts: structured.fields,
    cleanedText: cleaned.text,
    headings,
    imageMeta: imgResult.images.slice(0, 8).map((i) => ({ role: i.role, width: i.width })),
    secondaryPages,
  });
  sizeTrace.semanticInputChars = reduced.chars;

  const enrichment = await enrichFromContext({
    context: reduced.text,
    hintEntityType: classification.entityType,
  });
  if (enrichment.error) warnings.push(enrichment.error);
  if (enrichment.skipped) warnings.push(enrichment.skipped);
  if (enrichment.cost?.state === "billed" && typeof enrichment.cost.amountUsd === "number") {
    recordEnrichmentSpend(enrichment.cost.amountUsd);
  }

  // deterministic ProductProfile-shaped object (facts only)
  const f = structured.fields;
  const deterministic = {
    name: f.name?.value ?? null,
    brand: f.brand?.value ?? brandSignals.name ?? null,
    description: f.description?.value ?? null,
    price: f.price?.value ?? null,
    currency: f.currency?.value ?? null,
    category: f.category?.value ?? null,
    specifications: f.specifications?.value ?? [],
  };
  const determSources = Object.fromEntries(
    Object.entries(f).map(([k, v]) => [k, { source: v.source, confidence: v.confidence }])
  );

  const merged = mergeProfiles({
    deterministic,
    determSources,
    enriched: enrichment.enriched,
    entityTypeHint: classification.entityType,
  });

  // assemble image buckets (support product + web/SaaS roles)
  const productRoles = ["hero_product", "product_packshot", "alternate_angle"];
  const webRoles = ["hero_visual", "product_screenshot", "brand_art"];
  const heroAssets = assets.filter((a) => [...productRoles, ...webRoles].includes(a.role));
  const lifestyleImages = assets.filter((a) => a.role === "lifestyle");
  const logoAsset = assets.find((a) => a.role === "logo") || null;

  const mp = merged.profile;

  // ProductProfile kept for backward-compat with the existing Studio/generate
  // flow; now populated from the MERGED profile, not only JSON-LD/OG.
  const productProfile = {
    sourceUrl: normalizedInputUrl,
    canonicalUrl: f.canonicalUrl?.value || page.finalUrl,
    name: mp.name ?? null,
    brand: mp.brand ?? null,
    description: mp.description ?? null,
    shortDescription: mp.shortDescription ?? null,
    price: mp.price ?? null,
    currency: mp.currency ?? null,
    originalPrice: null,
    category: mp.category ?? null,
    sku: f.sku?.value ?? null,
    availability: f.availability?.value ?? null,
    features: mp.features ?? [],
    benefits: mp.benefits ?? [],
    specifications: mp.specifications ?? [],
    ingredients: [],
    materials: [],
    targetCustomer: mp.targetCustomer ?? null,
    useCases: mp.useCases ?? [],
    offer: mp.offer ?? null,
    primaryImage: heroAssets[0]?.storedUrl || heroAssets[0]?.sourceUrl || null,
    productImages: heroAssets.map((a) => a.storedUrl || a.sourceUrl),
    lifestyleImages: lifestyleImages.map((a) => a.storedUrl || a.sourceUrl),
    logo: brandSignals.logo || logoAsset?.sourceUrl || null,
    brandColors: brandSignals.primaryColors,
    cleanedContent: cleaned.text,
    rawStructuredData: structured.rawStructuredData,
    extractionConfidence: merged.confidence,
    sources: merged.sources,
  };

  // EntityProfile — the new root object (entity-agnostic)
  const entityProfile = {
    entityType: merged.entityType,
    ...mp,
    callsToAction: mp.callsToAction ?? [],
    differentiators: mp.differentiators ?? [],
    socialProof: mp.socialProof ?? [],
    confidence: merged.confidence,
    sources: merged.sources,
  };

  const enrichedBrand = enrichment.enriched?.brand || null;
  const brandProfile = {
    name: productProfile.brand,
    logo: productProfile.logo,
    tagline: brandSignals.tagline || enrichedBrand?.tagline || null,
    primaryColors: brandSignals.primaryColors,
    secondaryColors: brandSignals.secondaryColors,
    colors: brandSignals.colors,
    // interpretive fields now populated by AI enrichment when supported
    visualStyle: enrichedBrand?.visualStyle || null,
    toneOfVoice: enrichedBrand?.tone || null,
    positioning: enrichedBrand?.positioning || null,
    photographyStyle: null,
    brandKeywords: enrichedBrand?.keywords || [],
    sourceEvidence: brandSignals.sourceEvidence,
    confidence: Number(Math.min(0.98, brandSignals.confidence + (enrichedBrand ? 0.15 : 0)).toFixed(2)),
  };

  const result = {
    normalizedInputUrl,
    finalUrl: page.finalUrl,
    entityType: merged.entityType,
    productProfile,
    entityProfile,
    brandProfile,
    deterministicProfile: deterministic,
    semanticProfile: enrichment.enriched,
    assets,
    pagesUsed,
    extractionWarnings: warnings,
    extractionConfidence: merged.confidence,
    aiEnrichment: {
      model: enrichment.model,
      used: Boolean(enrichment.enriched),
      inputTokens: enrichment.usage?.input ?? null,
      outputTokens: enrichment.usage?.output ?? null,
      cost: enrichment.cost,
    },
    observability: {
      crawlProvider: provider.name,
      usedFirecrawl,
      rendered: page.rendered,
      pageStatus: page.status,
      canonicalUrl: productProfile.canonicalUrl,
      hasProductSchema: structured.hasProductSchema,
      classifierScores: classification.scores,
      candidateImageCount: imgResult.totalCandidates,
      keptImageCount: assets.length,
      removedDuplicateTextBlocks: cleaned.removedDuplicates,
      sizeTrace,
      extractionDurationMs: Date.now() - started,
    },
    cached: false,
  };

  // cache by url + content fingerprint
  const fingerprint = crypto.createHash("sha1").update(page.html.slice(0, 20000)).digest("hex").slice(0, 12);
  cache.set(cacheKey(normalizedInputUrl, fingerprint), { at: Date.now(), result });
  return result;
}

/**
 * Backward-compatible wrapper used by the existing routes/UI. Also serves the
 * cache (keyed by normalized URL; fingerprint-aware entries are matched by URL
 * prefix for repeat imports).
 */
export async function importProduct(rawInput, opts = {}) {
  const { refresh = false } = opts;
  if (!refresh) {
    const norm = normalizeInputUrl(rawInput);
    if (norm.ok) {
      for (const [k, v] of cache) {
        if (k.startsWith(norm.url + "::") && Date.now() - v.at < CACHE_TTL_MS) {
          return { ...v.result, cached: true };
        }
      }
    }
  }
  return importSource(rawInput, opts);
}

// ---------- helpers ----------

function extractHeadings(cleanedText) {
  if (!cleanedText) return [];
  return cleanedText
    .split("\n")
    .filter((l) => l.startsWith("# "))
    .map((l) => l.slice(2).trim())
    .slice(0, 20);
}

function dedupeImages(images) {
  const seen = new Set();
  const out = [];
  for (const img of images.sort((a, b) => b.score - a.score)) {
    if (seen.has(img.normUrl)) continue;
    seen.add(img.normUrl);
    out.push(img);
  }
  return out;
}
