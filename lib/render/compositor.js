/**
 * Compositor orchestrator.
 *
 * Turns the compiled creative plan + the generation request into a concrete
 * render spec (scenes with REAL image paths + deterministically-timed text
 * overlays), then renders a finished MP4 via the ffmpeg screen renderer.
 *
 * This is the first RELIABLE, repeatable production path: it uses only real,
 * verified assets and exact approved copy, and spends ZERO paid generative
 * credits. If there are no usable real images, it still produces a clean
 * branded explainer (title cards) rather than inventing a fake UI.
 */

import path from "node:path";
import { promises as fs } from "node:fs";
import { frameSize } from "./ffmpeg.js";
import { renderScreenAd } from "./screenRenderer.js";

const PUBLIC_IMPORTED = path.join(process.cwd(), "public", "imported-assets");

/** Resolve an asset url/ref to an on-disk readable image path (or null). */
async function resolveImagePath(ref) {
  if (!ref) return null;
  const url = typeof ref === "string" ? ref : ref.url || ref.storedUrl || ref.sourceUrl;
  if (!url) return null;
  // Only locally-stored imported assets can be used by the renderer. Remote
  // URLs are not fetched here (SSRF + we only animate verified local assets).
  if (!url.startsWith("/imported-assets/")) return null;
  const safe = path.basename(url); // anti-traversal
  if (safe.toLowerCase().endsWith(".svg")) return null; // raster only for Ken Burns
  const full = path.join(PUBLIC_IMPORTED, safe);
  try {
    await fs.access(full);
    return full;
  } catch {
    return null;
  }
}

/**
 * Collect the user-selected real images (primary first), de-duplicated.
 * Returns parallel arrays: resolved on-disk `paths` and their `meta`
 * ({ role, url }) so the per-shot router can match a shot's assetHint to a role.
 * @param {object} input validated generate request
 */
async function collectImagePaths(input) {
  const entries = []; // { url, role }
  if (Array.isArray(input.referenceAssets) && input.referenceAssets.length) {
    const primaryFirst = [...input.referenceAssets].sort((a, b) => (b.primary ? 1 : 0) - (a.primary ? 1 : 0));
    for (const a of primaryFirst) entries.push({ url: a.url, role: a.role || null });
  } else if (input.referenceAssetUrl) {
    entries.push({ url: input.referenceAssetUrl, role: input.referenceAssetRole || null });
  }
  // Also honor an array of gallery urls if the client sent them.
  if (Array.isArray(input.galleryUrls)) for (const u of input.galleryUrls) entries.push({ url: u, role: null });

  const seen = new Set();
  const paths = [];
  const meta = [];
  for (const e of entries) {
    if (!e.url || seen.has(e.url)) continue;
    seen.add(e.url);
    const p = await resolveImagePath(e.url);
    if (p) {
      paths.push(p);
      meta.push({ role: e.role, url: e.url });
    }
  }
  return { paths, meta };
}

/**
 * Build the overlay list (exact, verified copy only). Anything not provided is
 * simply omitted — we NEVER synthesize a price, discount, URL or claim.
 */
function buildOverlays(input, brief, totalDur) {
  const overlays = [];
  const brand = (input.brand || brief?.brand?.name || input.productName || "").trim();
  const headline = (brief?.conceptCentralMessage || input.offering || input.description || "").trim();
  const offer = (input.offer || "").trim();
  const url = extractUrl(input);
  const cta = (input.cta || "").trim();

  // Brand mark: whole video, top-left.
  if (brand) overlays.push({ kind: "brand", text: brand, start: 0, end: totalDur });

  // Headline / central message: first ~60%.
  if (headline) overlays.push({ kind: "headline", text: headline, start: 0.3, end: Math.max(1.2, totalDur * 0.6) });

  // Offer: only if the user actually provided one (no fabrication).
  if (offer) overlays.push({ kind: "offer", text: offer, start: totalDur * 0.45, end: totalDur });

  // CTA + URL on the final third.
  const endStart = Math.max(0.5, totalDur * 0.66);
  if (cta) overlays.push({ kind: "cta", text: cta, start: endStart, end: totalDur });
  if (url) overlays.push({ kind: "url", text: url, start: endStart, end: totalDur });

  return overlays;
}

/**
 * Build per-shot overlays from the storyboard's exact `onScreenText`, each
 * confined to its own shot's time window. These are the Creative Director's
 * copy for that beat — rendered deterministically, never by a model. The
 * global brand mark (from buildOverlays) still rides on top for the whole clip.
 * @param {object[]} scenes render scenes (carry onScreenText + durationSec)
 */
function buildShotOverlays(scenes) {
  const overlays = [];
  let t = 0;
  for (const s of scenes) {
    const dur = Number(s.durationSec) || 2.5;
    const text = (s.onScreenText || "").trim();
    if (text) {
      // small lead-in / tail so the copy doesn't flash exactly on the cut
      const start = t + Math.min(0.3, dur * 0.1);
      const end = t + dur - Math.min(0.2, dur * 0.1);
      overlays.push({ kind: "shot", text, start, end });
    }
    t += dur;
  }
  return overlays;
}
function extractUrl(input) {
  const pp = input.productProfile || {};
  const raw = pp.canonicalUrl || pp.sourceUrl || input.websiteUrl || null;
  if (!raw) return null;
  try {
    const u = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
    return u.hostname.replace(/^www\./, "") + (u.pathname !== "/" ? u.pathname.replace(/\/$/, "") : "");
  } catch {
    return typeof raw === "string" ? raw.slice(0, 60) : null;
  }
}

// Which storyboard techniques the DETERMINISTIC compositor can execute itself.
// real_asset/composite animate a genuine image; motion_graphic is a branded
// type card. ai_image / ai_video require a model and are only honored when an
// image/video provider has already produced the frame (passed in as an asset);
// otherwise the compositor degrades to a deterministic card and REPORTS it.
const DETERMINISTIC_TECHNIQUES = new Set(["real_asset", "motion_graphic", "composite"]);
const GENERATIVE_TECHNIQUES = new Set(["ai_image", "ai_video"]);

/**
 * Map scenePlan scenes → render scenes.
 *
 * When the plan came from the AI Creative Director, each scene carries a
 * per-shot `technique`, `assetHint` and exact `onScreenText`. We HONOR those:
 *  - real_asset / composite → animate the hinted real asset (by role when we
 *    can match it, else the next available real image);
 *  - motion_graphic → a deterministic branded card (no image);
 *  - ai_image / ai_video → only if a generated frame was supplied for the shot
 *    (shot.generatedImagePath); otherwise a deterministic card + a downgrade
 *    note, so we never present a fabricated frame as real AI output.
 *
 * Each scene records `requestedTechnique` and the `executedMethod` actually
 * used, so the route can report AI-generated vs deterministic per shot.
 *
 * @param {object} scenePlan compiled scene plan (may carry storyboard shots)
 * @param {string[]} imagePaths resolved local real-image paths (primary first)
 * @param {object} brief
 * @param {object[]} [assetMeta] parallel to imagePaths: { role, url } for role matching
 */
function buildScenes(scenePlan, imagePaths, brief, assetMeta = []) {
  const planned = scenePlan?.scenes?.length ? scenePlan.scenes : [{ purpose: "establish", duration: 3, motion: "controlled" }];
  const scenes = [];
  let realCursor = 0; // round-robin pointer into the real images actually used
  for (let i = 0; i < planned.length; i++) {
    const s = planned[i];
    const requestedTechnique = s.technique || null;
    const durationSec = Number(s.duration) || Math.max(1.5, (scenePlan?.totalDuration || 6) / planned.length);

    // Decide how THIS shot is produced.
    let executedMethod;
    let imagePath = null;
    let downgradedFrom = null;

    const generated = s.generatedImagePath || null; // set only when a model made a frame

    if (requestedTechnique && GENERATIVE_TECHNIQUES.has(requestedTechnique)) {
      if (generated) {
        imagePath = generated;
        executedMethod = requestedTechnique; // genuinely AI-produced frame
      } else {
        // No model frame available → honest deterministic fallback.
        downgradedFrom = requestedTechnique;
        const pick = pickRealImage(s, imagePaths, assetMeta, realCursor);
        imagePath = pick.path;
        if (pick.path) realCursor = pick.nextCursor;
        executedMethod = pick.path ? "real_asset" : "motion_graphic";
      }
    } else if (requestedTechnique === "motion_graphic") {
      executedMethod = "motion_graphic"; // branded card, no image
    } else {
      // real_asset / composite / unspecified → use a real asset if one exists.
      const pick = pickRealImage(s, imagePaths, assetMeta, realCursor);
      imagePath = pick.path;
      if (pick.path) realCursor = pick.nextCursor;
      executedMethod = pick.path ? requestedTechnique || "real_asset" : "motion_graphic";
    }

    scenes.push({
      imagePath,
      durationSec,
      motion: s.motion,
      purpose: s.purpose,
      kenBurns: s.kenBurns,
      // Per-shot execution record + exact copy for a per-scene overlay.
      intent: s.intent || s.purpose || null,
      requestedTechnique,
      executedMethod,
      downgradedFrom,
      onScreenText: typeof s.onScreenText === "string" ? s.onScreenText.trim() : "",
      assetHint: s.assetHint || null,
    });
  }
  return scenes;
}

/**
 * Choose a real image for a shot. Prefer one whose role matches the shot's
 * assetHint; otherwise take the next image in round-robin order so distinct
 * shots still get distinct frames. Returns the path (or null) and the advanced
 * cursor.
 */
function pickRealImage(shot, imagePaths, assetMeta, cursor) {
  if (!imagePaths.length) return { path: null, nextCursor: cursor };
  const hint = String(shot?.assetHint || "").toLowerCase();
  if (hint && hint !== "none" && Array.isArray(assetMeta) && assetMeta.length) {
    const idx = assetMeta.findIndex(
      (m) => m && typeof m.role === "string" && m.role.toLowerCase().includes(hint)
    );
    if (idx !== -1 && imagePaths[idx]) {
      return { path: imagePaths[idx], nextCursor: cursor };
    }
  }
  const path = imagePaths[cursor % imagePaths.length];
  return { path, nextCursor: cursor + 1 };
}

/**
 * Compose a finished screen-based ad from the compiled plan + request.
 * @param {{ input: object, compiled: object }} args
 * @returns {Promise<{ videoBase64: string, mimeType: string, durationSec: number,
 *   width: number, height: number, usedImages: number, overlays: object[], method: string }>}
 */
export async function composeScreenAd({ input, compiled }) {
  const { width, height } = frameSize(input.aspectRatio, input.resolution);
  const { paths: imagePaths, meta: assetMeta } = await collectImagePaths(input);
  const brief = compiled?.brief || {};
  const scenePlan = compiled?.scenePlan;
  const storyboardOrigin = scenePlan?.storyboardOrigin || null; // "ai" | "fallback" | null
  const storyboardDrove = Boolean(storyboardOrigin);
  const scenes = buildScenes(scenePlan, imagePaths, brief, assetMeta);
  const totalDur = scenes.reduce((a, s) => a + s.durationSec, 0);

  // Global copy (brand / offer / cta / url). When a storyboard authored per-shot
  // on-screen text, drop the GENERIC global headline so we don't double the
  // central message — the shot overlays carry the beat-by-beat copy instead.
  let overlays = buildOverlays(input, brief, totalDur);
  const shotOverlays = buildShotOverlays(scenes);
  if (storyboardDrove && shotOverlays.length) {
    overlays = overlays.filter((o) => o.kind !== "headline").concat(shotOverlays);
  } else {
    overlays = overlays.concat(shotOverlays);
  }

  const brandColorHex = brief?.brand?.colors?.[0] || input.productProfile?.brandColors?.[0] || null;
  const accentHex = brief?.brand?.colors?.[1] || brandColorHex || "#ff5a24";

  const { buffer, durationSec } = await renderScreenAd({
    scenes, overlays, width, height, brandColorHex, accentHex,
  });

  // Per-shot production report: requested technique vs the method actually
  // executed, and whether the frame was genuinely AI-generated. This is the
  // honest "AI-generated vs deterministic" accounting the UI surfaces.
  const shotReport = scenes.map((s, i) => ({
    shot: i + 1,
    intent: s.intent || s.purpose || null,
    requestedTechnique: s.requestedTechnique || "(none)",
    executedMethod: s.executedMethod,
    aiGenerated: GENERATIVE_TECHNIQUES.has(s.executedMethod),
    downgradedFrom: s.downgradedFrom || null,
    usedRealAsset: Boolean(s.imagePath) && !GENERATIVE_TECHNIQUES.has(s.executedMethod),
    onScreenText: s.onScreenText || "",
    durationSec: Number(s.durationSec.toFixed?.(2) ?? s.durationSec),
  }));

  return {
    videoBase64: buffer.toString("base64"),
    mimeType: "video/mp4",
    durationSec,
    width,
    height,
    usedImages: imagePaths.length,
    overlays,
    method: "screen_demo",
    storyboardDriven: storyboardDrove,
    // "ai" (Creative Director) vs "fallback" (deterministic storyboard) vs null.
    // The UI must NOT claim AI direction for a fallback.
    storyboardOrigin,
    shotReport,
  };
}

export const _internal = { resolveImagePath, buildOverlays, extractUrl, buildScenes, collectImagePaths, buildShotOverlays, pickRealImage };
