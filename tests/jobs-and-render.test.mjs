/**
 * Durable jobs (idempotency, leases, recovery) and the renderer's timeline +
 * export checks on a real (tiny, deterministic) ffmpeg render. No paid calls.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import { createJob, getJob, claimJob, heartbeat, recoverableJobIds, updateJob, publicSummary } from "../lib/jobs/jobStore.js";
import { computeTimeline, transitionAfter, pickFps, renderScreenAd, verifyShotCoverage } from "../lib/render/screenRenderer.js";
import { runMediaChecks } from "../lib/quality/mediaChecks.js";
import { runFfmpeg, grayBandThumb } from "../lib/render/ffmpeg.js";
import { submitJob } from "../lib/jobs/runner.js";
import { veoPromptFor } from "../lib/ai/veoProvider.js";
import { getModelInfo } from "../lib/ai/modelRegistry.js";

test("same idempotency key → same job (double click / second tab never creates a second paid job)", () => {
  const key = `test-${Math.random()}`;
  const a = createJob({ body: { productName: "X" }, idempotencyKey: key });
  const b = createJob({ body: { productName: "X" }, idempotencyKey: key });
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(a.job.id, b.job.id);
});

test("an uploaded image is kept out of the JSON record and restored for execution", async () => {
  const { job } = createJob({ body: { productName: "X", image: { data: Buffer.from("fakepng").toString("base64"), mimeType: "image/png" } }, idempotencyKey: `img-${Math.random()}` });
  const stored = getJob(job.id);
  assert.equal(stored.request.image.data, undefined);
  assert.match(stored.request.image.file, /input-image\.png$/);
  const { requestForExecution } = await import("../lib/jobs/jobStore.js");
  assert.equal(Buffer.from(requestForExecution(stored).image.data, "base64").toString(), "fakepng");
});

test("leases: one owner at a time; a dead owner's lease is recoverable", () => {
  const { job } = createJob({ body: { productName: "Y" }, idempotencyKey: `lease-${Math.random()}` });
  const a = claimJob(job.id, "owner-a", 60_000);
  assert.equal(a.status, "running");
  assert.equal(claimJob(job.id, "owner-b", 60_000), null, "second owner cannot claim a live lease");
  heartbeat(job.id, "owner-a", 60_000);
  assert.ok(!recoverableJobIds().includes(job.id));
  updateJob(job.id, (j) => { j.lease.until = new Date(Date.now() - 1000).toISOString(); });
  assert.ok(recoverableJobIds().includes(job.id), "expired lease → recoverable");
  const b = claimJob(job.id, "owner-b", 60_000);
  assert.equal(b.lease.owner, "owner-b");
  assert.ok(b.events.some((e) => /resuming/i.test(e.message)));
});

test("public job summary hides local paths and the raw request", () => {
  const { job } = createJob({ body: { productName: "Z", productProfile: { secretish: "x" } }, idempotencyKey: `pub-${Math.random()}` });
  updateJob(job.id, (j) => { j.result = { video: "C:/secret/path/final.mp4", durationSec: 3 }; });
  const pub = publicSummary(getJob(job.id));
  assert.equal(pub.request, undefined);
  assert.equal(pub.result.video, undefined);
  assert.equal(pub.hasVideo, true);
});

test("submitJob refuses explicit unsupported formats before creating a job", async () => {
  const r = await submitJob({ productName: "X", aspectRatio: "4:5" });
  assert.equal(r.status, 422);
  assert.equal(r.body.code, "VALIDATION");
});

test("timeline: whole-frame transitions, planned shot starts and the planned total (MAC-015/016)", () => {
  const scenes = [
    { videoPath: "a.mp4", durationSec: 3, transitionOut: "cut" },
    { imagePath: "b.png", durationSec: 3, transitionOut: "whip" },
    { durationSec: 2.5, intent: "cta" },
  ];
  const fps = pickFps(scenes);
  assert.equal(fps, 24, "footage drives 24 fps");
  assert.deepEqual(transitionAfter(scenes, 0, fps), { xf: "fade", frames: 1, d: 1 / 24 });
  assert.equal(transitionAfter(scenes, 1, fps).xf, "fade", "the cut into the closing card is a short fade");
  const tl = computeTimeline(scenes, fps);
  assert.deepEqual(tl.frames, [72, 72, 60]);
  assert.deepEqual(tl.startFrames, [0, 72, 144], "every shot starts where the plan says");
  assert.deepEqual(tl.starts, [0, 3, 6]);
  assert.equal(tl.total, 8.5, "the export is exactly as long as the plan");
  for (const x of tl.xfades) assert.ok(Number.isInteger(x.frames) && x.frames >= 1);
  assert.deepEqual(tl.renderFrames, [72 + 1 + 1, 72 + tl.xfades[1].frames + 1, 60], "outgoing shots are rendered long enough to feed their transition");
  // A transition never eats more than a third of a short shot.
  const short = computeTimeline([{ videoPath: "a", durationSec: 1.2, transitionOut: "dissolve" }, { videoPath: "b", durationSec: 1.2 }], 24);
  assert.ok(short.xfades[0].frames <= Math.floor(short.frames[0] / 3));
});

test("Veo 3.1 Lite gets negatives in the prompt (the API rejects negativePrompt); Fast keeps the parameter (MAC-014)", () => {
  const req = { prompt: "A woman walks through a sunlit loft.", negativePrompt: "text, watermark, letterbox." };
  const lite = veoPromptFor(req, getModelInfo("veo-3.1-lite"));
  assert.equal(lite.negativePrompt, null);
  assert.match(lite.prompt, /Avoid: text, watermark, letterbox\.$/);
  const fast = veoPromptFor(req, getModelInfo("veo-3.1-fast"));
  assert.equal(fast.prompt, req.prompt);
  assert.equal(fast.negativePrompt, "text, watermark, letterbox.");
  assert.deepEqual(veoPromptFor({ prompt: "p" }, getModelInfo("veo-3.1-lite")), { prompt: "p", negativePrompt: null });
});

/** Solid-grey 9:16 test clip (distinct luma per shot). */
async function greyClip(file, level, seconds) {
  const hex = level.toString(16).padStart(2, "0").repeat(3);
  await runFfmpeg(["-y", "-f", "lavfi", "-i", `color=c=0x${hex}:s=180x320:r=24:d=${seconds}`, "-pix_fmt", "yuv420p", file]);
}
const bandMean = (buf) => buf.reduce((a, v) => a + v, 0) / buf.length;

test("every shot is on screen at its planned time — three 1.5s cuts used to lose shot 3 (MAC-015)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mac-assembly-test-"));
  try {
    const levels = [220, 128, 60];
    const scenes = [];
    for (let i = 0; i < levels.length; i++) {
      const clip = path.join(dir, `s${i}.mp4`);
      await greyClip(clip, levels[i], 2);
      scenes.push({ videoPath: clip, durationSec: 1.5, transitionOut: "cut" });
    }
    scenes.push({ durationSec: 1.2, intent: "cta", purpose: "end" });
    const out = await renderScreenAd({ scenes, overlays: [], width: 180, height: 320, brandColorHex: "#223366", accentHex: "#ff5a24" });
    const file = path.join(dir, "out.mp4");
    await fs.writeFile(file, out.buffer);
    assert.ok(Math.abs(out.durationSec - 5.7) < 0.05, `planned 5.7s, got ${out.durationSec}`);
    assert.equal(out.assembly.joinMode, "xfade");
    assert.equal(out.assembly.checkedShots, 3);
    for (let i = 0; i < levels.length; i++) {
      const mid = out.timeline.starts[i] + 0.75;
      const seen = bandMean(await grayBandThumb(file, mid));
      // Studio-range luma: allow for the grey → YUV → grey round trip.
      assert.ok(Math.abs(seen - levels[i]) < 16, `shot ${i + 1} at ${mid}s shows luma ${seen.toFixed(0)}, expected ≈${levels[i]}`);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("the assembly check reports a shot that is not on screen", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mac-coverage-test-"));
  try {
    const a = path.join(dir, "a.mp4");
    const b = path.join(dir, "b.mp4");
    const c = path.join(dir, "c.mp4");
    await greyClip(a, 220, 1.5);
    await greyClip(b, 128, 1.5);
    await greyClip(c, 60, 1.5);
    // A "composite" that shows A, B, B: shot 3 never appears.
    const bad = path.join(dir, "bad.mp4");
    await runFfmpeg(["-y", "-i", a, "-i", b, "-i", b, "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]", "-map", "[v]", "-pix_fmt", "yuv420p", bad]);
    const tl = computeTimeline([{ videoPath: a, durationSec: 1.5 }, { videoPath: b, durationSec: 1.5 }, { videoPath: c, durationSec: 1.5 }], 24);
    const clips = [a, b, c].map((p) => ({ path: p, mode: "footage" }));
    const res = await verifyShotCoverage(clips, bad, tl);
    assert.equal(res.checked, 3);
    assert.deepEqual(res.missing.map((m) => m.shot), [3]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("renders a small ad end to end and the export checks measure the real file", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mac-render-test-"));
  try {
    const clip = path.join(dir, "c.mp4");
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "testsrc2=size=180x320:rate=24:duration=2.5", "-f", "lavfi", "-i", "sine=frequency=330:duration=2.5", "-shortest", "-pix_fmt", "yuv420p", clip]);
    const scenes = [{ videoPath: clip, durationSec: 2.2, transitionOut: "cut", onScreenText: "Ab skincare hua easy" }, { durationSec: 1.6, intent: "cta" }];
    const tl = computeTimeline(scenes, 24);
    const overlays = [
      { kind: "shot", text: "अब skincare हुआ easy", start: 0.2, end: tl.starts[1] },
      { kind: "cta", text: "Shop now", start: tl.starts[1] + 0.2, end: tl.total },
    ];
    const out = await renderScreenAd({ scenes, overlays, width: 180, height: 320, brandColorHex: "#223366", accentHex: "#ff5a24" });
    const file = path.join(dir, "out.mp4");
    await fs.writeFile(file, out.buffer);
    assert.equal(out.fps, 24);
    assert.equal(out.placedOverlays.length, 2);
    const checks = await runMediaChecks({
      file,
      composed: { ...out, quality: { requestedVideoShots: 0, aiVideoShots: 0, audioDetail: {} }, shotReport: [{ onScreenText: "Ab skincare hua easy", voiceover: "" }], voiceoverTempo: 1 },
      input: { narration: false, language: { mode: "mixed", preset: "hinglish" } },
      compiled: {},
    });
    assert.equal(checks.technical.measurements.width, 180);
    assert.ok(["pass", "warn"].includes(checks.technical.status), JSON.stringify(checks.technical.findings));
    assert.equal(checks.creative.status, "not_reviewed");
    assert.ok(!checks.language.findings.some((f) => f.code === "MISSING_GLYPHS"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
