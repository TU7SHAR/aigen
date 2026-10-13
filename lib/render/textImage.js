/**
 * Deterministic text → PNG renderer (via sharp/SVG).
 *
 * We render required ad copy (brand, headline, offer, URL, CTA) to transparent
 * PNGs and composite them with ffmpeg's `overlay` filter. This avoids depending
 * on ffmpeg being built with `drawtext`/libfreetype (the bundled static build
 * is not), and gives crisp, fully-controlled typography using a vendored font.
 *
 * The generative video model never renders this copy — these are exact,
 * verified strings rasterized deterministically.
 */

import path from "node:path";
import { promises as fs } from "node:fs";
import sharp from "sharp";

const FONT_DIR = path.join(process.cwd(), "assets", "fonts");

let _fontCache = null;
async function fontFaces() {
  if (_fontCache) return _fontCache;
  const [reg, bold] = await Promise.all([
    fs.readFile(path.join(FONT_DIR, "NotoSans-Regular.ttf")).then((b) => b.toString("base64")).catch(() => null),
    fs.readFile(path.join(FONT_DIR, "NotoSans-Bold.ttf")).then((b) => b.toString("base64")).catch(() => null),
  ]);
  _fontCache = `
    ${reg ? `@font-face{font-family:'AdSans';font-weight:400;src:url(data:font/ttf;base64,${reg}) format('truetype');}` : ""}
    ${bold ? `@font-face{font-family:'AdSans';font-weight:700;src:url(data:font/ttf;base64,${bold}) format('truetype');}` : ""}
  `;
  return _fontCache;
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Rough word-wrap by character budget (SVG has no auto-wrap). */
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

/**
 * Render a text block to a transparent PNG buffer.
 * @param {{
 *   text: string, width: number, fontSize: number, weight?: 400|700,
 *   color?: string, align?: "left"|"center", maxChars?: number,
 *   bg?: string|null, padX?: number, padY?: number, radius?: number,
 *   stroke?: string, strokeWidth?: number,
 * }} o
 * @returns {Promise<{ buffer: Buffer, width: number, height: number }>}
 */
export async function renderTextPng(o) {
  const faces = await fontFaces();
  const weight = o.weight || 400;
  const color = o.color || "#ffffff";
  const align = o.align || "center";
  const maxChars = o.maxChars || Math.max(8, Math.floor(o.width / (o.fontSize * 0.58)));
  const lines = wrap(o.text, maxChars);
  const lineH = Math.round(o.fontSize * 1.28);
  const padX = o.padX ?? Math.round(o.fontSize * 0.5);
  const padY = o.padY ?? Math.round(o.fontSize * 0.35);

  // Longest line → approximate text width to size the box.
  const longest = lines.reduce((m, l) => Math.max(m, l.length), 0);
  const textW = Math.min(o.width, Math.ceil(longest * o.fontSize * 0.6) + padX * 2);
  const boxW = o.bg ? textW : o.width;
  const boxH = lines.length * lineH + padY * 2;

  const anchorX = align === "left" ? padX : boxW / 2;
  const textAnchor = align === "left" ? "start" : "middle";

  const tspans = lines
    .map((l, i) => `<tspan x="${anchorX}" dy="${i === 0 ? lineH * 0.8 + padY : lineH}">${esc(l)}</tspan>`)
    .join("");

  const bgRect = o.bg
    ? `<rect x="0" y="0" width="${boxW}" height="${boxH}" rx="${o.radius ?? 12}" fill="${o.bg}"/>`
    : "";
  const strokeAttr = o.stroke
    ? `stroke="${o.stroke}" stroke-width="${o.strokeWidth ?? 2}" paint-order="stroke"`
    : "";

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${boxW}" height="${boxH}">
    <style>${faces} text{font-family:'AdSans',sans-serif;}</style>
    ${bgRect}
    <text x="${anchorX}" y="0" font-size="${o.fontSize}" font-weight="${weight}"
          fill="${color}" ${strokeAttr} text-anchor="${textAnchor}">${tspans}</text>
  </svg>`;

  const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
  const meta = await sharp(buffer).metadata();
  return { buffer, width: meta.width, height: meta.height };
}

export const _internal = { wrap, esc };
