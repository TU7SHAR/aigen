/**
 * Routed structured-text generation (JSON) for every text-model stage:
 * enrichment (cheap extraction), concepts, the creative director, script
 * tightening, campaign focus and creative review.
 *
 *   purpose "enrichment" → getChain("enrichment") (3.5 Flash-Lite first)
 *   purpose "creative"   → getChain("creative")   (3.8 Flash first)
 *
 * Switches models automatically on rate limits, unavailability and overload.
 * Text calls cost fractions of a cent; their estimated cost is recorded on
 * the durable ledger (not reserved against the per-job media budget).
 */

import { GoogleGenAI } from "@google/genai";
import { getGeminiApiKey } from "../config.js";
import { getChain } from "./modelRegistry.js";
import { routeCall } from "./router.js";
import { classifyProviderError } from "./errors.js";
import { ProviderError } from "./provider.js";
import { recordSpendUsd } from "../costs/estimate.js";

/** Estimated USD of a text call from usage metadata × published per-M rates. */
export function textCostUsd(info, u) {
  if (!u) return null;
  const input = Number(u.promptTokenCount || 0);
  const output = Number(u.candidatesTokenCount || 0) + Number(u.thoughtsTokenCount || 0);
  return Number(((input / 1e6) * (info.usdPerMInput ?? 0.75) + (output / 1e6) * (info.usdPerMOutput ?? 3.75)).toFixed(6));
}

/**
 * @param {{
 *   purpose?: "creative"|"enrichment",
 *   systemInstruction: string,
 *   contents: any,                  // string or Content[] (may include inline images)
 *   schema?: object,                // responseSchema (Type.* shape)
 *   temperature?: number,
 *   label?: string,
 *   onEvent?: Function,
 * }} args
 * @returns {Promise<{ json: any, model: string, usage: object|null, cost: object, attempts: object[] }>}
 */
export async function generateJson(args) {
  const { purpose = "creative", systemInstruction, contents, schema, temperature = 0.5, label, onEvent } = args;
  const key = getGeminiApiKey();
  if (!key) throw new ProviderError("GEMINI_API_KEY is not set.", { status: 503, category: "auth" });
  // Bounded: a hung HTTP request must fail (and switch models), not spin forever.
  const ai = new GoogleGenAI({ apiKey: key, httpOptions: { timeout: Number(process.env.TEXT_MODEL_TIMEOUT_MS || 45_000) } });
  const chain = getChain(purpose);
  const run = (models, signal) => routeCall({
    purpose: "text",
    chain: models,
    label: label || purpose,
    onEvent,
    signal,
    eligible: (info) => (info.family === "text" ? { ok: true } : { ok: false, reason: "not a text model" }),
    attempt: async (info) => {
      // Creative calls default to LOW thinking (3.8 Flash took 90s+ at the
      // default level in a live run); a model that rejects the setting is
      // retried once without it.
      const level = purpose === "creative" ? (process.env.CREATIVE_THINKING_LEVEL || "LOW") : process.env.ENRICHMENT_THINKING_LEVEL || "";
      const call = (withThinking) => ai.models.generateContent({
        model: info.apiModelId || info.id,
        contents,
        config: {
          systemInstruction,
          responseMimeType: "application/json",
          ...(schema ? { responseSchema: schema } : {}),
          temperature,
          ...(withThinking && level ? { thinkingConfig: { thinkingLevel: level } } : {}),
          ...(signal ? { abortSignal: signal } : {}),
        },
      });
      let resp;
      try {
        try {
          resp = await call(true);
        } catch (err) {
          if (!level || !/thinking/i.test(String(err?.message || ""))) throw err;
          resp = await call(false);
        }
      } catch (err) {
        const cls = classifyProviderError(err, { stage: "submit" });
        throw new ProviderError(`${label || purpose} (${info.id}): ${String(err?.message || err).slice(0, 240)}`, {
          status: cls.status || 502, cause: err, category: cls.category, scope: cls.scope,
          retryAfterMs: cls.retryAfterMs, notCharged: true, stage: "submit",
        });
      }
      const u = resp?.usageMetadata || null;
      const usd = textCostUsd(info, u);
      if (usd) recordSpendUsd(usd, { kind: "text", label: label || purpose, model: info.id });
      let json;
      try {
        json = JSON.parse(resp.text);
      } catch {
        // Billed but unusable; another model costs a fraction of a cent.
        throw new ProviderError(`${label || purpose} (${info.id}) returned non-JSON.`, { status: 502, category: "provider_error", notCharged: false, uncertain: false });
      }
      return {
        json,
        model: info.id,
        usage: u ? { input: u.promptTokenCount, output: u.candidatesTokenCount, thoughts: u.thoughtsTokenCount, total: u.totalTokenCount } : null,
        cost: { amountUsd: usd, state: usd == null ? "unknown" : "estimated", basis: "reported tokens × published rates" },
      };
    },
  });

  // Hedge (creative only): typical calls take ~10s, but a model sometimes
  // stalls for a minute. If the head has not answered after HEDGE ms, start
  // the next model too and keep whichever answers first (the other is
  // aborted). Costs at most one extra text call (~1 cent) on slow requests.
  const hedgeMs = Number(process.env.TEXT_HEDGE_MS ?? (purpose === "creative" ? 15_000 : 0));
  if (!(hedgeMs > 0) || chain.length < 2) {
    const routed = await run(chain);
    return { ...routed.result, attempts: routed.attempts };
  }
  const primary = new AbortController();
  const backup = new AbortController();
  let timer;
  let rejectSecond;
  const first = run(chain, primary.signal).then(
    (r) => { backup.abort(); return { r, hedged: false }; },
    (err) => { if (timer) { clearTimeout(timer); timer = null; rejectSecond?.(err); } throw err; }
  );
  const second = new Promise((resolve, reject) => {
    rejectSecond = reject;
    timer = setTimeout(() => {
      timer = null;
      onEvent?.({ type: "waiting", model: chain[0], label, reason: `no answer after ${hedgeMs / 1000}s — also asking ${chain[1]}` });
      run(chain.slice(1), backup.signal).then((r) => { primary.abort(); resolve({ r, hedged: true }); }, reject);
    }, hedgeMs);
  });
  try {
    const { r, hedged } = await Promise.any([first, second]);
    return { ...r.result, attempts: hedged ? [{ model: chain[0], outcome: "skipped", category: "slow", reason: `still running after ${hedgeMs / 1000}s (hedged)` }, ...r.attempts] : r.attempts };
  } catch (err) {
    throw err?.errors?.[0] || err;
  } finally {
    clearTimeout(timer);
  }
}
