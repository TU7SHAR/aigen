/**
 * Writing systems, fonts and glyph coverage for exported captions.
 *
 * Spoken language and writing system are separate: Hinglish may be captioned
 * in Roman script or Devanagari; Punjabi in Gurmukhi or Shahmukhi. This module
 * detects which scripts a string actually uses, maps each script to a vendored
 * Noto font (assets/fonts, SIL OFL), and checks REAL glyph coverage by reading
 * each font's cmap table — so a caption with no font is reported before
 * rendering instead of exporting tofu boxes.
 */

import fs from "node:fs";
import path from "node:path";

/** ISO 15924 script → Unicode ranges [start, end]. */
export const SCRIPT_RANGES = {
  Latn: [[0x41, 0x5a], [0x61, 0x7a], [0xc0, 0x24f], [0x1e00, 0x1eff]],
  Cyrl: [[0x400, 0x4ff], [0x500, 0x52f]],
  Grek: [[0x370, 0x3ff]],
  Armn: [[0x530, 0x58f]],
  Hebr: [[0x590, 0x5ff], [0xfb1d, 0xfb4f]],
  Arab: [[0x600, 0x6ff], [0x750, 0x77f], [0x8a0, 0x8ff], [0xfb50, 0xfdff], [0xfe70, 0xfeff]],
  Deva: [[0x900, 0x97f], [0xa8e0, 0xa8ff]],
  Beng: [[0x980, 0x9ff]],
  Guru: [[0xa00, 0xa7f]],
  Gujr: [[0xa80, 0xaff]],
  Orya: [[0xb00, 0xb7f]],
  Taml: [[0xb80, 0xbff]],
  Telu: [[0xc00, 0xc7f]],
  Knda: [[0xc80, 0xcff]],
  Mlym: [[0xd00, 0xd7f]],
  Sinh: [[0xd80, 0xdff]],
  Thai: [[0xe00, 0xe7f]],
  Laoo: [[0xe80, 0xeff]],
  Mymr: [[0x1000, 0x109f]],
  Geor: [[0x10a0, 0x10ff]],
  Ethi: [[0x1200, 0x137f]],
  Khmr: [[0x1780, 0x17ff]],
  Hang: [[0x1100, 0x11ff], [0x3130, 0x318f], [0xac00, 0xd7af]],
  Kana: [[0x3040, 0x30ff]],
  Hani: [[0x3400, 0x4dbf], [0x4e00, 0x9fff]],
};

export const RTL_SCRIPTS = new Set(["Arab", "Hebr"]);

export const SCRIPT_NAMES = {
  Latn: "Latin (Roman)", Cyrl: "Cyrillic", Grek: "Greek", Armn: "Armenian", Hebr: "Hebrew", Arab: "Arabic",
  Deva: "Devanagari", Beng: "Bengali", Guru: "Gurmukhi", Gujr: "Gujarati", Orya: "Odia", Taml: "Tamil",
  Telu: "Telugu", Knda: "Kannada", Mlym: "Malayalam", Sinh: "Sinhala", Thai: "Thai", Laoo: "Lao",
  Mymr: "Myanmar", Geor: "Georgian", Ethi: "Ethiopic", Khmr: "Khmer", Hang: "Hangul", Kana: "Kana",
  Hani: "Han (Chinese characters)",
};

const FONT_DIR = path.join(process.cwd(), "assets", "fonts");

/** Vendored font family per script (Regular/Bold files in assets/fonts). */
export const SCRIPT_FONTS = {
  Latn: { family: "Noto Sans", base: "NotoSans" },
  Cyrl: { family: "Noto Sans", base: "NotoSans" },
  Grek: { family: "Noto Sans", base: "NotoSans" },
  Armn: { family: "Noto Sans Armenian", base: "NotoSansArmenian" },
  Hebr: { family: "Noto Sans Hebrew", base: "NotoSansHebrew" },
  Arab: { family: "Noto Sans Arabic", base: "NotoSansArabic" },
  Deva: { family: "Noto Sans Devanagari", base: "NotoSansDevanagari" },
  Beng: { family: "Noto Sans Bengali", base: "NotoSansBengali" },
  Guru: { family: "Noto Sans Gurmukhi", base: "NotoSansGurmukhi" },
  Gujr: { family: "Noto Sans Gujarati", base: "NotoSansGujarati" },
  Orya: { family: "Noto Sans Oriya", base: "NotoSansOriya" },
  Taml: { family: "Noto Sans Tamil", base: "NotoSansTamil" },
  Telu: { family: "Noto Sans Telugu", base: "NotoSansTelugu" },
  Knda: { family: "Noto Sans Kannada", base: "NotoSansKannada" },
  Mlym: { family: "Noto Sans Malayalam", base: "NotoSansMalayalam" },
  Sinh: { family: "Noto Sans Sinhala", base: "NotoSansSinhala" },
  Thai: { family: "Noto Sans Thai", base: "NotoSansThai" },
  Laoo: { family: "Noto Sans Lao", base: "NotoSansLao" },
  Mymr: { family: "Noto Sans Myanmar", base: "NotoSansMyanmar" },
  Geor: { family: "Noto Sans Georgian", base: "NotoSansGeorgian" },
  Ethi: { family: "Noto Sans Ethiopic", base: "NotoSansEthiopic" },
  Khmr: { family: "Noto Sans Khmer", base: "NotoSansKhmer" },
  // CJK fonts are 10-16 MB each and are NOT vendored: captions in these
  // scripts are reported as unavailable until a font is installed here.
  Hang: { family: "Noto Sans KR", base: "NotoSansKR" },
  Kana: { family: "Noto Sans JP", base: "NotoSansJP" },
  Hani: { family: "Noto Sans SC", base: "NotoSansSC" },
};

/** Absolute path of a script's font file (null when not installed). */
export function fontFile(script, weight = 700) {
  const f = SCRIPT_FONTS[script];
  if (!f) return null;
  const file = path.join(FONT_DIR, `${f.base}-${weight >= 700 ? "Bold" : "Regular"}.ttf`);
  return fs.existsSync(file) ? file : null;
}

/** Which scripts appear in `text` → { Latn: 12, Deva: 30 } (letter counts). */
export function detectScripts(text) {
  const counts = {};
  for (const ch of String(text || "")) {
    const cp = ch.codePointAt(0);
    if (cp < 0x41) continue; // digits, punctuation, spaces, symbols
    for (const [script, ranges] of Object.entries(SCRIPT_RANGES)) {
      if (ranges.some(([a, b]) => cp >= a && cp <= b)) {
        counts[script] = (counts[script] || 0) + 1;
        break;
      }
    }
  }
  return counts;
}

/** Scripts in `text`, most frequent first. */
export function scriptsIn(text) {
  return Object.entries(detectScripts(text)).sort((a, b) => b[1] - a[1]).map(([s]) => s);
}

/** True when the text's dominant script is right-to-left. */
export function isRtlText(text) {
  const s = scriptsIn(text)[0];
  return Boolean(s && RTL_SCRIPTS.has(s));
}

// ---------------------------------------------------------------- cmap --

const cmapCache = new Map();

/** Read the codepoint ranges a TrueType/OpenType font maps (cmap 4 / 12). */
export function fontCodepointRanges(file) {
  if (cmapCache.has(file)) return cmapCache.get(file);
  let ranges = [];
  try {
    const buf = fs.readFileSync(file);
    const numTables = buf.readUInt16BE(4);
    let cmapOff = -1;
    for (let i = 0; i < numTables; i++) {
      const rec = 12 + i * 16;
      if (buf.toString("ascii", rec, rec + 4) === "cmap") { cmapOff = buf.readUInt32BE(rec + 8); break; }
    }
    if (cmapOff >= 0) {
      const n = buf.readUInt16BE(cmapOff + 2);
      const subs = [];
      for (let i = 0; i < n; i++) {
        const r = cmapOff + 4 + i * 8;
        subs.push({ pid: buf.readUInt16BE(r), eid: buf.readUInt16BE(r + 2), off: cmapOff + buf.readUInt32BE(r + 4) });
      }
      const pick = subs.find((s) => s.pid === 3 && s.eid === 10) || subs.find((s) => s.pid === 0 && s.eid >= 4)
        || subs.find((s) => s.pid === 3 && s.eid === 1) || subs.find((s) => s.pid === 0);
      if (pick) {
        const format = buf.readUInt16BE(pick.off);
        if (format === 12) {
          const groups = buf.readUInt32BE(pick.off + 12);
          for (let g = 0; g < groups; g++) {
            const o = pick.off + 16 + g * 12;
            ranges.push([buf.readUInt32BE(o), buf.readUInt32BE(o + 4)]);
          }
        } else if (format === 4) {
          const segX2 = buf.readUInt16BE(pick.off + 6);
          const ends = pick.off + 14;
          const starts = ends + segX2 + 2;
          for (let s = 0; s < segX2 / 2; s++) {
            const end = buf.readUInt16BE(ends + s * 2);
            const start = buf.readUInt16BE(starts + s * 2);
            if (start !== 0xffff) ranges.push([start, end]);
          }
        }
      }
    }
  } catch {
    ranges = [];
  }
  cmapCache.set(file, ranges);
  return ranges;
}

function covers(ranges, cp) {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b] = ranges[mid];
    if (cp < a) hi = mid - 1;
    else if (cp > b) lo = mid + 1;
    else return true;
  }
  return false;
}

const IGNORABLE = (cp) =>
  cp <= 0x20 || (cp >= 0x200b && cp <= 0x200f) || cp === 0x2060 || cp === 0xfeff || (cp >= 0xfe00 && cp <= 0xfe0f) ||
  (cp >= 0x1f000 && cp <= 0x1faff) || (cp >= 0x2600 && cp <= 0x27bf); // emoji are stripped before rendering

/**
 * Fonts the renderer will use for `text`: every detected script's vendored
 * font plus Noto Sans for Latin/digits/punctuation.
 */
export function fontsForText(text, weight = 700) {
  const scripts = scriptsIn(text);
  const order = [...scripts.filter((s) => s !== "Latn" && s !== "Cyrl" && s !== "Grek"), "Latn"];
  const out = [];
  for (const s of order) {
    const file = fontFile(s, weight);
    const family = SCRIPT_FONTS[s]?.family;
    if (file && family && !out.some((f) => f.family === family)) out.push({ script: s, family, file });
  }
  return out;
}

/**
 * Glyph coverage of `text` by the fonts that would render it.
 * @returns {{ ok: boolean, missing: string[], missingScripts: string[], fonts: string[] }}
 */
export function checkGlyphCoverage(text, weight = 700) {
  const fonts = fontsForText(text, weight);
  const rangeSets = fonts.map((f) => fontCodepointRanges(f.file));
  const missing = new Set();
  for (const ch of String(text || "")) {
    const cp = ch.codePointAt(0);
    if (IGNORABLE(cp)) continue;
    if (!rangeSets.some((r) => covers(r, cp))) missing.add(ch);
  }
  const missingScripts = scriptsIn([...missing].join("")).filter((s) => !fontFile(s, weight));
  return { ok: missing.size === 0, missing: [...missing].slice(0, 20), missingScripts, fonts: fonts.map((f) => f.family) };
}

/** Is a caption font installed for this script? */
export function hasFontForScript(script) {
  return Boolean(fontFile(script, 700) && fontFile(script, 400));
}
