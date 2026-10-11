/**
 * Deterministic text rendering for the compositor.
 *
 * CRITICAL product rule: the generative video model must NEVER be trusted to
 * render brand names, website URLs, prices/offers or CTA copy — it hallucinates
 * them (invented "55% off", wrong domain, gibberish). ALL required readable copy
 * is rendered here, deterministically, by ffmpeg `drawtext`, from EXACT verified
 * values. If a value isn't verified/approved, it is simply not drawn.
 */

import path from "node:path";

const FONT_DIR = path.join(process.cwd(), "assets", "fonts");
export const FONT_REGULAR = path.join(FONT_DIR, "NotoSans-Regular.ttf");
export const FONT_BOLD = path.join(FONT_DIR, "NotoSans-Bold.ttf");

/**
 * Escape text for ffmpeg drawtext `text=` value. drawtext has its own escaping
 * on top of filtergraph escaping; the robust approach for arbitrary user text
 * is to use a textfile instead (see drawTextFileFilter). This escapes for the
 * inline form used by simple, controlled strings.
 */
export function escapeDrawtext(s) {
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/%/g, "\\%");
}

/** Sanitize a path for use inside a filtergraph (Windows backslashes, colons). */
export function escapeFilterPath(p) {
  // ffmpeg filtergraph: backslash and colon (drive letter) must be escaped.
  return String(p).replace(/\\/g, "/").replace(/:/g, "\\:");
}

/**
 * Build a drawtext filter that reads its text from a FILE (safest for arbitrary
 * copy — avoids all inline escaping pitfalls with punctuation/unicode).
 *
 * @param {{
 *   textfile: string, font?: string, fontsize: number, fontcolor?: string,
 *   x: string, y: string, box?: boolean, boxcolor?: string, boxborderw?: number,
 *   borderw?: number, bordercolor?: string, shadowx?: number, shadowy?: number,
 *   enable?: string, lineSpacing?: number, alpha?: string,
 * }} o
 * @returns {string} a single drawtext filter string
 */
export function drawTextFileFilter(o) {
  const parts = [
    `drawtext=fontfile='${escapeFilterPath(o.font || FONT_REGULAR)}'`,
    `textfile='${escapeFilterPath(o.textfile)}'`,
    `fontsize=${o.fontsize}`,
    `fontcolor=${o.fontcolor || "white"}`,
    `x=${o.x}`,
    `y=${o.y}`,
    `expansion=none`,
  ];
  if (o.lineSpacing != null) parts.push(`line_spacing=${o.lineSpacing}`);
  if (o.box) {
    parts.push(`box=1`, `boxcolor=${o.boxcolor || "black@0.55"}`, `boxborderw=${o.boxborderw ?? 24}`);
  }
  if (o.borderw) parts.push(`borderw=${o.borderw}`, `bordercolor=${o.bordercolor || "black@0.8"}`);
  if (o.shadowx != null) parts.push(`shadowx=${o.shadowx}`, `shadowy=${o.shadowy ?? o.shadowx}`, `shadowcolor=black@0.6`);
  if (o.alpha) parts.push(`alpha='${o.alpha}'`);
  if (o.enable) parts.push(`enable='${o.enable}'`);
  return parts.join(":");
}

/**
 * Word-wrap a string to a max character width (rough; drawtext has no auto-wrap
 * for textfiles). Returns the wrapped multi-line string.
 */
export function wrapText(text, maxChars = 28) {
  const words = String(text || "").trim().split(/\s+/);
  const lines = [];
  let cur = "";
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + " " + w).length <= maxChars) cur += " " + w;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines.join("\n");
}
