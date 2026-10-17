/**
 * Content-level image checks for imported assets (beyond "it decodes").
 *
 * Calibrated on the H&M regression import (2026-10-17):
 *   product packshots / editorial: sharpness 1.36–3.5, edge share ≥ 0.016
 *   decorative textures (brushed gold, soft gradients): sharpness ≈ 0.35, edges 0.000
 *   bot-block / error-page captures: entropy < 0.6, ~98% white
 * A texture can still be useful brand atmosphere but is never a product; a
 * near-blank capture is evidence the page did not render for us.
 */

import sharp from "sharp";

/** @returns {Promise<{ entropy: number, sharpness: number, edgeShare: number, whiteShare: number, verdict: "ok"|"texture"|"blank" }>} */
export async function analyzeImageQuality(buffer) {
  const small = await sharp(buffer).resize(256, 256, { fit: "inside" }).greyscale().toBuffer();
  const st = await sharp(small).stats();
  const { data, info } = await sharp(small).convolve({ width: 3, height: 3, kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0] }).raw().toBuffer({ resolveWithObject: true });
  let strong = 0;
  for (let i = 0; i < data.length; i += info.channels) if (data[i] > 24) strong++;
  const edgeShare = strong / (data.length / info.channels);
  const { data: g } = await sharp(small).raw().toBuffer({ resolveWithObject: true });
  let white = 0;
  for (const v of g) if (v > 235) white++;
  const whiteShare = white / g.length;
  const entropy = st.entropy;
  const sharpness = st.sharpness;
  let verdict = "ok";
  if (entropy < 1.0 && whiteShare > 0.9) verdict = "blank";
  else if (sharpness < 0.8 && edgeShare < 0.005) verdict = "texture";
  return {
    entropy: Number(entropy.toFixed(2)), sharpness: Number(sharpness.toFixed(2)),
    edgeShare: Number(edgeShare.toFixed(3)), whiteShare: Number(whiteShare.toFixed(2)), verdict,
  };
}
