/**
 * Language profile — ONE validated production setting carried from the
 * Studio through the API, creative direction, TTS routing, captions, cache
 * keys, the job record and the export.
 *
 *   mode: "single"  one language (regional locale)            e.g. fr-CA
 *         "mixed"   intentional code-switching style          e.g. Hinglish = hi-IN + en-IN
 *         "custom"  user-described combination/dialect/style  (validated, unverified)
 *   primary / secondary: BCP-47 tags (mixed speech is structured settings,
 *     never a pretend provider locale)
 *   captionScript: ISO 15924 writing system for on-screen text (Hinglish can
 *     be Roman "Latn" or Devanagari "Deva") — independent of spoken language
 *   captionLanguage: optional translated-subtitle language (default: captions
 *     follow what is spoken)
 *   accent / tone / pronunciations / voice: delivery controls passed to TTS
 */

import { z } from "zod";
import { getLanguage, getPreset, VERIFIED_LANGUAGES } from "./languages.js";
import { SCRIPT_NAMES, hasFontForScript, detectScripts, checkGlyphCoverage } from "./scripts.js";

const BCP47 = /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|\d{3}))?$/;
const tag = z.string().trim().regex(BCP47, "Use a language tag such as en-US, hi-IN or fr-CA");

export const PREBUILT_VOICES = [
  "Charon", "Kore", "Puck", "Zephyr", "Fenrir", "Leda", "Orus", "Aoede", "Callirrhoe", "Autonoe", "Enceladus",
  "Iapetus", "Umbriel", "Algieba", "Despina", "Erinome", "Algenib", "Rasalgethi", "Laomedeia", "Achernar",
  "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird", "Zubenelgenubi", "Vindemiatrix", "Sadachbia",
  "Sadaltager", "Sulafat",
];

export const languageProfileSchema = z.object({
  mode: z.enum(["single", "mixed", "custom"]).default("single"),
  primary: tag.default("en-US"),
  secondary: z.array(tag).max(3).optional().default([]),
  preset: z.string().trim().max(40).optional(),
  mixBalance: z.number().min(0.1).max(0.9).optional(),
  captionScript: z.string().regex(/^[A-Z][a-z]{3}$/, "Use an ISO 15924 script code such as Latn or Deva").optional(),
  captionLanguage: tag.optional(),
  accent: z.string().trim().max(80).optional(),
  tone: z.string().trim().max(120).optional(),
  description: z.string().trim().max(240).optional(),
  voice: z.enum(PREBUILT_VOICES).optional(),
  pronunciations: z.array(z.object({ term: z.string().trim().min(1).max(60), sayAs: z.string().trim().min(1).max(80) })).max(12).optional(),
});

/** Default profile (keeps old requests behaving exactly as before). */
export const DEFAULT_PROFILE = Object.freeze({ mode: "single", primary: "en-US", secondary: [], captionScript: "Latn" });

/**
 * Normalise a (validated) profile: apply a preset, default the caption script
 * to the spoken language's own script, drop secondaries in single mode.
 */
export function normalizeLanguageProfile(input) {
  if (!input) return { ...DEFAULT_PROFILE };
  const p = { ...input };
  p.primary = p.primary || DEFAULT_PROFILE.primary;
  p.mode = p.mode || (p.preset || p.secondary?.length ? "mixed" : "single");
  if (p.preset) {
    const preset = getPreset(p.preset);
    if (preset) {
      p.mode = p.mode === "custom" ? "custom" : "mixed";
      p.primary = p.primary && p.primary !== "en-US" ? p.primary : preset.primary;
      if (!p.secondary?.length) p.secondary = [...preset.secondary];
      p.captionScript = p.captionScript || preset.captionScript;
      p.mixBalance = p.mixBalance ?? preset.mixBalance;
    }
  }
  if (p.mode === "single") p.secondary = [];
  p.secondary = (p.secondary || []).filter((c) => c !== p.primary);
  if (p.mode === "mixed" && !p.secondary.length) p.mode = "single";
  p.captionScript = p.captionScript || getLanguage(p.primary).defaultScript;
  return p;
}

/** Human label, e.g. "Hinglish (Hindi + English) · Roman captions". */
export function describeProfile(profile) {
  const p = normalizeLanguageProfile(profile);
  const prim = getLanguage(p.primary).name;
  const sec = (p.secondary || []).map((c) => getLanguage(c).name.replace(/ \(.*\)$/, ""));
  const preset = p.preset ? getPreset(p.preset) : null;
  const head = p.mode === "single" ? prim : preset ? `${preset.label} (${preset.detail})` : `${prim} + ${sec.join(" + ")}`;
  const script = SCRIPT_NAMES[p.captionScript] || p.captionScript;
  return `${head}${p.mode === "custom" ? " · custom style" : ""} · ${script} captions`;
}

/** Stable key for cache separation (voiceover/captions must never cross languages). */
export function profileCacheKey(profile) {
  const p = normalizeLanguageProfile(profile);
  return JSON.stringify([p.mode, p.primary, [...(p.secondary || [])].sort(), p.captionScript, p.captionLanguage || "", p.accent || "", p.tone || "", p.voice || "", p.description || "", p.mixBalance ?? "", (p.pronunciations || []).map((x) => `${x.term}=${x.sayAs}`)]);
}

/**
 * Honest per-stage capability assessment. `blockers` must be resolved before
 * any paid generation; `warnings` are shown but allowed.
 * @param {object} profile
 * @param {{ ttsModels?: string[], narration?: boolean }} [opts]
 */
export function assessLanguageProfile(profile, { ttsModels = ["gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts"], narration = true } = {}) {
  const p = normalizeLanguageProfile(profile);
  const spoken = [p.primary, ...(p.secondary || [])];
  const langs = spoken.map(getLanguage);
  const blockers = [];
  const warnings = [];

  // Script/copy writing: Gemini writes all catalogue languages; still model-written.
  const writing = langs.some((l) => l.custom)
    ? { status: "unverified", note: "Language outside the catalogue — copy quality is unverified." }
    : { status: "supported", note: "Written by the creative model; not reviewed by a native speaker." };

  // Voice: Google's TTS language listing per model.
  const flashOk = langs.every((l) => l.tts.flash);
  const liteOk = langs.every((l) => l.tts.lite);
  const voiceModels = ttsModels.filter((m) => (m.includes("lite") ? liteOk : flashOk));
  let voice;
  if (!narration) voice = { status: "not_requested", note: "No narration requested." };
  else if (!voiceModels.length) {
    const missing = langs.filter((l) => !l.tts.flash).map((l) => l.name);
    voice = { status: "unavailable", note: `Gemini TTS does not list ${missing.join(", ")}.`, models: [] };
    blockers.push(`Voiceover in ${missing.join(", ")} is not supported by the available voice models. Choose another narration language, or turn narration off (captions only).`);
  } else {
    voice = {
      status: spoken.every((c) => VERIFIED_LANGUAGES.has(c)) ? "verified" : "provider_listed",
      note: p.mode === "single" ? "Listed as supported by Google; listen before publishing." : "Each language is listed; natural code-switching is model-dependent — listen before publishing.",
      models: voiceModels,
    };
    if (!liteOk) warnings.push("The cheaper fallback voice model does not list this language, so auto-switching has one fewer option.");
  }

  // Captions: is a font installed for the caption script?
  const captionLangs = p.captionLanguage ? [getLanguage(p.captionLanguage)] : langs;
  const scriptOk = hasFontForScript(p.captionScript);
  const captions = scriptOk
    ? { status: ["Latn", "Deva", "Guru", "Taml", "Arab", "Beng"].includes(p.captionScript) ? "verified" : "font_installed", script: p.captionScript, note: `${SCRIPT_NAMES[p.captionScript] || p.captionScript} font installed${["Latn", "Deva", "Guru", "Taml", "Arab", "Beng"].includes(p.captionScript) ? "; shaping checked in a rendered sample" : "; shaping not yet checked"}.` }
    : { status: "unavailable", script: p.captionScript, note: `No ${SCRIPT_NAMES[p.captionScript] || p.captionScript} caption font is installed.` };
  if (!scriptOk) blockers.push(`Captions in ${SCRIPT_NAMES[p.captionScript] || p.captionScript} cannot be rendered (font not installed). Pick another caption script.`);
  const scriptFitsLanguage = captionLangs.some((l) => l.scripts.includes(p.captionScript)) || p.captionScript === "Latn";
  if (!scriptFitsLanguage) warnings.push(`${SCRIPT_NAMES[p.captionScript]} is unusual for ${captionLangs.map((l) => l.name).join("/")}; check the captions.`);

  // Dialogue / lip sync: not offered by this pipeline.
  const dialogue = { status: "not_offered", note: "On-camera speech and lip sync are not generated; narration is a voiceover and footage audio is ambient only." };

  if (p.mode === "custom") warnings.push("Custom language style: every stage is treated as unverified until you review the export.");
  if (p.captionLanguage && p.captionLanguage !== p.primary) warnings.push("Translated subtitles: captions will not match the narration word-for-word (by your choice).");

  return {
    profile: p,
    label: describeProfile(p),
    stages: { writing, voice, captions, rendering: { status: scriptOk ? captions.status : "unavailable", note: "Text shaping by Pango/HarfBuzz with Noto fonts; RTL handled." }, dialogue },
    blockers,
    warnings,
    ok: blockers.length === 0,
  };
}

/** Speech budget for a shot: words (or chars for CJK/Thai) that fit in `seconds`. */
export function speechBudget(profile, seconds) {
  const lang = getLanguage(normalizeLanguageProfile(profile).primary);
  const n = Math.max(1, Math.floor(Number(seconds || 0) * lang.speechRate.value * 0.92));
  return { max: n, unit: lang.speechRate.unit === "chars/sec" ? "characters" : "words" };
}

/** Count speech units of a line in the profile's unit. */
export function speechUnits(profile, text) {
  const lang = getLanguage(normalizeLanguageProfile(profile).primary);
  const s = String(text || "").trim();
  if (!s) return 0;
  if (lang.speechRate.unit === "chars/sec") return [...s.replace(/\s+/g, "")].length;
  return (s.match(/\S+/g) || []).length;
}

/**
 * Prompt block for the creative model. Visual prompts stay English (they go
 * to the video model); everything spoken or shown follows the profile.
 */
export function languageInstructions(profile) {
  const p = normalizeLanguageProfile(profile);
  const prim = getLanguage(p.primary);
  const script = SCRIPT_NAMES[p.captionScript] || p.captionScript;
  const lines = ["LANGUAGE (applies to every voiceover line, every onScreenText caption, the hook and the CTA):"];
  if (p.mode === "single") {
    lines.push(`- Write natively in ${prim.name} (${p.primary}) as a local copywriter would for this audience — not a word-for-word translation.`);
  } else {
    const sec = p.secondary.map((c) => getLanguage(c).name).join(" + ");
    const pct = Math.round((p.mixBalance ?? 0.6) * 100);
    lines.push(`- Style: ${p.preset ? getPreset(p.preset)?.label : "mixed"} — natural code-switching between ${prim.name} and ${sec} the way real speakers talk (roughly ${pct}% ${prim.name}).`);
    lines.push(`- Use ${prim.name} grammar and connective words; switch to ${sec} for everyday terms, product words and punchy phrases where a native speaker would. Do NOT alternate translated sentences and do NOT sprinkle random ${sec} words.`);
  }
  if (p.mode === "custom" && p.description) lines.push(`- Custom style requested by the user: "${p.description}". Follow it while staying natural.`);
  lines.push(`- voiceover is a VERBATIM text-to-speech transcript: write each language's words in its own native script (e.g. Hindi in Devanagari, English in Latin) so the voice pronounces them correctly. No stage directions.`);
  lines.push(`- onScreenText and the CTA use the ${script} writing system${p.captionScript === "Latn" && prim.defaultScript !== "Latn" ? ` (romanized ${prim.name}, as people type it on social media)` : ""}. Captions say the same thing as the voiceover (shorter is fine)${p.captionLanguage ? `, except they are translated subtitles in ${getLanguage(p.captionLanguage).name}` : ""}.`);
  if (p.mode === "mixed" && !p.captionLanguage) {
    lines.push(`- Captions are written in the SAME mixed style as the narration — e.g. a Hinglish caption reads "Naya season, naya style", never an English-only line. Only a CTA the user typed verbatim may stay as given.`);
  }
  lines.push("- Keep brand names, product names, URLs, prices, numbers and offer terms EXACTLY as given (never translate or transliterate a brand). Keep every qualification of an offer.");
  lines.push("- The `visual` field (video-model prompt) is always written in English.");
  if (p.tone) lines.push(`- Tone: ${p.tone}.`);
  return lines.join("\n");
}

/** TTS delivery instruction (speech_metadata.style) for the profile. */
export function voiceStyleFor(profile, baseStyle = "") {
  const p = normalizeLanguageProfile(profile);
  const prim = getLanguage(p.primary);
  const parts = [baseStyle];
  if (p.mode === "single") parts.push(`native ${prim.name} speaker`);
  else parts.push(`natural ${p.preset ? getPreset(p.preset)?.label : "mixed-language"} speaker who code-switches between ${[p.primary, ...p.secondary].map((c) => getLanguage(c).name).join(" and ")} fluently`);
  if (p.accent) parts.push(`${p.accent} accent`);
  if (p.tone) parts.push(p.tone);
  for (const pr of p.pronunciations || []) parts.push(`pronounce "${pr.term}" as "${pr.sayAs}"`);
  return parts.filter(Boolean).join("; ").slice(0, 480);
}

// ------------------------------------------------------- output checks --

const HINDI_ROMAN = new Set("hai hain ka ki ke ko se mein me aur nahi nahin kya yeh ye woh wo ab bhi sirf apna apni apne hum aap tum karo kare karein hoga hogi wala wali wale liye abhi bas bilkul sab kuch bahut ekdum chalo dekho lo le jao ho hua hui gaya gayi tha thi naya nayi accha acha".split(" "));
const STOPWORDS = {
  en: new Set("the and your with for you is to of in on now get our this that it are".split(" ")),
  fr: new Set("le la les des et votre vos avec pour vous est une du sur dans nos notre plus".split(" ")),
  de: new Set("der die das und mit für ihr ist ein eine jetzt zu sie wir den dem nicht".split(" ")),
  es: new Set("el la los las y tu tus con para es un una ahora de del que nuestro".split(" ")),
  pt: new Set("o a os as e seu sua com para é um uma agora de do da que nosso".split(" ")),
  it: new Set("il la le e con per è un una ora di del della tuo tua che".split(" ")),
};

/**
 * Check generated copy against the profile. Script checks are reliable;
 * word-level language identification is a heuristic and says so.
 * @param {{ voiceover: string[], captions: string[], cta?: string }} copy
 * @returns {{ ok: boolean, findings: { level: "error"|"warning", field: string, message: string, confidence: string }[] }}
 */
export function checkCopyLanguage(profile, copy) {
  const p = normalizeLanguageProfile(profile);
  const findings = [];
  const prim = getLanguage(p.primary);
  const captionText = [...(copy.captions || []), copy.cta || ""].join(" ");
  const voText = (copy.voiceover || []).join(" ");

  // Captions: letters must be in the caption script (Latin allowed for brand/URL tokens).
  const capScripts = detectScripts(captionText);
  const total = Object.values(capScripts).reduce((a, b) => a + b, 0);
  if (total > 0 && p.captionScript !== "Latn") {
    const share = (capScripts[p.captionScript] || 0) / total;
    if (share < 0.5) findings.push({ level: "error", field: "captions", message: `Captions should be in ${SCRIPT_NAMES[p.captionScript]} but only ${Math.round(share * 100)}% of letters are.`, confidence: "high" });
  }
  if (total > 0 && p.captionScript === "Latn") {
    const latin = (capScripts.Latn || 0) / total;
    if (latin < 0.8) findings.push({ level: "error", field: "captions", message: `Captions should be romanized (Latin) but ${Math.round((1 - latin) * 100)}% of letters use another script.`, confidence: "high" });
  }
  const cov = checkGlyphCoverage(captionText);
  if (!cov.ok) findings.push({ level: "error", field: "captions", message: `Caption characters without a font: ${cov.missing.join(" ")}`, confidence: "high" });

  // Voiceover: the primary language's native script must appear when it is not Latin.
  const voScripts = detectScripts(voText);
  if (voText && prim.defaultScript !== "Latn" && !voScripts[prim.defaultScript] && !(p.mode === "mixed" && p.captionScript === "Latn" && voScripts.Latn)) {
    findings.push({ level: "warning", field: "voiceover", message: `Voiceover has no ${SCRIPT_NAMES[prim.defaultScript]} text; it may be read as ${voScripts.Latn ? "English" : "another language"}.`, confidence: "medium" });
  }

  // Mixed: both languages should actually be present.
  if (p.mode === "mixed") {
    const all = `${voText} ${captionText}`;
    const words = all.toLowerCase().match(/[a-z']+/g) || [];
    const primNative = (detectScripts(all)[prim.defaultScript] || 0) > 0;
    const hindiRoman = base(p.primary) === "hi" && words.some((w) => HINDI_ROMAN.has(w));
    const secLatin = p.secondary.some((c) => getLanguage(c).defaultScript === "Latn") ? words.some((w) => STOPWORDS.en.has(w) || w.length > 3) : true;
    if (!(primNative || hindiRoman)) findings.push({ level: "error", field: "voiceover", message: `${prim.name} is missing — the copy reads as ${p.secondary.map((c) => getLanguage(c).name).join("/")} only.`, confidence: base(p.primary) === "hi" ? "medium" : "low" });
    if (!secLatin) findings.push({ level: "warning", field: "voiceover", message: "The secondary language is barely present; this may not read as a mix.", confidence: "low" });
    // Natural mixing happens WITHIN lines; a script where most lines are
    // entirely the secondary language just alternates translated sentences.
    const voLines = (copy.voiceover || []).map((l) => String(l || "").trim()).filter(Boolean);
    if (voLines.length >= 3) {
      const hasPrimary = (l) => (detectScripts(l)[prim.defaultScript] || 0) > 0 || (base(p.primary) === "hi" && (l.toLowerCase().match(/[a-z']+/g) || []).some((w) => HINDI_ROMAN.has(w)));
      const mixed = voLines.filter(hasPrimary).length;
      if (mixed / voLines.length < 0.6) {
        findings.push({ level: "error", field: "voiceover", message: `Only ${mixed} of ${voLines.length} narration lines use ${prim.name}; the script alternates languages by sentence instead of mixing naturally.`, confidence: "medium" });
      }
    }
    // Captions must follow the mix too (not English-only lines over Hinglish narration).
    const capList = (copy.captions || []).filter((c) => String(c || "").trim());
    if (capList.length && !p.captionLanguage) {
      const capWords = capList.join(" ").toLowerCase().match(/[a-z']+/g) || [];
      const capNative = (detectScripts(capList.join(" "))[prim.defaultScript] || 0) > 0;
      const capHindi = base(p.primary) === "hi" && capWords.some((w) => HINDI_ROMAN.has(w));
      if (base(p.primary) === "hi" && !capNative && !capHindi) {
        findings.push({ level: "error", field: "captions", message: "Captions are English-only; they should follow the Hinglish style of the narration.", confidence: "medium" });
      } else if (base(p.primary) !== "hi" && p.captionScript === "Latn" && !capNative) {
        findings.push({ level: "warning", field: "captions", message: `Romanized ${prim.name} in captions cannot be verified automatically — read them before publishing.`, confidence: "low" });
      }
    }
  }

  // Single Latin-script languages: obvious wrong-language detection by stopwords.
  if (p.mode === "single" && prim.defaultScript === "Latn" && STOPWORDS[base(p.primary)]) {
    const words = `${voText} ${captionText}`.toLowerCase().match(/[a-zà-ÿ']+/g) || [];
    if (words.length >= 8) {
      const scores = Object.fromEntries(Object.entries(STOPWORDS).map(([k, set]) => [k, words.filter((w) => set.has(w)).length]));
      const want = scores[base(p.primary)] || 0;
      const [bestLang, best] = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
      if (bestLang !== base(p.primary) && best >= Math.max(3, want * 2)) {
        findings.push({ level: "error", field: "copy", message: `Copy looks like ${bestLang.toUpperCase()} rather than ${prim.name}.`, confidence: "medium" });
      }
    }
  }
  return { ok: !findings.some((f) => f.level === "error"), findings };
}

function base(code) {
  return String(code || "").split("-")[0].toLowerCase();
}
