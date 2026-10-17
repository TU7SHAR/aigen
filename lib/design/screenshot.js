/**
 * Rendered-page capture (screenshots + computed styles) behind a provider
 * interface, so the production app NEVER hard-depends on a headless browser.
 *
 *   captureRenderedPage(url) → { available, screenshot?, computed?, reason? }
 *
 * ────────────────────────────────────────────────────────────────────────
 * SECURITY STATUS — READ THIS. This is NOT production-safe as written.
 * ────────────────────────────────────────────────────────────────────────
 * Fetching an arbitrary user-supplied URL into a real browser is a serious
 * SSRF surface. The mitigations here (per-subrequest DNS-resolve + IP blocklist,
 * scheme allowlist, request/byte/time budgets) RAISE the bar but do NOT close
 * the hole, for two honest reasons:
 *
 *   1. DNS REBINDING: we resolve the host and check the IP, but Chromium does
 *      its OWN DNS resolution when it actually connects. A hostile DNS server
 *      can answer our lookup with a public IP and the browser's lookup with a
 *      private/metadata IP (TOCTOU). Application-level checks cannot fully
 *      prevent this.
 *   2. SANDBOX: Chromium is launched with `--no-sandbox` (required in many
 *      container hosts). A browser-renderer exploit is then not contained.
 *
 * The ONLY correct production posture is network-level isolation enforced at
 * the boundary, OUTSIDE this process — e.g. a dedicated egress proxy / firewall
 * that blocks RFC1918, loopback, link-local (169.254.0.0/16), ULA, and the
 * cloud metadata endpoint for the browser's traffic, or a managed isolated
 * browser service. See docs/SECURITY.md § "Rendered capture".
 *
 * Therefore this capability is GATED OFF by default and must stay off for any
 * public/multi-tenant deployment until that isolation exists. It is usable only
 * for local, operator-driven capture of trusted URLs.
 *
 * Providers:
 *   - PlaywrightProvider: used only when BOTH `ENABLE_RENDERED_CAPTURE=true`
 *     AND `ACKNOWLEDGE_CAPTURE_UNSAFE=true` are set AND playwright is installed
 *     and a browser launches. In-process best-effort mitigations as above.
 *   - NullProvider: otherwise returns { available:false } so callers fall back
 *     to HTML/CSS design extraction and screenshot-based assets are skipped
 *     (documented, not faked).
 *
 * This module is dynamically imported and tolerant of a missing dependency —
 * it must not break the build when `playwright` isn't installed.
 */

import dns from "node:dns/promises";
import net from "node:net";
import { assertSafeUrl, isBlockedIp } from "../crawl/safeFetch.js";
import { detectBlockedPage } from "../crawl/blockDetect.js";

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

  // SECOND GATE: this capability is NOT production-safe for untrusted URLs
  // (DNS rebinding + --no-sandbox; see the security banner at the top). Require
  // an explicit operator acknowledgement so it can never be enabled by the
  // capture flag alone in a public/multi-tenant deployment.
  if (process.env.ACKNOWLEDGE_CAPTURE_UNSAFE !== "true") {
    cachedProvider = nullProvider(
      "Rendered capture requires ACKNOWLEDGE_CAPTURE_UNSAFE=true (not production-safe for untrusted URLs; use only for local, operator-driven capture of trusted URLs — see docs/SECURITY.md)."
    );
    return cachedProvider;
  }

  // THIRD GATE (production): a public deployment must run the browser behind
  // enforced network isolation; the operator declares it explicitly.
  if (process.env.NODE_ENV === "production" && process.env.CAPTURE_NETWORK_ISOLATED !== "true") {
    cachedProvider = nullProvider(
      "Rendered capture is disabled in production until the capture browser runs behind enforced egress isolation (set CAPTURE_NETWORK_ISOLATED=true only when that exists)."
    );
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

const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

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
      // opts.mobile → a phone viewport (390x844 @2x) for vertical-ad screen footage.
      const viewport = opts.viewport || (opts.mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 });
      let browser;
      try {
        // NOTE: `--no-sandbox` is required to launch in many container hosts,
        // but it removes Chromium's own OS sandbox. This is exactly why this
        // provider is gated behind ACKNOWLEDGE_CAPTURE_UNSAFE and must only run
        // against trusted, operator-supplied URLs until network-level isolation
        // exists (see the security banner at the top of this file).
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
          ...(opts.mobile ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: MOBILE_UA } : {}),
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

        // Enforce the download budget on ACTUAL received bytes, not just the
        // Content-Length header (which can be absent or lie). We read each
        // finished response body's real length; Content-Length is only an
        // early-exit hint.
        ctx.on("response", async (resp) => {
          try {
            const hinted = Number(resp.headers()["content-length"] || 0);
            if (hinted > limits.maxTotalBytes) {
              aborted = "download_budget_exceeded";
              return;
            }
            const body = await resp.body().catch(() => null);
            if (body) {
              totalBytes += body.length;
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
        const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: opts.timeoutMs || 15_000 });
        await page.waitForTimeout(1200); // brief settle for hero content
        if (aborted) {
          clearTimeout(captureDeadline);
          return { available: true, ok: false, reason: aborted };
        }
        // A bot-block / access-denied / error page is NOT the website: never
        // store it as footage (H&M regression).
        const pageText = await page.evaluate(() => `${document.title}\n${(document.body?.innerText || "").slice(0, 6000)}`).catch(() => "");
        const blocked = detectBlockedPage({ status: response?.status?.() ?? 200, text: pageText });
        if (blocked.blocked) {
          clearTimeout(captureDeadline);
          return { available: true, ok: false, blocked: true, reason: `site blocked the capture (${blocked.reason})` };
        }

        let screenshot;
        if (opts.fullPage) {
          // Walk the page once so lazy-loaded sections render, then capture the
          // top N screens (capped) as one tall image the renderer can scroll.
          const maxH = Math.max(viewport.height, Math.min(opts.maxHeightPx || viewport.height * 4, 6000));
          const fullH = await page.evaluate(async (cap) => {
            const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
            for (let y = 0; y < cap; y += step) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 120)); }
            window.scrollTo(0, 0);
            await new Promise((r) => setTimeout(r, 300));
            return Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0);
          }, maxH);
          const h = Math.max(viewport.height, Math.min(fullH || viewport.height, maxH));
          screenshot = await page.screenshot({ type: "png", fullPage: true, clip: { x: 0, y: 0, width: viewport.width, height: h } });
        } else {
          screenshot = await page.screenshot({ type: "png", fullPage: false });
        }
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
