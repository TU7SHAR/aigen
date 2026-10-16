/**
 * AI Creative Director — generates an EXECUTABLE, variable-length storyboard
 * for a chosen advertising concept.
 *
 * This is the step that was missing: concepts (lib/ai/concepts.js) propose an
 * idea; the Director turns ONE chosen concept into a concrete shot-by-shot plan
 * that different production techniques can execute. It replaces the old fixed
 * establish/detail/end formula — the number of shots, their intent, visuals,
 * motion and chosen technique are REASONED per request, not templated.
 *
 * Design rules (match the product vision):
 *  - No hardcoded concepts, no per-industry template. Entity type is only an
 *    INPUT signal + a safety constraint (allowsPhysicalLanguage), never a
 *    selector that picks a canned storyboard.
 *  - Grounded: shots may only use facts/assets present in the evidence. No
 *    invented prices, claims, UI or packaging.
 *  - Each shot declares a production TECHNIQUE so the per-scene router can
 *    execute it with the right tool:
 *      real_asset     — animate an actual crawled/uploaded image (deterministic)
 *      motion_graphic — brand-colored type/graphics card (deterministic)
 *      ai_image       — generate a brand-aligned still, then animate it (needs image model)
 *      ai_video       — generate footage with a video model (needs video provider; paid-gated)
 *      composite      — real asset + deterministic overlays combined
 *  - Uses the cheap enrichment TEXT model (no video cost). Degrades gracefully:
 *    on no key / disabled / failure the caller falls back to a deterministic
 *    storyboard that is clearly labeled.
 */

import { GoogleGenAI, Type } from "@google/genai";
import { getGeminiApiKey, getEnrichmentModel, isEnrichmentEnabled } from "../config.js";
import { costFromUsage } from "../costs/estimate.js";

export const SHOT_TECHNIQUES = ["real_asset", "motion_graphic", "ai_image", "ai_video", "composite"];

function storyboardSchema() {
  const S = Type;
  return {
    type: S.OBJECT,
    properties: {
      logline: { type: S.STRING },
      totalDurationSec: { type: S.NUMBER },
      music: { type: S.STRING },       // instrumental bed direction: mood, genre, tempo
      voiceStyle: { type: S.STRING },  // narrator delivery: tone, pace, persona
      shots: {
        type: S.ARRAY,
        items: {
          type: S.OBJECT,
          properties: {
            intent: { type: S.STRING },           // narrative purpose of THIS shot
            durationSec: { type: S.NUMBER },
            visual: { type: S.STRING },            // what the viewer literally sees
            technique: { type: S.STRING, enum: SHOT_TECHNIQUES },
            assetHint: { type: S.STRING },         // which available asset/role, or "none"
            motion: { type: S.STRING },            // camera/subject movement
            onScreenText: { type: S.STRING },      // exact copy to render deterministically ("" if none)
            voiceover: { type: S.STRING },         // VO/narration line ("" if none)
            transitionOut: { type: S.STRING },     // cut/fade/slide/etc. into next shot
          },
          required: ["intent", "durationSec", "visual", "technique"],
        },
      },
    },
    required: ["shots"],
  };
}

const SYSTEM = `You are an AI creative director for short video advertisements. Given a chosen advertising concept plus evidence about the business and its available assets, produce an EXECUTABLE storyboard.

RULES:
- Design the storyboard to express THIS specific concept. Shot count, pacing and structure must fit the idea and the total duration — do NOT force a fixed establish/detail/end formula. A tight 5s ad might be 1–2 shots; a 15s ad might be 4–6.
- Ground every shot in the evidence. Never invent prices, discounts, metrics, testimonials, guarantees, product packaging, or UI that isn't described as available.
- This is a VIDEO ad: every shot must MOVE. Prefer footage over stills.
- For each shot choose the TECHNIQUE that best serves the intent AND is honest about available assets:
    ai_video: DEFAULT for hooks, lifestyle, people/actors, B-roll and any cinematic moment. Generated footage (image-to-video from the real product photo when one exists, so the product stays faithful).
    real_asset: when a genuine product photo / UI screenshot exists and exact fidelity matters (e.g. the UI or packaging hero).
    composite: a real asset plus deterministic overlays.
    motion_graphic: brand-colored kinetic typography — use sparingly (mainly the end card).
    ai_image: only when a single generated still is clearly better than footage.
- Never put readable text, logos or prices INSIDE generated footage; that copy goes in onScreenText (rendered exactly by the compositor).
- onScreenText and voiceover must be exact, publishable copy grounded in evidence. Use the real brand name, offer and CTA when provided; otherwise leave them empty rather than inventing.
- STRUCTURE: the first shot is a scroll-stopping visual hook that lands in under 2 seconds; then a coherent progression of visually DISTINCT shots (problem/desire → product or service in action → payoff); the last shot is the closing card (technique motion_graphic, onScreenText = the exact CTA).
- PACING: every shot is 2–4 seconds and the closing card 2–3 seconds, so a 12–15 second ad has 4–5 shots. Use AT MOST ONE shot per real screen asset (never the same screenshot in two shots, whether real_asset or composite); the other shots are footage (ai_video) of people and moments.
- VOICEOVER: write a voiceover line for EVERY shot except the closing card may be short. Size each line to its shot (about 2.3 spoken words per second of the shot). Read in order, the lines must form one natural, persuasive script that names the brand at least once and ends on the CTA.
- onScreenText is a short punchy caption (max ~7 words) that complements — not transcribes — the voiceover.
- ai_video "visual" is a precise prompt for a video model: subject, action, setting, lighting, lens/camera move, mood. Describe people concretely (age, look, wardrobe) and reuse the SAME description across shots so the character stays consistent. Vertical framing for 9:16. One continuous action per shot.
- If a website/app screenshot asset exists, use it (technique real_asset, assetHint = its role) for a demonstration shot — the compositor scrolls it like a real phone screen recording.
- PRODUCT FIDELITY: NEVER ask a video/image model to depict the product's own interface, screens, dashboards, app UI, packaging, logo or charts — generated versions misrepresent the real product. The real product appears only through real assets. Generated shots show PEOPLE and real-life moments: the target customer's situation, emotion and payoff (a phone may be in hand, but its screen faces away or is out of focus).
- Prefer human, emotional, concrete moments over abstract graphics (no floating planets, particles or "data streams" unless the concept truly demands it).
- If a real product photo exists and a shot features the product, use technique ai_video with assetHint = that asset's role: the real photo becomes the first frame so the product stays faithful.
- music: one line directing the instrumental bed (mood, genre, tempo, energy arc). voiceStyle: one line on the narrator's delivery.
- The closing card's onScreenText is the exact CTA, max 5 words (use the provided CTA verbatim when given).
- If the entity is NOT a physical product, do NOT depict physical packaging or a product-as-hero.
- Keep each field concise and concrete (a production engine must act on it).`;

/**
 * Generate a storyboard for one concept.
 * @param {{
 *   concept: object,                    // a chosen concept (from concepts.js)
 *   entityType?: string,
 *   allowsPhysicalLanguage?: boolean,   // safety constraint, NOT a template selector
 *   durationSeconds?: number,
 *   aspectRatio?: string,
 *   availableAssets?: { role?: string, kind?: string }[], // what real assets exist
 *   product?: object, brand?: object, design?: object,
 *   emphasis?: string[], avoid?: string[],
 * }} input
 */
export async function generateStoryboardAI(input = {}) {
  const model = getEnrichmentModel();
  if (!isEnrichmentEnabled() || !getGeminiApiKey()) {
    return { storyboard: null, model, cost: { amountUsd: 0, state: "estimated" }, skipped: "AI director disabled / no key." };
  }
  const evidence = buildEvidence(input);
  if (!evidence || evidence.length < 30) {
    return { storyboard: null, model, cost: { amountUsd: 0, state: "estimated" }, skipped: "Not enough evidence for a storyboard." };
  }

  const ai = new GoogleGenAI({ apiKey: getGeminiApiKey() });
  try {
    const resp = await ai.models.generateContent({
      model,
      contents: evidence,
      config: {
        systemInstruction: SYSTEM,
        responseMimeType: "application/json",
        responseSchema: storyboardSchema(),
        temperature: 0.7, // creative variety across concepts, still grounded
      },
    });
    let parsed;
    try {
      parsed = JSON.parse(resp.text);
    } catch {
      return { storyboard: null, model, cost: { amountUsd: null, state: "unknown" }, error: "Director returned non-JSON." };
    }
    const storyboard = sanitizeStoryboard(parsed, input);
    if (!storyboard?.shots?.length) {
      return { storyboard: null, model, cost: { amountUsd: null, state: "unknown" }, error: "Director returned no usable shots." };
    }
    await tightenVoiceover(ai, model, storyboard);
    const u = resp.usageMetadata;
    const usage = u
      ? { total_input_tokens: u.promptTokenCount, total_output_tokens: u.candidatesTokenCount, total_tokens: u.totalTokenCount, videoOutputTokens: 0 }
      : null;
    return { storyboard, model, usage, cost: usage ? costFromUsage(usage) : { amountUsd: null, state: "unknown" } };
  } catch (err) {
    return { storyboard: null, model, cost: { amountUsd: null, state: "unknown" }, error: `Director failed: ${err?.message || "unknown"}` };
  }
}

function buildEvidence(input) {
  const { concept = {}, product = {}, brand = {}, design = {}, availableAssets = [], emphasis = [], avoid = [] } = input;
  const lines = [];
  const push = (label, v) => {
    if (v == null || v === "" || (Array.isArray(v) && !v.length)) return;
    lines.push(`${label}: ${Array.isArray(v) ? v.slice(0, 8).join("; ") : v}`);
  };
  push("CONCEPT title", concept.title);
  push("CONCEPT central message", concept.centralMessage);
  push("CONCEPT visual idea", concept.visualIdea);
  push("CONCEPT angle", concept.advertisingAngle);
  push("CONCEPT subject (what the viewer sees)", concept.proposedSubject);
  push("Entity type", input.entityType);
  push("Physical product allowed", input.allowsPhysicalLanguage ? "yes" : "no — do not depict physical packaging");
  push("Target duration (seconds)", input.durationSeconds);
  push("Aspect ratio", input.aspectRatio);
  push("Product/brand name", product.name || brand.name);
  push("What it is", product.description);
  push("Benefits", product.benefits);
  push("Differentiators", product.differentiators);
  push("Audience", product.targetCustomer);
  push("Exact offer (use verbatim or omit)", product.offer);
  push("Exact CTA (use verbatim or omit)", product.cta);
  push("Brand palette", (design?.palette?.primary || brand.primaryColors || []).slice(0, 4));
  push("Brand tone", brand.toneOfVoice);
  push(
    "Available real assets (role:kind)",
    availableAssets.map((a) => `${a.role || "image"}:${a.kind || "image"}`)
  );
  push("Must EMPHASIZE", emphasis);
  push("Must NOT appear", avoid);
  return lines.join("\n");
}

/** Clamp + normalize the model's storyboard; scale shot durations to the target. */
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
      visual: visual || intent,
      durationSec: num(s.durationSec, 2.5),
      technique: SHOT_TECHNIQUES.includes(s.technique) ? s.technique : "motion_graphic",
      assetHint: str(s.assetHint) || "none",
      motion: str(s.motion) || "subtle",
      onScreenText: typeof s.onScreenText === "string" ? s.onScreenText.trim() : "",
      voiceover: typeof s.voiceover === "string" ? s.voiceover.trim() : "",
      transitionOut: str(s.transitionOut) || "cut",
    });
  }
  if (!shots.length) return null;

  // Scale shot durations to the requested total (keep relative weighting).
  const target = num(input.durationSeconds, num(parsed.totalDurationSec, 8));
  const sum = shots.reduce((a, s) => a + s.durationSec, 0) || shots.length;
  let acc = 0;
  shots.forEach((s, i) => {
    if (i === shots.length - 1) {
      s.durationSec = Math.max(0.8, Number((target - acc).toFixed(2)));
    } else {
      s.durationSec = Math.max(0.8, Number(((s.durationSec / sum) * target).toFixed(2)));
      acc += s.durationSec;
    }
  });

  return {
    logline: str(parsed.logline) || null,
    totalDurationSec: target,
    music: str(parsed.music) ? str(parsed.music).slice(0, 240) : null,
    voiceStyle: str(parsed.voiceStyle) ? str(parsed.voiceStyle).slice(0, 200) : null,
    shots,
    origin: "ai",
  };
}

function str(x) {
  return typeof x === "string" && x.trim() ? x.trim() : null;
}

const WORDS_PER_SEC = 2.4;
const wordCount = (s) => (String(s || "").trim().match(/\S+/g) || []).length;
const maxWordsFor = (sec) => Math.max(3, Math.floor(Number(sec || 0) * WORDS_PER_SEC));

/**
 * Models are bad at counting: when the voiceover would overrun its shots, ask
 * the (cheap) text model once to tighten each line to its word budget, keeping
 * the brand, exact offer wording and CTA. Best effort — on any failure the
 * original lines stand and the renderer fits them (tempo/hold).
 */
async function tightenVoiceover(ai, model, storyboard) {
  const shots = storyboard.shots;
  const over = shots.some((s) => wordCount(s.voiceover) > maxWordsFor(s.durationSec) + 1);
  if (!over) return;
  try {
    const resp = await ai.models.generateContent({
      model,
      contents: JSON.stringify(shots.map((s, i) => ({ shot: i + 1, seconds: s.durationSec, maxWords: maxWordsFor(s.durationSec), voiceover: s.voiceover }))),
      config: {
        systemInstruction:
          "You edit ad voiceover. Rewrite each line to AT MOST maxWords words. Keep the meaning, the brand name, any exact offer/price wording and the call to action. Natural, persuasive, spoken English. Return the lines in the same order; keep an empty line empty.",
        responseMimeType: "application/json",
        responseSchema: { type: Type.OBJECT, properties: { lines: { type: Type.ARRAY, items: { type: Type.STRING } } }, required: ["lines"] },
        temperature: 0.3,
      },
    });
    const lines = JSON.parse(resp.text)?.lines;
    if (!Array.isArray(lines) || lines.length !== shots.length) return;
    shots.forEach((s, i) => {
      const l = typeof lines[i] === "string" ? lines[i].trim() : "";
      if (l && wordCount(l) <= maxWordsFor(s.durationSec) + 1) s.voiceover = l;
    });
  } catch {
    /* keep the original lines */
  }
}
function num(x, d) {
  const n = Number(x);
  return Number.isFinite(n) && n > 0 ? n : d;
}
