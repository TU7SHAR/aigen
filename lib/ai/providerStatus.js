/**
 * Sanitized provider status — what WILL actually run for images and scene
 * video, real vs mock, and the active spend caps. Never includes secret values
 * (only "set"/"missing"). Safe to return to the browser.
 */

import {
  getImageProviderName, getImageModel, isPaidImageGenerationEnabled, getGeminiApiKey,
  getProviderName, getVideoModel, isPaidGenerationEnabled, isPaidGenerationHardDisabled,
  isPaidSceneVideoEnabled, getModalEndpoint, getModalWorkerSecret, getModalGpuUsdPerSecond,
  getModalWorstCaseGpuSeconds, getDevSpendLimitUsd,
} from "../config.js";
import { getModelInfo } from "./modelRegistry.js";
import { getJobBudgetConfig } from "../costs/jobBudget.js";
import { getModalSpend, getModalBudgetUsd } from "../costs/modalLedger.js";
import { getRunningSpendUsd } from "../costs/estimate.js";

export async function getProviderStatus() {
  const key = Boolean(getGeminiApiKey());
  const imageWanted = getImageProviderName();
  const imageReal = imageWanted === "gemini" && isPaidImageGenerationEnabled() && key;
  const blockers = [];
  if (imageWanted !== "gemini") blockers.push("IMAGE_PROVIDER is not 'gemini'");
  if (process.env.ENABLE_PAID_IMAGE_GENERATION !== "true") blockers.push("ENABLE_PAID_IMAGE_GENERATION is not 'true'");
  if (isPaidGenerationHardDisabled()) blockers.push("DISABLE_PAID_GENERATION is not 'false' (global kill-switch on)");
  if (!key) blockers.push("GEMINI_API_KEY missing");

  const videoModel = getVideoModel();
  const info = getModelInfo(videoModel);
  const videoBlockers = [];
  if (getProviderName() !== "gemini") videoBlockers.push("VIDEO_PROVIDER is not 'gemini'");
  if (!isPaidGenerationEnabled()) videoBlockers.push("ENABLE_PAID_GENERATION is not 'true'");
  if (isPaidGenerationHardDisabled()) videoBlockers.push("DISABLE_PAID_GENERATION is not 'false' (global kill-switch on)");
  const jb = getJobBudgetConfig();
  if (jb.maxVideoClips < 1) videoBlockers.push("JOB_MAX_PAID_VIDEO_CLIPS is 0");
  if (info.providerImpl === "modal" && !getModalEndpoint()) videoBlockers.push("MODAL_VIDEO_ENDPOINT missing");

  let modal = null;
  if (info.providerImpl === "modal") {
    const spend = await getModalSpend().catch(() => ({ spentUsd: null }));
    modal = {
      endpoint: getModalEndpoint() ? "set" : "missing",
      workerSecret: getModalWorkerSecret() ? "set" : "missing",
      gpuUsdPerSecond: getModalGpuUsdPerSecond(),
      worstCaseUsdPerClip: Number((getModalWorstCaseGpuSeconds() * getModalGpuUsdPerSecond()).toFixed(4)),
      monthlyBudgetUsd: getModalBudgetUsd(),
      monthlySpentUsd: spend.spentUsd,
    };
  }

  return {
    image: {
      provider: imageReal ? "gemini" : "mock",
      model: imageReal ? getImageModel() : "mock-gradient",
      real: imageReal,
      requested: imageWanted,
      blockers: imageReal ? [] : blockers,
    },
    sceneVideo: {
      provider: isPaidSceneVideoEnabled() ? info.providerImpl : "off",
      model: videoModel,
      real: isPaidSceneVideoEnabled(),
      blockers: isPaidSceneVideoEnabled() ? [] : videoBlockers,
      modal,
    },
    audio: { provider: "none", real: false, note: "Silent track — no music/voiceover engine yet." },
    budget: { ...jb, devSpendLimitUsd: getDevSpendLimitUsd(), processSpentUsd: getRunningSpendUsd() },
  };
}
