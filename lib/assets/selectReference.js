/**
 * Role-based reference selection.
 *
 * HONEST SCOPE: this ranks VERIFIED assets by their crawl-assigned ROLE
 * (hero_product, product_screenshot, logo, …) and then by resolution. It is
 * NOT image-content relevance analysis — nothing here looks at pixels to decide
 * whether an image actually depicts the product/brand. Its one strong guarantee
 * is a NEGATIVE one: a logo/icon/navigation asset is never promoted to the
 * primary scene reference. True visual-relevance ranking (a vision pass) is
 * future work, tracked in docs/VISUAL_INTELLIGENCE.md — do not describe this as
 * relevance analysis.
 *
 * Inputs are assumed already verified (status "ready") by lib/assets/verify.js.
 * "Verified" means decodable + correctly sized — NOT creatively suitable.
 */

// Roles that are legitimate PRIMARY references, by what the creative needs.
const PRIMARY_PREFERENCE = {
  // physical product ad → real product shots
  physical: ["hero_product", "product_packshot", "alternate_angle", "lifestyle", "brand_art"],
  // software/app demo → real UI/screenshots, then hero visual
  ui_demo: ["product_screenshot", "app_screenshot", "dashboard_screenshot", "hero_visual", "brand_art"],
  // brand/service/generic → hero visual, brand art, lifestyle (NOT a bare logo/icon)
  brand: ["hero_visual", "brand_art", "lifestyle", "product_screenshot", "illustration"],
};

const NEVER_PRIMARY = new Set(["logo", "icon", "navigation_asset", "unrelated"]);

/**
 * @param {{ role?: string, width?: number, height?: number, storedUrl?: string, sourceUrl?: string, isVector?: boolean }[]} verified
 * @param {{ entityType?: string, productionMethod?: string }} ctx
 * @returns {{
 *   primary: object|null,
 *   alternates: object[],
 *   logo: object|null,
 *   reason: string,
 *   needsReference: boolean,
 * }}
 */
export function selectReference(verified, ctx = {}) {
  const assets = (verified || []).filter((a) => a && (a.storedUrl || a.sourceUrl));
  const logo = assets.find((a) => a.role === "logo") || null;

  // Which preference list applies?
  const et = ctx.entityType || "";
  const isPhysical = /physical_product|ecommerce/.test(et);
  const isUiDemo =
    /saas|app/.test(et) ||
    ["image_to_video"].includes(ctx.productionMethod) === false && /screenshot/.test(et);
  const prefKey = isPhysical ? "physical" : isUiDemo ? "ui_demo" : "brand";
  const pref = PRIMARY_PREFERENCE[prefKey];

  // Candidate primaries: never a logo/icon/unrelated; rank by role preference
  // then resolution.
  const candidates = assets
    .filter((a) => !NEVER_PRIMARY.has(a.role))
    .map((a) => {
      const roleRank = pref.indexOf(a.role);
      return { ...a, _roleRank: roleRank === -1 ? 99 : roleRank };
    })
    .sort((a, b) => {
      if (a._roleRank !== b._roleRank) return a._roleRank - b._roleRank;
      return (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0);
    });

  const primary = candidates[0] || null;
  const alternates = candidates.slice(1, 4);

  let reason;
  if (primary) {
    reason = `Primary reference: ${primary.role || "image"} (chosen for a ${prefKey} creative).`;
  } else if (logo) {
    // A logo exists but no scene-worthy visual. For brand-led creatives this is
    // fine (logo used for an end-card overlay), but it's NOT a scene hero.
    reason = "Only a logo was found — usable for a brand end-card overlay, not as a scene reference.";
  } else {
    reason = "No usable visual reference found.";
  }

  // Does the chosen production method actually NEED a reference image?
  const needsReference = ctx.productionMethod === "image_to_video";

  // If the caller passes a user-chosen reference (Milestone 2 manual asset
  // controls), it is AUTHORITATIVE and overrides the automatic ranking — the
  // human's pick wins over role heuristics. We still return `logo`/alternates.
  const userPick =
    ctx.userSelectedReference &&
    assets.find(
      (a) =>
        (a.storedUrl && a.storedUrl === ctx.userSelectedReference) ||
        (a.sourceUrl && a.sourceUrl === ctx.userSelectedReference)
    );
  if (userPick) {
    return {
      primary: userPick,
      alternates: candidates.filter((c) => c !== userPick).slice(0, 3),
      logo,
      reason: "Primary reference set manually by the user (authoritative).",
      needsReference,
      basis: "user_selected",
    };
  }

  return {
    primary,
    alternates,
    logo,
    reason,
    needsReference,
    // How `primary` was chosen — honest provenance, not a relevance score.
    basis: primary ? "role_rank_then_resolution" : "none",
  };
}
