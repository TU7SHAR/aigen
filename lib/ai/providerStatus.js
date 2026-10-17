/**
 * Sanitized production status for the Studio: what will actually run (real vs
 * mock/off), each routing chain with live quota availability, and durable
 * spend. Never includes secret values (only "set"/"missing").
 */

import {
  getImageProviderName, isPaidImageGenerationEnabled, getGeminiApiKey, getProviderName,
  isPaidGenerationEnabled, isPaidGenerationHardDisabled, isPaidSceneVideoEnabled, getModalEndpoint,
  getModalWorkerSecret, isPaidAudioGenerationEnabled, getTtsVoice,
} from "../config.js";
import { getChain, getModelInfo, isAutoSwitchEnabled } from "./modelRegistry.js";
import { quotaSnapshot } from "./quota.js";
import { getJobBudgetConfig } from "../costs/jobBudget.js";
import { spendSummary } from "../costs/ledger.js";
import { getModalSpend, getModalBudgetUsd } from "../costs/modalLedger.js";

function chainStatus(purpose) {
  const chain = getChain(purpose);
  const quota = quotaSnapshot(chain);
  return chain.map((id, i) => {
    const info = getModelInfo(id);
    return {
      id, label: info.label, status: info.status, shutdownDate: info.shutdownDate || null,
      price: info.usdPerSecond720p ? `$${info.usdPerSecond720p}/s (720p)` : info.usdPerUnit ? `$${info.usdPerUnit}/${info.unit}` : info.usdPerMInput ? `$${info.usdPerMInput}/$${info.usdPerMOutput} per 1M tokens` : null,
      available: quota[i].available, reason: quota[i].reason, usedToday: quota[i].usedToday, limits: quota[i].limits,
    };
  });
}

export async function getProviderStatus() {
  const key = Boolean(getGeminiApiKey());
  const imageWanted = getImageProviderName();
  const imageReal = imageWanted === "gemini" && isPaidImageGenerationEnabled() && key;
  const imageBlockers = [];
  if (imageWanted !== "gemini") imageBlockers.push("IMAGE_PROVIDER is not 'gemini'");
  if (process.env.ENABLE_PAID_IMAGE_GENERATION !== "true") imageBlockers.push("ENABLE_PAID_IMAGE_GENERATION is not 'true'");
  if (isPaidGenerationHardDisabled()) imageBlockers.push("DISABLE_PAID_GENERATION is not 'false' (global kill-switch on)");
  if (!key) imageBlockers.push("GEMINI_API_KEY missing");

  const videoBlockers = [];
  if (getProviderName() !== "gemini") videoBlockers.push("VIDEO_PROVIDER is not 'gemini'");
  if (!isPaidGenerationEnabled()) videoBlockers.push("ENABLE_PAID_GENERATION is not 'true'");
  if (isPaidGenerationHardDisabled()) videoBlockers.push("DISABLE_PAID_GENERATION is not 'false' (global kill-switch on)");
  const jb = getJobBudgetConfig();
  if (jb.maxVideoClips < 1) videoBlockers.push("JOB_MAX_PAID_VIDEO_CLIPS is 0");
  if (!key) videoBlockers.push("GEMINI_API_KEY missing");

  const videoChain = chainStatus("video");
  let modal = null;
  if (videoChain.some((m) => getModelInfo(m.id).providerImpl === "modal")) {
    const spend = await getModalSpend().catch(() => ({ spentUsd: null }));
    modal = {
      endpoint: getModalEndpoint() ? "set" : "missing", workerSecret: getModalWorkerSecret() ? "set" : "missing",
      monthlyBudgetUsd: getModalBudgetUsd(), monthlySpentUsd: spend.spentUsd,
    };
  }
  const audioOn = isPaidAudioGenerationEnabled() && key;
  return {
    autoSwitch: isAutoSwitchEnabled("video"),
    image: { provider: imageReal ? "gemini" : "mock", model: imageReal ? getChain("image")[0] : "mock-gradient", real: imageReal, requested: imageWanted, blockers: imageReal ? [] : imageBlockers, chain: chainStatus("image") },
    sceneVideo: {
      provider: isPaidSceneVideoEnabled() ? "router" : "off", model: videoChain[0]?.id || null, real: isPaidSceneVideoEnabled(),
      blockers: isPaidSceneVideoEnabled() ? [] : videoBlockers, chain: videoChain, modal,
      availableToday: videoChain.filter((m) => m.available).reduce((a, m) => a + Math.max(0, (m.limits?.rpd || 0) - (m.usedToday || 0)), 0),
    },
    audio: {
      provider: audioOn ? "gemini-tts + lyria" : "off", real: Boolean(audioOn), voice: getTtsVoice(),
      voiceChain: chainStatus("tts"), musicChain: chainStatus("music"),
      note: audioOn ? "Voiceover + music bed per job, under the audio cap." : "Paid audio off — needs ENABLE_PAID_AUDIO_GENERATION=true and JOB_MAX_PAID_AUDIO>0.",
    },
    text: { creativeChain: chainStatus("creative"), enrichmentChain: chainStatus("enrichment") },
    budget: { ...jb, spend: spendSummary() },
  };
}
