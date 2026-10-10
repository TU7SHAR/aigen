/**
 * POST /api/products/import  — import ANY source (product/SaaS/business/creator)
 *                              from a URL. Bare domains like "bhavishai.in" are
 *                              accepted and normalized to https before crawling.
 * POST /api/products/refresh — same, forcing a fresh crawl (bypass cache).
 *
 * Input:  { url: string, refresh?: boolean }
 * Output: rich Source-Intelligence result (see lib/crawl/importProduct.js).
 *
 * This endpoint performs NO paid VIDEO generation. It may make a cheap Gemini
 * TEXT enrichment call (tracked separately). SSRF protection lives in
 * lib/crawl/safeFetch; URL normalization in lib/crawl/normalizeUrl.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { importProduct } from "@/lib/crawl/importProduct.js";
import { CrawlError } from "@/lib/crawl/safeFetch.js";

export const maxDuration = 60;

// NOTE: we accept a loose string (NOT z.string().url()) so "bhavishai.in"
// without a scheme is not rejected with a 422. normalizeInputUrl handles it.
const schema = z.object({
  url: z.string().trim().min(3).max(2000),
  refresh: z.boolean().optional().default(false),
});

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed.", details: parsed.error.issues },
      { status: 422 }
    );
  }

  try {
    const result = await importProduct(parsed.data.url, {
      refresh: parsed.data.refresh,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof CrawlError) {
      // Map crawl failures to understandable statuses; never hallucinate data.
      const status =
        err.code === "BLOCKED_IP" || err.code === "BLOCKED_HOST" || err.code === "UNSUPPORTED_SCHEME"
          ? 400
          : err.code === "TIMEOUT"
            ? 504
            : err.code === "TOO_LARGE"
              ? 413
              : 422;
      return NextResponse.json(
        { error: err.message, code: err.code, fallback: "You can import this product manually instead." },
        { status }
      );
    }
    return NextResponse.json(
      { error: `Unexpected error: ${err?.message || "unknown"}` },
      { status: 500 }
    );
  }
}
