/**
 * Forgiving URL normalization for user input.
 *
 * Accepts bare domains and messy input and produces a valid https URL BEFORE
 * Zod/SSRF validation, so `bhavishai.in` no longer 422s just for lacking a
 * scheme. Does NOT weaken SSRF — the result is still passed through
 * assertSafeUrl downstream.
 */

/**
 * @param {string} input
 * @returns {{ ok: true, url: string } | { ok: false, reason: string }}
 */
export function normalizeInputUrl(input) {
  if (typeof input !== "string") return { ok: false, reason: "No URL provided." };
  let s = input.trim();
  if (!s) return { ok: false, reason: "No URL provided." };

  // Strip wrapping quotes/backticks a user might paste.
  s = s.replace(/^["'`<]+|["'`>]+$/g, "").trim();

  // Reject obvious non-http schemes early (file:, ftp:, javascript:, etc.).
  const schemeMatch = s.match(/^([a-z][a-z0-9+.-]*):/i);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (scheme !== "http" && scheme !== "https") {
      return { ok: false, reason: `Unsupported scheme "${scheme}". Use http(s).` };
    }
  } else {
    // No scheme → assume https. Also handle protocol-relative "//host".
    s = "https://" + s.replace(/^\/\//, "");
  }

  let u;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, reason: "That doesn't look like a valid web address." };
  }

  // Must have a dotted host or be a known single-label (localhost handled by SSRF).
  if (!u.hostname || (!u.hostname.includes(".") && u.hostname !== "localhost")) {
    return { ok: false, reason: "Enter a full domain, e.g. example.com." };
  }

  // Canonicalize: drop fragment, strip tracking params, collapse trailing slash
  // on the root path.
  u.hash = "";
  [
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
    "fbclid", "gclid", "mc_cid", "mc_eid", "ref", "ref_src",
  ].forEach((k) => u.searchParams.delete(k));
  if (u.pathname === "/") u.pathname = "/";

  return { ok: true, url: u.href };
}
