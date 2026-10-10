/**
 * ContextReducer — compress crawled evidence into a compact, high-signal block
 * for the AI enrichment step, so we never pay to send 40k+ chars of HTML.
 *
 * Priority (highest first): structured facts → title/meta → H1/headings →
 * hero/primary blocks → features/pricing/benefits → about/positioning →
 * selected secondary-page summaries. Output is capped to a char budget.
 */

const DEFAULT_BUDGET = 7000;

/**
 * @param {{
 *   finalUrl: string,
 *   title?: string,
 *   metaDescription?: string,
 *   structuredFacts?: Record<string, { value: any }>,
 *   cleanedText?: string,
 *   headings?: string[],
 *   imageMeta?: { role: string, width?: number }[],
 *   secondaryPages?: { url: string, title?: string, cleanedText?: string }[],
 *   budget?: number,
 * }} input
 * @returns {{ text: string, chars: number }}
 */
export function reduceContext(input) {
  const budget = input.budget ?? DEFAULT_BUDGET;
  const parts = [];
  let used = 0;

  const push = (label, body, max) => {
    if (!body) return;
    let b = String(body).replace(/\s+/g, " ").trim();
    if (!b) return;
    if (max && b.length > max) b = b.slice(0, max) + "…";
    const block = `## ${label}\n${b}`;
    if (used + block.length > budget) {
      const remaining = budget - used - label.length - 6;
      if (remaining < 120) return; // not worth a tiny fragment
      parts.push(`## ${label}\n${b.slice(0, remaining)}…`);
      used = budget;
      return;
    }
    parts.push(block);
    used += block.length;
  };

  push("SOURCE", input.finalUrl, 300);
  push("TITLE", input.title, 300);
  push("META DESCRIPTION", input.metaDescription, 500);

  if (input.structuredFacts) {
    const facts = Object.entries(input.structuredFacts)
      .filter(([, v]) => v && v.value != null && v.value !== "")
      .map(([k, v]) => `${k}: ${stringifyFact(v.value)}`)
      .join("\n");
    push("STRUCTURED FACTS (reliable)", facts, 1200);
  }

  if (input.headings?.length) {
    push("HEADINGS", input.headings.slice(0, 20).join(" · "), 800);
  }

  // The cleaned text already favors product/hero/feature blocks.
  push("PAGE CONTENT", input.cleanedText, Math.max(1000, budget - used - 1500));

  if (input.secondaryPages?.length) {
    for (const sp of input.secondaryPages) {
      if (used >= budget) break;
      push(
        `SECONDARY PAGE: ${sp.title || sp.url}`,
        sp.cleanedText,
        1200
      );
    }
  }

  if (input.imageMeta?.length) {
    const im = input.imageMeta
      .slice(0, 8)
      .map((i) => `${i.role}${i.width ? ` (${i.width}px)` : ""}`)
      .join(", ");
    push("IMAGE METADATA", im, 400);
  }

  const text = parts.join("\n\n");
  return { text, chars: text.length };
}

function stringifyFact(v) {
  if (Array.isArray(v)) return v.map((x) => (typeof x === "object" ? JSON.stringify(x) : x)).join("; ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
