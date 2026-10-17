/**
 * CTA destination: the URL shown on the closing card.
 *
 * Source of truth, in order: the destination the user supplied, then the
 * business/product page that was actually imported. Never an advertising,
 * tracking, redirect or URL-shortener host found on the page. Tracking query
 * parameters are removed; the on-screen text is the readable host (+ a short
 * path).
 */

// Ad-serving / analytics / CDN infrastructure: never a customer destination.
const AD_OR_TRACKER = /(^|\.)(doubleclick\.net|googleadservices\.com|googlesyndication\.com|google-analytics\.com|googletagmanager\.com|adservice\.google\.[a-z.]+|fbcdn\.net|connect\.facebook\.net|adnxs\.com|criteo\.(com|net)|taboola\.com|outbrain\.com|amazon-adsystem\.com|scorecardresearch\.com|hotjar\.com|clarity\.ms|edgesuite\.net|akamaihd\.net|cloudfront\.net|klaviyo\.com|list-manage\.com)$/i;
// Short links hide the real destination: accepted only when the user supplies them.
const SHORTENER = /(^|\.)(t\.co|bit\.ly|tinyurl\.com|ow\.ly|lnkd\.in|rb\.gy|cutt\.ly|is\.gd)$/i;
const TRACKING_PARAM = /^(utm_[a-z]+|fbclid|gclid|gbraid|wbraid|msclkid|mc_[a-z]+|_ga|_gl|igshid|ref|ref_src|spm|yclid)$/i;

/** Remove tracking params; returns a URL object or null. */
export function cleanUrl(raw) {
  if (!raw || typeof raw !== "string") return null;
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!/^https?:$/.test(u.protocol)) return null;
    for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAM.test(k)) u.searchParams.delete(k);
    u.hash = "";
    return u;
  } catch {
    return null;
  }
}

export const isAdOrTrackerHost = (host) => AD_OR_TRACKER.test(String(host || ""));
const bareHost = (h) => String(h || "").toLowerCase().replace(/^www\d?\./, "");

/** Registrable-ish domain (last two labels; three for e.g. co.uk). */
export function siteOf(host) {
  const parts = bareHost(host).split(".");
  if (parts.length <= 2) return parts.join(".");
  const sld = parts[parts.length - 2];
  return (sld.length <= 3 && parts.length >= 3 ? parts.slice(-3) : parts.slice(-2)).join(".");
}

/**
 * @param {object} input validated generate request
 * @returns {{ url: string|null, display: string|null, source: string|null, warnings: string[] }}
 */
export function resolveDestination(input = {}) {
  const warnings = [];
  const pp = input.productProfile || {};
  const business = cleanUrl(pp.canonicalUrl || pp.sourceUrl || input.websiteUrl || "");
  const supplied = cleanUrl(input.destinationUrl || "");
  let chosen = null;
  let source = null;
  if (supplied) {
    if (isAdOrTrackerHost(supplied.hostname)) {
      warnings.push(`The destination ${supplied.hostname} is ad-serving/tracking infrastructure, not a customer page; using the business site instead.`);
    } else {
      chosen = supplied;
      source = "user";
      if (business && siteOf(business.hostname) !== siteOf(supplied.hostname)) {
        warnings.push(`The destination (${bareHost(supplied.hostname)}) is a different site from the imported business (${bareHost(business.hostname)}). Using your destination as given.`);
      }
    }
  }
  if (!chosen && business && !isAdOrTrackerHost(business.hostname) && !SHORTENER.test(business.hostname)) {
    chosen = business;
    source = "imported_site";
  }
  if (!chosen) return { url: null, display: null, source: null, warnings };
  const host = bareHost(chosen.hostname);
  const p = chosen.pathname !== "/" ? chosen.pathname.replace(/\/$/, "") : "";
  return { url: chosen.toString(), display: p && p.length <= 14 ? host + p : host, source, warnings };
}
