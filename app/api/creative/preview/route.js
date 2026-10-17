/**
 * POST /api/creative/preview — the exact plan, preflight and production
 * estimate that "Create video" would use (same prepareGeneration), with no
 * paid call.
 */

import { NextResponse } from "next/server";
import { prepareGeneration } from "@/lib/api/generateCore.js";
import { estimateProduction } from "@/lib/costs/productionEstimate.js";

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const prepared = await prepareGeneration(body);
  if (!prepared.ok) return NextResponse.json(prepared.body, { status: prepared.status });
  const { compiled, input, est, creativePayload } = prepared;
  return NextResponse.json({
    ok: true,
    entityType: compiled.entityType,
    strategy: compiled.strategy,
    generationMode: compiled.generationMode,
    creativeBrief: compiled.brief,
    scenePlan: compiled.scenePlan,
    finalVideoPrompt: compiled.finalVideoPrompt,
    negativeRules: compiled.negativeRules,
    sourceImage: compiled.sourceImage,
    preflight: compiled.preflight,
    language: creativePayload.language,
    destination: creativePayload.destination,
    estimatedCost: est,
    production: estimateProduction(compiled.scenePlan, input),
  });
}
