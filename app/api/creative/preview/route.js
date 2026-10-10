/**
 * POST /api/creative/preview — compile the creative plan WITHOUT generating.
 *
 * Returns exactly what /api/generate would use (same compileCreativeRequest),
 * so the UI's prompt preview and storyboard reflect the real server prompt.
 * NO paid video generation here.
 */

import { NextResponse } from "next/server";
import { generateRequestSchema } from "@/lib/validation.js";
import { compileCreativeRequest } from "@/lib/creative/compile.js";
import { estimateCost } from "@/lib/costs/estimate.js";

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  // Reuse the generate schema but tolerate a missing clientRequestId etc.
  const parsed = generateRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Validation failed.",
        details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      },
      { status: 422 }
    );
  }
  const input = parsed.data;
  const compiled = compileCreativeRequest(input);
  const estimatedCost = estimateCost({
    durationSeconds: input.durationSeconds,
    resolution: input.resolution,
  });

  return NextResponse.json({
    ok: true,
    entityType: compiled.entityType,
    strategy: compiled.strategy,
    generationMode: compiled.generationMode,
    creativeBrief: compiled.brief,
    scenePlan: compiled.scenePlan,
    generationContext: compiled.generationContext,
    generationContextChars: compiled.generationContextChars,
    finalVideoPrompt: compiled.finalVideoPrompt,
    negativeRules: compiled.negativeRules,
    sourceImage: compiled.sourceImage,
    preflight: compiled.preflight,
    estimatedCost,
  });
}
