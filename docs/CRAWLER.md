# Product URL Importer — architecture

_Last updated: 2026-10-09_

Turns a pasted product URL into a normalized `ProductProfile` + `BrandProfile`
+ ranked image assets, deterministically and cheaply, so the user reviews real
extracted data before any paid video generation.

## Flow

```
POST /api/products/import { url }
   │  (SSRF-safe) assertSafeUrl
   ▼
ProductCrawler provider  (DirectFetchProvider default | FirecrawlProvider opt-in)
   │  raw HTML
   ▼
extractStructured()   JSON-LD / schema.org Product+Offer, OG/Twitter, microdata  → facts + provenance
   │
cleanProductContent() strip nav/header/footer/noise, dedupe, relevance-score     → compact product text
   │
discoverImages()      <img>/srcset/<picture>/lazy + structured imgs, classify,   → ranked, deduped assets
   │                  score, dedupe
extractBrandSignals() intentional colors (CSS vars/theme/CTA), logo, tagline     → brand evidence
   │
downloadAndStore()    persist top images via AssetStore (SSRF-safe fetch)        → stable storedUrl
   ▼
ProductProfile + BrandProfile + assets + warnings + observability  (cached 10 min)
```

Separate endpoints keep responsibilities small:
`/api/products/import`, `/api/products/refresh` (force re-crawl),
`/api/creative/concepts`, `/api/generate`.

## Crawl providers (abstraction)

`lib/crawl/providers.js` defines a provider whose only job is returning raw
HTML, so extraction never depends on which crawler ran:

- **DirectFetchProvider** (default) — SSRF-safe `fetch` + Cheerio. No secrets,
  covers the majority of commerce sites that expose JSON-LD/OpenGraph.
- **FirecrawlProvider** (opt-in) — for JS-heavy sites. Enabled only when
  `FIRECRAWL_API_KEY` is set and `CRAWL_PROVIDER=firecrawl`. Key stays
  server-side. **Unverified** until exercised with a real key.

**Why Cheerio, not Firecrawl-by-default or Python/BeautifulSoup:** most product
pages ship structured data in the initial HTML, so a direct fetch + Cheerio is
fast, free, dependency-light and keeps the app pure JS/Next. Firecrawl is kept
behind the abstraction for the JS-heavy cases without hard-wiring the product to
it. Python/BeautifulSoup would add a second runtime for no extraction advantage
over Cheerio here, so it was deliberately not introduced.

## Extraction priority

1. **Structured commerce data** (highest trust): JSON-LD `Product`/`Offer`,
   then OpenGraph/Twitter/canonical, then microdata. Each field carries
   `{ source, confidence }` provenance; structured facts outrank weaker sources
   and we never overwrite a higher-confidence field with a lower one.
2. **Page DOM** only as fallback for missing fields.
3. **Gemini** is NOT used for factual extraction. (A future optional enrichment
   pass may add *interpretive* fields — benefits/angles/tone — clearly labeled
   as AI inference, never stored as website-stated fact.)

## Content cleaning

`lib/crawl/clean.js`: removes scripts/styles/nav/header/footer/aside and common
noise containers; prefers a product container; splits into blocks; normalizes
whitespace; drops short nav-like fragments; removes exact duplicates and
penalizes repeated blocks; scores by heading hierarchy, product keywords,
token-overlap with the product name and length; keeps the top blocks within a
~4 KB budget so we never feed huge duplicated content to any AI step.

## Image logic

`lib/crawl/images.js`:
- **Discovery:** JSON-LD/OG images, `<img src>`, `srcset` (largest candidate),
  `<picture><source>`, and lazy attrs (`data-src`, `data-zoom-image`, …).
- **Avoiding thumbnails:** picks the largest `srcset` entry; infers width from
  common URL patterns (`_1200x`, `w_1500`, `width=1024`); tiny images penalized.
- **Classification:** `hero_product | product_packshot | alternate_angle |
  lifestyle | logo | icon | navigation_asset | unrelated` from URL hints,
  gallery membership, structured-data origin and size.
- **Ranking:** `role score + resolution score + structured bonus + gallery bonus
  − icon/tiny penalties`.
- **Dedup:** normalized URL (strip cache-busting params + CDN size suffixes so
  `_400x` and `_1600x` of the same asset collapse). Content-hash dedup again at
  storage time.
- Icons, payment/trust badges, stars and nav assets are dropped.

## Asset storage

`lib/assets/store.js` — an `AssetStore` abstraction:
- **LocalAssetStore (default, PROTOTYPE ONLY):** downloads images SSRF-safely
  and writes content-addressed files to `public/imported-assets/`, returning a
  stable `/imported-assets/<hash>.<ext>` URL. **Not durable on ephemeral
  serverless disk** — runtime writes on Vercel/Lambda do not persist. Documented,
  not pretended otherwise.
- **SupabaseAssetStore (STUB):** intended production path (private bucket +
  signed URLs). Throws until implemented, so it can't be silently relied upon.
- If an image can't be saved, the remote source URL is kept as a fallback and a
  warning is emitted.

## Security / SSRF

See `docs/SECURITY.md`. Enforced in `lib/crawl/safeFetch.js`: http/https only;
reject localhost and private/loopback/link-local/CGNAT/unique-local/metadata
ranges by **resolving DNS** (not just string-matching); manual redirect handling
re-validates every hop; redirect/size/time caps.

## Caching

In-memory, 10-minute TTL keyed on canonicalized URL (tracking params stripped).
`/api/products/refresh` or the UI "Refresh product data" button forces a fresh
crawl. The cache is per-process and resets on restart (prototype).

## Observability

Each import returns non-sensitive diagnostics: crawl provider, rendered flag,
page status, canonical URL, structured-schema presence, candidate vs. kept image
counts, removed duplicate images/text blocks, extraction duration. No secrets
are logged.

## Known limitations

- Direct fetch does not execute JavaScript; fully client-rendered pages with no
  structured data in HTML need the Firecrawl provider (opt-in, unverified).
- Image dimensions are inferred from URL/attributes during discovery (no
  per-image network probe); real dimensions could be read at download time.
- Perceptual (near-duplicate) image hashing is not implemented — dedup is by
  normalized URL + content hash. Noted as future work.
- Local asset storage is not durable in serverless deployments.
