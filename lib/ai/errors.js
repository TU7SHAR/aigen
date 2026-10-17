/**
 * Classify a provider/SDK error into a routing category.
 *
 *   rate_limited       429 / RESOURCE_EXHAUSTED (scope: minute | day | unknown)
 *   model_unavailable  404 / 403 / model not found, not enabled, shut down
 *   auth               invalid or missing API key (fatal for the whole chain)
 *   invalid_request    400 the model rejected this request shape
 *   overloaded         500/502/503 transient server-side refusal
 *   safety_blocked     content filtered (Veo/Omni safety)
 *   timeout_uncertain  the request may still be running/billed remotely
 *   provider_error     anything else
 *
 * `notCharged` is only true when the request was certainly rejected before
 * any billable generation (pre-acceptance errors, or a provider that states it
 * bills successful generations only and returned none).
 */

/** @returns {{ category: string, scope?: string, retryAfterMs?: number|null, notCharged: boolean, uncertain: boolean, fatal: boolean, status: number|null }} */
export function classifyProviderError(err, { stage = "submit" } = {}) {
  if (err?.category) {
    return {
      category: err.category,
      scope: err.scope,
      retryAfterMs: err.retryAfterMs ?? null,
      notCharged: Boolean(err.notCharged),
      uncertain: Boolean(err.uncertain),
      fatal: err.category === "auth",
      status: Number(err.status) || null,
    };
  }
  const status = Number(err?.status ?? err?.code ?? err?.cause?.status ?? err?.cause?.code) || null;
  const msg = String(err?.message || err || "");
  const has = (re) => re.test(msg);
  const preAcceptance = stage === "submit";

  if (err?.filtered || has(/raiMediaFiltered|content was filtered|SAFETY|blocked by .*safety|prohibited/i)) {
    return { category: "safety_blocked", notCharged: err?.notCharged !== false, uncertain: false, fatal: false, status };
  }
  if (status === 429 || has(/RESOURCE_EXHAUSTED|exceeded your current quota|quota exceeded|rate.?limit|too many requests/i)) {
    const scope = has(/per.?day|perday|_per_day|requests per day|daily/i)
      ? "day"
      : has(/per.?minute|perminute|_per_minute|requests per minute/i)
        ? "minute"
        : "unknown";
    const m = msg.match(/retry(?:Delay|[ _-]?in|[ _-]?after)?["'\s:=]*"?([\d.]+)\s*s/i);
    return {
      category: "rate_limited", scope,
      retryAfterMs: m ? Math.ceil(Number.parseFloat(m[1]) * 1000) : null,
      notCharged: true, uncertain: false, fatal: false, status: 429,
    };
  }
  if (status === 401 || has(/API key not valid|API_KEY_INVALID|UNAUTHENTICATED|invalid api key|api key (is )?missing/i)) {
    return { category: "auth", notCharged: true, uncertain: false, fatal: true, status };
  }
  if (status === 404 || has(/NOT_FOUND|is not found|was not found|does not exist|unknown model|has been (shut ?down|discontinued|retired)/i)) {
    return { category: "model_unavailable", notCharged: true, uncertain: false, fatal: false, status };
  }
  if (status === 403 || has(/PERMISSION_DENIED|does not have (access|permission)|not available (in|for) (your|this)|not enabled|allowlist/i)) {
    return { category: "model_unavailable", notCharged: true, uncertain: false, fatal: false, status };
  }
  if (status === 400 || has(/INVALID_ARGUMENT|invalid argument|is not supported|unsupported/i)) {
    return { category: "invalid_request", notCharged: true, uncertain: false, fatal: false, status };
  }
  if (status === 504 || err?.name === "AbortError" || has(/timed? ?out|deadline exceeded|did not finish/i)) {
    return { category: "timeout_uncertain", notCharged: false, uncertain: true, fatal: false, status };
  }
  if ([500, 502, 503].includes(status) || has(/UNAVAILABLE|overloaded|INTERNAL|try again later|service unavailable/i)) {
    return { category: "overloaded", notCharged: preAcceptance, uncertain: !preAcceptance, fatal: false, status };
  }
  return { category: "provider_error", notCharged: false, uncertain: !preAcceptance, fatal: false, status };
}

/** Categories after which the router may try the next model in the chain. */
export const SWITCHABLE = new Set(["rate_limited", "model_unavailable", "invalid_request", "overloaded", "safety_blocked", "provider_error_not_charged"]);

/** Short, user-safe description of a category (no provider internals). */
export function describeCategory(category, scope) {
  switch (category) {
    case "rate_limited": return scope === "day" ? "daily limit reached" : "rate limit reached";
    case "model_unavailable": return "model not available to this account";
    case "auth": return "API key rejected";
    case "invalid_request": return "request not supported by this model";
    case "overloaded": return "provider temporarily overloaded";
    case "safety_blocked": return "blocked by the provider's safety filter";
    case "timeout_uncertain": return "timed out (may still be running)";
    case "budget": return "would exceed the spending limit";
    case "capability": return "model cannot produce this shot";
    case "quota_local": return "local quota tracker says exhausted";
    default: return "provider error";
  }
}
