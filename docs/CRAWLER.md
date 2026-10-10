# Source Intelligence (URL Importer) — architecture

_Last updated: 2026-10-11_

Turns ANY pasted URL (product, SaaS, service, business, creator, course, app…)
into a normalized `EntityProfile` + `ProductProfile` (back-compat) +
`BrandProfile` + ranked assets, so the user reviews real extracted data before
any paid video generation.

> The importer's job is not "download HTML" — it is "gather enough reliable
> evidence to understand what the user is advertising." Deterministic parsing is
> reliable *evidence*; a cheap Gemini TEXT pass turns that evidence into a
> structured profile; neither invents facts.

## Pipeline (updated)

```
raw input (e.g. "bhavishai.in")
   │  normalizeInputUrl  → https://bhavishai.in/   (forgiving; bare domains OK)
   │  assertSafeUrl       (SSRF unchanged)
   ▼
crawl root (DirectFetch → Firecrawl FALLBACK only if extraction is poor)
   ▼
structured extraction + content cleaning + classifySource (entity type)
   │  if root is thin → discoverInternalPages (budget MAX_SITE_PAGES=5) and
   │  merge facts/images from /pricing /services /about /get-report etc.
   ▼
image discovery (product AND web/SaaS roles) + rank + dedup + persist
   ▼
brand signals (colors/logo/tagline)
   ▼
ContextReducer → AI semantic enrichment (cheap Gemini TEXT) → mergeProfiles
   ▼
EntityProfile + ProductProfile + BrandProfile + provenance + confidence
```

### Why the old importer returned blank fields

It only populated fields from ecommerce `Product` JSON-LD / OpenGraph. A SaaS/
business homepage (no `Product` schema) therefore produced empty name/price/
description and "No image", yet still offered generic product concepts. The new
pipeline classifies the entity, discovers internal pages, and runs AI semantic
extraction so a business homepage yields a real profile.

### URL normalization (`lib/crawl/normalizeUrl.js`)

`bhavishai.in`, `www.bhavishai.in`, `http(s)://bhavishai.in`, trailing slash and
quoted input all normalize to a valid https URL **before** validation. The API
route accepts a loose string (not `z.string().url()`) so a missing scheme no
longer causes a 422. Non-http schemes and junk are still rejected with a clear
error. SSRF protection is unchanged.

### Classification + page discovery (`lib/crawl/classify.js`)

`classifySource` picks an entity type (`ecommerce_product | ecommerce_store |
saas | service | business | creator | portfolio | course | app | landing_page |
unknown`) from schema presence, URL patterns, OG type and content hints. A root
URL without product signals leans business/landing — never assumed to be a
Product. When the root is thin, `discoverInternalPages` ranks a few high-value
links (`/pricing`, `/services`, `/features`, `/about`, `/get-report`…) and skips
noise (`/privacy`, `/terms`, `/blog`…), capped by `MAX_SITE_PAGES`.

### AI semantic enrichment (`lib/ai/enrich.js`)

A cheap Gemini TEXT model (`SOURCE_ENRICHMENT_MODEL`, default
`gemini-2.5-flash-lite`) receives the **reduced** context and returns strict
JSON (via `responseSchema`) with nullable fields. System instruction forbids
inventing prices/discounts/guarantees/claims; unsupported fields come back null/
[]. Degrades gracefully (returns no enrichment, not an error) when disabled or
keyless. Token usage + a billed-cost estimate are reported and tracked
separately from video spend.

### Merge layer (`lib/crawl/merge.js`)

Priority: `user_edit > json_ld/structured > open_graph > internal_page >
page_dom > ai_extracted > ai_inferred`. AI fills GAPS and interpretive fields;
it never overwrites a present high-confidence structured fact (e.g. a JSON-LD
price). Every field keeps `{ source, confidence }` provenance.

### Context reduction (`lib/crawl/contextReducer.js`)

Compresses 40k+ chars of crawl into a prioritized ~7k-char block (structured
facts → title/meta → headings → page content → selected secondary pages → image
meta) so we never pay to send raw HTML to Gemini.

### Firecrawl fallback (updated)

Direct fetch runs first. Firecrawl is used **automatically** only when direct
extraction is poor (no name + short text, or short text + no images) AND
`FIRECRAWL_API_KEY` is set — not via a manual per-request flag, and not both
providers unnecessarily.

## Separate from this: Generation Context Compiler

See `docs/CREATIVE.md`. Video generation receives a **minimal**
`GenerationContext` (identity, offer, brand look, hero reference, chosen
concept, brief) — never the raw crawl, full profile, specs, warnings or every
image URL.

---

## Legacy notes (still accurate)

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
