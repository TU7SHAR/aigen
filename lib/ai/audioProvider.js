/**
 * Audio provider boundary — voiceover (TTS) and music bed.
 *
 *   getAudioProviders() → { voice, music, reasons }
 *     voice.generate({ text, style })   → { audioBase64, mimeType, provider, model }
 *     music.generate({ prompt })        → { audioBase64, mimeType, provider, model }
 *
 * Both run on the Gemini API through the Interactions endpoint
 * (`ai.interactions.create`): Gemini TTS for narration and Lyria 3 Clip for a
 * 30s instrumental bed (trimmed to the ad by the renderer).
 *
 * Paid and therefore gated (config.isPaidAudioGenerationEnabled): when the
 * gate is closed both providers are null and the ad ships with whatever
 * ambient audio the video model produced — reported, never faked. There is no
 * mock audio: a synthetic placeholder would be mistaken for a finished mix.
 * Every call goes through the caller's JobBudget (kind "audio").
 */

import { GoogleGenAI } from "@google/genai";
import { getGeminiApiKey, getTtsModel, getTtsVoice, getMusicModel, isPaidAudioGenerationEnabled } from "../config.js";
import { ProviderError } from "./provider.js";

/** Pull the audio payload out of an Interaction (SDK getter or raw outputs). */
export function extractInteractionAudio(interaction) {
  const direct = interaction?.output_audio;
  if (direct?.data) return { data: direct.data, mimeType: direct.mime_type || direct.mimeType || null };
  const lists = [interaction?.outputs, interaction?.steps, interaction?.output].filter(Array.isArray);
  for (const list of lists) {
    for (const item of [...list].reverse()) {
      const blocks = Array.isArray(item?.content) ? item.content : [item];
      for (const b of blocks) {
        if (b && (b.type === "audio" || /^audio\//.test(b.mime_type || b.mimeType || "")) && b.data) {
          return { data: b.data, mimeType: b.mime_type || b.mimeType || null };
        }
      }
    }
  }
  return null;
}

function mapError(err, what, model) {
  const status = err?.status || err?.code;
  const msg = String(err?.message || err || "unknown").slice(0, 300);
  return new ProviderError(`${what} failed (${model}): ${msg}`, {
    status: status === 429 ? 429 : status === 400 || status === 404 ? 400 : 502,
    cause: err,
  });
}

function voiceProvider(ai) {
  const model = getTtsModel();
  const voice = getTtsVoice();
  return {
    name: "gemini-tts",
    model,
    voice,
    async generate({ text, style }) {
      if (!String(text || "").trim()) throw new ProviderError("Voiceover text is empty.", { status: 400 });
      let interaction;
      try {
        interaction = await ai.interactions.create({
          model,
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
        throw mapError(err, "Voiceover", model);
      }
      const audio = extractInteractionAudio(interaction);
      if (!audio) throw new ProviderError(`Voiceover returned no audio (${model}).`, { status: 502 });
      return { audioBase64: audio.data, mimeType: audio.mimeType || "audio/wav", provider: "gemini-tts", model, voice, mock: false };
    },
  };
}

function musicProvider(ai) {
  const model = getMusicModel();
  return {
    name: "lyria",
    model,
    async generate({ prompt }) {
      let interaction;
      try {
        interaction = await ai.interactions.create({ model, input: String(prompt || "").trim() });
      } catch (err) {
        throw mapError(err, "Music", model);
      }
      const audio = extractInteractionAudio(interaction);
      if (!audio) throw new ProviderError(`Music returned no audio (${model}).`, { status: 502 });
      return { audioBase64: audio.data, mimeType: audio.mimeType || "audio/mpeg", provider: "lyria", model, mock: false };
    },
  };
}

/**
 * Resolve the voice + music providers for this job. Null means "not
 * available" and `reasons` says why (surfaced in the quality report/Studio).
 */
export function getAudioProviders() {
  const reasons = [];
  if (!isPaidAudioGenerationEnabled()) {
    reasons.push("paid audio is off (needs ENABLE_PAID_AUDIO_GENERATION=true, DISABLE_PAID_GENERATION=false, JOB_MAX_PAID_AUDIO>0)");
  }
  const key = getGeminiApiKey();
  if (!key) reasons.push("GEMINI_API_KEY missing");
  if (reasons.length) return { voice: null, music: null, reasons };
  const ai = new GoogleGenAI({ apiKey: key });
  return { voice: voiceProvider(ai), music: musicProvider(ai), reasons };
}
