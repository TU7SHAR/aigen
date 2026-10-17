/**
 * POST /api/creative/storyboard — the AI Creative Director.
 *
 * Turns ONE chosen concept into an executable, variable-length storyboard
 * (per-shot technique, exact copy, motion, transitions). Cheap TEXT model, no
 * video cost; degrades to a deterministic concept-driven storyboard with no key.
 *
 * Input:  { concept, product?, brand?, design?, entityType?, allowsPhysicalLanguage?,
 *           durationSeconds?, aspectRatio?, availableAssets?, emphasis?, avoid? }
 * Output: { ok, storyboard, origin, aiCost, note? }
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { directStoryboard } from "@/lib/creative/director.js";
import { languageProfileSchema, assessLanguageProfile } from "@/lib/i18n/profile.js";

export const maxDuration = 60;

const schema = z.object({
  concept: z.object({}).passthrough(),
  product: z.object({}).passthrough().optional().default({}),
  brand: z.object({}).passthrough().nullable().optional(),
  design: z.object({}).passthrough().nullable().optional(),
  entityType: z.string().optional(),
  allowsPhysicalLanguage: z.boolean().optional(),
  durationSeconds: z.number().int().min(3).max(30).optional(),
  aspectRatio: z.string().max(10).optional(),
  availableAssets: z.array(z.object({}).passthrough()).max(12).optional(),
  emphasis: z.array(z.string()).max(12).optional(),
  avoid: z.array(z.string()).max(12).optional(),
  focus: z.union([z.string().max(200), z.object({}).passthrough()]).optional(),
  language: languageProfileSchema.optional(),
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
    return NextResponse.json({ error: "Validation failed.", details: parsed.error.issues }, { status: 422 });
  }
  const languageCheck = assessLanguageProfile(parsed.data.language);
  const result = await directStoryboard({ ...parsed.data, language: languageCheck.profile });
  return NextResponse.json({ ok: true, ...result, languageCheck });
}
