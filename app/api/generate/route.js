/**
 * /api/generate
 *   POST — legacy synchronous one-shot generation (CLI/tests). The Studio uses
 *          the durable job path (POST /api/jobs) instead.
 *   GET  — capability/status probe for the UI: routing chains with live quota,
 *          paid gates, durable spend. No secrets.
 */

import { NextResponse, connection } from "next/server";
import { runGenerate } from "@/lib/api/generateCore.js";
import { getProviderStatus } from "@/lib/ai/providerStatus.js";
import { getModelInfo, deprecationWarning, getDefaultModelId } from "@/lib/ai/modelRegistry.js";
import { isPaidGenerationEnabled, getProviderName, getDailySpendLimitUsd } from "@/lib/config.js";
import { RESOLUTION_MULTIPLIER } from "@/lib/costs/estimate.js";

// cacheComponents disallows `runtime`/`dynamic` segment configs; POST is
// dynamic by default. Keep maxDuration within the host's limit.
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
  await connection();
  const model = getModelInfo(getDefaultModelId());
  return NextResponse.json({
    providers: await getProviderStatus(),
    provider: getProviderName(),
    paidGenerationEnabled: isPaidGenerationEnabled(),
    dailySpendLimitUsd: getDailySpendLimitUsd(),
    devSpendLimitUsd: getDailySpendLimitUsd(),
    model: { id: model.id, label: model.label, status: model.status, usdPerSecond720p: model.usdPerSecond720p },
    resolutionMultipliers: RESOLUTION_MULTIPLIER,
    modelWarning: deprecationWarning(),
  });
}
