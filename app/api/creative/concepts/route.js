/**
 * POST /api/creative/concepts — generate brand-adaptive ad concepts.
 *
 * Input:  { product, brand? }
 * Output: { concepts, basis }
 *
 * Deterministic, no AI cost. Runs AFTER import and BEFORE paid generation so
 * the user chooses a direction before any video credits are spent.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { generateConcepts } from "@/lib/creative/concepts.js";

const schema = z.object({
  product: z.object({}).passthrough().optional().default({}),
  brand: z.object({}).passthrough().nullable().optional(),
  entityType: z.string().optional(),
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
  const result = generateConcepts({
    product: parsed.data.product,
    brand: parsed.data.brand ?? null,
    entityType: parsed.data.entityType,
  });
  return NextResponse.json({ ok: true, ...result });
}
