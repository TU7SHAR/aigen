/**
 * Transport-agnostic core of POST /api/generate.
 *
 * This holds the REAL request pipeline — Zod validation, reference resolution,
 * canonical creative compile, preflight gate, provider dispatch, spend
 * accounting — and returns a plain `{ status, body }`. The Next route handler
 * (`app/api/generate/route.js`) is a thin wrapper that serializes this with
 * `NextResponse`. Splitting it out lets the full server pipeline be
 * integration-tested without Next's `next/server` module resolution.
 *
 * No transport types (NextResponse/Request) appear here.
 */

import { generateRequestSchema } from "../validation.js";
import { compileCreativeRequest } from "../creative/compile.js";
import { getVideoProvider, ProviderError } from "../ai/index.js";
import { resolveReferenceAsset } from "../assets/resolveReference.js";
import {
  isPaidGenerationEnabled,
  getProviderName,
  getDevSpendLimitUsd,
} from "../config.js";
import {
  estimateCost,
  checkSpendBudget,
  recordSpendUsd,
} from "../costs/estimate.js";

// --- Simple in-memory guards (reset on restart; prototype-only) ---
/** @type {Map<string, number>} recently seen idempotency keys -> timestamp */
const seenRequests = new Map();
let activeGenerations = 0;
const MAX_CONCURRENT = 1;
const DEDUP_WINDOW_MS = 60_000;

function rememberRequest(id) {
  const now = Date.now();
  for (const [k, t] of seenRequests) {
    if (now - t > DEDUP_WINDOW_MS) seenRequests.delete(k);
  }
  if (id) seenRequests.set(id, now);
}

/** For tests: reset the in-memory dedup/concurrency guards. */
export function __resetGenerateGuards() {
  seenRequests.clear();
  activeGenerations = 0;
}

/**
 * Run the generation pipeline.
 * @param {unknown} body already-parsed JSON request body
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function runGenerate(body) {
  const parsed = generateRequestSchema.safeParse(body);
  if (!parsed.success) {
    return {
      status: 422,
      body: {
        error: "Validation failed.",
        details: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
    };
  }
  const input = parsed.data;

  // Resolve a chosen IMPORTED asset into the generation reference image.
  //
  // Product PR A: the review UI can now select MULTIPLE references with roles.
  // The video provider takes a single hero/reference image, so we resolve the
  // PRIMARY one (explicitly flagged, else the first selected) into `image`, and
  // record the full selected set on `sourceImageMeta.selectedReferences` so the
  // choice is auditable and available to the creative pipeline. Single-URL
  // `referenceAssetUrl` remains supported for back-compat.
  if (!input.image) {
    let primaryUrl = input.referenceAssetUrl;
    let primaryRole = input.referenceAssetRole;
    const selected = Array.isArray(input.referenceAssets) ? input.referenceAssets : [];
    if (!primaryUrl && selected.length) {
      const chosen = selected.find((a) => a.primary) || selected[0];
      primaryUrl = chosen?.url;
      primaryRole = chosen?.role || primaryRole;
    }
    if (primaryUrl) {
      const resolved = await resolveReferenceAsset(primaryUrl);
      if (resolved) {
        input.image = resolved;
        input.sourceImageMeta = {
          ...(input.sourceImageMeta || {}),
          role: primaryRole || input.sourceImageMeta?.role,
          url: primaryUrl,
          selectedReferences: selected.length
            ? selected.map((a) => ({ url: a.url, role: a.role || null, primary: Boolean(a.primary) }))
            : undefined,
        };
      }
    }
  }

  if (input.clientRequestId && seenRequests.has(input.clientRequestId)) {
    return { status: 409, body: { error: "Duplicate request ignored (same clientRequestId)." } };
  }
  if (activeGenerations >= MAX_CONCURRENT) {
    return {
      status: 429,
      body: {
        error:
          "A generation is already in progress. Only one at a time is allowed in this prototype.",
      },
    };
  }

  const usingRealProvider = getProviderName() === "gemini";
  const est = estimateCost({ durationSeconds: input.durationSeconds, resolution: input.resolution });

  if (usingRealProvider) {
    if (!isPaidGenerationEnabled()) {
      return {
        status: 503,
        body: {
          error:
            "Paid AI generation is disabled. Set ENABLE_PAID_GENERATION=true to allow real Gemini calls.",
          code: "PAID_GENERATION_DISABLED",
          estimatedCost: est,
        },
      };
    }
    const budget = checkSpendBudget(est.amountUsd, getDevSpendLimitUsd());
    if (!budget.ok) {
      return { status: 402, body: { error: budget.reason, code: "SPEND_LIMIT", estimatedCost: est } };
    }
  }

  const compiled = compileCreativeRequest(input);
  const { brief, scenePlan, finalVideoPrompt: prompt, generationContext, preflight } = compiled;

  if (!preflight.readyForPaidGeneration) {
    return {
      status: 422,
      body: { error: "Creative preflight failed — generation blocked.", code: "PREFLIGHT_BLOCKED", preflight },
    };
  }

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

    if (usingRealProvider) {
      const actual =
        result.cost?.state === "billed" && typeof result.cost.amountUsd === "number"
          ? result.cost.amountUsd
          : est.amountUsd;
      recordSpendUsd(actual);
    }

    const billed = result.cost?.state === "billed";
    return {
      status: 200,
      body: {
        ok: true,
        prompt,
        creative: {
          entityType: compiled.entityType,
          strategy: compiled.strategy,
          generationMode: compiled.generationMode,
          brief,
          scenePlan,
          sourceImage: compiled.sourceImage,
          negativeRules: compiled.negativeRules,
          generationContext,
          generationContextChars: compiled.generationContextChars,
          preflight,
        },
        mock: result.mock,
        provider: result.provider,
        model: result.model,
        mimeType: result.mimeType,
        usage: result.usage ?? null,
        receivedRequest: result.receivedRequest ?? null,
        video: `data:${result.mimeType};base64,${result.videoBase64}`,
        cost: {
          estimated: est,
          reported: result.cost,
          note: result.mock
            ? "Mock generation: no API call, no charge. Estimate shows what a real call would cost."
            : billed
              ? "Cost computed from the provider's reported token usage × published rates. Reconcile against Google AI Studio billing for the authoritative amount."
              : "Provider did not report usage; actual cost unknown — check Google AI Studio billing.",
        },
      },
    };
  } catch (err) {
    if (err instanceof ProviderError) {
      return { status: err.status, body: { error: err.message, code: "PROVIDER_ERROR" } };
    }
    return { status: 500, body: { error: `Unexpected error: ${err?.message || "unknown"}` } };
  } finally {
    activeGenerations -= 1;
  }
}
