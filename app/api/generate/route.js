/**
 * POST /api/generate — create a product video ad.
 *
 * Thin transport wrapper. The real pipeline (validation, reference resolution,
 * canonical compile, preflight gate, provider dispatch, spend accounting) lives
 * in `lib/api/generateCore.js` so it can be integration-tested without Next's
 * module resolution. This file only parses the request and serializes the
 * result with NextResponse.
 *
 * The Gemini Omni Interactions API is synchronous, so we return the video
 * inline. maxDuration is raised accordingly; on serverless hosts this must stay
 * within the plan's execution limit (documented in docs/ARCHITECTURE.md).
 */

import { NextResponse } from "next/server";
import { runGenerate } from "@/lib/api/generateCore.js";
import { getModelInfo, deprecationWarning } from "@/lib/ai/modelRegistry.js";
import {
  isPaidGenerationEnabled,
  getProviderName,
  getDevSpendLimitUsd,
} from "@/lib/config.js";
import { RESOLUTION_MULTIPLIER } from "@/lib/costs/estimate.js";

// NOTE: This build enables `cacheComponents`, which disallows the `runtime`
// and `dynamic` route segment configs. POST handlers are dynamic by default,
// so no config is needed. `maxDuration` raises the execution limit to allow
// the synchronous Gemini Omni call to complete; keep it within your host's
// plan limit when deploying.
export const maxDuration = 300;

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { status, body: payload } = await runGenerate(body);
  return NextResponse.json(payload, { status });
}

export async function GET() {
  // Lightweight capability/status probe for the UI.
  const model = getModelInfo();
  return NextResponse.json({
    provider: getProviderName(),
    paidGenerationEnabled: isPaidGenerationEnabled(),
    devSpendLimitUsd: getDevSpendLimitUsd(),
    model: {
      id: model.id,
      label: model.label,
      status: model.status,
      usdPerSecond720p: model.usdPerSecond720p,
    },
    // Resolution multipliers so the UI estimate matches the server exactly
    // (single source of truth; no duplicated numbers in the client).
    resolutionMultipliers: RESOLUTION_MULTIPLIER,
    modelWarning: deprecationWarning(),
  });
}
