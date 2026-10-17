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
import { computeTimeline, transitionAfter, pickFps, renderScreenAd } from "../lib/render/screenRenderer.js";
import { runMediaChecks } from "../lib/quality/mediaChecks.js";
import { runFfmpeg } from "../lib/render/ffmpeg.js";
import { submitJob } from "../lib/jobs/runner.js";

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

test("timeline: storyboard transitions (cut = one frame, fade into the closing card)", () => {
  const scenes = [
    { videoPath: "a.mp4", durationSec: 3, transitionOut: "cut" },
    { imagePath: "b.png", durationSec: 3, transitionOut: "whip" },
    { durationSec: 2.5, intent: "cta" },
  ];
  const fps = pickFps(scenes);
  assert.equal(fps, 24, "footage drives 24 fps");
  assert.equal(transitionAfter(scenes, 0, fps).d, Number((1 / 24).toFixed(4)));
  const intoEnd = transitionAfter(scenes, 1, fps);
  assert.equal(intoEnd.xf, "fade");
  const tl = computeTimeline(scenes, fps);
  assert.ok(Math.abs(tl.total - (8.5 - tl.xfades.reduce((a, x) => a + x.d, 0))) < 0.002);
  assert.equal(tl.starts.length, 3);
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
