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
import { composeScreenAd } from "../render/compositor.js";
import {
  isPaidGenerationEnabled,
  getProviderName,
  getDevSpendLimitUsd,
  isDryRun,
  isPaidGenerationHardDisabled,
  DETERMINISTIC_FORMATS,
} from "../config.js";
import {
  estimateCost,
  checkSpendBudget,
  recordSpendUsd,
} from "../costs/estimate.js";

/** Is this request a deterministic (compositor) render — no paid model? */
function isDeterministicFormat(format) {
  // Default route is the deterministic screen path (safe, no cost).
  const f = format || "screen_demo";
  return DETERMINISTIC_FORMATS.includes(f);
}

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

  const format = input.format || "screen_demo";
  const deterministic = isDeterministicFormat(format);
  const est = estimateCost({ durationSeconds: input.durationSeconds, resolution: input.resolution });

  // Compile the creative plan (shared by every route and by dry-run).
  const compiled = compileCreativeRequest(input);
  const { brief, scenePlan, finalVideoPrompt: prompt, generationContext, preflight } = compiled;

  const creativePayload = {
    entityType: compiled.entityType,
    strategy: compiled.strategy,
    generationMode: compiled.generationMode,
    productionMethod: compiled.productionMethod,
    brief,
    scenePlan,
    sourceImage: compiled.sourceImage,
    negativeRules: compiled.negativeRules,
    generationContext,
    generationContextChars: compiled.generationContextChars,
    preflight,
  };

  // ---- PRIORITY 0: hard dry-run / paid-disable gate for GENERATIVE route ----
  // A paid generative call requires an EXPLICIT generative format AND the hard
  // kill-switch to be lifted. Otherwise we return the full plan WITHOUT spending
  // anything, so the user can review before authorizing. Deterministic formats
  // (screen_demo / cinematic_card) are rendered for real below — no model.
  if (!deterministic) {
    if (isPaidGenerationHardDisabled() || isDryRun()) {
      return {
        status: 200,
        body: {
          ok: true,
          dryRun: true,
          format,
          prompt,
          creative: creativePayload,
          plan: buildDryRunPlan(input, compiled, est, format),
          video: null,
          cost: { estimated: est, reported: { amountUsd: 0, state: "estimated" } },
          note:
            "DRY RUN — paid generative video is disabled during the quality rebuild. " +
            "This is the exact plan, script, storyboard, assets and model request that WOULD be sent. " +
            "No credits were spent. Set DISABLE_PAID_GENERATION=false (and the other gates) to allow a real call.",
        },
      };
    }
  }

  // Preflight gate applies to any route that actually renders/generates.
  if (!preflight.readyForPaidGeneration) {
    return {
      status: 422,
      body: { error: "Creative preflight failed — generation blocked.", code: "PREFLIGHT_BLOCKED", preflight },
    };
  }

  activeGenerations += 1;
  rememberRequest(input.clientRequestId);
  try {
    // ---- DETERMINISTIC ROUTE: real finished MP4 via the ffmpeg compositor ----
    // (P0 FIX: this branch was lost in a merge, so screen_demo wrongly fell
    // through to a paid video model. The default format is deterministic.)
    if (deterministic) {
      const composed = await composeScreenAd({ input, compiled });
      return {
        status: 200,
        body: {
          ok: true,
          format,
          deterministic: true,
          prompt,
          creative: creativePayload,
          render: {
            method: composed.method,
            usedImages: composed.usedImages,
            overlays: composed.overlays,
            durationSec: composed.durationSec,
            width: composed.width,
            height: composed.height,
          },
          mock: false,
          provider: "compositor",
          model: "ffmpeg-static",
          mimeType: composed.mimeType,
          video: `data:${composed.mimeType};base64,${composed.videoBase64}`,
          cost: {
            estimated: est,
            reported: { amountUsd: 0, state: "billed" },
            note:
              "Rendered deterministically from your real assets + exact copy (ffmpeg). " +
              "No generative video model was called; no credits were spent.",
          },
        },
      };
    }

    // ---- GENERATIVE ROUTE (only reachable when paid gen is explicitly on) ----
    // (P0 FIX: declare usingRealProvider and ENFORCE the paid-gen kill switch +
    // spend budget BEFORE dispatching to any paid provider.)
    const usingRealProvider = getProviderName() === "gemini";
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

    // Provider resolution is async: the `modal` route checks its monthly GPU
    // budget and transparently falls back to Gemini when the cap is reached.
    const provider = await getVideoProvider({ estimatedUsd: est.amountUsd });
    const result = await provider.generate({
      prompt,
      image: input.image,
      aspectRatio: input.aspectRatio,
      resolution: input.resolution,
      durationSeconds: input.durationSeconds,
    });

    // Record spend for any genuinely-billed/estimated real provider (Gemini
    // family OR the Modal GPU estimate), so the dev ledger reflects reality.
    if (usingRealProvider || result.provider === "modal") {
      const actual =
        typeof result.cost?.amountUsd === "number" ? result.cost.amountUsd : est.amountUsd;
      recordSpendUsd(actual);
    }

    const billed = result.cost?.state === "billed";
    return {
      status: 200,
      body: {
        ok: true,
        format,
        prompt,
        creative: creativePayload,
        mock: result.mock,
        provider: result.provider,
        model: result.model,
        fallbackReason: provider.fallbackReason || undefined,
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

/**
 * Build the dry-run plan the user reviews before any paid call: the exact
 * offering, format, script/message, storyboard, selected assets, final model
 * request and estimated cost.
 */
function buildDryRunPlan(input, compiled, est, format) {
  const brief = compiled.brief || {};
  const scenes = compiled.scenePlan?.scenes || [];
  return {
    format,
    offering: {
      entityType: compiled.entityType,
      name: input.productName || null,
      brand: input.brand || brief?.brand?.name || null,
      category: input.category || null,
      offering: input.offering || null,
      description: input.description || null,
    },
    message: {
      objective: brief.objective || null,
      centralMessage: brief.conceptCentralMessage || null,
      emphasis: brief.emphasis || [],
      avoid: brief.avoid || [],
    },
    storyboard: scenes.map((s, i) => ({
      scene: i + 1,
      purpose: s.purpose,
      durationSec: s.duration,
      visual: s.visual,
      camera: s.camera,
      motion: s.motion,
    })),
    deterministicCopy: {
      brand: input.brand || brief?.brand?.name || null,
      offer: input.offer || null,
      cta: input.cta || null,
      note: "These exact strings are rendered by the compositor — never by the video model.",
    },
    selectedAssets:
      (Array.isArray(input.referenceAssets) && input.referenceAssets.map((a) => ({ url: a.url, role: a.role, primary: !!a.primary }))) ||
      (input.referenceAssetUrl ? [{ url: input.referenceAssetUrl, role: input.referenceAssetRole }] : []),
    finalModelRequest: {
      prompt: compiled.finalVideoPrompt,
      negativeRules: compiled.negativeRules,
      aspectRatio: input.aspectRatio,
      resolution: input.resolution,
      durationSeconds: input.durationSeconds,
    },
    estimatedCost: est,
  };
}
