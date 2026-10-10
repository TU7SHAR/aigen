/**
 * POST /api/creative/concepts — generate ad concepts.
 *
 * Input:  { product, brand?, design?, entity?, entityType?, objective?, hasUsableImage? }
 * Output: { concepts, basis, origin }
 *
 * PRIMARY: AI creative reasoning grounded in the source evidence (cheap TEXT
 * model, no video cost). FALLBACK: entity-neutral generic directions when AI is
 * unavailable. Runs AFTER import and BEFORE any paid video generation.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { generateConceptsSmart } from "@/lib/creative/concepts.js";

export const maxDuration = 30;

const schema = z.object({
  product: z.object({}).passthrough().optional().default({}),
  brand: z.object({}).passthrough().nullable().optional(),
  design: z.object({}).passthrough().nullable().optional(),
  entity: z.object({}).passthrough().nullable().optional(),
  entityType: z.string().optional(),
  objective: z.string().max(300).optional(),
  hasUsableImage: z.boolean().optional(),
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
  const d = parsed.data;
  const result = await generateConceptsSmart({
    product: d.product,
    brand: d.brand ?? null,
    design: d.design ?? null,
    entity: d.entity ?? null,
    entityType: d.entityType || d.product?.entityType || d.entity?.entityType,
    objective: d.objective,
    hasUsableImage: d.hasUsableImage,
  });
  return NextResponse.json({ ok: true, ...result });
}
