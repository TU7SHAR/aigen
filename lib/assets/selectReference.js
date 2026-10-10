/**
 * Relevance-based reference selection.
 *
 * The best generation reference depends on the CREATIVE, not just image size.
 * This picks a primary reference (and alternates) from VERIFIED assets, honoring
 * the production method and entity type. A generic icon/logo must never become
 * the primary video reference for an unrelated product/demo.
 *
 * Inputs are assumed already verified (status "ready") by lib/assets/verify.js.
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
 * @param {{ role?: string, width?: number, height?: number, relevanceScore?: number, storedUrl?: string, sourceUrl?: string, isVector?: boolean }[]} verified
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

  return { primary, alternates, logo, reason, needsReference };
}
