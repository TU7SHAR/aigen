/**
 * Deterministic text → PNG renderer.
 *
 * Ad copy (brand, captions, offer, URL, CTA) is rasterized to transparent PNGs
 * and composited with ffmpeg's `overlay` filter. The model never draws copy.
 *
 * Glyphs are rendered by libvips/Pango (`sharp({ text })`) with an explicit
 * `fontfile`, so the vendored Noto Sans is ALWAYS used. (The previous SVG
 * `@font-face` approach is ignored by librsvg, which silently fell back to a
 * system monospace font — the "cheap typewriter captions" defect.)
 *
 * Readability over footage comes from a soft drop shadow (default) or an
 * optional filled box / pill (CTA, URL).
 */

import path from "node:path";
import sharp from "sharp";

const FONT_DIR = path.join(process.cwd(), "assets", "fonts");
const FONTS = {
  400: { file: path.join(FONT_DIR, "NotoSans-Regular.ttf"), name: "Noto Sans" },
  700: { file: path.join(FONT_DIR, "NotoSans-Bold.ttf"), name: "Noto Sans Bold" },
};

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Rough word-wrap by character budget (kept for callers/tests that use it). */
function wrap(text, maxChars) {
  const words = String(text || "").trim().split(/\s+/);
  const lines = [];
  let cur = "";
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + " " + w).length <= maxChars) cur += " " + w;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** "#rgb"/"#rrggbb"/"rgba(r,g,b,a)" → { hex:"#rrggbb", alpha:0..1 } (null if unparseable). */
function parseColor(c) {
  if (!c) return null;
  const s = String(c).trim();
  let m = s.match(/^#?([0-9a-f]{6})$/i);
  if (m) return { hex: `#${m[1].toLowerCase()}`, alpha: 1 };
  m = s.match(/^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  if (m) return { hex: `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`.toLowerCase(), alpha: 1 };
  m = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i);
  if (m) {
    const h = (n) => Math.max(0, Math.min(255, Number(n))).toString(16).padStart(2, "0");
    return { hex: `#${h(m[1])}${h(m[2])}${h(m[3])}`, alpha: m[4] == null ? 1 : Math.max(0, Math.min(1, Number(m[4]))) };
  }
  return null;
}

/** Render just the glyphs (tight bbox, transparent) with the vendored font. */
async function renderGlyphs({ text, fontSize, weight, color, maxWidth, align }) {
  const font = FONTS[weight >= 700 ? 700 : 400];
  const fg = parseColor(color)?.hex || "#ffffff";
  const { data, info } = await sharp({
    text: {
      text: `<span foreground="${fg}">${esc(text)}</span>`,
      font: `${font.name} ${Math.max(6, Math.round(fontSize))}`,
      fontfile: font.file,
      width: Math.max(16, Math.round(maxWidth)),
      dpi: 72, // 1pt == 1px, so fontSize is in pixels
      rgba: true,
      align: align === "left" ? "left" : "centre",
      wrap: "word",
    },
  }).png().toBuffer({ resolveWithObject: true });
  return { buffer: data, width: info.width, height: info.height };
}

/**
 * Render a text block to a transparent PNG buffer.
 * @param {{
 *   text: string, width: number, fontSize: number, weight?: 400|700,
 *   color?: string, align?: "left"|"center",
 *   bg?: string|null, padX?: number, padY?: number, radius?: number,
 *   shadow?: boolean, stroke?: string, strokeWidth?: number,
 * }} o  `width` is the maximum block width; the PNG is tight to the content.
 *        `stroke` is accepted for back-compat and treated as a shadow request.
 * @returns {Promise<{ buffer: Buffer, width: number, height: number }>}
 */
export async function renderTextPng(o) {
  const weight = o.weight || 400;
  const align = o.align === "left" ? "left" : "center";
  const bg = parseColor(o.bg);
  const padX = bg ? (o.padX ?? Math.round(o.fontSize * 0.75)) : 0;
  const padY = bg ? (o.padY ?? Math.round(o.fontSize * 0.42)) : 0;
  const glyphs = await renderGlyphs({
    text: o.text, fontSize: o.fontSize, weight, color: o.color || "#ffffff",
    maxWidth: Math.max(16, (o.width || 600) - padX * 2), align,
  });

  // Filled box / pill behind the glyphs.
  if (bg) {
    const W = glyphs.width + padX * 2;
    const H = glyphs.height + padY * 2;
    const r = Math.min(Math.round(H / 2), o.radius ?? 12);
    const rect = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
      `<rect x="0" y="0" width="${W}" height="${H}" rx="${r}" ry="${r}" fill="${bg.hex}" fill-opacity="${bg.alpha}"/></svg>`
    );
    const buffer = await sharp(rect)
      .composite([{ input: glyphs.buffer, left: padX, top: padY }])
      .png().toBuffer();
    return { buffer, width: W, height: H };
  }

  // Soft drop shadow (default for captions over footage).
  if (o.shadow === false) return glyphs;
  const sigma = Math.max(1.5, o.fontSize * 0.09);
  const pad = Math.ceil(sigma * 3) + 2;
  const dy = Math.max(1, Math.round(o.fontSize * 0.05));
  const black = await sharp(glyphs.buffer)
    .composite([{ input: { create: { width: glyphs.width, height: glyphs.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } }, blend: "in" }])
    .png().toBuffer();
  const shadow = await sharp(black)
    .extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .blur(sigma)
    .png().toBuffer();
  const W = glyphs.width + pad * 2;
  const H = glyphs.height + pad * 2;
  const buffer = await sharp(shadow)
    .composite([
      { input: shadow, left: 0, top: 0 },          // double pass = denser shadow
      { input: glyphs.buffer, left: pad, top: Math.max(0, pad - dy) },
    ])
    .png().toBuffer();
  return { buffer, width: W, height: H };
}

export const _internal = { wrap, esc, parseColor };
