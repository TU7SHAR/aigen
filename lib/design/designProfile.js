/**
 * DesignProfile — structured, evidence-based visual identity.
 *
 * Two sources, clearly separated by provenance:
 *   - "html_css": deterministic signals from the page source (theme-color,
 *     CSS custom properties, CTA/button colors, font-family declarations,
 *     border-radius hints). Works with NO browser.
 *   - "rendered": computed styles + a screenshot from a headless browser (via
 *     lib/design/screenshot.js), when a renderer is available. Richer, but
 *     optional — the production app must not DEPEND on a browser existing.
 *
 * Every meaningful claim is traceable to evidence or marked inferred. If a site
 * has no recognizable palette, we DO NOT invent one and claim detection.
 */

import * as cheerio from "cheerio";

const NEAR_WHITE = /^#(f{3}|f{6}|fff(fff)?)$/i;
const NEAR_BLACK = /^#(0{3}|0{6})$/i;

/** @typedef {{ palette, typography, shapes, motifs, visualPersonality, references, evidence, confidence }} DesignProfile */

/**
 * Deterministic extraction from HTML/CSS (no browser). Reuses the same
 * intentional-color heuristic as brand.js but produces the richer DesignProfile
 * shape and keeps evidence.
 * @param {string} html
 * @param {string} pageUrl
 * @returns {DesignProfile}
 */
export function extractDesignFromHtml(html, pageUrl) {
  const $ = cheerio.load(html);
  const evidence = [];
  const colorVotes = new Map();
  const fonts = new Set();
  const radii = new Set();

  const voteColor = (hex, weight, src) => {
    const norm = normalizeHex(hex);
    if (!norm || NEAR_WHITE.test(norm)) return;
    colorVotes.set(norm, (colorVotes.get(norm) || 0) + weight);
    if (!evidence.some((e) => e.kind === src)) evidence.push({ kind: src, origin: "html_css" });
  };

  // theme-color (intentional)
  const theme = $('meta[name="theme-color"]').attr("content");
  if (theme) voteColor(theme, 4, "meta_theme_color");

  // inline <style>: CSS variables (design tokens), font-family, radius
  $("style").each((_, el) => {
    const css = $(el).contents().text() || "";
    (css.match(/--[\w-]*(?:color|brand|primary|accent|theme)[\w-]*\s*:\s*(#[0-9a-fA-F]{3,8}|rgb[^;]+)/gi) || [])
      .forEach((m) => voteColor(cssColorToHex(m.split(":")[1]), 3, "css_variable"));
    (css.match(/font-family\s*:\s*([^;}]+)/gi) || []).forEach((m) => {
      const fam = m.split(":")[1]?.split(",")[0]?.replace(/['"]/g, "").trim();
      if (fam && fam.length < 40 && !/inherit|initial|unset|sans-serif|serif|monospace/i.test(fam)) fonts.add(fam);
    });
    (css.match(/border-radius\s*:\s*([\d.]+)(px|rem)/gi) || []).forEach((m) => {
      const v = m.match(/([\d.]+)(px|rem)/i);
      if (v) radii.add(v[0]);
    });
  });

  // prominent CTA / button inline colors
  $('[style*="background"], button, .btn, .button, [class*="cta"]').each((_, el) => {
    const style = $(el).attr("style") || "";
    const m = style.match(/background(?:-color)?\s*:\s*(#[0-9a-fA-F]{3,8}|rgb[^;]+)/i);
    if (m) voteColor(cssColorToHex(m[1]), 2, "cta_button_color");
  });

  // link to webfonts (typography signal)
  $('link[href*="fonts.googleapis"], link[href*="fonts."], link[rel="preconnect"][href*="font"]').each((_, el) => {
    const href = $(el).attr("href") || "";
    const fam = href.match(/family=([^&:]+)/i);
    if (fam) fonts.add(decodeURIComponent(fam[1]).replace(/\+/g, " "));
  });

  const colors = [...colorVotes.entries()].sort((a, b) => b[1] - a[1]).map(([hex]) => hex);
  const primary = colors.filter((c) => !NEAR_BLACK.test(c)).slice(0, 2);
  const accent = colors.slice(primary.length, primary.length + 2);

  const confidence = Number(
    Math.min(0.9, (colors.length ? 0.3 : 0) + colors.length * 0.1 + (fonts.size ? 0.15 : 0)).toFixed(2)
  );

  return {
    palette: {
      primary,
      accent,
      all: colors.slice(0, 6),
      detected: colors.length > 0,
    },
    typography: {
      families: [...fonts].slice(0, 4),
      detected: fonts.size > 0,
    },
    shapes: { borderRadii: [...radii].slice(0, 4) },
    motifs: [],
    visualPersonality: [], // filled by AI enrichment only; never fabricated here
    references: [],
    evidence,
    source: "html_css",
    confidence,
  };
}

/**
 * Merge a rendered-browser design observation (computed styles) into an
 * HTML/CSS DesignProfile. Rendered evidence outranks HTML guesses.
 * @param {DesignProfile} base
 * @param {object|null} rendered  output of screenshot.js computed-style capture
 */
export function mergeRenderedDesign(base, rendered) {
  if (!rendered) return base;
  const palette = { ...base.palette };
  if (rendered.colors?.length) {
    const merged = [...new Set([...(rendered.colors || []), ...base.palette.all])].slice(0, 6);
    palette.all = merged;
    palette.primary = merged.slice(0, 2);
    palette.accent = merged.slice(2, 4);
    palette.detected = true;
  }
  return {
    ...base,
    palette,
    typography: {
      families: [...new Set([...(rendered.fonts || []), ...base.typography.families])].slice(0, 4),
      detected: base.typography.detected || Boolean(rendered.fonts?.length),
    },
    references: rendered.screenshotUrl ? [{ kind: "rendered_screenshot", url: rendered.screenshotUrl }] : base.references,
    evidence: [...base.evidence, { kind: "computed_styles", origin: "rendered" }],
    source: "html_css+rendered",
    confidence: Math.min(0.95, base.confidence + 0.2),
  };
}

// ---- helpers ----
function normalizeHex(hex) {
  if (!hex) return null;
  let h = hex.trim().toLowerCase();
  if (!h.startsWith("#")) h = "#" + h;
  if (/^#[0-9a-f]{3}$/.test(h)) h = "#" + h.slice(1).split("").map((c) => c + c).join("");
  return /^#[0-9a-f]{6}$/.test(h) ? h : null;
}
function cssColorToHex(c) {
  if (!c) return null;
  c = c.trim();
  if (c.startsWith("#")) return c;
  const m = c.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
  if (m) {
    const to2 = (n) => Number(n).toString(16).padStart(2, "0");
    return "#" + to2(m[1]) + to2(m[2]) + to2(m[3]);
  }
  return null;
}
