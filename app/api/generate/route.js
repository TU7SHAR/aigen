/**
 * POST /api/generate — create a product video ad.
 *
 * Flow:
 *   1. Validate payload (Zod).
 *   2. Guard against duplicate submits (clientRequestId) and concurrent runs.
 *   3. Build the ad prompt (or use the user's edited override).
 *   4. If the active provider is the REAL Gemini one, enforce the paid-gen
 *      kill-switch and the local dev spend budget BEFORE calling the model.
 *   5. Call the provider. On failure, return an honest error (never a fake OK).
 *
 * The Gemini Omni Interactions API is synchronous, so we return the video
 * inline. maxDuration is raised accordingly; on serverless hosts this must stay
 * within the plan's execution limit (documented in docs/ARCHITECTURE.md).
 */

import { NextResponse } from "next/server";
import { generateRequestSchema } from "@/lib/validation.js";
import { buildCreativePlan } from "@/lib/creative/planner.js";
import { composeVideoPrompt } from "@/lib/creative/promptComposer.js";
import { classifySourceImageHeuristic } from "@/lib/creative/sourceImage.js";
import {
  compileGenerationContext,
  contextSize,
} from "@/lib/creative/generationContext.js";
import { getVideoProvider, ProviderError } from "@/lib/ai/index.js";
import {
  isPaidGenerationEnabled,
  getProviderName,
  getDevSpendLimitUsd,
} from "@/lib/config.js";
import {
  estimateCost,
  checkSpendBudget,
  recordSpendUsd,
} from "@/lib/costs/estimate.js";

// NOTE: This build enables `cacheComponents`, which disallows the `runtime`
// and `dynamic` route segment configs. POST handlers are dynamic by default,
// so no config is needed. `maxDuration` raises the execution limit to allow
// the synchronous Gemini Omni call to complete; keep it within your host's
// plan limit when deploying.
export const maxDuration = 300;

// --- Simple in-memory guards (reset on restart; prototype-only) ---
/** @type {Map<string, number>} recently seen idempotency keys -> timestamp */
const seenRequests = new Map();
let activeGenerations = 0;
const MAX_CONCURRENT = 1;
const DEDUP_WINDOW_MS = 60_000;

function rememberRequest(id) {
  const now = Date.now();
  // prune
  for (const [k, t] of seenRequests) {
    if (now - t > DEDUP_WINDOW_MS) seenRequests.delete(k);
  }
  if (id) seenRequests.set(id, now);
}

export async function POST(request) {
  // 1. Parse + validate
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body." },
      { status: 400 }
    );
  }

  const parsed = generateRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Validation failed.",
        details: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
      { status: 422 }
    );
  }
  const input = parsed.data;

  // 2. Duplicate-submit guard
  if (input.clientRequestId && seenRequests.has(input.clientRequestId)) {
    return NextResponse.json(
      { error: "Duplicate request ignored (same clientRequestId)." },
      { status: 409 }
    );
  }

  // 2b. Single active generation (prototype constraint)
  if (activeGenerations >= MAX_CONCURRENT) {
    return NextResponse.json(
      {
        error:
          "A generation is already in progress. Only one at a time is allowed in this prototype.",
      },
      { status: 429 }
    );
  }

  const usingRealProvider = getProviderName() === "gemini";

  // 3. Cost estimate (always computed for the UI / ledger)
  const est = estimateCost({
    durationSeconds: input.durationSeconds,
    resolution: input.resolution,
  });

  // 4. Paid-gen kill switch + budget guard — ONLY for the real provider.
  if (usingRealProvider) {
    if (!isPaidGenerationEnabled()) {
      return NextResponse.json(
        {
          error:
            "Paid AI generation is disabled. Set ENABLE_PAID_GENERATION=true to allow real Gemini calls.",
          code: "PAID_GENERATION_DISABLED",
          estimatedCost: est,
        },
        { status: 503 }
      );
    }
    const budget = checkSpendBudget(est.amountUsd, getDevSpendLimitUsd());
    if (!budget.ok) {
      return NextResponse.json(
        { error: budget.reason, code: "SPEND_LIMIT", estimatedCost: est },
        { status: 402 }
      );
    }
  }

  // 5. Build prompt via the brand-aware creative pipeline:
  //    source-image class → CreativeBrief → ScenePlan → professional prompt.
  //    (A user prompt override still wins when supplied.)
  const product = {
    name: input.productName,
    brand: input.brand || input.productProfile?.brand || undefined,
    description: input.description || input.productProfile?.description,
    category: input.productProfile?.category,
    targetCustomer: input.productProfile?.targetCustomer,
    ...(input.productProfile || {}),
  };
  const brand = input.brandProfile || null;

  // Classify the source image so a poster/ad/collage is treated as a
  // REFERENCE rather than literally animated (the key quality fix).
  const sourceImage = input.image
    ? classifySourceImageHeuristic({
        role: input.sourceImageMeta?.role,
        url: input.sourceImageMeta?.url,
        hintText: input.sourceImageMeta?.hintText,
      })
    : undefined;

  const { brief, scenePlan } = buildCreativePlan({
    product,
    brand,
    template: input.template,
    durationSeconds: input.durationSeconds,
    aspectRatio: input.aspectRatio,
    sourceImage,
    brandInfluence: input.brandInfluence,
    userIntent: input.userIntent,
  });

  const composed = composeVideoPrompt({
    brief,
    scenePlan,
    product,
    brand,
    sourceImage,
    aspectRatio: input.aspectRatio,
    offer: input.offer,
    cta: input.cta,
  });

  const prompt =
    input.promptOverride && input.promptOverride.length > 0
      ? input.promptOverride
      : composed.prompt;

  // Compile the MINIMAL generation context (not the whole profile/crawl). This
  // is what a future multi-input pipeline/Remotion step should consume; we also
  // return it so context-reduction is measurable.
  const generationContext = compileGenerationContext({
    entityType: input.productProfile?.entityType || input.entityType,
    profile: product,
    brand,
    heroAsset: input.productProfile?.primaryImage || null,
    sourceType: sourceImage?.type || null,
    concept: input.concept || null,
    brief,
  });

  // 6. Generate
  activeGenerations += 1;
  rememberRequest(input.clientRequestId);
  try {
    const provider = getVideoProvider();
    const result = await provider.generate({
      prompt,
      image: input.image,
      aspectRatio: input.aspectRatio,
      resolution: input.resolution,
      durationSeconds: input.durationSeconds,
    });

    // Record spend against the dev guard for the real provider. Prefer the
    // ACTUAL billed amount derived from the provider's reported token usage;
    // fall back to the pre-call estimate only if usage was not reported.
    if (usingRealProvider) {
      const actual =
        result.cost?.state === "billed" &&
        typeof result.cost.amountUsd === "number"
          ? result.cost.amountUsd
          : est.amountUsd;
      recordSpendUsd(actual);
    }

    const billed = result.cost?.state === "billed";
    return NextResponse.json({
      ok: true,
      prompt,
      // Surface the internal creative plan + source-image handling for
      // transparency/debugging (helps show WHY a poster didn't become a phone).
      creative: {
        brief,
        scenePlan,
        sourceImage: sourceImage || null,
        negativePrompt: composed.negativePrompt,
        generationContext,
        generationContextChars: contextSize(generationContext),
      },
      mock: result.mock,
      provider: result.provider,
      model: result.model,
      mimeType: result.mimeType,
      usage: result.usage ?? null,
      video: `data:${result.mimeType};base64,${result.videoBase64}`,
      cost: {
        // Pre-call estimate (used only for the budget guard / UI preview).
        estimated: est,
        // What was actually billed, computed from the provider's reported
        // token usage. state: "billed" | "unknown" | "estimated" (mock).
        reported: result.cost,
        note: result.mock
          ? "Mock generation: no API call, no charge. Estimate shows what a real call would cost."
          : billed
            ? "Cost computed from the provider's reported token usage × published rates. Reconcile against Google AI Studio billing for the authoritative amount."
            : "Provider did not report usage; actual cost unknown — check Google AI Studio billing.",
      },
    });
  } catch (err) {
    if (err instanceof ProviderError) {
      return NextResponse.json(
        { error: err.message, code: "PROVIDER_ERROR" },
        { status: err.status }
      );
    }
    return NextResponse.json(
      { error: `Unexpected error: ${err?.message || "unknown"}` },
      { status: 500 }
    );
  } finally {
    activeGenerations -= 1;
  }
}

export async function GET() {
  // Lightweight capability/status probe for the UI.
  return NextResponse.json({
    provider: getProviderName(),
    paidGenerationEnabled: isPaidGenerationEnabled(),
    devSpendLimitUsd: getDevSpendLimitUsd(),
  });
}
