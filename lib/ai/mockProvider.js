/**
 * Mock video provider.
 *
 * Produces a tiny, clearly-labeled placeholder MP4 WITHOUT calling any API and
 * WITHOUT any cost. Used for UI development and automated tests so we never
 * accidentally spend money. The result is flagged `mock: true` and callers MUST
 * surface that to the user — we never claim a real generation occurred.
 */

import { estimateCost } from "../costs/estimate.js";

/**
 * A minimal valid MP4 (ftyp + empty moov). It is not watchable footage; it is a
 * deliberately empty placeholder so the download/playback plumbing can be
 * exercised without pretending to be AI-generated content.
 *
 * Bytes: ftyp(isom) box + empty moov box.
 */
function buildPlaceholderMp4Base64() {
  const boxes = [];

  // ftyp box
  const ftypBody = Buffer.concat([
    Buffer.from("isom", "ascii"), // major brand
    Buffer.from([0, 0, 0, 1]), // minor version
    Buffer.from("isom", "ascii"), // compatible brand
    Buffer.from("mp42", "ascii"), // compatible brand
  ]);
  boxes.push(sizedBox("ftyp", ftypBody));

  // minimal empty moov box
  boxes.push(sizedBox("moov", Buffer.alloc(0)));

  return Buffer.concat(boxes).toString("base64");
}

/**
 * @param {string} type 4-char box type
 * @param {Buffer} body
 */
function sizedBox(type, body) {
  const size = 8 + body.length;
  const header = Buffer.alloc(8);
  header.writeUInt32BE(size, 0);
  header.write(type, 4, "ascii");
  return Buffer.concat([header, body]);
}

const PLACEHOLDER_MP4_B64 = buildPlaceholderMp4Base64();

/**
 * @param {import("./provider.js").ProviderError} [_unused]
 */
export function createMockProvider() {
  return {
    name: "mock",
    /**
     * @param {{ durationSeconds?: number, resolution?: string }} request
     */
    async generate(request) {
      // Simulate a little latency so loading states are visible in the UI.
      await new Promise((r) => setTimeout(r, 400));
      const est = estimateCost({
        durationSeconds: request.durationSeconds,
        resolution: request.resolution,
      });
      return {
        videoBase64: PLACEHOLDER_MP4_B64,
        mimeType: "video/mp4",
        provider: "mock",
        model: "mock",
        // Mock never bills; estimate shown is what the real call WOULD cost.
        cost: { amountUsd: 0, state: "estimated" },
        estimatedIfReal: est,
        mock: true,
      };
    },
  };
}
