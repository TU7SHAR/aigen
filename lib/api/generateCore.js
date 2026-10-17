/**
 * Transport-agnostic core of ad generation, shared by the Studio job path
 * (lib/jobs/runner.js), the legacy synchronous POST /api/generate and the CLI.
 *
 *   prepareGeneration(body) → validate, resolve the reference image, resolve
 *     the CTA destination, compile the creative plan, assess the language
 *     profile, run the preflight. No paid call happens here.
 *   produceGeneration(prepared, ctx) → run the production engine.
 *   runGenerate(body) → legacy one-shot (prepare + produce, base64 response).
 */

import { generateRequestSchema } from "../validation.js";
import { compileCreativeRequest } from "../creative/compile.js";
import { getVideoProvider, ProviderError } from "../ai/index.js";
import { resolveReferenceAsset } from "../assets/resolveReference.js";
import { composeScreenAd } from "../render/compositor.js";
import { resolveDestination } from "../creative/destination.js";
import { assessLanguageProfile, normalizeLanguageProfile } from "../i18n/profile.js";
import {
  isPaidGenerationEnabled, getProviderName, getDevSpendLimitUsd, isDryRun, isPaidGenerationHardDisabled, DETERMINISTIC_FORMATS,
} from "../config.js";
import { estimateCost, checkSpendBudget, recordSpendUsd } from "../costs/estimate.js";

const isDeterministicFormat = (format) => DETERMINISTIC_FORMATS.includes(format || "screen_demo");

// Legacy synchronous path guards (the job path uses durable idempotency).
const seenRequests = new Map();
let activeGenerations = 0;
const MAX_CONCURRENT = 1;
const DEDUP_WINDOW_MS = 60_000;
function rememberRequest(id) {
  const now = Date.now();
  for (const [k, t] of seenRequests) if (now - t > DEDUP_WINDOW_MS) seenRequests.delete(k);
  if (id) seenRequests.set(id, now);
}
/** For tests: reset the in-memory dedup/concurrency guards. */
export function __resetGenerateGuards() {
  seenRequests.clear();
  activeGenerations = 0;
}

/**
 * Validate + compile + preflight. Never spends.
 * @returns {Promise<{ ok: false, status: number, body: object } | { ok: true, input: object, compiled: object, format: string, deterministic: boolean, est: object, creativePayload: object, languageCheck: object, destination: object }>}
 */
export async function prepareGeneration(body) {
  const parsed = generateRequestSchema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false, status: 422,
      body: { error: "Validation failed.", code: "VALIDATION", details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
    };
  }
  const input = parsed.data;

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
          selectedReferences: selected.length ? selected.map((a) => ({ url: a.url, role: a.role || null, primary: Boolean(a.primary) })) : undefined,
        };
      }
    }
  }

  // Language: the request profile wins; otherwise the storyboard's.
  input.language = normalizeLanguageProfile(input.language || input.storyboard?.language || null);
  const languageCheck = assessLanguageProfile(input.language, { narration: input.narration !== false });

  // CTA destination: user-supplied or the imported business site, never a tracker.
  const destination = resolveDestination(input);
  if (destination.url) input.destinationUrl = destination.url;

  const format = input.format || "screen_demo";
  const deterministic = isDeterministicFormat(format);
  const est = estimateCost({ durationSeconds: input.durationSeconds, resolution: input.resolution });
  const compiled = compileCreativeRequest(input);

  // Fold language + plan validation into the preflight so nothing is charged
  // for a plan that is known to be wrong.
  const preflight = { ...compiled.preflight, blockers: [...(compiled.preflight.blockers || [])], warnings: [...(compiled.preflight.warnings || [])] };
  for (const b of languageCheck.blockers) preflight.blockers.push(b);
  for (const w of languageCheck.warnings) preflight.warnings.push(w);
  for (const w of destination.warnings) preflight.warnings.push(w);
  const validation = input.storyboard?.validation;
  for (const f of validation?.findings || []) {
    if (f.level === "error") preflight.blockers.push(`Plan check: ${f.message}`);
    else preflight.warnings.push(`Plan check: ${f.message}`);
  }
  preflight.readyForPaidGeneration = preflight.blockers.length === 0;
  compiled.preflight = preflight;

  const creativePayload = {
    entityType: compiled.entityType,
    strategy: compiled.strategy,
    generationMode: compiled.generationMode,
    productionMethod: compiled.productionMethod,
    brief: compiled.brief,
    creativeBrief: compiled.scenePlan?.creativeBrief || null,
    scenePlan: compiled.scenePlan,
    sourceImage: compiled.sourceImage,
    negativeRules: compiled.negativeRules,
    generationContext: compiled.generationContext,
    generationContextChars: compiled.generationContextChars,
    language: languageCheck,
    destination,
    preflight,
  };
  return { ok: true, input, compiled, format, deterministic, est, creativePayload, languageCheck, destination };
}

/**
 * Run the production engine for a prepared request.
 * @param {object} prepared result of prepareGeneration (ok: true)
 * @param {object} [ctx] { jobId, mediaDir, progress, resume, onOperation, signal, budget }
 */
export async function produceGeneration(prepared, ctx = {}) {
  const { input, compiled, format, deterministic, est } = prepared;
  if (deterministic) {
    const composed = await composeScreenAd({ input, compiled, ctx });
    return { kind: "composed", composed, est, format };
  }
  // Legacy single-shot generative route (format "generative").
  const usingRealProvider = getProviderName() === "gemini";
  if (usingRealProvider) {
    if (!isPaidGenerationEnabled()) {
      throw Object.assign(new Error("Paid AI generation is disabled. Set ENABLE_PAID_GENERATION=true to allow real Gemini calls."), { status: 503, code: "PAID_GENERATION_DISABLED" });
    }
    const budget = checkSpendBudget(est.amountUsd, getDevSpendLimitUsd());
    if (!budget.ok) throw Object.assign(new Error(budget.reason), { status: 402, code: "SPEND_LIMIT" });
  }
  const provider = await getVideoProvider({ estimatedUsd: est.amountUsd });
  const result = await provider.generate({
    prompt: compiled.finalVideoPrompt, image: input.image, aspectRatio: input.aspectRatio,
    resolution: input.resolution, durationSeconds: input.durationSeconds,
  });
  if (usingRealProvider || result.provider === "modal") {
    recordSpendUsd(typeof result.cost?.amountUsd === "number" ? result.cost.amountUsd : est.amountUsd, { kind: "video", label: "generative format", model: result.model });
  }
  return { kind: "generative", result, provider, est, format };
}

/** Render-response body for a composed ad (no binary). */
export function composedSummary(composed) {
  return {
    method: composed.method,
    usedImages: composed.usedImages,
    overlays: composed.overlays,
    durationSec: composed.durationSec,
    width: composed.width,
    height: composed.height,
    fps: composed.fps,
    storyboardDriven: composed.storyboardDriven,
    storyboardOrigin: composed.storyboardOrigin,
    generatedKeyframes: composed.generatedKeyframes,
    generatedVideoClips: composed.generatedVideoClips,
    imageProvider: composed.imageProvider,
    budget: composed.budget,
    quality: composed.quality,
    language: composed.language,
    timings: composed.timings,
    timeline: composed.timeline ? { starts: composed.timeline.starts, durs: composed.timeline.durs, total: composed.timeline.total, fps: composed.timeline.fps, transitions: (composed.timeline.xfades || []).map((x) => ({ xf: x.xf, frames: x.frames })) } : null,
    assembly: composed.assembly || null,
    shotReport: composed.shotReport,
  };
}

/**
 * Legacy one-shot pipeline (sync; returns the MP4 as a data URL).
 * @param {unknown} body
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function runGenerate(body) {
  const prepared = await prepareGeneration(body);
  if (!prepared.ok) return { status: prepared.status, body: prepared.body };
  const { input, compiled, format, deterministic, est, creativePayload } = prepared;
  const prompt = compiled.finalVideoPrompt;

  if (input.clientRequestId && seenRequests.has(input.clientRequestId)) {
    return { status: 409, body: { error: "Duplicate request ignored (same clientRequestId)." } };
  }
  if (activeGenerations >= MAX_CONCURRENT) {
    return { status: 429, body: { error: "A generation is already in progress on the synchronous path. Use the Studio (jobs) for parallel work." } };
  }
  if (!deterministic && (isPaidGenerationHardDisabled() || isDryRun())) {
    return {
      status: 200,
      body: {
        ok: true, dryRun: true, format, prompt, creative: creativePayload,
        plan: buildDryRunPlan(input, compiled, est, format), video: null,
        cost: { estimated: est, reported: { amountUsd: 0, state: "estimated" } },
        note: "DRY RUN — paid generative video is disabled. No credits were spent.",
      },
    };
  }
  if (!compiled.preflight.readyForPaidGeneration) {
    return { status: 422, body: { error: "Creative preflight failed — generation blocked.", code: "PREFLIGHT_BLOCKED", preflight: compiled.preflight } };
  }

  activeGenerations += 1;
  rememberRequest(input.clientRequestId);
  try {
    const out = await produceGeneration(prepared);
    if (out.kind === "composed") {
      const composed = out.composed;
      return {
        status: 200,
        body: {
          ok: true, format, deterministic: true, prompt, creative: creativePayload,
          render: composedSummary(composed),
          mock: (composed.shotReport || []).some((s) => s.executedMethod === "placeholder_keyframe"),
          provider: "compositor", model: "ffmpeg-static", mimeType: composed.mimeType,
          video: `data:${composed.mimeType};base64,${composed.videoBase64}`,
          cost: composed.paidCalls
            ? {
                estimated: est,
                reported: { amountUsd: composed.budget?.reservedUsd ?? null, state: "reserved_worst_case" },
                note: `${composed.paidCalls} paid provider call(s) ran under the per-job budget; amounts are local estimates/reservations, not the invoice.`,
              }
            : { estimated: est, reported: { amountUsd: 0, state: "billed" }, note: "Composed from your real assets + exact copy. No paid provider was called." },
        },
      };
    }
    const { result, provider } = out;
    return {
      status: 200,
      body: {
        ok: true, format, prompt, creative: creativePayload, mock: result.mock, provider: result.provider, model: result.model,
        fallbackReason: provider.fallbackReason || undefined, mimeType: result.mimeType, usage: result.usage ?? null,
        receivedRequest: result.receivedRequest ?? null,
        video: `data:${result.mimeType};base64,${result.videoBase64}`,
        cost: { estimated: est, reported: result.cost, note: result.mock ? "Mock generation: no API call, no charge." : "Reconcile against Google AI Studio billing for the authoritative amount." },
      },
    };
  } catch (err) {
    if (err instanceof ProviderError) return { status: err.status, body: { error: err.message, code: "PROVIDER_ERROR" } };
    if (err?.code) return { status: err.status || 500, body: { error: err.message, code: err.code } };
    return { status: 500, body: { error: `Unexpected error: ${err?.message || "unknown"}` } };
  } finally {
    activeGenerations -= 1;
  }
}

/** Reviewable plan for a dry run (no spend). */
export function buildDryRunPlan(input, compiled, est, format) {
  const brief = compiled.brief || {};
  const scenes = compiled.scenePlan?.scenes || [];
  return {
    format,
    offering: {
      entityType: compiled.entityType, name: input.productName || null, brand: input.brand || brief?.brand?.name || null,
      category: input.category || null, offering: input.offering || null, description: input.description || null,
    },
    message: { objective: brief.objective || null, centralMessage: brief.conceptCentralMessage || null, emphasis: brief.emphasis || [], avoid: brief.avoid || [] },
    storyboardOrigin: compiled.scenePlan?.storyboardOrigin || null,
    storyboard: scenes.map((s, i) => ({
      scene: i + 1, purpose: s.purpose, intent: s.intent || s.purpose, durationSec: s.duration, visual: s.visual,
      technique: s.technique || null, assetHint: s.assetHint || null, onScreenText: s.onScreenText || "",
      voiceover: s.voiceover || "", camera: s.camera, motion: s.motion, transitionOut: s.transitionOut || null,
    })),
    deterministicCopy: { brand: input.brand || brief?.brand?.name || null, offer: input.offer || null, cta: input.cta || null, note: "Rendered by the compositor — never by the video model." },
    selectedAssets:
      (Array.isArray(input.referenceAssets) && input.referenceAssets.map((a) => ({ url: a.url, role: a.role, primary: !!a.primary }))) ||
      (input.referenceAssetUrl ? [{ url: input.referenceAssetUrl, role: input.referenceAssetRole }] : []),
    finalModelRequest: { prompt: compiled.finalVideoPrompt, negativeRules: compiled.negativeRules, aspectRatio: input.aspectRatio, resolution: input.resolution, durationSeconds: input.durationSeconds },
    estimatedCost: est,
  };
}
