# Multilingual Pipeline

`lib/i18n/` — `languages.js`, `profile.js`, `scripts.js`

## Language profile

A `LanguageProfile` (Zod schema in `profile.js`) flows through every production stage:

```js
{
  mode: "single" | "mixed",
  primary: "en-US",          // BCP-47
  secondary: ["hi-IN"],      // mixed mode only
  captionScript: "Latn",     // ISO 15924 (or "Deva", "Arab", etc.)
}
```

The profile is set once by the user in `LanguagePicker.js` and carried through:
- Director (narration style, caption language, CTA copy)
- TTS routing (voice filtering by BCP-47)
- Caption renderer (font selection by script)
- Export checks (`lib/quality/mediaChecks.js` — `checkCopyLanguage`)
- Cache keys (different profiles → different cache entries)

## Language catalogue

`lib/i18n/languages.js` — 84 languages with:
- BCP-47 code + display name + native name
- Script tag (for font selection)
- Google TTS availability flag
- Mixed-language presets (14 total, e.g. Hinglish = hi-IN + en-US in Roman script)

## TTS routing

`lib/ai/audioProvider.js` filters the TTS model chain by the profile's `primary` language. If no TTS voice is available, a silent voiceover is produced and a `language.warn` check is emitted.

**Known gaps (as of 2026-10-17):**
- Urdu (ur-PK) — not in Google TTS listing
- Ukrainian (uk-UA) — not in Google TTS listing

## Fonts

38 Noto TTF files in `assets/fonts/`, covering:
- Latin (NotoSans, NotoSerif)
- Devanagari (Hindi, Marathi, Sanskrit)
- Gurmukhi (Punjabi)
- Tamil
- Telugu, Kannada, Malayalam, Bengali
- Arabic, Urdu, Persian (RTL)
- Hebrew (RTL)
- Thai, Sinhala, Georgian, Armenian

CJK (Chinese, Japanese, Korean) fonts are **not bundled** due to file size (~30 MB each). Captions in CJK scripts fall back to a Latin sans-serif — the glyphs render as boxes. This is a known limitation.

## Mixed-language captions

In `mixed` mode the director is instructed to write captions in the mixed style (e.g. Roman Hinglish: "Aaj try karo"). Two checks run:
1. **English-only detection** — if all captions are English and the language profile is Hinglish, the director is retried.
2. **Sentence alternation detection** — if captions alternate English / Hindi sentence-by-sentence (unnatural), the director is retried with a stronger constraint.

## Capability checks

`lib/i18n/profile.js` → `assess(profile)` returns a capability object:
```js
{
  voice: "supported" | "captions_only" | "unsupported",
  captions: "supported" | "partial" | "unsupported",
  lipSync: "not_offered",
  gaps: ["Urdu voice not available — captions only"]
}
```

The Studio shows gaps as warnings before the user commits to a paid run.
