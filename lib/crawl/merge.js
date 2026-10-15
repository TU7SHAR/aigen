/**
 * Merge layer — reconciles deterministic facts with AI enrichment into a final
 * EntityProfile, with per-field provenance.
 *
 * Priority (high → low):
 *   user_edit > json_ld / structured commerce > open_graph >
 *   high-confidence page_dom > ai_extracted > ai_inferred
 *
 * Rule: AI fills GAPS and adds interpretive fields; it must NOT overwrite a
 * present high-confidence deterministic fact.
 */

/**
 * @param {{
 *   deterministic: object,   // from structured extraction (ProductProfile-ish)
 *   determSources: Record<string, { source: string, confidence: number }>,
 *   enriched: object | null, // from enrichFromContext (nullable)
 *   entityTypeHint?: string,
 * }} input
 */
export function mergeProfiles({ deterministic, determSources = {}, enriched, entityTypeHint, classifyAmbiguous = false }) {
  /** @type {Record<string, { value: any, source: string, confidence: number }>} */
  const sources = {};
  const out = {};

  const setFact = (key, value, source, confidence) => {
    if (value === undefined || value === null || value === "" ||
        (Array.isArray(value) && value.length === 0)) return;
    const existing = sources[key];
    if (existing && rank(existing.source) >= rank(source)) return;
    out[key] = value;
    sources[key] = { source, confidence };
  };

  // 1. deterministic facts first (highest trust)
  const d = deterministic || {};
  setFact("name", d.name, srcOf(determSources, "name", "page_dom"), confOf(determSources, "name", 0.6));
  setFact("brand", d.brand, srcOf(determSources, "brand", "page_dom"), confOf(determSources, "brand", 0.6));
  setFact("description", d.description, srcOf(determSources, "description", "page_dom"), confOf(determSources, "description", 0.6));
  setFact("price", d.price, srcOf(determSources, "price", "page_dom"), confOf(determSources, "price", 0.7));
  setFact("currency", d.currency, srcOf(determSources, "currency", "page_dom"), confOf(determSources, "currency", 0.7));
  setFact("category", d.category, srcOf(determSources, "category", "page_dom"), confOf(determSources, "category", 0.6));
  if (Array.isArray(d.specifications) && d.specifications.length) {
    setFact("specifications", d.specifications, "json_ld", 0.85);
  }

  // 2. AI enrichment — fills gaps + interpretive fields
  const e = enriched || null;
  if (e) {
    setFact("name", e.name, "ai_extracted", 0.7);
    setFact("brand", e.brandName, "ai_extracted", 0.7);
    setFact("shortDescription", e.shortDescription, "ai_extracted", 0.7);
    setFact("description", e.description, "ai_extracted", 0.68);
    setFact("category", e.category, "ai_extracted", 0.65);
    setFact("offer", e.primaryOffer, "ai_extracted", 0.65);
    setFact("offers", e.offers, "ai_extracted", 0.6);
    setFact("features", e.features, "ai_extracted", 0.6);
    setFact("benefits", e.benefits, "ai_inferred", 0.55);
    setFact("targetCustomer", (e.targetAudience || [])[0], "ai_inferred", 0.5);
    setFact("useCases", e.useCases, "ai_inferred", 0.5);
    setFact("differentiators", e.differentiators, "ai_inferred", 0.5);
    setFact("callsToAction", e.callsToAction, "ai_extracted", 0.6);
    setFact("socialProof", e.socialProof, "ai_extracted", 0.55);
    // pricing only if deterministic price absent (never overwrite structured price)
    if (out.price == null && e.pricing?.value != null) {
      setFact("price", e.pricing.value, "ai_extracted", 0.5);
      setFact("currency", e.pricing.currency, "ai_extracted", 0.5);
      setFact("billingPeriod", e.pricing.billingPeriod, "ai_extracted", 0.5);
    }
  }

  // entityType resolution. AI refines the deterministic classifier, but we do
  // NOT let AI silently override a CONFIDENT deterministic call, and when they
  // disagree we RECORD the conflict + lower confidence instead of hiding it.
  const determType = entityTypeHint && entityTypeHint !== "unknown" ? entityTypeHint : null;
  const aiType = e?.entityType && e.entityType !== "unknown" ? e.entityType : null;

  let entityType;
  let entityTypeConflict = false;
  if (aiType && determType && aiType !== determType) {
    entityTypeConflict = true;
    // Disagreement: trust the deterministic classifier when it was CONFIDENT
    // (unambiguous); otherwise defer to AI. Either way, flag it for the user.
    entityType = classifyAmbiguous ? aiType : determType;
  } else {
    entityType = aiType || determType || "unknown";
  }

  // final confidence: blend deterministic completeness + AI confidence, and
  // DOCK confidence when the two sources disagreed or the classifier was unsure.
  const determFilled = ["name", "description", "price"].filter((k) => out[k] != null).length;
  const aiConf = e?.confidence ?? 0;
  let confidence = Math.min(0.98, 0.15 + determFilled * 0.18 + aiConf * 0.35);
  if (entityTypeConflict) confidence -= 0.2;
  if (classifyAmbiguous) confidence -= 0.1;
  confidence = Number(Math.max(0.1, confidence).toFixed(2));

  return {
    profile: out,
    sources,
    entityType,
    confidence,
    // Uncertainty surfaced to the review UI (so the user can confirm/correct).
    entityTypeUncertainty: {
      deterministic: determType,
      ai: aiType,
      conflict: entityTypeConflict,
      ambiguous: Boolean(classifyAmbiguous),
      needsConfirmation: entityTypeConflict || Boolean(classifyAmbiguous),
    },
  };
}

const RANK = {
  user_edit: 100,
  json_ld: 90,
  structured: 85,
  open_graph: 70,
  internal_page: 60,
  page_dom: 55,
  firecrawl: 50,
  ai_extracted: 40,
  ai_inferred: 30,
};
function rank(src) {
  return RANK[src] ?? 10;
}
function srcOf(map, key, fallback) {
  return map[key]?.source || fallback;
}
function confOf(map, key, fallback) {
  return map[key]?.confidence ?? fallback;
}
