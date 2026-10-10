/**
 * Rendered-page capture (screenshots + computed styles) behind a provider
 * interface, so the production app NEVER hard-depends on a headless browser.
 *
 *   captureRenderedPage(url) → { available, screenshot?, computed?, reason? }
 *
 * Providers:
 *   - PlaywrightProvider: uses `playwright` if it's installed AND a browser
 *     launches. SSRF-hardened: the initial URL is validated AND every browser
 *     subrequest is checked (host resolved → private/loopback/link-local/
 *     metadata IPs blocked), non-http(s) blocked, request-count + download-byte
 *     budgets enforced, and a hard capture-duration cap. Captures a hero
 *     screenshot + computed styles of representative elements.
 *   - NullProvider: when Playwright/browser is unavailable, returns
 *     { available:false } so callers fall back to HTML/CSS design extraction
 *     and website-screenshot-based assets are simply skipped (documented, not
 *     faked).
 *
 * This module is dynamically imported and tolerant of a missing dependency —
 * it must not break the build when `playwright` isn't installed.
 */

import dns from "node:dns/promises";
import net from "node:net";
import { assertSafeUrl, isBlockedIp } from "../crawl/safeFetch.js";

let cachedProvider = null;

/**
 * Is a subrequest URL safe to load inside the capture browser? Resolves the
 * host (DNS) and blocks any that maps to a private/loopback/link-local/metadata
 * address — the real SSRF/DNS-rebinding boundary (a URL regex is not enough).
 * Results are briefly cached to avoid re-resolving the same host per asset.
 */
const _hostCache = new Map();
async function isSubrequestAllowed(rawUrl) {
  let host;
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    host = u.hostname;
  } catch {
    return false;
  }
  if (/^(localhost|localhost\.localdomain)$/i.test(host)) return false;
  if (net.isIP(host)) return !isBlockedIp(host);

  const cached = _hostCache.get(host);
  if (cached !== undefined) return cached;
  let allowed = false;
  try {
    const addrs = await dns.lookup(host, { all: true });
    allowed = addrs.length > 0 && addrs.every((a) => !isBlockedIp(a.address));
  } catch {
    allowed = false;
  }
  _hostCache.set(host, allowed);
  return allowed;
}

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
      const limits = {
        maxRequests: 150,
        maxTotalBytes: 25 * 1024 * 1024, // 25 MB total download budget
        maxCaptureMs: opts.maxCaptureMs || 30_000,
      };
      let requestCount = 0;
      let totalBytes = 0;
      let aborted = null;

      try {
        const ctx = await browser.newContext({
          viewport,
          javaScriptEnabled: true,
          // Deny implicit downloads.
          acceptDownloads: false,
        });

        // SECURITY: validate EVERY subrequest destination, not just the first
        // page URL. A URL regex is not a boundary — we resolve the host and
        // block private / loopback / link-local / metadata IPs (reusing the
        // crawler's SSRF checks), block non-http(s) schemes, and enforce
        // request-count + byte budgets to bound SSRF, DNS-rebinding and
        // resource-exhaustion risk.
        await ctx.route("**/*", async (route) => {
          const req = route.request();
          const u = req.url();
          if (!/^https?:/i.test(u)) return route.abort("blockedbyclient");
          if (++requestCount > limits.maxRequests) {
            aborted = "too_many_requests";
            return route.abort("blockedbyclient");
          }
          const ok = await isSubrequestAllowed(u);
          if (!ok) return route.abort("blockedbyclient");
          return route.continue();
        });

        // Track response sizes to enforce the download budget.
        ctx.on("response", async (resp) => {
          try {
            const len = Number(resp.headers()["content-length"] || 0);
            if (len) {
              totalBytes += len;
              if (totalBytes > limits.maxTotalBytes) aborted = "download_budget_exceeded";
            }
          } catch {
            /* ignore */
          }
        });

        const page = await ctx.newPage();

        // Hard overall capture-duration cap (independent of goto timeout).
        const captureDeadline = setTimeout(() => {
          aborted = aborted || "capture_timeout";
          page.close().catch(() => {});
        }, limits.maxCaptureMs);

        // Wait for DOM content, not endless network idle (sites with trackers
        // never go idle). "domcontentloaded" + a short settle is safer/faster.
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: opts.timeoutMs || 15_000 });
        await page.waitForTimeout(1200); // brief settle for hero content
        if (aborted) {
          clearTimeout(captureDeadline);
          return { available: true, ok: false, reason: aborted };
        }

        const screenshot = await page.screenshot({ type: "png", fullPage: false });
        clearTimeout(captureDeadline);

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
