/**
 * Mock image provider — generates a GENUINE branded keyframe with NO API cost.
 *
 * This is the whole point of the keyframe path even before any paid provider is
 * wired: a shot the Director marked `ai_image` must become an actual VISUAL, not
 * a flat black card. We render a real composition deterministically via sharp/
 * SVG — a brand-colored gradient field, a soft radial light, a geometric motif
 * and a large focal typographic element — so the finished ad has visible,
 * on-brand imagery with motion to animate, at zero spend.
 *
 * It is flagged `mock: true`: it is NOT a photoreal model generation and callers
 * MUST surface that. But it is a real, non-empty image — not a placeholder.
 */

import crypto from "node:crypto";
import sharp from "sharp";
import path from "node:path";
import { promises as fs } from "node:fs";

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
    ${bold ? `@font-face{font-family:'AdSans';font-weight:700;src:url(data:font/ttf;base64,${bold}) format('truetype');}` : ""}`;
  return _fontCache;
}

function normHex(h, fb) {
  const m = String(h || "").trim().match(/^#?([0-9a-fA-F]{6})$/);
  return m ? `#${m[1].toLowerCase()}` : fb;
}
/** Darken/lighten a hex by a factor (−1..1). */
function shade(hex, f) {
  const h = normHex(hex, "#1a1d24").slice(1);
  const n = parseInt(h, 16);
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const t = f < 0 ? 0 : 255, k = Math.abs(f);
  r = clamp(r + (t - r) * k); g = clamp(g + (t - g) * k); b = clamp(b + (t - b) * k);
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}
/** Deterministic 0..1 from a string + salt (stable keyframes per shot). */
function hash01(s, salt = 0) {
  const d = crypto.createHash("sha256").update(`${s}:${salt}`).digest();
  return d.readUInt32BE(0) / 0xffffffff;
}

function wrap(_text, _maxChars) {
  return []; // keyframes leave all copy to the overlay layer (no baked text)
}

/**
 * Compose a branded keyframe SVG → PNG at the requested frame size.
 * @param {object} req see ImageProvider contract
 */
async function renderKeyframe(req) {
  const W = Math.max(64, Math.round(req.width || 720));
  const H = Math.max(64, Math.round(req.height || 1280));
  const faces = await fontFaces();
  const seedStr = `${req.prompt || ""}|${req.subjectText || ""}|${req.brand?.name || ""}`;
  const brandColors = Array.isArray(req.brand?.colors) ? req.brand.colors : [];
  const c1 = normHex(brandColors[0], "#2b2f6e");
  const c2 = normHex(brandColors[1], shade(c1, 0.25));
  const accent = normHex(brandColors[1] || brandColors[0], "#ff5a24");

  // Gradient angle + light position vary deterministically per shot so distinct
  // ai_image shots look distinct (not one repeated frame).
  const ang = Math.round(hash01(seedStr, 1) * 120 + 20);
  const lx = Math.round((0.3 + hash01(seedStr, 2) * 0.4) * 100);
  const ly = Math.round((0.2 + hash01(seedStr, 3) * 0.35) * 100);

  // Focal copy is NOT baked into the keyframe — the compositor overlays the
  // exact on-screen text as its own layer, so baking it here would double it.
  // The keyframe is a pure VISUAL background (gradient + light + motif). We DO
  // vary the composition by the shot's subject/prompt so distinct shots differ.

  // Geometric motif: a few soft shapes in brand/accent, deterministic placement.
  const shapes = [];
  for (let i = 0; i < 5; i++) {
    const r = Math.round((0.1 + hash01(seedStr, 10 + i) * 0.26) * Math.min(W, H));
    const cx = Math.round(hash01(seedStr, 20 + i) * W);
    const cy = Math.round(hash01(seedStr, 30 + i) * H);
    const fill = i % 2 === 0 ? accent : shade(c1, 0.4);
    shapes.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" opacity="0.12"/>`);
  }
  // A diagonal accent bar for structure.
  const barY = Math.round(H * (0.6 + hash01(seedStr, 5) * 0.1));

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs>
      <linearGradient id="g" gradientTransform="rotate(${ang})">
        <stop offset="0%" stop-color="${c1}"/>
        <stop offset="100%" stop-color="${shade(c2, -0.35)}"/>
      </linearGradient>
      <radialGradient id="light" cx="${lx}%" cy="${ly}%" r="75%">
        <stop offset="0%" stop-color="${shade(c1, 0.45)}" stop-opacity="0.6"/>
        <stop offset="100%" stop-color="${c1}" stop-opacity="0"/>
      </radialGradient>
      <style>${faces} text{font-family:'AdSans',sans-serif;}</style>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#g)"/>
    ${shapes.join("")}
    <rect width="${W}" height="${H}" fill="url(#light)"/>
    <rect x="0" y="${barY}" width="${W}" height="${Math.round(H * 0.012)}" fill="${accent}" opacity="0.85"/>
  </svg>`;

  const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
  const meta = await sharp(buffer).metadata();
  return { buffer, width: meta.width, height: meta.height };
}

export function createMockImageProvider() {
  return {
    name: "mock",
    /** @param {object} request see ImageProvider contract */
    async generateKeyframe(request) {
      const { buffer, width, height } = await renderKeyframe(request);
      return {
        imageBase64: buffer.toString("base64"),
        mimeType: "image/png",
        width,
        height,
        provider: "mock",
        model: "mock-keyframe",
        cost: { amountUsd: 0, state: "estimated" },
        mock: true,
      };
    },
  };
}

export const _internal = { renderKeyframe, shade, hash01, wrap };
