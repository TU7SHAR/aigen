/**
 * Language catalogue (extensible, searchable).
 *
 * Each entry: BCP-47 code, names, writing systems (ISO 15924, default first),
 * an approximate ad-narration speaking rate, and the TTS support that Google
 * LISTS for Gemini 3.8 Flash TTS / 3.8 Flash-Lite TTS
 * (docs/speech-generation "Supported languages", read 2026-10-17).
 *
 * "Listed" is not "verified": a language counts as verified only after an
 * export in it has been produced and reviewed (see VERIFIED_LANGUAGES). Codes
 * not in this list can still be used through the Custom path; they are then
 * reported as unverified at every stage.
 */

/** Languages missing from the 3.8 Flash-Lite TTS column (all others listed for both). */
const LITE_MISSING = new Set(["fi", "th", "sv", "sw", "lt", "lb", "sl", "so", "sd", "tg", "ug", "ti", "my", "ig", "gn", "oc", "ba", "bem", "dz", "kab", "ltg", "pag", "st", "ss", "crh", "dyu", "sq"]);
/** Languages NOT in Google's TTS table at all (voice unverified). */
const TTS_UNLISTED = new Set(["ur", "uk"]);

// [code, english, native, scripts, rate, rateUnit("w"|"c"), region note]
const RAW = [
  ["en-US", "English (US)", "English", ["Latn"], 2.5],
  ["en-GB", "English (UK)", "English", ["Latn"], 2.5],
  ["en-IN", "English (India)", "English", ["Latn"], 2.5],
  ["en-AU", "English (Australia)", "English", ["Latn"], 2.5],
  ["hi-IN", "Hindi", "हिन्दी", ["Deva", "Latn"], 2.4],
  ["pa-IN", "Punjabi (Gurmukhi)", "ਪੰਜਾਬੀ", ["Guru", "Latn"], 2.4],
  ["pa-PK", "Punjabi (Shahmukhi)", "پنجابی", ["Arab", "Latn"], 2.4],
  ["ta-IN", "Tamil", "தமிழ்", ["Taml", "Latn"], 1.6],
  ["ta-LK", "Tamil (Sri Lanka)", "தமிழ்", ["Taml"], 1.6],
  ["te-IN", "Telugu", "తెలుగు", ["Telu", "Latn"], 1.7],
  ["kn-IN", "Kannada", "ಕನ್ನಡ", ["Knda", "Latn"], 1.7],
  ["ml-IN", "Malayalam", "മലയാളം", ["Mlym", "Latn"], 1.5],
  ["bn-IN", "Bangla (India)", "বাংলা", ["Beng", "Latn"], 2.1],
  ["bn-BD", "Bangla (Bangladesh)", "বাংলা", ["Beng"], 2.1],
  ["mr-IN", "Marathi", "मराठी", ["Deva", "Latn"], 2.0],
  ["gu-IN", "Gujarati", "ગુજરાતી", ["Gujr", "Latn"], 2.1],
  ["or-IN", "Odia", "ଓଡ଼ିଆ", ["Orya"], 2.0],
  ["as-IN", "Assamese", "অসমীয়া", ["Beng"], 2.0],
  ["ne-NP", "Nepali", "नेपाली", ["Deva"], 2.2],
  ["bho-IN", "Bhojpuri", "भोजपुरी", ["Deva", "Latn"], 2.3],
  ["mai-IN", "Maithili", "मैथिली", ["Deva"], 2.2],
  ["si-LK", "Sinhala", "සිංහල", ["Sinh"], 1.9],
  ["ur-PK", "Urdu", "اردو", ["Arab", "Latn"], 2.4],
  ["ar", "Arabic (Modern Standard)", "العربية", ["Arab"], 2.1],
  ["ar-EG", "Arabic (Egyptian)", "العربية المصرية", ["Arab"], 2.2],
  ["he-IL", "Hebrew", "עברית", ["Hebr"], 2.3],
  ["fa-IR", "Persian", "فارسی", ["Arab"], 2.3],
  ["ps-AF", "Pashto", "پښتو", ["Arab"], 2.2],
  ["ckb-IQ", "Central Kurdish", "کوردی", ["Arab"], 2.1],
  ["tr-TR", "Turkish", "Türkçe", ["Latn"], 2.0],
  ["fr-FR", "French", "Français", ["Latn"], 2.6],
  ["fr-CA", "French (Canada)", "Français (Canada)", ["Latn"], 2.6],
  ["de-DE", "German", "Deutsch", ["Latn"], 2.2],
  ["es-ES", "Spanish (Spain)", "Español", ["Latn"], 2.8],
  ["es-419", "Spanish (Latin America)", "Español (Latinoamérica)", ["Latn"], 2.8],
  ["es-US", "Spanish (US)", "Español (EE. UU.)", ["Latn"], 2.8],
  ["pt-BR", "Portuguese (Brazil)", "Português (Brasil)", ["Latn"], 2.6],
  ["pt-PT", "Portuguese (Portugal)", "Português", ["Latn"], 2.6],
  ["it-IT", "Italian", "Italiano", ["Latn"], 2.7],
  ["nl-NL", "Dutch", "Nederlands", ["Latn"], 2.4],
  ["pl-PL", "Polish", "Polski", ["Latn"], 2.1],
  ["ro-RO", "Romanian", "Română", ["Latn"], 2.4],
  ["cs-CZ", "Czech", "Čeština", ["Latn"], 2.1],
  ["sk-SK", "Slovak", "Slovenčina", ["Latn"], 2.1],
  ["hu-HU", "Hungarian", "Magyar", ["Latn"], 2.0],
  ["el-GR", "Greek", "Ελληνικά", ["Grek"], 2.3],
  ["bg-BG", "Bulgarian", "Български", ["Cyrl"], 2.2],
  ["ru-RU", "Russian", "Русский", ["Cyrl"], 2.1],
  ["uk-UA", "Ukrainian", "Українська", ["Cyrl"], 2.1],
  ["sr-RS", "Serbian", "Српски", ["Cyrl", "Latn"], 2.2],
  ["hr-HR", "Croatian", "Hrvatski", ["Latn"], 2.2],
  ["da-DK", "Danish", "Dansk", ["Latn"], 2.4],
  ["sv-SE", "Swedish", "Svenska", ["Latn"], 2.4],
  ["nb-NO", "Norwegian Bokmål", "Norsk bokmål", ["Latn"], 2.4],
  ["fi-FI", "Finnish", "Suomi", ["Latn"], 1.8],
  ["et-EE", "Estonian", "Eesti", ["Latn"], 1.9],
  ["lv-LV", "Latvian", "Latviešu", ["Latn"], 2.0],
  ["lt-LT", "Lithuanian", "Lietuvių", ["Latn"], 2.0],
  ["ka-GE", "Georgian", "ქართული", ["Geor"], 1.9],
  ["hy-AM", "Armenian", "Հայերեն", ["Armn"], 2.0],
  ["kk-KZ", "Kazakh", "Қазақ", ["Cyrl"], 1.9],
  ["uz-UZ", "Uzbek", "Oʻzbek", ["Latn"], 1.9],
  ["az-AZ", "Azerbaijani", "Azərbaycan", ["Latn"], 2.0],
  ["id-ID", "Indonesian", "Bahasa Indonesia", ["Latn"], 2.3],
  ["ms-MY", "Malay", "Bahasa Melayu", ["Latn"], 2.3],
  ["fil-PH", "Filipino", "Filipino", ["Latn"], 2.4],
  ["jv-ID", "Javanese", "Basa Jawa", ["Latn"], 2.2],
  ["vi-VN", "Vietnamese", "Tiếng Việt", ["Latn"], 3.0],
  ["th-TH", "Thai", "ไทย", ["Thai"], 7, "c"],
  ["lo-LA", "Lao", "ລາວ", ["Laoo"], 7, "c"],
  ["km-KH", "Khmer", "ខ្មែរ", ["Khmr"], 7, "c"],
  ["my-MM", "Burmese", "မြန်မာ", ["Mymr"], 6, "c"],
  ["zh-CN", "Chinese (Simplified)", "简体中文", ["Hani"], 4.5, "c"],
  ["zh-TW", "Chinese (Traditional)", "繁體中文", ["Hani"], 4.5, "c"],
  ["yue-HK", "Cantonese", "粵語", ["Hani"], 4.5, "c"],
  ["ja-JP", "Japanese", "日本語", ["Kana", "Hani"], 7, "c"],
  ["ko-KR", "Korean", "한국어", ["Hang"], 2.3],
  ["sw-KE", "Swahili", "Kiswahili", ["Latn"], 2.2],
  ["am-ET", "Amharic", "አማርኛ", ["Ethi"], 1.9],
  ["ha-NG", "Hausa", "Hausa", ["Latn"], 2.2],
  ["yo-NG", "Yoruba", "Yorùbá", ["Latn"], 2.2],
  ["ig-NG", "Igbo", "Igbo", ["Latn"], 2.2],
  ["zu-ZA", "Zulu", "isiZulu", ["Latn"], 1.9],
  ["af-ZA", "Afrikaans", "Afrikaans", ["Latn"], 2.4],
];

/** TTS languages Google lists that have no dedicated catalogue row get through Custom. */
const TTS_LISTED_BASE = new Set([
  "af", "ak", "am", "hy", "as", "awa", "ban", "bn", "bjn", "ba", "eu", "be", "bem", "bho", "bs", "bug", "bg", "my", "yue",
  "ca", "ceb", "ckb", "hne", "zh", "crh", "hr", "cs", "da", "nl", "dyu", "dz", "arz", "en", "et", "fil", "fi", "fr", "gl",
  "lg", "ka", "de", "el", "gn", "gu", "ht", "mn", "ha", "he", "hi", "hu", "is", "ig", "ilo", "id", "fa", "it", "ja", "jv",
  "kab", "kam", "kn", "ks", "kk", "km", "ki", "rw", "kg", "ko", "ky", "lo", "ltg", "ln", "lt", "lb", "mk", "mag", "mai",
  "ml", "mt", "mni", "mr", "min", "lus", "ne", "fuv", "az", "nso", "uz", "nb", "nn", "ny", "oc", "or", "pag", "prs", "pl",
  "pt", "pa", "ro", "ru", "sat", "sr", "sd", "si", "sk", "sl", "so", "azb", "ps", "st", "es", "ar", "lv", "ms", "sw", "ss",
  "sv", "tg", "ta", "te", "th", "ti", "sq", "tr", "ug", "vi", "zu", "yo",
]);

const base = (code) => String(code || "").split("-")[0].toLowerCase();

/** Gemini 3.8 TTS support Google lists for a language code. */
export function ttsListing(code) {
  const b = base(code);
  if (TTS_UNLISTED.has(b)) return { flash: false, lite: false };
  const listed = TTS_LISTED_BASE.has(b) || b === "fil" || b === "yue";
  return { flash: listed, lite: listed && !LITE_MISSING.has(b) };
}

export const LANGUAGES = RAW.map(([code, name, native, scripts, rate, unit = "w"]) => ({
  code, name, native, scripts, defaultScript: scripts[0],
  rtl: scripts[0] === "Arab" || scripts[0] === "Hebr",
  speechRate: { value: rate, unit: unit === "c" ? "chars/sec" : "words/sec" },
  tts: ttsListing(code),
}));

const BY_CODE = new Map(LANGUAGES.map((l) => [l.code.toLowerCase(), l]));

/**
 * Mixed-language presets: natural code-switching styles, stored as structured
 * settings (primary + secondary + caption script), never as a fake locale.
 */
export const MIXED_PRESETS = [
  { id: "hinglish", label: "Hinglish", detail: "Hindi + English", primary: "hi-IN", secondary: ["en-IN"], captionScript: "Latn", mixBalance: 0.6 },
  { id: "punjabi-english", label: "Punjabi-English", detail: "Punjabi + English", primary: "pa-IN", secondary: ["en-IN"], captionScript: "Latn", mixBalance: 0.6 },
  { id: "tanglish", label: "Tanglish", detail: "Tamil + English", primary: "ta-IN", secondary: ["en-IN"], captionScript: "Latn", mixBalance: 0.55 },
  { id: "tenglish", label: "Tenglish", detail: "Telugu + English", primary: "te-IN", secondary: ["en-IN"], captionScript: "Latn", mixBalance: 0.55 },
  { id: "kanglish", label: "Kanglish", detail: "Kannada + English", primary: "kn-IN", secondary: ["en-IN"], captionScript: "Latn", mixBalance: 0.55 },
  { id: "manglish", label: "Manglish", detail: "Malayalam + English", primary: "ml-IN", secondary: ["en-IN"], captionScript: "Latn", mixBalance: 0.55 },
  { id: "benglish", label: "Benglish", detail: "Bangla + English", primary: "bn-IN", secondary: ["en-IN"], captionScript: "Latn", mixBalance: 0.6 },
  { id: "marathi-english", label: "Marathi-English", detail: "Marathi + English", primary: "mr-IN", secondary: ["en-IN"], captionScript: "Latn", mixBalance: 0.6 },
  { id: "gujarati-english", label: "Gujarati-English", detail: "Gujarati + English", primary: "gu-IN", secondary: ["en-IN"], captionScript: "Latn", mixBalance: 0.6 },
  { id: "urdu-english", label: "Urdu-English", detail: "Urdu + English", primary: "ur-PK", secondary: ["en-GB"], captionScript: "Latn", mixBalance: 0.6 },
  { id: "spanglish", label: "Spanglish", detail: "Spanish + English", primary: "es-US", secondary: ["en-US"], captionScript: "Latn", mixBalance: 0.5 },
  { id: "franglais", label: "French-English", detail: "French + English", primary: "fr-FR", secondary: ["en-US"], captionScript: "Latn", mixBalance: 0.65 },
  { id: "taglish", label: "Taglish", detail: "Filipino + English", primary: "fil-PH", secondary: ["en-US"], captionScript: "Latn", mixBalance: 0.5 },
  { id: "arabic-english", label: "Arabic-English", detail: "Arabic + English", primary: "ar", secondary: ["en-US"], captionScript: "Arab", mixBalance: 0.65 },
];

/**
 * Languages for which an export has actually been produced AND reviewed in
 * this project (updated by hand after a verified run — never automatically).
 */
export const VERIFIED_LANGUAGES = new Set(["en-US", "en-IN"]);

/** Look up a catalogue entry; unknown codes get a best-effort record. */
export function getLanguage(code) {
  const hit = BY_CODE.get(String(code || "").toLowerCase());
  if (hit) return hit;
  const b = base(code);
  const sameBase = LANGUAGES.find((l) => base(l.code) === b);
  let name = code;
  try {
    name = new Intl.DisplayNames(["en"], { type: "language" }).of(code) || code;
  } catch { /* invalid tag */ }
  return {
    code, name, native: name, scripts: sameBase?.scripts || ["Latn"], defaultScript: sameBase?.defaultScript || "Latn",
    rtl: sameBase?.rtl || false, speechRate: sameBase?.speechRate || { value: 2.3, unit: "words/sec" },
    tts: ttsListing(code), custom: true,
  };
}

export function getPreset(id) {
  return MIXED_PRESETS.find((p) => p.id === id) || null;
}

/** Case/diacritic-insensitive search over names, native names and codes. */
export function searchLanguages(query = "", limit = 20) {
  const norm = (s) => String(s || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const q = norm(query).trim();
  const all = LANGUAGES.map((l) => ({ ...l, kind: "single" }));
  const presets = MIXED_PRESETS.map((p) => ({ ...p, kind: "mixed", code: p.id, name: p.label, native: p.detail }));
  const pool = [...all, ...presets];
  if (!q) return pool.slice(0, limit);
  return pool
    .map((l) => {
      const hay = [l.name, l.native, l.code, l.detail].map(norm).join(" ");
      const score = norm(l.name).startsWith(q) ? 3 : hay.includes(q) ? 1 : 0;
      return { l, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.l);
}
