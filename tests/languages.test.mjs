/**
 * Language profile, scripts/fonts, CTA destination and claim grounding.
 * Pure functions — no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeLanguageProfile, assessLanguageProfile, checkCopyLanguage, profileCacheKey, languageInstructions, speechBudget, describeProfile } from "../lib/i18n/profile.js";
import { searchLanguages, getLanguage, MIXED_PRESETS } from "../lib/i18n/languages.js";
import { checkGlyphCoverage, scriptsIn, isRtlText, fontCodepointRanges, fontFile } from "../lib/i18n/scripts.js";
import { resolveDestination, cleanUrl } from "../lib/creative/destination.js";
import { unsupportedClaims, validateStoryboard } from "../lib/ai/director.js";

test("catalogue is searchable (names, native names, codes, presets)", () => {
  assert.equal(searchLanguages("punj")[0].code, "pa-IN");
  assert.ok(searchLanguages("தமிழ்").some((l) => l.code === "ta-IN"));
  assert.ok(searchLanguages("hinglish").some((l) => l.kind === "mixed" && l.id === "hinglish"));
  assert.ok(searchLanguages("francais").some((l) => l.code.startsWith("fr")), "diacritic-insensitive");
  assert.ok(MIXED_PRESETS.find((p) => p.id === "tanglish"));
});

test("Hinglish preset normalises to structured settings (not a fake locale)", () => {
  const p = normalizeLanguageProfile({ mode: "mixed", preset: "hinglish" });
  assert.equal(p.primary, "hi-IN");
  assert.deepEqual(p.secondary, ["en-IN"]);
  assert.equal(p.captionScript, "Latn");
  assert.match(describeProfile(p), /Hinglish/);
});

test("single language defaults its caption script to the language's own script", () => {
  assert.equal(normalizeLanguageProfile({ mode: "single", primary: "pa-IN" }).captionScript, "Guru");
  assert.equal(normalizeLanguageProfile({ mode: "single", primary: "ta-IN" }).captionScript, "Taml");
  assert.equal(normalizeLanguageProfile({ mode: "single", primary: "ar" }).captionScript, "Arab");
});

test("capabilities are honest per stage: listed voice, verified fonts, unlisted Urdu voice blocks narration", () => {
  const hi = assessLanguageProfile({ mode: "mixed", preset: "hinglish" });
  assert.equal(hi.ok, true);
  assert.equal(hi.stages.voice.status, "provider_listed");
  assert.equal(hi.stages.captions.status, "verified");
  const ur = assessLanguageProfile({ mode: "single", primary: "ur-PK" });
  assert.equal(ur.ok, false, "Urdu is not in Google's TTS list");
  assert.match(ur.blockers[0], /Voiceover in Urdu/);
  const urCaptionsOnly = assessLanguageProfile({ mode: "single", primary: "ur-PK" }, { narration: false });
  assert.equal(urCaptionsOnly.ok, true, "captions-only Urdu is possible (Arabic-script font installed)");
  const zh = assessLanguageProfile({ mode: "single", primary: "zh-CN" });
  assert.equal(zh.ok, false, "no CJK caption font is vendored");
  assert.equal(zh.stages.captions.status, "unavailable");
  assert.equal(assessLanguageProfile({ mode: "single", primary: "th-TH" }).stages.voice.models.length, 1, "Thai is not listed for Flash-Lite TTS");
});

test("language changes change the cache key (no stale voiceover/captions)", () => {
  const a = profileCacheKey({ mode: "single", primary: "en-US" });
  const b = profileCacheKey({ mode: "mixed", preset: "hinglish" });
  const c = profileCacheKey({ mode: "mixed", preset: "hinglish", captionScript: "Deva" });
  assert.notEqual(a, b);
  assert.notEqual(b, c);
});

test("speech budget follows the language's speaking rate (Tamil < English words; Japanese in characters)", () => {
  assert.ok(speechBudget({ primary: "ta-IN" }, 4).max < speechBudget({ primary: "en-US" }, 4).max);
  assert.equal(speechBudget({ primary: "ja-JP" }, 4).unit, "characters");
});

test("director language block asks for native scripts in the TTS transcript and the caption script on screen", () => {
  const txt = languageInstructions({ mode: "mixed", preset: "hinglish" });
  assert.match(txt, /code-switching/);
  assert.match(txt, /Do NOT alternate translated sentences/);
  assert.match(txt, /native script/);
  assert.match(txt, /Latin \(Roman\) writing system/);
});

test("copy checks catch wrong scripts and missing mix languages", () => {
  const tamilWrong = checkCopyLanguage({ primary: "ta-IN" }, { captions: ["Glow every day"], voiceover: ["Glow every day"] });
  assert.equal(tamilWrong.ok, false);
  const tamilOk = checkCopyLanguage({ primary: "ta-IN" }, { captions: ["தினமும் பளபளப்பு"], voiceover: ["தினமும் பளபளப்பு"] });
  assert.equal(tamilOk.ok, true);
  const hinglishEnglishOnly = checkCopyLanguage({ mode: "mixed", preset: "hinglish" }, { captions: ["Skincare made easy"], voiceover: ["Your skin deserves the best care today"] });
  assert.equal(hinglishEnglishOnly.ok, false);
  const hinglishOk = checkCopyLanguage({ mode: "mixed", preset: "hinglish" }, { captions: ["Ab skincare hua easy"], voiceover: ["अब skincare हुआ बिल्कुल easy"] });
  assert.equal(hinglishOk.ok, true);
  // Live-run regression (H&M, 2026-10-17): Hinglish narration but English-only captions.
  const englishCaptions = checkCopyLanguage({ mode: "mixed", preset: "hinglish" }, { captions: ["The Fall Upgrade is here", "Affordable autumn icons"], voiceover: ["Wardrobe को दीजिए stylish upgrade!"] });
  assert.equal(englishCaptions.ok, false);
  assert.ok(englishCaptions.findings.some((f) => f.field === "captions" && /English-only/.test(f.message)));
  // Live-run regression: one Hindi line, then English sentences = alternation, not mixing.
  const alternating = checkCopyLanguage({ mode: "mixed", preset: "hinglish" }, { captions: ["Naya season, naya style?"], voiceover: ["क्या आपका wardrobe ready है?", "Discover H&M wardrobe icons!", "Best quality at affordable prices.", "Shop the new looks!"] });
  assert.ok(alternating.findings.some((f) => /alternates languages/.test(f.message)));
  const frenchAsEnglish = checkCopyLanguage({ primary: "fr-FR" }, { captions: ["The new collection is here"], voiceover: ["Get the new collection now, with your favourite pieces for the season"] });
  assert.equal(frenchAsEnglish.ok, false);
});

test("glyph coverage is read from the real font cmap; scripts and RTL detected", () => {
  assert.ok(fontCodepointRanges(fontFile("Deva")).length > 5);
  assert.equal(checkGlyphCoverage("अब skincare हुआ easy").ok, true);
  assert.equal(checkGlyphCoverage("ਹੁਣ glow ਕਰੋ").ok, true);
  assert.equal(checkGlyphCoverage("新系列").ok, false, "CJK font not vendored");
  assert.deepEqual(scriptsIn("اكتشف H&M").sort(), ["Arab", "Latn"]);
  assert.equal(isRtlText("اكتشف مجموعة الخريف"), true);
});

test("CTA destination: user URL wins, tracking params stripped, ad infrastructure rejected", () => {
  const d = resolveDestination({ destinationUrl: "https://www2.hm.com/en_in/women.html?utm_source=x&gclid=1", productProfile: { canonicalUrl: "https://www2.hm.com/en_in/index.html" } });
  assert.equal(d.source, "user");
  assert.ok(!/utm_|gclid/.test(d.url));
  assert.equal(d.display, "hm.com"); // long path → readable host only
  const ad = resolveDestination({ destinationUrl: "https://ad.doubleclick.net/x", productProfile: { canonicalUrl: "https://brand.example/" } });
  assert.equal(ad.source, "imported_site");
  assert.match(ad.warnings[0], /ad-serving/);
  assert.equal(cleanUrl("javascript:alert(1)"), null);
});

test("numeric claims must appear in the evidence; Hinglish words are not mistaken for units", () => {
  assert.deepEqual(unsupportedClaims("Now 50% off, only ₹299", "Price: INR 299"), ["50%"]);
  assert.deepEqual(unsupportedClaims("Sirf 5 mein ready", ""), []);
  const v = validateStoryboard(
    { shots: [{ durationSec: 2, voiceover: "Save 40% today", onScreenText: "40% off", technique: "ai_video", visual: "x" }, { durationSec: 2, voiceover: "", onScreenText: "Shop now", technique: "motion_graphic", visual: "end" }] },
    { evidence: "Spring dresses", language: { primary: "en-US" }, input: {} }
  );
  assert.ok(v.findings.some((f) => f.code === "UNSUPPORTED_CLAIM"));
  assert.equal(getLanguage("hi-IN").tts.flash, true);
});
