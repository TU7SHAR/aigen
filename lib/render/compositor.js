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
 * @param {object} input validated generate request
 */
async function collectImagePaths(input) {
  const urls = [];
  if (Array.isArray(input.referenceAssets) && input.referenceAssets.length) {
    const primaryFirst = [...input.referenceAssets].sort((a, b) => (b.primary ? 1 : 0) - (a.primary ? 1 : 0));
    for (const a of primaryFirst) urls.push(a.url);
  } else if (input.referenceAssetUrl) {
    urls.push(input.referenceAssetUrl);
  }
  // Also honor an array of gallery urls if the client sent them.
  if (Array.isArray(input.galleryUrls)) urls.push(...input.galleryUrls);

  const seen = new Set();
  const paths = [];
  for (const u of urls) {
    if (seen.has(u)) continue;
    seen.add(u);
    const p = await resolveImagePath(u);
    if (p) paths.push(p);
  }
  return paths;
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

/** Pull an exact website URL from the request/profile — never invented. */
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

/** Map scenePlan scenes → render scenes, distributing real images across them. */
function buildScenes(scenePlan, imagePaths, brief) {
  const planned = scenePlan?.scenes?.length ? scenePlan.scenes : [{ purpose: "establish", duration: 3, motion: "controlled" }];
  const scenes = [];
  for (let i = 0; i < planned.length; i++) {
    const s = planned[i];
    // Assign a real image per scene (cycle through available ones). If none,
    // the renderer draws a clean branded card (no fabricated UI).
    const imagePath = imagePaths.length ? imagePaths[i % imagePaths.length] : null;
    scenes.push({
      imagePath,
      durationSec: Number(s.duration) || Math.max(1.5, (scenePlan?.totalDuration || 6) / planned.length),
      motion: s.motion,
      purpose: s.purpose,
      kenBurns: s.kenBurns,
    });
  }
  return scenes;
}

/**
 * Compose a finished screen-based ad from the compiled plan + request.
 * @param {{ input: object, compiled: object }} args
 * @returns {Promise<{ videoBase64: string, mimeType: string, durationSec: number,
 *   width: number, height: number, usedImages: number, overlays: object[], method: string }>}
 */
export async function composeScreenAd({ input, compiled }) {
  const { width, height } = frameSize(input.aspectRatio, input.resolution);
  const imagePaths = await collectImagePaths(input);
  const brief = compiled?.brief || {};
  const scenes = buildScenes(compiled?.scenePlan, imagePaths, brief);
  const totalDur = scenes.reduce((a, s) => a + s.durationSec, 0);

  const overlays = buildOverlays(input, brief, totalDur);
  const brandColorHex = brief?.brand?.colors?.[0] || input.productProfile?.brandColors?.[0] || null;
  const accentHex = brief?.brand?.colors?.[1] || brandColorHex || "#ff5a24";

  const { buffer, durationSec } = await renderScreenAd({
    scenes, overlays, width, height, brandColorHex, accentHex,
  });

  return {
    videoBase64: buffer.toString("base64"),
    mimeType: "video/mp4",
    durationSec,
    width,
    height,
    usedImages: imagePaths.length,
    overlays,
    method: "screen_demo",
  };
}

export const _internal = { resolveImagePath, buildOverlays, extractUrl, buildScenes, collectImagePaths };
