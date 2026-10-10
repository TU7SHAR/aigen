/**
 * SSRF-safe HTTP(S) fetch for the crawler.
 *
 * Protections (see docs/SECURITY.md):
 *  - only http/https schemes
 *  - reject hostnames that resolve to loopback / private / link-local / CGNAT /
 *    unique-local / metadata (169.254.169.254) ranges — checked by RESOLVING
 *    DNS, not just string matching, so `foo.example.com -> 127.0.0.1` is blocked
 *  - manual redirect handling: every hop is re-validated; capped count
 *  - response size cap (streamed, aborts if exceeded)
 *  - request timeout
 *
 * This runs server-side only.
 */

import dns from "node:dns/promises";
import net from "node:net";

export class CrawlError extends Error {
  constructor(message, code = "CRAWL_ERROR") {
    super(message);
    this.name = "CrawlError";
    this.code = code;
  }
}

const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024; // 4 MB
const MAX_REDIRECTS = 4;

/**
 * Is this IP address in a blocked (private/internal) range?
 * @param {string} ip
 * @returns {boolean}
 */
export function isBlockedIp(ip) {
  const type = net.isIP(ip);
  if (type === 4) {
    const o = ip.split(".").map(Number);
    if (o[0] === 10) return true; // 10.0.0.0/8
    if (o[0] === 127) return true; // loopback
    if (o[0] === 0) return true; // 0.0.0.0/8
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true; // 172.16/12
    if (o[0] === 192 && o[1] === 168) return true; // 192.168/16
    if (o[0] === 169 && o[1] === 254) return true; // link-local + metadata
    if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true; // CGNAT 100.64/10
    if (o[0] >= 224) return true; // multicast / reserved
    return false;
  }
  if (type === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true; // loopback / unspecified
    if (lower.startsWith("fe80")) return true; // link-local
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique-local
    if (lower.startsWith("ff")) return true; // multicast
    // IPv4-mapped (::ffff:a.b.c.d) — extract and re-check
    const m = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isBlockedIp(m[1]);
    return false;
  }
  return true; // not a valid IP → block
}

/**
 * Validate a URL string: scheme + resolve host and ensure no address is blocked.
 * @param {string} rawUrl
 * @returns {Promise<URL>}
 */
export async function assertSafeUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new CrawlError("Invalid URL.", "INVALID_URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CrawlError(
      `Unsupported scheme "${url.protocol}". Only http/https are allowed.`,
      "UNSUPPORTED_SCHEME"
    );
  }
  const host = url.hostname;

  // Reject obvious literal localhost names up front.
  if (/^(localhost|localhost\.localdomain)$/i.test(host)) {
    throw new CrawlError("Refusing to fetch localhost.", "BLOCKED_HOST");
  }

  // If host is a literal IP, check it directly.
  if (net.isIP(host)) {
    if (isBlockedIp(host)) {
      throw new CrawlError("Refusing to fetch a private/internal IP.", "BLOCKED_IP");
    }
    return url;
  }

  // Otherwise resolve DNS and check every resolved address.
  let addresses;
  try {
    addresses = await dns.lookup(host, { all: true });
  } catch {
    throw new CrawlError(`Could not resolve host "${host}".`, "DNS_FAILURE");
  }
  if (!addresses.length) {
    throw new CrawlError(`Host "${host}" did not resolve.`, "DNS_FAILURE");
  }
  for (const a of addresses) {
    if (isBlockedIp(a.address)) {
      throw new CrawlError(
        `Host "${host}" resolves to a blocked address.`,
        "BLOCKED_IP"
      );
    }
  }
  return url;
}

/**
 * SSRF-safe fetch with manual redirect validation, size + time caps.
 * @param {string} rawUrl
 * @param {{ timeoutMs?: number, maxBytes?: number, accept?: string, asBuffer?: boolean }} [opts]
 * @returns {Promise<{ url: string, status: number, contentType: string, body: string | Buffer, bytes: number }>}
 */
export async function safeFetch(rawUrl, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const url = await assertSafeUrl(current);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(url.href, {
        method: "GET",
        redirect: "manual", // we validate each hop ourselves
        signal: controller.signal,
        headers: {
          "User-Agent": "AdForgeStudioBot/1.0 (+product-import; respects robots intent)",
          Accept: opts.accept || "text/html,application/xhtml+xml,*/*",
        },
      });
    } catch (err) {
      clearTimeout(timer);
      if (err?.name === "AbortError") {
        throw new CrawlError("Request timed out.", "TIMEOUT");
      }
      throw new CrawlError(`Fetch failed: ${err?.message || "unknown"}`, "FETCH_FAILED");
    }
    clearTimeout(timer);

    // Handle redirects manually so each target is re-validated.
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new CrawlError("Redirect without Location header.", "BAD_REDIRECT");
      current = new URL(loc, url.href).href;
      continue;
    }

    if (!res.ok) {
      throw new CrawlError(`Upstream returned HTTP ${res.status}.`, "HTTP_ERROR");
    }

    const contentType = res.headers.get("content-type") || "";

    // Enforce size cap via streaming.
    const reader = res.body?.getReader();
    const chunks = [];
    let bytes = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) {
          try { await reader.cancel(); } catch {}
          throw new CrawlError(
            `Response exceeded size cap of ${maxBytes} bytes.`,
            "TOO_LARGE"
          );
        }
        chunks.push(value);
      }
    }
    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    return {
      url: url.href,
      status: res.status,
      contentType,
      body: opts.asBuffer ? buf : buf.toString("utf8"),
      bytes,
    };
  }
  throw new CrawlError("Too many redirects.", "TOO_MANY_REDIRECTS");
}
