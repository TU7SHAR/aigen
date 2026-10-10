/**
 * Deterministic brand-signal extraction from a product page.
 *
 * We extract EVIDENCE only (colors from CSS/theme hints, logo candidate,
 * tagline, site name). Interpretive brand attributes (style/tone) are left to
 * the AI step and clearly marked as inference — never fabricated here.
 *
 * Color detection deliberately avoids "most common pixel" approaches (which a
 * big white background would dominate). Instead we read intentional sources:
 * CSS custom properties / theme-color meta / inline brand/button colors, and
 * ignore near-white and near-black-text defaults unless they recur.
 */

import * as cheerio from "cheerio";

const NEAR_WHITE = /^#?(f{3,6}|f[0-9a-f]f[0-9a-f]f[0-9a-f])$/i;

export function extractBrandSignals(html, pageUrl) {
  const $ = cheerio.load(html);
  const evidence = [];
  const colorVotes = new Map();

  const voteColor = (hex, weight, src) => {
    const norm = normalizeHex(hex);
    if (!norm) return;
    if (NEAR_WHITE.test(norm)) return; // ignore white backgrounds
    colorVotes.set(norm, (colorVotes.get(norm) || 0) + weight);
    if (!evidence.includes(src)) evidence.push(src);
  };

  // theme-color meta (intentional brand color)
  const theme = $('meta[name="theme-color"]').attr("content");
  if (theme) voteColor(theme, 4, "meta[theme-color]");

  // CSS custom properties in inline <style> (design tokens)
  $("style").each((_, el) => {
    const css = $(el).contents().text() || "";
    const varMatches = css.match(/--[\w-]*(?:color|brand|primary|accent|theme)[\w-]*\s*:\s*(#[0-9a-fA-F]{3,8}|rgb[^;]+)/gi) || [];
    for (const m of varMatches) {
      const c = m.split(":")[1]?.trim();
      voteColor(cssColorToHex(c), 3, "css-variable");
    }
  });

  // inline styles on prominent elements (buttons/CTA/header)
  $('[style*="background"], button, .btn, .button, [class*="cta"]').each((_, el) => {
    const style = $(el).attr("style") || "";
    const m = style.match(/background(?:-color)?\s*:\s*(#[0-9a-fA-F]{3,8}|rgb[^;]+)/i);
    if (m) voteColor(cssColorToHex(m[1]), 2, "cta/button-color");
  });

  const colors = [...colorVotes.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([hex, votes]) => ({ hex, votes }));

  // logo candidate
  let logo = null;
  const logoEl = $('img[alt*="logo" i], img[class*="logo" i], .logo img, header img, [class*="brand"] img').first();
  if (logoEl.length) {
    const src = logoEl.attr("src") || logoEl.attr("data-src");
    if (src) logo = absUrl(src, pageUrl);
  }

  // site name / tagline
  const siteName = $('meta[property="og:site_name"]').attr("content") || null;
  const tagline =
    $('meta[name="description"]').attr("content")?.slice(0, 140) ||
    $(".tagline, .site-tagline, [class*='tagline']").first().text().trim() ||
    null;

  return {
    name: siteName,
    tagline,
    logo,
    colors, // [{hex, votes}]
    primaryColors: colors.slice(0, 2).map((c) => c.hex),
    secondaryColors: colors.slice(2, 4).map((c) => c.hex),
    sourceEvidence: evidence,
    // confidence scales with how much intentional evidence we found
    confidence: Number(Math.min(0.95, 0.2 + colors.length * 0.15 + (logo ? 0.2 : 0)).toFixed(2)),
  };
}

function normalizeHex(hex) {
  if (!hex) return null;
  let h = hex.trim().toLowerCase();
  if (!h.startsWith("#")) h = "#" + h;
  if (/^#[0-9a-f]{3}$/.test(h)) {
    h = "#" + h.slice(1).split("").map((c) => c + c).join("");
  }
  if (/^#[0-9a-f]{6}$/.test(h)) return h;
  return null;
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

function absUrl(href, base) {
  try {
    return new URL(href, base).href;
  } catch {
    return href;
  }
}
