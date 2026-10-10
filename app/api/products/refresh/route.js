/**
 * POST /api/products/refresh — force a fresh crawl, bypassing the cache.
 * Thin wrapper over the import orchestrator with refresh=true.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { importProduct } from "@/lib/crawl/importProduct.js";
import { CrawlError } from "@/lib/crawl/safeFetch.js";

export const maxDuration = 60;

// Loose string (not z.string().url()) so bare domains work; normalizeInputUrl
// handles scheme/validation inside the orchestrator.
const schema = z.object({ url: z.string().trim().min(3).max(2000) });

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
    const result = await importProduct(parsed.data.url, { refresh: true });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof CrawlError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 422 });
    }
    return NextResponse.json(
      { error: `Unexpected error: ${err?.message || "unknown"}` },
      { status: 500 }
    );
  }
}
