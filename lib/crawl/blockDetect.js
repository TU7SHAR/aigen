/**
 * Detect bot-block, access-denied, captcha, consent-wall and error pages.
 *
 * Regression (H&M): the browser capture of www2.hm.com received Akamai's
 * "Access Denied" page and the importer stored it as the website footage the
 * ad then scrolled. A page like that is evidence that we could NOT see the
 * site, never content about the business.
 */

const BLOCK_PATTERNS = [
  /\baccess denied\b/i,
  /you don'?t have permission to access/i,
  /errors\.edgesuite\.net|reference\s*#\d+\.[0-9a-f]+/i,
  /attention required!?\s*\|\s*cloudflare/i,
  /\bcf-error|cloudflare ray id/i,
  /just a moment\.\.\.|checking your browser|enable javascript and cookies to continue/i,
  /verify (that )?you are (a )?human|are you a robot|captcha/i,
  /request (was )?blocked|request unsuccessful\. incapsula|incident id/i,
  /\b(403|404|429|500|502|503) (forbidden|not found|too many requests|internal server error|bad gateway|service unavailable)\b/i,
  /^\s*(forbidden|not found|page not found|site (is )?unavailable)\s*$/im,
  /pardon our interruption|unusual traffic from your (computer|network)/i,
];

/**
 * @param {{ status?: number, title?: string, text?: string, html?: string }} page
 * @returns {{ blocked: boolean, reason: string|null }}
 */
export function detectBlockedPage({ status = 200, title = "", text = "", html = "" } = {}) {
  if (Number(status) >= 400) return { blocked: true, reason: `HTTP ${status}` };
  const body = `${title}\n${text || stripTags(html).slice(0, 6000)}`;
  const short = body.replace(/\s+/g, " ").trim().length < 1800;
  for (const re of BLOCK_PATTERNS) {
    // Generic phrases only count on short pages (a real store can mention "captcha" in a footer).
    if (re.test(body) && (short || re === BLOCK_PATTERNS[2] || re === BLOCK_PATTERNS[3])) {
      return { blocked: true, reason: (body.match(re)?.[0] || "blocked page").trim().slice(0, 80) };
    }
  }
  return { blocked: false, reason: null };
}

function stripTags(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");
}
