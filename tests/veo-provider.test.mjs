/**
 * Veo provider — video extraction correctness (no network, no key, no cost).
 *
 * Regression tests for the real 502 bug: the SDK's `ai.files.download()`
 * returns void (it writes to downloadPath / mutates the Video), so the old code
 * that read a return value always produced a false "no downloadable video" 502
 * even on success. These exercise `extractVeoVideo` with a fake SDK.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import { extractVeoVideo } from "../lib/ai/veoProvider.js";
import { ProviderError } from "../lib/ai/provider.js";

function op(video, extra = {}) {
  return { done: true, response: { generatedVideos: video ? [{ video }] : [], ...extra } };
}

test("inline videoBytes are returned directly (no download)", async () => {
  const ai = { files: { download: async () => { throw new Error("should not be called"); } } };
  const out = await extractVeoVideo(ai, op({ videoBytes: "QUJD", mimeType: "video/mp4" }));
  assert.equal(out.data, "QUJD");
  assert.equal(out.mimeType, "video/mp4");
});

test("downloads to a temp file and reads bytes back when no inline bytes", async () => {
  // Fake SDK: writes real bytes to the requested downloadPath (what the real
  // SDK does for the Gemini API) and returns void.
  const ai = {
    files: {
      download: async ({ downloadPath }) => {
        await fs.writeFile(downloadPath, Buffer.from("hello-mp4"));
      },
    },
  };
  const out = await extractVeoVideo(ai, op({ uri: "https://files/x", mimeType: "video/mp4" }));
  assert.equal(Buffer.from(out.data, "base64").toString(), "hello-mp4");
});

test("populating videoBytes in-place during download is honored", async () => {
  const video = { uri: "https://files/y" };
  const ai = {
    files: {
      download: async () => {
        video.videoBytes = "WFla"; // SDK mutated the object in place
      },
    },
  };
  const out = await extractVeoVideo(ai, op(video));
  assert.equal(out.data, "WFla");
});

test("RAI-filtered result throws a descriptive error (not a bare 502)", async () => {
  const ai = { files: { download: async () => {} } };
  await assert.rejects(
    () => extractVeoVideo(ai, op(null, { raiMediaFilteredReasons: ["unsafe content"] })),
    (e) => e instanceof ProviderError && /filtered/i.test(e.message) && /unsafe content/.test(e.message)
  );
});

test("download failure surfaces the real message", async () => {
  const ai = { files: { download: async () => { throw new Error("network boom"); } } };
  await assert.rejects(
    () => extractVeoVideo(ai, op({ uri: "https://files/z" })),
    (e) => e instanceof ProviderError && /download failed/i.test(e.message) && /network boom/.test(e.message)
  );
});

test("empty downloaded file is NOT treated as success", async () => {
  const ai = {
    files: {
      download: async ({ downloadPath }) => { await fs.writeFile(downloadPath, Buffer.alloc(0)); },
    },
  };
  await assert.rejects(
    () => extractVeoVideo(ai, op({ uri: "https://files/empty" })),
    (e) => e instanceof ProviderError && e.status === 502
  );
});

test("temp files are cleaned up after extraction", async () => {
  const before = (await fs.readdir(os.tmpdir())).filter((f) => f.startsWith("veo-")).length;
  const ai = {
    files: { download: async ({ downloadPath }) => { await fs.writeFile(downloadPath, Buffer.from("x")); } },
  };
  await extractVeoVideo(ai, op({ uri: "https://files/clean" }));
  const after = (await fs.readdir(os.tmpdir())).filter((f) => f.startsWith("veo-")).length;
  assert.ok(after <= before, `temp veo-* files should be cleaned up (before=${before}, after=${after})`);
});
