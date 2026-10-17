/**
 * Audio providers — voiceover (Gemini TTS) and music bed (Lyria), each routed
 * across its model chain (getChain("tts"), getChain("music")) with automatic
 * switching under the job budget.
 *
 *   getAudioProviders({ language }) → { voice, music, reasons }
 *     voice.generate({ text, style }, ctx) → { audioBase64, mimeType, provider, model, voice, attempts }
 *     music.generate({ prompt }, ctx)      → { audioBase64, mimeType, provider, model, attempts }
 *
 * Gemini 3.8 TTS treats the input as a VERBATIM transcript and detects the
 * language from it; delivery (accent, tone, code-switching persona,
 * pronunciations) goes in speech_metadata.style. The TTS chain is filtered to
 * models that LIST every spoken language of the profile. There is no mock
 * audio: a missing stem is reported, never faked.
 */

import { GoogleGenAI } from "@google/genai";
import { getGeminiApiKey, getTtsVoice, isPaidAudioGenerationEnabled } from "../config.js";
import { ProviderError } from "./provider.js";
import { classifyProviderError } from "./errors.js";
import { getChain, getModelInfo } from "./modelRegistry.js";
import { routeCall } from "./router.js";
import { normalizeLanguageProfile } from "../i18n/profile.js";
import { getLanguage } from "../i18n/languages.js";

/** Pull the audio payload out of an Interaction (SDK getter or raw outputs). */
export function extractInteractionAudio(interaction) {
  const direct = interaction?.output_audio;
  if (direct?.data) return { data: direct.data, mimeType: direct.mime_type || direct.mimeType || null };
  for (const list of [interaction?.outputs, interaction?.steps, interaction?.output].filter(Array.isArray)) {
    for (const item of [...list].reverse()) {
      for (const b of Array.isArray(item?.content) ? item.content : [item]) {
        if (b && (b.type === "audio" || /^audio\//.test(b.mime_type || b.mimeType || "")) && b.data) {
          return { data: b.data, mimeType: b.mime_type || b.mimeType || null };
        }
      }
    }
  }
  return null;
}

/** Duration of a PCM WAV payload from its header (null if not WAV). */
export function wavDurationSec(base64) {
  try {
    const buf = Buffer.from(String(base64).slice(0, 2_000_000), "base64");
    if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return null;
    let off = 12;
    let byteRate = 0;
    while (off + 8 <= buf.length) {
      const id = buf.toString("ascii", off, off + 4);
      const size = buf.readUInt32LE(off + 4);
      if (id === "fmt ") byteRate = buf.readUInt32LE(off + 16);
      if (id === "data") return byteRate ? Number((size / byteRate).toFixed(2)) : null;
      off += 8 + size + (size % 2);
    }
  } catch { /* not a wav */ }
  return null;
}

function typed(err, what, model) {
  const cls = classifyProviderError(err, { stage: "submit" });
  return new ProviderError(`${what} failed (${model}): ${String(err?.message || err || "unknown").slice(0, 300)}`, {
    status: cls.status || 502, cause: err, category: cls.category, scope: cls.scope, retryAfterMs: cls.retryAfterMs,
    notCharged: cls.notCharged || cls.category !== "provider_error", stage: "submit",
  });
}

function voiceProvider(ai, profile) {
  const p = normalizeLanguageProfile(profile);
  const spoken = [p.primary, ...(p.secondary || [])].map(getLanguage);
  const voice = p.voice || getTtsVoice();
  const chain = getChain("tts");
  return {
    name: "gemini-tts",
    model: chain[0],
    voice,
    chain,
    async generate({ text, style }, ctx = {}) {
      if (!String(text || "").trim()) throw new ProviderError("Voiceover text is empty.", { status: 400, category: "invalid_request", notCharged: true });
      const routed = await routeCall({
        purpose: "tts",
        chain,
        label: ctx.label || "voiceover",
        budget: ctx.budget || null,
        budgetKind: "audio",
        onEvent: ctx.onEvent,
        signal: ctx.signal,
        eligible: (info) => {
          if (info.family !== "tts") return { ok: false, reason: "not a TTS model" };
          const lite = info.id.includes("lite");
          const missing = spoken.filter((l) => !(lite ? l.tts.lite : l.tts.flash));
          return missing.length ? { ok: false, reason: `does not list ${missing.map((l) => l.name).join(", ")}` } : { ok: true };
        },
        worstCaseUsd: (info) => Math.max(Number(process.env.TTS_USD_PER_CALL || 0.02), Number(info.usdPerUnit || 0.000225) * 60),
        attempt: async (info) => {
          let interaction;
          try {
            interaction = await ai.interactions.create({
              model: info.apiModelId || info.id,
              input: [{
                type: "user_input",
                content: [{
                  type: "text",
                  text: String(text).trim(),
                  annotations: [{ type: "speech_metadata", style: style || "confident, warm advertising narrator; natural pace" }],
                }],
              }],
              response_format: { type: "audio" },
              generation_config: { speech_config: [{ voice }] },
            });
          } catch (err) {
            throw typed(err, "Voiceover", info.id);
          }
          const audio = extractInteractionAudio(interaction);
          if (!audio) throw new ProviderError(`Voiceover returned no audio (${info.id}).`, { status: 502, category: "provider_error", notCharged: false, uncertain: true });
          const secs = wavDurationSec(audio.data);
          return {
            audioBase64: audio.data, mimeType: audio.mimeType || "audio/wav", provider: "gemini-tts", model: info.id, voice, mock: false,
            durationSec: secs,
            cost: { amountUsd: secs ? Number((secs * Number(info.usdPerUnit || 0.000225)).toFixed(5)) : null, state: "estimated" },
          };
        },
      });
      return { ...routed.result, attempts: routed.attempts, switched: routed.switched };
    },
  };
}

function musicProvider(ai) {
  const chain = getChain("music");
  return {
    name: "lyria",
    model: chain[0],
    chain,
    async generate({ prompt }, ctx = {}) {
      const routed = await routeCall({
        purpose: "music",
        chain,
        label: ctx.label || "music",
        budget: ctx.budget || null,
        budgetKind: "audio",
        onEvent: ctx.onEvent,
        signal: ctx.signal,
        eligible: (info) => (info.family === "music" ? { ok: true } : { ok: false, reason: "not a music model" }),
        worstCaseUsd: (info) => Number(info.usdPerUnit || 0.08),
        attempt: async (info) => {
          let interaction;
          try {
            interaction = await ai.interactions.create({ model: info.apiModelId || info.id, input: String(prompt || "").trim() });
          } catch (err) {
            throw typed(err, "Music", info.id);
          }
          const audio = extractInteractionAudio(interaction);
          if (!audio) throw new ProviderError(`Music returned no audio (${info.id}).`, { status: 502, category: "provider_error", notCharged: false, uncertain: true });
          return {
            audioBase64: audio.data, mimeType: audio.mimeType || "audio/mpeg", provider: "lyria", model: info.id, mock: false,
            cost: { amountUsd: Number(getModelInfo(info.id).usdPerUnit || 0.04), state: "estimated" },
          };
        },
      });
      return { ...routed.result, attempts: routed.attempts, switched: routed.switched };
    },
  };
}

/**
 * Resolve the voice + music providers for this job. Null means "not
 * available" and `reasons` says why (surfaced in the quality report/Studio).
 * @param {{ language?: object }} [opts]
 */
export function getAudioProviders(opts = {}) {
  const reasons = [];
  if (!isPaidAudioGenerationEnabled()) {
    reasons.push("paid audio is off (needs ENABLE_PAID_AUDIO_GENERATION=true, DISABLE_PAID_GENERATION=false, JOB_MAX_PAID_AUDIO>0)");
  }
  const key = getGeminiApiKey();
  if (!key) reasons.push("GEMINI_API_KEY missing");
  if (reasons.length) return { voice: null, music: null, reasons };
  const ai = new GoogleGenAI({ apiKey: key, httpOptions: { timeout: Number(process.env.AUDIO_MODEL_TIMEOUT_MS || 150_000) } });
  return { voice: voiceProvider(ai, opts.language), music: musicProvider(ai), reasons };
}
