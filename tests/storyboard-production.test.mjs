/**
 * Per-shot production routing — the AI Creative Director's storyboard must
 * drive the compositor: each shot's technique is honored, exact on-screen copy
 * is confined to the shot's time window, asset hints match by role, and
 * ai_image/ai_video with NO model frame degrade deterministically (never a
 * fabricated "AI" frame).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { _internal as comp } from "../lib/render/compositor.js";

const storyboardPlan = {
  storyboardOrigin: "ai",
  totalDuration: 8,
  scenes: [
    { intent: "hook", duration: 2.5, technique: "motion_graphic", assetHint: "none", onScreenText: "Ship ads in minutes", motion: "kinetic" },
    { intent: "proof", duration: 3, technique: "real_asset", assetHint: "screenshot", onScreenText: "Your dashboard, animated", motion: "slow push-in" },
    { intent: "dream", duration: 1.5, technique: "ai_video", assetHint: "none", onScreenText: "", motion: "drift" },
    { intent: "cta", duration: 1, technique: "motion_graphic", assetHint: "logo", onScreenText: "Start free", motion: "hold" },
  ],
};

test("buildScenes honors per-shot technique and records executed method", () => {
  const imagePaths = ["/screens/dash.png"];
  const assetMeta = [{ role: "screenshot", url: "/imported-assets/dash.png" }];
  const scenes = comp.buildScenes(storyboardPlan, imagePaths, {}, assetMeta);

  assert.equal(scenes.length, 4);
  // motion_graphic → deterministic card, no image
  assert.equal(scenes[0].executedMethod, "motion_graphic");
  assert.equal(scenes[0].imagePath, null);
  // real_asset → animates the matched real image (by role hint)
  assert.equal(scenes[1].executedMethod, "real_asset");
  assert.equal(scenes[1].imagePath, "/screens/dash.png");
  // ai_video with NO generated frame → honest deterministic downgrade
  assert.equal(scenes[2].aiGenerated, undefined); // not a report field here
  assert.equal(scenes[2].downgradedFrom, "ai_video");
  assert.notEqual(scenes[2].executedMethod, "ai_video"); // never claims AI it didn't do
});

test("ai_image/ai_video with a supplied model frame is genuinely honored", () => {
  const plan = {
    storyboardOrigin: "ai",
    totalDuration: 3,
    scenes: [{ intent: "b-roll", duration: 3, technique: "ai_image", assetHint: "none", generatedImagePath: "/gen/frame0.png" }],
  };
  const scenes = comp.buildScenes(plan, [], {}, []);
  assert.equal(scenes[0].executedMethod, "ai_image");
  assert.equal(scenes[0].imagePath, "/gen/frame0.png");
  assert.equal(scenes[0].downgradedFrom, null);
});

test("buildShotOverlays confines each shot's exact copy to its own window", () => {
  const scenes = comp.buildScenes(storyboardPlan, ["/screens/dash.png"], {}, [{ role: "screenshot" }]);
  const overlays = comp.buildShotOverlays(scenes);
  // 3 shots carry onScreenText; the empty ai_video shot contributes none.
  assert.equal(overlays.length, 3);
  assert.ok(overlays.every((o) => o.kind === "shot"));
  // windows are ordered and non-overlapping-ish (each starts after prior start)
  for (let i = 1; i < overlays.length; i++) {
    assert.ok(overlays[i].start >= overlays[i - 1].start);
  }
  // exact authored copy, never invented
  assert.equal(overlays[0].text, "Ship ads in minutes");
});

test("pickRealImage matches a shot's assetHint to an asset role", () => {
  const paths = ["/a-hero.png", "/b-shot.png"];
  const meta = [{ role: "hero" }, { role: "screenshot" }];
  const hit = comp.pickRealImage({ assetHint: "screenshot" }, paths, meta, 0);
  assert.equal(hit.path, "/b-shot.png");
  // no match → round-robin from cursor
  const rr = comp.pickRealImage({ assetHint: "none" }, paths, meta, 1);
  assert.equal(rr.path, "/b-shot.png");
  assert.equal(rr.nextCursor, 2);
});

test("non-storyboard plan still round-robins images (back-compat)", () => {
  const plan = { scenes: [{ purpose: "establish", duration: 3 }, { purpose: "detail", duration: 2 }, { purpose: "end", duration: 2 }], totalDuration: 7 };
  const scenes = comp.buildScenes(plan, ["/a.png", "/b.png"], {});
  assert.equal(scenes[0].imagePath, "/a.png");
  assert.equal(scenes[1].imagePath, "/b.png");
  assert.equal(scenes[2].imagePath, "/a.png"); // cycles
});

test("all-empty onScreenText keeps the global headline (no silent copy-less ad)", () => {
  // If a storyboard's shots carry NO on-screen text, buildShotOverlays yields
  // nothing — so the caller must NOT drop the global headline. Guard the
  // precondition the compositor relies on: shotOverlays.length === 0.
  const plan = {
    storyboardOrigin: "ai",
    totalDuration: 4,
    scenes: [{ intent: "a", duration: 2, technique: "motion_graphic", onScreenText: "" }, { intent: "b", duration: 2, technique: "motion_graphic", onScreenText: "" }],
  };
  const scenes = comp.buildScenes(plan, [], {}, []);
  assert.equal(comp.buildShotOverlays(scenes).length, 0);
});
