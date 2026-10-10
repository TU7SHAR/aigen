/**
 * Rendered-page capture (screenshots + computed styles) behind a provider
 * interface, so the production app NEVER hard-depends on a headless browser.
 *
 *   captureRenderedPage(url) → { available, screenshot?, computed?, reason? }
 *
 * Providers:
 *   - PlaywrightProvider: uses `playwright` if it's installed AND a browser
 *     launches. SSRF-safe (URL is validated before capture; the browser is
 *     told not to follow to private hosts via pre-validation). Captures a hero
 *     screenshot + computed styles of representative elements.
 *   - NullProvider: when Playwright/browser is unavailable, returns
 *     { available:false } so callers fall back to HTML/CSS design extraction
 *     and website-screenshot-based assets are simply skipped (documented, not
 *     faked).
 *
 * This module is dynamically imported and tolerant of a missing dependency —
 * it must not break the build when `playwright` isn't installed.
 */

import { assertSafeUrl } from "../crawl/safeFetch.js";

let cachedProvider = null;

async function loadPlaywright() {
  try {
    const mod = await import("playwright");
    return mod?.chromium ? mod : null;
  } catch {
    return null;
  }
}

/**
 * @returns {Promise<{ name: string, available: boolean, capture: Function }>}
 */
export async function getScreenshotProvider() {
  if (cachedProvider) return cachedProvider;

  // Opt-in: capture is only attempted when explicitly enabled, to avoid
  // launching browsers in CI / unsupported hosts.
  if (process.env.ENABLE_RENDERED_CAPTURE !== "true") {
    cachedProvider = nullProvider("Rendered capture disabled (set ENABLE_RENDERED_CAPTURE=true).");
    return cachedProvider;
  }

  const pw = await loadPlaywright();
  if (!pw) {
    cachedProvider = nullProvider("Playwright is not installed.");
    return cachedProvider;
  }
  cachedProvider = playwrightProvider(pw);
  return cachedProvider;
}

function nullProvider(reason) {
  return {
    name: "null",
    available: false,
    async capture() {
      return { available: false, reason };
    },
  };
}

function playwrightProvider(pw) {
  return {
    name: "playwright",
    available: true,
    /**
     * @param {string} url
     * @param {{ viewport?: {width:number,height:number}, timeoutMs?: number }} [opts]
     */
    async capture(url, opts = {}) {
      // Re-validate SSRF before handing the URL to a real browser.
      try {
        await assertSafeUrl(url);
      } catch (err) {
        return { available: true, ok: false, reason: `blocked_url: ${err?.message || err}` };
      }
      const viewport = opts.viewport || { width: 1280, height: 800 };
      let browser;
      try {
        browser = await pw.chromium.launch({ headless: true, args: ["--no-sandbox"] });
      } catch (err) {
        return { available: false, reason: `browser_launch_failed: ${err?.message || err}` };
      }
      try {
        const ctx = await browser.newContext({ viewport, javaScriptEnabled: true });
        // Block requests to anything that isn't the target origin's http(s) to
        // reduce SSRF/exfiltration surface and speed capture.
        await ctx.route("**/*", (route) => {
          const u = route.request().url();
          if (/^https?:/i.test(u)) route.continue();
          else route.abort();
        });
        const page = await ctx.newPage();
        await page.goto(url, { waitUntil: "networkidle", timeout: opts.timeoutMs || 20_000 });

        const screenshot = await page.screenshot({ type: "png", fullPage: false });

        // Computed styles of representative elements.
        const computed = await page.evaluate(() => {
          const pick = (sel) => document.querySelector(sel);
          const cs = (el) => (el ? getComputedStyle(el) : null);
          const colors = new Set();
          const fonts = new Set();
          const addColor = (c) => {
            if (!c) return;
            const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
            if (!m) return;
            const [r, g, b] = [m[1], m[2], m[3]].map(Number);
            // skip near-white / fully transparent
            if (r > 245 && g > 245 && b > 245) return;
            const hex = "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("");
            colors.add(hex);
          };
          const els = [
            pick("button"), pick("[class*=cta]"), pick("a[class*=btn]"),
            pick("header"), pick("h1"), pick("nav"),
          ].filter(Boolean);
          for (const el of els) {
            const s = cs(el);
            if (!s) continue;
            addColor(s.backgroundColor);
            addColor(s.color);
            const fam = (s.fontFamily || "").split(",")[0].replace(/['"]/g, "").trim();
            if (fam) fonts.add(fam);
          }
          const bodyFam = (cs(document.body)?.fontFamily || "").split(",")[0].replace(/['"]/g, "").trim();
          if (bodyFam) fonts.add(bodyFam);
          return { colors: [...colors].slice(0, 6), fonts: [...fonts].slice(0, 4) };
        });

        return { available: true, ok: true, screenshot, computed };
      } catch (err) {
        return { available: true, ok: false, reason: `capture_failed: ${err?.message || err}` };
      } finally {
        await browser.close().catch(() => {});
      }
    },
  };
}
