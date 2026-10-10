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

import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { generateRequestSchema } from "@/lib/validation.js";
import { compileCreativeRequest } from "@/lib/creative/compile.js";
import { getVideoProvider, ProviderError } from "@/lib/ai/index.js";
import { getModelInfo, deprecationWarning } from "@/lib/ai/modelRegistry.js";
import { safeFetch } from "@/lib/crawl/safeFetch.js";

const REF_MIME = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".svg": "image/svg+xml",
};

/**
 * Resolve a reference asset URL into { data(base64), mimeType }.
 * - Local stored asset (/imported-assets/..): read from public dir.
 * - Remote URL: SSRF-safe fetch.
 * Returns null on failure (generation proceeds without a reference).
 */
async function resolveReferenceAsset(url) {
  try {
    if (url.startsWith("/imported-assets/")) {
      const safeName = path.basename(url); // prevent traversal
      const full = path.join(process.cwd(), "public", "imported-assets", safeName);
      const buf = await fs.readFile(full);
      const mime = REF_MIME[path.extname(safeName).toLowerCase()] || "image/png";
      if (mime === "image/svg+xml") return null; // raster-only for the model
      return { data: buf.toString("base64"), mimeType: mime };
    }
    if (/^https?:\/\//i.test(url)) {
      const res = await safeFetch(url, { accept: "image/*", asBuffer: true, maxBytes: 8 * 1024 * 1024, timeoutMs: 10_000 });
      const mime = (res.contentType || "").split(";")[0].trim().toLowerCase();
      if (!mime.startsWith("image/") || mime === "image/svg+xml") return null;
      if (!(res.body instanceof Buffer)) return null;
      return { data: res.body.toString("base64"), mimeType: mime };
    }
  } catch {
    return null;
  }
  return null;
}
import {
  isPaidGenerationEnabled,
  getProviderName,
  getDevSpendLimitUsd,
} from "@/lib/config.js";
import {
  estimateCost,
  checkSpendBudget,
  recordSpendUsd,
  RESOLUTION_MULTIPLIER,
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

  // 1b. Resolve a chosen IMPORTED asset into the generation reference image.
  //     This fixes the bug where a crawler-found image was shown but never sent
  //     to the model (only manual uploads populated input.image). We fetch it
  //     server-side, SSRF-safely, and feed it as the reference.
  if (!input.image && input.referenceAssetUrl) {
    const resolved = await resolveReferenceAsset(input.referenceAssetUrl);
    if (resolved) {
      input.image = resolved;
      input.sourceImageMeta = {
        ...(input.sourceImageMeta || {}),
        role: input.referenceAssetRole || input.sourceImageMeta?.role,
        url: input.referenceAssetUrl,
      };
    }
  }

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

  // 5. Compile the creative request with the SINGLE canonical compiler (the
  //    same one /api/creative/preview uses). This dispatches on entity type, so
  //    a SaaS/service/creator never gets physical-product language.
  const compiled = compileCreativeRequest(input);
  const { brief, scenePlan, finalVideoPrompt: prompt, generationContext, preflight } = compiled;

  // 5b. PREFLIGHT GATE — never spend credits on an entity/prompt contradiction
  //     (e.g. a SaaS plan that mentions a bottle). Blockers hard-stop here.
  if (!preflight.readyForPaidGeneration) {
    return NextResponse.json(
      {
        error: "Creative preflight failed — generation blocked.",
        code: "PREFLIGHT_BLOCKED",
        preflight,
      },
      { status: 422 }
    );
  }

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
