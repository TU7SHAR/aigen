/**
 * QUALITY BASELINE HARNESS (step 1).
 *
 * For a given brand input, runs the REAL pipeline end-to-end with the mock /
 * deterministic path (NO paid calls) and records:
 *   - import result (entity, assets, colors)   → what the system "understands"
 *   - compiled shot plan (scenes)              → the creative brief
 *   - a rendered MP4 via the compositor        → the actual output
 *   - extracted frames                         → so a human can judge polish
 *
 * Usage: node scripts/baseline.mjs <out-dir>
 * Writes <out-dir>/<slug>.report.json, <slug>.mp4, <slug>.frameN.png
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { compileCreativeRequest } from "../lib/creative/compile.js";
import { composeScreenAd } from "../lib/render/compositor.js";
import { runFfmpeg } from "../lib/render/ffmpeg.js";

export async function runBaseline({ label, input, importResult, outDir }) {
  await fs.mkdir(outDir, { recursive: true });
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  const compiled = compileCreativeRequest(input);
  const composed = await composeScreenAd({ input, compiled });

  const mp4Path = path.join(outDir, `${slug}.mp4`);
  await fs.writeFile(mp4Path, Buffer.from(composed.videoBase64, "base64"));

  // Extract 3 frames (start / middle / end) for human review.
  const frames = [];
  const times = [0.5, Math.max(1, (composed.durationSec || 5) / 2), Math.max(1.5, (composed.durationSec || 5) - 0.6)];
  for (let i = 0; i < times.length; i++) {
    const fp = path.join(outDir, `${slug}.frame${i}.png`);
    // eslint-disable-next-line no-await-in-loop
    await runFfmpeg(["-y", "-ss", String(times[i]), "-i", mp4Path, "-frames:v", "1", fp]);
    frames.push(fp);
  }

  const report = {
    label,
    understanding: {
      entityType: compiled.entityType,
      importedEntityType: importResult?.entityType ?? null,
      name: input.productName,
      brand: input.brand,
      brandColors: compiled.brief?.brand?.colors || [],
      assetCount: (input.referenceAssets || []).length,
    },
    shotPlan: (compiled.scenePlan?.scenes || []).map((s, i) => ({
      scene: i + 1, purpose: s.purpose, durationSec: s.duration, visual: s.visual, camera: s.camera, motion: s.motion,
    })),
    render: {
      provider: "compositor", durationSec: composed.durationSec,
      usedImages: composed.usedImages, width: composed.width, height: composed.height,
      overlays: composed.overlays.map((o) => ({ kind: o.kind, text: o.text })),
      mp4Bytes: Buffer.from(composed.videoBase64, "base64").length,
    },
    finalPromptPreview: (compiled.finalVideoPrompt || "").slice(0, 400),
    files: { mp4: mp4Path, frames },
  };
  await fs.writeFile(path.join(outDir, `${slug}.report.json`), JSON.stringify(report, null, 2));
  return report;
}
