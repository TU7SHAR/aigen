/**
 * Entity creative strategies.
 *
 * The entity type fundamentally changes how we plan and prompt an ad. A SaaS
 * service must NEVER be described with physical-product language (bottle, cap,
 * packaging). Each strategy defines:
 *   - subjectNoun / subjectDescriptor: how to refer to the thing
 *   - sceneVocabulary: establish/detail/end scene descriptions (NO product
 *     assumptions unless physical)
 *   - fidelityRule: what must be preserved for THIS entity type
 *   - extraNegatives: entity-specific forbidden content
 *   - defaultConcepts: concept families appropriate to the entity
 *   - generationMode: default cost/quality strategy
 *   - allowsPhysicalLanguage: whether packaging/geometry terms are legitimate
 *
 * Shared negative rules live in promptComposer; strategies ADD to them.
 */

/** Entity types we support as first-class. */
export const ENTITY_TYPES = [
  "physical_product",
  "ecommerce_store",
  "saas",
  "app",
  "service",
  "business",
  "creator",
  "personal_brand",
  "course",
  "agency",
  "event",
  "unknown",
];

/** Normalize importer entity-type strings to a strategy key. */
export function normalizeEntityType(t) {
  if (!t) return "unknown";
  const map = {
    ecommerce_product: "physical_product",
    product: "physical_product",
    landing_page: "business",
    portfolio: "personal_brand",
  };
  const n = map[t] || t;
  return ENTITY_TYPES.includes(n) ? n : "unknown";
}

const PHYSICAL = {
  key: "physical_product",
  allowsPhysicalLanguage: true,
  subjectNoun: "product",
  generationMode: "image_to_video",
  fidelityRule:
    "Preserve the product's exact shape, packaging proportions, box/bottle geometry, cap/lid, label placement, colors, logo and distinctive features. Do not redesign or rebrand the package.",
  extraNegatives: [],
  defaultConcepts: ["studio-hero", "macro-detail", "product-demo", "lifestyle"],
  scene(brief) {
    return {
      establish: `${brief.environment}; the physical product as the clean hero object`,
      detail: `macro / detail beat emphasizing ${brief.productHeroMoment || "the product's materials and finish"}`,
      end: "final hero composition of the product with reserved negative space for exact logo/CTA overlays",
    };
  },
  quality:
    "Professional ecommerce commercial photography, realistic materials, natural reflections and contact shadows, controlled depth of field.",
};

const SAAS = {
  key: "saas",
  allowsPhysicalLanguage: false,
  subjectNoun: "software product",
  generationMode: "hybrid",
  fidelityRule:
    "Represent the actual software: use its real interface/screenshots, logo, brand colors and typography. Do NOT invent a physical object, bottle, box, package or device. Keep any depicted UI consistent with the real product; exact logo/UI/text are composited in post, not drawn by the model.",
  extraNegatives: [
    "no physical product, bottle, box, package, jar, tube or cosmetic container",
    "no fake 3D product rendering of a digital service",
    "do not place the app on a literal phone/laptop unless explicitly requested",
  ],
  defaultConcepts: ["interface-reveal", "feature-flow", "problem-workflow", "outcome-story", "brand-experience"],
  scene(brief) {
    return {
      establish: `an on-brand abstract environment using the brand palette; the brand/logo established cleanly (no physical object)`,
      detail: `a motion beat built around the product's real interface or key feature, with clean negative space for exact UI/screenshot overlays composited in post`,
      end: "a confident brand end-card beat with reserved space for the exact logo and call-to-action",
    };
  },
  quality:
    "Clean, modern software-brand motion design. Premium but not literal; favor typography, brand color fields, subtle depth and smooth transitions over any physical object.",
};

const APP = { ...SAAS, key: "app", subjectNoun: "app" };

const SERVICE = {
  key: "service",
  allowsPhysicalLanguage: false,
  subjectNoun: "service",
  generationMode: "hybrid",
  fidelityRule:
    "The service is not a physical object. Represent it through outcome, transformation, the customer's situation, process, and brand identity. Do not invent packaging or a physical product. Keep claims consistent with the source; exact logo/text are composited in post.",
  extraNegatives: [
    "no physical product, bottle, box or package for a non-physical service",
    "no invented product geometry",
  ],
  defaultConcepts: ["service-story", "transformation", "problem-solution", "trust-proof", "how-it-works"],
  scene(brief) {
    return {
      establish: `a relatable real-world context for the customer this service helps, in the brand's visual language`,
      detail: `a transformation / outcome beat showing the positive change the service delivers`,
      end: "a confident brand end-card with reserved space for the exact logo and call-to-action",
    };
  },
  quality:
    "Authentic, human, outcome-focused commercial film in the brand's visual language. No fabricated product object.",
};

const BUSINESS = {
  ...SERVICE,
  key: "business",
  subjectNoun: "business",
  defaultConcepts: ["brand-intro", "value-reveal", "problem-solution", "experience-film"],
};

const AGENCY = { ...SERVICE, key: "agency", subjectNoun: "agency" };

const CREATOR = {
  key: "creator",
  allowsPhysicalLanguage: false,
  subjectNoun: "creator",
  generationMode: "hybrid",
  fidelityRule:
    "Only use authorized imagery of the person. Do NOT generate or impersonate an identifiable person without authorized assets. Represent the creator's offer and personal brand; keep identity accurate when authorized assets exist.",
  extraNegatives: [
    "no physical product or packaging",
    "do not synthesize a realistic identifiable human face unless an authorized portrait/video was provided",
  ],
  defaultConcepts: ["authority-intro", "offer-launch", "story", "social-proof"],
  scene(brief) {
    return {
      establish: `an on-brand environment that fits the creator's niche and energy`,
      detail: `a beat built around the creator's offer / value, using authorized assets where available`,
      end: "a confident end-card with reserved space for the exact logo/handle and call-to-action",
    };
  },
  quality: "Energetic, authentic creator-style motion in the creator's own visual language.",
};

const PERSONAL_BRAND = { ...CREATOR, key: "personal_brand", subjectNoun: "personal brand" };

const COURSE = {
  key: "course",
  allowsPhysicalLanguage: false,
  subjectNoun: "course",
  generationMode: "hybrid",
  fidelityRule:
    "Represent the course through transformation, curriculum, instructor authority and learner outcomes. Do not invent a physical product. Exact logo/text composited in post.",
  extraNegatives: ["no physical product or packaging"],
  defaultConcepts: ["transformation", "curriculum-reveal", "instructor-authority", "outcomes", "social-proof"],
  scene(brief) {
    return {
      establish: `an aspirational context representing the learner's goal, in the brand's visual language`,
      detail: `a beat conveying what the learner will gain (curriculum / outcome), clean and motivating`,
      end: "a confident end-card with reserved space for the exact logo and enrollment call-to-action",
    };
  },
  quality: "Motivational, credible educational motion design in the brand's visual language.",
};

const EVENT = { ...SERVICE, key: "event", subjectNoun: "event", defaultConcepts: ["hype", "lineup-reveal", "experience", "register-now"] };

const UNKNOWN = {
  key: "unknown",
  allowsPhysicalLanguage: false,
  subjectNoun: "offering",
  generationMode: "hybrid",
  fidelityRule:
    "The entity type is uncertain. Use entity-NEUTRAL creative language. Do NOT assume a physical product. Represent the brand through its name, colors, typography and any real assets only.",
  extraNegatives: [
    "no assumed physical product, bottle, box or packaging",
    "no invented product geometry",
  ],
  defaultConcepts: ["brand-intro", "problem-solution", "value-reveal"],
  scene(brief) {
    return {
      establish: `a clean, brand-neutral environment using the brand's palette and logo (no assumed physical object)`,
      detail: `a beat built around the offering's core value, using real assets where available`,
      end: "a brand end-card with reserved space for the exact logo and call-to-action",
    };
  },
  quality: "Clean, brand-led motion design. No assumed physical object.",
};

const STRATEGIES = {
  physical_product: PHYSICAL,
  ecommerce_store: PHYSICAL,
  saas: SAAS,
  app: APP,
  service: SERVICE,
  business: BUSINESS,
  agency: AGENCY,
  creator: CREATOR,
  personal_brand: PERSONAL_BRAND,
  course: COURSE,
  event: EVENT,
  unknown: UNKNOWN,
};

/** @param {string} entityType */
export function getEntityStrategy(entityType) {
  return STRATEGIES[normalizeEntityType(entityType)] || UNKNOWN;
}
