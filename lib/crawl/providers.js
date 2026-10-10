/**
 * Crawl provider abstraction.
 *
 *   ProductCrawler
 *     ├─ DirectFetchProvider  (default; SSRF-safe fetch + Cheerio parsing)
 *     └─ FirecrawlProvider    (optional; for JS-heavy sites, if FIRECRAWL_API_KEY set)
 *
 * A provider's job is ONLY to return raw HTML (+ metadata) for a URL. All
 * extraction/cleaning happens in the orchestrator so swapping providers never
 * rewrites the product workflow. Firecrawl is kept behind this interface — we
 * are not hard-wired to it.
 */

import { safeFetch } from "./safeFetch.js";

/** @typedef {{ name: string, fetchPage(url:string): Promise<{ html:string, finalUrl:string, status:number, rendered:boolean }> }} CrawlProvider */

/** Default: direct server-side fetch (no JS rendering). */
export class DirectFetchProvider {
  name = "direct-fetch";
  async fetchPage(url) {
    const res = await safeFetch(url, {
      accept: "text/html,application/xhtml+xml",
      maxBytes: 4 * 1024 * 1024,
      timeoutMs: 12_000,
    });
    const html = typeof res.body === "string" ? res.body : res.body.toString("utf8");
    return { html, finalUrl: res.url, status: res.status, rendered: false };
  }
}

/**
 * Optional Firecrawl provider for JS-heavy pages. Only usable when
 * FIRECRAWL_API_KEY is configured. Kept minimal and behind the same interface.
 * The API key stays server-side. This path is UNVERIFIED until exercised with a
 * real key.
 */
export class FirecrawlProvider {
  name = "firecrawl";
  constructor(apiKey) {
    this.apiKey = apiKey;
  }
  async fetchPage(url) {
    const resp = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url, formats: ["html"], onlyMainContent: false }),
    });
    if (!resp.ok) {
      throw new Error(`Firecrawl returned HTTP ${resp.status}`);
    }
    const data = await resp.json();
    const html = data?.data?.html || data?.html || "";
    if (!html) throw new Error("Firecrawl returned no HTML.");
    return { html, finalUrl: data?.data?.metadata?.sourceURL || url, status: 200, rendered: true };
  }
}

/**
 * Pick a provider. Prefers Firecrawl only when explicitly configured; the
 * default direct-fetch provider needs no secrets and covers most product pages
 * that expose JSON-LD / OpenGraph (which is the majority of commerce sites).
 */
export function getCrawlProvider() {
  const key = process.env.FIRECRAWL_API_KEY;
  if (key && process.env.CRAWL_PROVIDER === "firecrawl") {
    return new FirecrawlProvider(key);
  }
  return new DirectFetchProvider();
}
