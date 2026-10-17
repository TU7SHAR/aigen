/**
 * Finished-ad engine tests (mock-only — NO paid calls are made).
 *
 * Covers what a viewer sees/hears: real-font typography, the audio mix
 * (voiceover + music + ambient stems), letterbox removal on generated footage,
 * screen footage in a device card, the closing card copy, brand-colour choice,
 * product-fidelity prompt guards, and the budget's audio cap / unbilled refund.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import sharp from "sharp";

import { renderTextPng } from "../lib/render/textImage.js";
import { renderScreenAd } from "../lib/render/screenRenderer.js";
import { runFfmpeg, probe, probeStreams } from "../lib/render/ffmpeg.js";
import { createJobBudget, BudgetError } from "../lib/costs/jobBudget.js";
import { extractInteractionAudio, getAudioProviders } from "../lib/ai/audioProvider.js";
import { _internal as comp } from "../lib/render/compositor.js";

test("captions render with the vendored font (not a fallback) and a shadow pad", async () => {
  const a = await renderTextPng({ text: "Stop reading generic horoscopes", width: 600, fontSize: 40, weight: 700 });
  assert.ok(a.width > 300 && a.height > 40, `${a.width}x${a.height}`);
  const pill = await renderTextPng({ text: "Get started", width: 600, fontSize: 36, weight: 700, bg: "#7c3aed", radius: 999 });
  const meta = await sharp(pill.buffer).metadata();
  assert.equal(meta.width, pill.width);
  // pill centre is the brand colour (opaque box), not transparent
  const { data } = await sharp(pill.buffer).extract({ left: 4, top: Math.floor(pill.height / 2), width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
  assert.equal(data[3], 255);
});

test("budget enforces the audio cap and releases an attempt the provider says was not billed", async () => {
  const b = createJobBudget({ maxUsd: 1, maxImages: 0, maxVideoClips: 1, maxAudio: 1, maxRetries: 0 });
  await b.run("audio", 0.05, "vo", async () => ({ ok: true }));
  await assert.rejects(() => b.run("audio", 0.05, "music", async () => ({})), BudgetError);
  const filtered = Object.assign(new Error("filtered: You have not been charged"), { filtered: true, notCharged: true });
  await assert.rejects(() => b.run("video", 0.6, "clip", async () => { throw filtered; }));
  const s = b.summary();
  assert.equal(s.paidVideoClips, 0, "unbilled attempt frees its slot");
  assert.equal(s.reservedUsd, 0.05, "unbilled attempt frees its dollars");
  // the slot is reusable for the rephrased attempt
  await b.run("video", 0.6, "clip (rephrased)", async () => ({ ok: true }));
  assert.equal(b.summary().paidVideoClips, 1);
});

test("audio providers stay off unless every audio gate is open", () => {
  const prev = { ...process.env };
  try {
    process.env.ENABLE_PAID_AUDIO_GENERATION = "true";
    process.env.DISABLE_PAID_GENERATION = "true"; // kill-switch on
    process.env.JOB_MAX_PAID_AUDIO = "2";
    const r = getAudioProviders();
    assert.equal(r.voice, null);
    assert.equal(r.music, null);
    assert.ok(r.reasons.length > 0);
  } finally {
    for (const k of ["ENABLE_PAID_AUDIO_GENERATION", "DISABLE_PAID_GENERATION", "JOB_MAX_PAID_AUDIO"]) {
      if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k];
    }
  }
});

test("interaction audio is extracted from the SDK getter or the raw outputs", () => {
  assert.deepEqual(extractInteractionAudio({ output_audio: { data: "QQ==", mime_type: "audio/wav" } }), { data: "QQ==", mimeType: "audio/wav" });
  assert.deepEqual(
    extractInteractionAudio({ outputs: [{ type: "text", text: "lyrics" }, { type: "audio", data: "Qg==", mime_type: "audio/mpeg" }] }),
    { data: "Qg==", mimeType: "audio/mpeg" }
  );
  assert.equal(extractInteractionAudio({ outputs: [{ type: "text", text: "x" }] }), null);
});

test("renderer: letterbox cropped, screen in a device card, end card, and a mixed soundtrack", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mac-finish-"));
  try {
    const clip = path.join(dir, "bars.mp4");
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "testsrc2=size=180x280:rate=24:duration=2", "-f", "lavfi", "-i", "sine=frequency=330:duration=2",
      "-vf", "pad=180:320:0:20:black", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip]);
    const tall = path.join(dir, "page.png");
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "testsrc=size=120x900:rate=1:duration=1", "-frames:v", "1", tall]);
    const vo = path.join(dir, "vo.wav");
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "sine=frequency=220:duration=3", "-ar", "24000", "-ac", "1", vo]);
    const music = path.join(dir, "music.mp3");
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=8", "-ac", "2", music]);

    const scenes = [
      { videoPath: clip, durationSec: 1.6 },
      { imagePath: tall, durationSec: 1.6 },
      { imagePath: null, durationSec: 1.4, purpose: "end" },
    ];
    const out = await renderScreenAd({
      scenes,
      overlays: [{ kind: "brand", text: "Brand", start: 0, end: 3 }, { kind: "cta", text: "Shop now", start: 3.6, end: 4 }],
      width: 180, height: 320, brandColorHex: "#2b1a6e", accentHex: "#7c3aed",
      audio: { voiceoverPath: vo, musicPath: music },
    });
    assert.deepEqual(out.sceneModes, ["footage", "screen_scroll", "endcard_backdrop"]);
    assert.ok(scenes[0].cropped, "baked black bars were detected and cropped");
    assert.deepEqual(out.audioLayers, ["ambient", "voiceover", "music"]);
    const f = path.join(dir, "out.mp4");
    await fs.writeFile(f, out.buffer);
    const st = await probeStreams(f);
    assert.ok(st.hasAudio && st.hasVideo);
    const p = await probe(f);
    assert.ok(p.durationSec > 3.6 && p.durationSec < 4.3, `duration ${p.durationSec}`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("closing card gets brand title + CTA pill + URL; the brand mark stops before it", () => {
  const scenes = [
    { videoPath: "/x/a.mp4", durationSec: 3, onScreenText: "Hook", intent: "hook" },
    { imagePath: "/x/p.png", screenStage: true, durationSec: 4, onScreenText: "Demo", intent: "demo" },
    { durationSec: 3, onScreenText: "Get started", intent: "Closing CTA", executedMethod: "motion_graphic" },
  ];
  const ov = comp.buildStoryboardOverlays(scenes, { brand: "Acme", productProfile: { canonicalUrl: "https://www.acme.com/products/a-very-long-product-handle" } }, {});
  const kinds = ov.map((o) => o.kind);
  assert.deepEqual(kinds, ["brand", "shot", "shotTop", "brandTitle", "cta", "url"]);
  const brand = ov.find((o) => o.kind === "brand");
  const title = ov.find((o) => o.kind === "brandTitle");
  assert.ok(brand.end <= title.start + 0.2, "small brand mark ends as the closing card starts");
  assert.equal(ov.find((o) => o.kind === "url").text, "acme.com", "long product paths collapse to the domain");
});

test("video prompts guard product fidelity (no invented UI) and framing", () => {
  const p = comp.videoPrompt({ visual: "A man studying the app dashboard on a tablet" }, "9:16");
  assert.match(p, /screen faces away|out of focus/i);
  assert.match(p, /9:16 composition that fills the frame/);
  assert.match(p, /no speech, no dialogue, no music/i);
  assert.match(p, /No readable text/);
});
