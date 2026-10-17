/**
 * Production estimate for a compiled plan, shown BEFORE "Create video".
 *
 *   expectedUsd  — every shot on the cheapest available model, at published rates
 *   worstCaseUsd — the most expensive model each shot could be switched to
 *                  (bounded by the per-job cap), plus audio and keyframes
 * Both are estimates from published prices, not invoices.
 */

import { getChain, getModelInfo, videoUsdPerSecond } from "../ai/modelRegistry.js";
import { billedSeconds, clipWorstCaseUsd } from "../ai/index.js";
import { getJobBudgetConfig } from "./jobBudget.js";
import { spendSummary } from "./ledger.js";
import { isPaidSceneVideoEnabled, isPaidAudioGenerationEnabled, isPaidImageGenerationEnabled, getImageProviderName } from "../config.js";
import { quotaSnapshot } from "../ai/quota.js";

export function estimateProduction(scenePlan, input = {}) {
  const shots = scenePlan?.scenes || [];
  const chain = getChain("video").filter((id) => getModelInfo(id).providerImpl !== "modal" && getModelInfo(id).providerImpl !== "mock");
  const quota = quotaSnapshot(chain);
  const usable = chain.filter((_, i) => quota[i].available);
  const head = getModelInfo(usable[0] || chain[0] || "veo-3.1-lite");
  const cfg = getJobBudgetConfig();
  const videoOn = isPaidSceneVideoEnabled();
  const breakdown = [];
  let expected = 0;
  let worst = 0;

  const videoShots = shots.filter((s) => s.technique === "ai_video");
  for (const [i, s] of videoShots.entries()) {
    if (!videoOn) break;
    const secs = billedSeconds(head, Number(s.duration) || 4);
    const e = videoUsdPerSecond(head, "720p") * secs;
    const w = Math.max(...chain.map((id) => clipWorstCaseUsd(getModelInfo(id), { durationSeconds: Number(s.duration) || 4, resolution: "720p" })));
    expected += e;
    worst += w;
    breakdown.push({ item: `shot clip ${i + 1}`, model: head.id, expectedUsd: Number(e.toFixed(3)), worstCaseUsd: Number(w.toFixed(3)) });
  }
  if (isPaidImageGenerationEnabled() && getImageProviderName() === "gemini") {
    const stills = shots.filter((s) => s.technique === "ai_image" || (s.technique === "ai_video" && (!s.assetHint || s.assetHint === "none"))).length;
    if (stills) {
      expected += stills * 0.0336;
      worst += stills * 0.067;
      breakdown.push({ item: `${stills} keyframe image(s)`, model: getChain("image")[0], expectedUsd: Number((stills * 0.0336).toFixed(3)), worstCaseUsd: Number((stills * 0.067).toFixed(3)) });
    }
  }
  if (isPaidAudioGenerationEnabled() && input.narration !== false) {
    const words = shots.map((s) => s.voiceover || "").join(" ").split(/\s+/).filter(Boolean).length;
    const vo = Math.max(0.001, (words / 2.3) * 0.000225);
    expected += vo + 0.04;
    worst += Math.max(cfg.ttsUsdPerCall, vo) + cfg.musicUsdPerCall;
    breakdown.push({ item: "voiceover + music", model: `${getChain("tts")[0]} + ${getChain("music")[0]}`, expectedUsd: Number((vo + 0.04).toFixed(3)), worstCaseUsd: Number((cfg.ttsUsdPerCall + cfg.musicUsdPerCall).toFixed(3)) });
  }
  const spend = spendSummary();
  const clipsAllowed = Math.min(cfg.maxVideoClips, videoShots.length);
  return {
    expectedUsd: Number(expected.toFixed(2)),
    worstCaseUsd: Number(Math.min(worst, cfg.maxUsd).toFixed(2)),
    perJobCapUsd: cfg.maxUsd,
    dailyRemainingUsd: Number(Math.max(0, spend.today.limitUsd - spend.today.usedUsd).toFixed(2)),
    videoShots: videoShots.length,
    clipsAllowed,
    clipCapWarning: videoOn && videoShots.length > cfg.maxVideoClips ? `The plan has ${videoShots.length} AI-video shots but the per-job cap allows ${cfg.maxVideoClips}; extra shots will use other visuals.` : null,
    videoAvailable: videoOn,
    modelsAvailableToday: usable.map((id) => getModelInfo(id).label),
    breakdown,
    basis: "published prices; the actual bill may differ — see Google AI Studio billing",
  };
}
