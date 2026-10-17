/**
 * AI Creative Director — turns ONE chosen concept + the source evidence into a
 * structured creative brief and an EXECUTABLE storyboard, in the requested
 * language profile, BEFORE any paid media is requested.
 *
 * Output:
 *   brief: focus, audience, objective, one main message, hook, reason to
 *          believe (with evidence), CTA
 *   shots: purpose, relationship to the story, technique, visual prompt
 *          (English, for the video model), exact caption + voiceover in the
 *          profile's language/script, transition, evidence used
 *   validation: findings from deterministic checks (script fits the time,
 *          unsupported numeric claims, CTA, structure, language/script)
 *
 * Grounding: shots may only use facts present in the evidence. Numbers,
 * prices, percentages and offers not found in the evidence are removed by an
 * editing pass, not shipped. Model-written copy is never "native-reviewed".
 */

import { Type } from "@google/genai";
import { getGeminiApiKey, isEnrichmentEnabled } from "../config.js";
import { getChain } from "./modelRegistry.js";
import { generateJson } from "./textModel.js";
import {
  normalizeLanguageProfile, languageInstructions, speechBudget, speechUnits, checkCopyLanguage, describeProfile,
} from "../i18n/profile.js";

export const SHOT_TECHNIQUES = ["real_asset", "motion_graphic", "ai_image", "ai_video", "composite"];
export const TRANSITIONS = ["cut", "dissolve", "whip", "zoom", "slide", "fade"];

function storyboardSchema() {
  const S = Type;
  return {
    type: S.OBJECT,
    properties: {
      brief: {
        type: S.OBJECT,
        properties: {
          focus: { type: S.STRING },            // exactly what is advertised
          audience: { type: S.STRING },
          objective: { type: S.STRING },
          mainMessage: { type: S.STRING },      // ONE message
          hook: { type: S.STRING },             // the first-2-seconds idea
          reasonToBelieve: { type: S.STRING },  // proof grounded in evidence
          cta: { type: S.STRING },
        },
        required: ["focus", "mainMessage", "hook"],
      },
      logline: { type: S.STRING },
      music: { type: S.STRING },
      voiceStyle: { type: S.STRING },
      shots: {
        type: S.ARRAY,
        items: {
          type: S.OBJECT,
          properties: {
            intent: { type: S.STRING },          // narrative beat (hook / problem / demo / proof / payoff / cta)
            purpose: { type: S.STRING },         // what THIS shot communicates
            linksTo: { type: S.STRING },         // how it follows the previous shot
            durationSec: { type: S.NUMBER },
            visual: { type: S.STRING },          // English video-model prompt
            technique: { type: S.STRING, enum: SHOT_TECHNIQUES },
            assetHint: { type: S.STRING },
            motion: { type: S.STRING },
            camera: { type: S.STRING },
            onScreenText: { type: S.STRING },    // caption, profile language + caption script
            voiceover: { type: S.STRING },       // verbatim TTS transcript, native scripts
            transitionOut: { type: S.STRING, enum: TRANSITIONS },
            evidence: { type: S.STRING },        // which fact this shot relies on ("" if none)
          },
          required: ["intent", "durationSec", "visual", "technique"],
        },
      },
    },
    required: ["brief", "shots"],
  };
}

const SYSTEM = `You are the creative director of a small, excellent advertising team making a short VERTICAL video ad. Think like a performance-marketing director: one clear idea, a scroll-stopping hook, proof, and a clear next step.

STEP 1 — BRIEF. Decide from the evidence: the exact focus (one product, one collection with a shared theme, or the business itself — never a mix of unrelated items), who it is for, the objective, ONE main message, a specific hook for the first 2 seconds, a reason to believe grounded in the evidence, and the CTA.

STEP 2 — STORYBOARD that expresses the brief:
- Every shot has a communicative purpose and follows from the previous one (hook → tension/desire → product/service in action → proof → payoff → CTA). No decorative filler, no disconnected pretty scenes, no generic stock moments.
- Shot count and pacing fit the duration: shots of 2–4 s, closing card 2–3 s. The hook lands in under 2 s.
- Technique per shot, honest about assets:
    ai_video: hooks, people, lifestyle and product-in-use moments. When a real product photo exists and the shot features the product, set assetHint to that asset's role — the photo becomes the first frame so the product stays faithful.
    real_asset: a genuine product photo or a real website/app screenshot when exact fidelity matters (screenshots scroll like a phone screen recording — present them as "a look at the site", never as an interactive demo). Use each real asset at most once.
    composite: a real asset plus overlays.
    motion_graphic: the closing card (and only rarely anything else).
    ai_image: only when one still is clearly better than footage.
- FIDELITY: never ask a generative model to show the product's own interface, screens, packaging, logo, label or charts, and never put readable text in generated footage. Generated shots show people and real moments; a phone screen faces away or is out of focus.
- The visual field is a precise ENGLISH prompt for a video model: subject, action, setting, light, lens and camera move, mood; one continuous action; vertical framing. Describe recurring people identically in every shot (age, look, wardrobe) so they stay consistent.
- GROUNDING: use only facts in the evidence. Never invent prices, discounts, percentages, quantities, ratings, testimonials, guarantees, availability, capabilities or results. If a fact is needed but missing, leave it out. Put the fact a shot relies on in its evidence field.
- COPY: onScreenText is a short caption (about 2–7 words) that complements the voiceover; voiceover is ONE natural, persuasive script split across shots, sized to each shot's duration, naming the brand at least once and ending on the CTA. The closing card's onScreenText is the CTA (max 5 words; use the provided CTA verbatim when given).
- transitionOut: "cut" by default; "whip" or "zoom" only for an energetic beat change; "dissolve" for a time/mood shift; "fade" into the closing card.
- music: one line directing an instrumental bed (mood, genre, tempo, energy arc). voiceStyle: one line on delivery.
- If the entity is not a physical product, do not depict packaging or a product hero.`;

const NUMERIC = /(?:[$€£₹¥]\s?\d[\d.,]*|\d[\d.,]*\s?(?:%|×|★|\+|(?:percent|mg|kg|ml|g|l|x|k|m|hrs?|hours?|days?|mins?|minutes?|years?|yrs?|stars?|rs\.?|inr|usd|eur|rupees?)\b))/gi;

/** Numeric/price claims in `text` that do not appear in the evidence. */
export function unsupportedClaims(text, evidence) {
  const ev = String(evidence || "").toLowerCase().replace(/\s+/g, "");
  const found = String(text || "").match(NUMERIC) || [];
  return found.filter((tok) => {
    const t = tok.toLowerCase().replace(/\s+/g, "");
    const digits = t.replace(/[^\d.,]/g, "");
    return !(ev.includes(t) || (digits && ev.includes(digits)));
  });
}

/**
 * Generate a brief + storyboard for one concept.
 * @param {object} input see buildEvidence; plus language (profile), durationSeconds, aspectRatio
 */
export async function generateStoryboardAI(input = {}) {
  const model = getChain("creative")[0];
  if (!isEnrichmentEnabled() || !getGeminiApiKey()) {
    return { storyboard: null, model, cost: { amountUsd: 0, state: "estimated" }, skipped: "AI director disabled / no key." };
  }
  const evidence = buildEvidence(input);
  if (!evidence || evidence.length < 30) {
    return { storyboard: null, model, cost: { amountUsd: 0, state: "estimated" }, skipped: "Not enough evidence for a storyboard." };
  }
  const language = normalizeLanguageProfile(input.language);
  try {
    const res = await generateJson({
      purpose: "creative",
      label: "creative director",
      systemInstruction: `${SYSTEM}\n\n${languageInstructions(language)}`,
      contents: evidence,
      schema: storyboardSchema(),
      temperature: 0.7,
    });
    const storyboard = sanitizeStoryboard(res.json, input);
    if (!storyboard?.shots?.length) {
      return { storyboard: null, model: res.model, cost: res.cost, error: "Director returned no usable shots." };
    }
    storyboard.language = language;
    storyboard.languageLabel = describeProfile(language);
    storyboard.directorModel = res.model;
    const edit = await editScript(storyboard, { evidence, language, input });
    storyboard.validation = validateStoryboard(storyboard, { evidence, language, input });
    storyboard.editPass = edit;
    const usd = [res.cost?.amountUsd, edit?.cost?.amountUsd].filter(Number.isFinite).reduce((a, b) => a + b, 0);
    return { storyboard, model: res.model, attempts: res.attempts, cost: { amountUsd: Number(usd.toFixed(6)), state: "estimated" } };
  } catch (err) {
    return { storyboard: null, model, cost: { amountUsd: null, state: "unknown" }, error: `Director failed: ${err?.message || "unknown"}` };
  }
}

function buildEvidence(input) {
  const { concept = {}, product = {}, brand = {}, design = {}, availableAssets = [], emphasis = [], avoid = [] } = input;
  const lines = [];
  const push = (label, v) => {
    if (v == null || v === "" || (Array.isArray(v) && !v.length)) return;
    lines.push(`${label}: ${Array.isArray(v) ? v.slice(0, 10).join("; ") : v}`);
  };
  push("CAMPAIGN FOCUS (advertise exactly this)", input.focus?.title || input.focus);
  push("CONCEPT title", concept.title);
  push("CONCEPT central message", concept.centralMessage);
  push("CONCEPT visual idea", concept.visualIdea);
  push("CONCEPT angle", concept.advertisingAngle);
  push("CONCEPT subject", concept.proposedSubject);
  push("Entity type", input.entityType);
  push("Physical product allowed", input.allowsPhysicalLanguage === false ? "no — do not depict packaging" : "yes");
  push("Target duration (seconds)", input.durationSeconds);
  push("Aspect ratio", input.aspectRatio);
  push("Product/brand name", product.name || brand.name);
  push("Brand", product.brand || brand.name);
  push("What it is", product.description);
  push("Category", product.category);
  push("Offering", product.offering);
  push("Features", product.features);
  push("Benefits", product.benefits);
  push("Differentiators", product.differentiators);
  push("Audience", product.targetCustomer);
  push("Price (verbatim or omit)", product.price ? `${product.currency || ""} ${product.price}`.trim() : null);
  push("Exact offer (verbatim or omit)", product.offer);
  push("Exact CTA (verbatim or omit)", product.cta);
  push("Destination", product.destination);
  push("Brand palette", (design?.palette?.primary || brand.primaryColors || []).slice(0, 4));
  push("Brand tone", brand.toneOfVoice);
  push("Available real assets (role:kind)", availableAssets.map((a) => `${a.role || "image"}:${a.kind || "image"}${a.description ? ` (${a.description})` : ""}`));
  push("Must EMPHASIZE", emphasis);
  push("Must NOT appear", avoid);
  return lines.join("\n");
}

function str(x) {
  return typeof x === "string" && x.trim() ? x.trim() : null;
}
function num(x, d) {
  const n = Number(x);
  return Number.isFinite(n) && n > 0 ? n : d;
}

/** Clamp + normalise the model's storyboard; scale durations to the target. */
function sanitizeStoryboard(parsed, input) {
  const rawShots = Array.isArray(parsed?.shots) ? parsed.shots : [];
  const shots = [];
  for (const s of rawShots.slice(0, 8)) {
    if (!s || typeof s !== "object") continue;
    const visual = str(s.visual);
    const intent = str(s.intent);
    if (!visual && !intent) continue;
    shots.push({
      intent: intent || "shot",
      purpose: str(s.purpose) || intent || "",
      linksTo: str(s.linksTo) || "",
      visual: visual || intent,
      durationSec: num(s.durationSec, 2.5),
      technique: SHOT_TECHNIQUES.includes(s.technique) ? s.technique : "motion_graphic",
      assetHint: str(s.assetHint) || "none",
      motion: str(s.motion) || "subtle",
      camera: str(s.camera) || "",
      onScreenText: typeof s.onScreenText === "string" ? s.onScreenText.trim() : "",
      voiceover: typeof s.voiceover === "string" ? s.voiceover.trim() : "",
      transitionOut: TRANSITIONS.includes(s.transitionOut) ? s.transitionOut : "cut",
      evidence: str(s.evidence) || "",
    });
  }
  if (!shots.length) return null;
  const target = num(input.durationSeconds, 12);
  const sum = shots.reduce((a, s) => a + s.durationSec, 0) || shots.length;
  let acc = 0;
  shots.forEach((s, i) => {
    if (i === shots.length - 1) s.durationSec = Math.max(1.8, Number((target - acc).toFixed(2)));
    else {
      s.durationSec = Math.max(1.2, Number(((s.durationSec / sum) * target).toFixed(2)));
      acc += s.durationSec;
    }
  });
  const b = parsed?.brief || {};
  return {
    brief: {
      focus: str(b.focus) || "", audience: str(b.audience) || "", objective: str(b.objective) || "",
      mainMessage: str(b.mainMessage) || "", hook: str(b.hook) || "", reasonToBelieve: str(b.reasonToBelieve) || "", cta: str(b.cta) || "",
    },
    logline: str(parsed.logline) || null,
    totalDurationSec: target,
    music: str(parsed.music) ? str(parsed.music).slice(0, 240) : null,
    voiceStyle: str(parsed.voiceStyle) ? str(parsed.voiceStyle).slice(0, 200) : null,
    shots,
    origin: "ai",
  };
}

/**
 * One editing pass: shorten lines that cannot be spoken in their shot and
 * remove claims the evidence does not support, keeping language, brand,
 * offer wording and CTA. Deterministic fallbacks apply if the edit fails.
 */
async function editScript(storyboard, { evidence, language, input }) {
  const shots = storyboard.shots;
  const issues = shots.map((s, i) => {
    const budget = speechBudget(language, Math.max(0.8, s.durationSec - (i === 0 ? 0.25 : 0.1)));
    const units = speechUnits(language, s.voiceover);
    const claims = [...unsupportedClaims(s.voiceover, evidence), ...unsupportedClaims(s.onScreenText, evidence)];
    return { shot: i + 1, seconds: s.durationSec, max: budget.max, unit: budget.unit, over: units > budget.max + 1, claims };
  });
  const needs = issues.filter((x) => x.over || x.claims.length);
  if (!needs.length) return { edited: false };
  let cost = null;
  try {
    const res = await generateJson({
      purpose: "creative",
      label: "script editor",
      temperature: 0.3,
      systemInstruction:
        "You edit short video-ad scripts. For each shot return its voiceover and onScreenText. Rules: keep the SAME language style and writing systems; keep brand names, exact offer wording and the CTA; a voiceover must not exceed `max` units (" +
        "words, or characters for languages written without spaces); remove every claim listed in `unsupported` (do not replace it with another number); keep empty lines empty; keep lines natural and persuasive.\n\n" + languageInstructions(language),
      contents: JSON.stringify({
        evidence: String(evidence).slice(0, 4000),
        shots: shots.map((s, i) => ({ shot: i + 1, max: issues[i].max, unit: issues[i].unit, unsupported: issues[i].claims, voiceover: s.voiceover, onScreenText: s.onScreenText })),
      }),
      schema: {
        type: Type.OBJECT,
        properties: { shots: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { voiceover: { type: Type.STRING }, onScreenText: { type: Type.STRING } } } } },
        required: ["shots"],
      },
    });
    cost = res.cost;
    const out = res.json?.shots;
    if (Array.isArray(out) && out.length === shots.length) {
      out.forEach((o, i) => {
        const vo = typeof o?.voiceover === "string" ? o.voiceover.trim() : null;
        const cap = typeof o?.onScreenText === "string" ? o.onScreenText.trim() : null;
        if (vo !== null && speechUnits(language, vo) <= issues[i].max + 1 && !unsupportedClaims(vo, evidence).length) shots[i].voiceover = vo;
        if (cap !== null && !unsupportedClaims(cap, evidence).length) shots[i].onScreenText = cap;
      });
    }
  } catch {
    /* deterministic fallbacks below */
  }
  // Deterministic safety net: strip any claim the edit left behind.
  for (const s of shots) {
    for (const field of ["voiceover", "onScreenText"]) {
      for (const tok of unsupportedClaims(s[field], evidence)) s[field] = s[field].replace(tok, "").replace(/\s{2,}/g, " ").trim();
    }
  }
  if (input?.product?.cta && shots.length) shots[shots.length - 1].onScreenText = shots[shots.length - 1].onScreenText || input.product.cta;
  return { edited: true, issues: needs, cost };
}

/** Deterministic validation of the plan (shown in review; blocks nothing by itself). */
export function validateStoryboard(storyboard, { evidence = "", language, input = {} } = {}) {
  const findings = [];
  const shots = storyboard?.shots || [];
  const add = (level, code, message, shot = null) => findings.push({ level, code, message, shot });
  if (!shots.length) add("error", "NO_SHOTS", "The storyboard has no shots.");
  if (shots[0] && shots[0].durationSec > 3.5) add("warning", "SLOW_HOOK", "The opening shot is longer than 3.5 s; the hook may land late.", 1);
  const last = shots[shots.length - 1];
  if (last && !last.onScreenText) add("error", "NO_CTA", "The closing shot has no call to action.", shots.length);
  const cta = String(input?.product?.cta || "").trim();
  if (cta && last && last.onScreenText.toLowerCase() !== cta.toLowerCase()) add("warning", "CTA_CHANGED", `Closing CTA differs from the provided CTA "${cta}".`, shots.length);
  const hints = shots.filter((s) => ["real_asset", "composite"].includes(s.technique) && s.assetHint !== "none").map((s) => s.assetHint);
  if (new Set(hints).size !== hints.length) add("warning", "ASSET_REUSED", "A real asset is used in more than one shot.");
  shots.forEach((s, i) => {
    const budget = speechBudget(language, s.durationSec);
    if (speechUnits(language, s.voiceover) > budget.max + 1) add("warning", "LINE_TOO_LONG", `Shot ${i + 1} narration may not fit ${s.durationSec}s (${speechUnits(language, s.voiceover)} > ${budget.max} ${budget.unit}).`, i + 1);
    for (const tok of [...unsupportedClaims(s.voiceover, evidence), ...unsupportedClaims(s.onScreenText, evidence)]) {
      add("error", "UNSUPPORTED_CLAIM", `Shot ${i + 1} states "${tok}", which is not in the source evidence.`, i + 1);
    }
    if (s.technique === "ai_video" && /\b(dashboard|interface|screen ui|app screen|website)\b/i.test(s.visual) && !/faces away|out of focus/i.test(s.visual)) {
      add("warning", "GENERATED_UI", `Shot ${i + 1} asks a video model to show an interface; it will be shown out of focus to avoid inventing UI.`, i + 1);
    }
  });
  const lang = checkCopyLanguage(language, {
    voiceover: shots.map((s) => s.voiceover),
    captions: shots.map((s) => s.onScreenText),
  });
  for (const f of lang.findings) add(f.level, "LANGUAGE", `${f.message} (confidence: ${f.confidence})`);
  return { ok: !findings.some((f) => f.level === "error"), findings };
}
