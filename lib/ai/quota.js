/**
 * Durable per-model quota tracker.
 *
 * Counts the requests THIS installation sends to each model (requests per
 * minute + requests per Pacific day, the Gemini API's reset boundary) and
 * remembers provider-reported exhaustion (429 until Pacific midnight, cooldown
 * after overload, model unavailable). State lives in .data/model-quota.json,
 * shared by every local process and kept across restarts, so the router can
 * skip a model it already knows is exhausted instead of burning a request to
 * rediscover it.
 *
 * It is an ESTIMATE of remaining quota: requests made elsewhere with the same
 * key are invisible until the provider answers 429, at which point the
 * provider's verdict wins.
 */

import { dataPath, updateJsonSync, readJsonSync } from "../store/fileStore.js";
import { getModelLimits } from "./modelRegistry.js";

const MINUTE_MS = 60_000;
const quotaFile = () => dataPath("model-quota.json");
const empty = () => ({ version: 1, models: {} });

/** Pacific calendar day (YYYY-MM-DD) — Gemini RPD quotas reset at midnight PT. */
export function pacificDay(now = Date.now()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(now));
}

/** Milliseconds until the next Pacific midnight (+1 min safety margin). */
export function msUntilPacificMidnight(now = Date.now()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles", hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(now)).map((p) => [p.type, p.value])
  );
  const elapsed = (Number(parts.hour) % 24) * 3600 + Number(parts.minute) * 60 + Number(parts.second);
  return Math.max(MINUTE_MS, (86400 - elapsed) * 1000 + MINUTE_MS);
}

function touch(state, id, now) {
  const day = pacificDay(now);
  const e = state.models[id] || (state.models[id] = { day, dayCount: 0, starts: [] });
  if (e.day !== day) {
    e.day = day;
    e.dayCount = 0;
    if (e.cooldownScope === "day") {
      e.cooldownUntil = 0;
      e.cooldownScope = null;
      e.cooldownReason = null;
    }
  }
  e.starts = (e.starts || []).filter((t) => now - t < MINUTE_MS);
  return e;
}

function verdict(e, limits, now) {
  if (e.cooldownUntil && e.cooldownUntil > now) {
    return { ok: false, reason: e.cooldownReason || "cooling down", waitMs: e.cooldownUntil - now, scope: e.cooldownScope || "cooldown" };
  }
  if (limits.rpd > 0 && e.dayCount >= limits.rpd) {
    return { ok: false, reason: `daily limit (${limits.rpd}/day) used`, waitMs: msUntilPacificMidnight(now), scope: "day" };
  }
  if (limits.rpm > 0 && e.starts.length >= limits.rpm) {
    const oldest = Math.min(...e.starts);
    return { ok: false, reason: `rate limit (${limits.rpm}/min)`, waitMs: Math.max(250, MINUTE_MS - (now - oldest) + 250), scope: "minute" };
  }
  return { ok: true, waitMs: 0, remainingToday: limits.rpd > 0 ? limits.rpd - e.dayCount : null };
}

/** Read-only check: could a request to `id` be sent now? */
export function checkModel(id, now = Date.now()) {
  const state = readJsonSync(quotaFile(), empty);
  const e = touch(state, id, now);
  return verdict(e, getModelLimits(id), now);
}

/**
 * Atomically reserve one request slot for `id`. Returns the verdict; when
 * ok, the request is counted (towards RPM and RPD) before it is sent.
 */
export function acquireModel(id, now = Date.now()) {
  let result;
  updateJsonSync(quotaFile(), empty, (state) => {
    const e = touch(state, id, now);
    result = verdict(e, getModelLimits(id), now);
    if (result.ok) {
      e.starts.push(now);
      e.dayCount += 1;
      e.lastUsedAt = now;
    }
  });
  return result;
}

/** Record a provider 429. Per-day → blocked until Pacific midnight. */
export function reportRateLimited(id, { scope = "unknown", retryAfterMs = null, message = "" } = {}, now = Date.now()) {
  updateJsonSync(quotaFile(), empty, (state) => {
    const e = touch(state, id, now);
    if (scope === "day") {
      e.cooldownUntil = now + msUntilPacificMidnight(now);
      e.cooldownScope = "day";
      e.cooldownReason = "daily quota exhausted (provider 429)";
      e.dayCount = Math.max(e.dayCount, getModelLimits(id).rpd || e.dayCount);
    } else {
      const wait = retryAfterMs && retryAfterMs > 0 ? retryAfterMs : scope === "minute" ? MINUTE_MS : 2 * MINUTE_MS;
      e.cooldownUntil = now + Math.min(wait, 15 * MINUTE_MS);
      e.cooldownScope = "minute";
      e.cooldownReason = "rate limited (provider 429)";
    }
    e.lastError = String(message).slice(0, 200);
  });
}

/** Mark a model unavailable (not found / not enabled / shut down) for `ms`. */
export function reportUnavailable(id, { ms = 6 * 3600_000, reason = "model unavailable", message = "" } = {}, now = Date.now()) {
  updateJsonSync(quotaFile(), empty, (state) => {
    const e = touch(state, id, now);
    e.cooldownUntil = now + ms;
    e.cooldownScope = "unavailable";
    e.cooldownReason = reason;
    e.lastError = String(message).slice(0, 200);
  });
}

/** Snapshot for status UIs (no secrets). */
export function quotaSnapshot(ids, now = Date.now()) {
  const state = readJsonSync(quotaFile(), empty);
  return ids.map((id) => {
    const e = touch(state, id, now);
    const limits = getModelLimits(id);
    const v = verdict(e, limits, now);
    return {
      id, limits, usedToday: e.dayCount, usedLastMinute: e.starts.length,
      available: v.ok, reason: v.ok ? null : v.reason, retryInSec: v.ok ? 0 : Math.ceil(v.waitMs / 1000),
    };
  });
}

/** Tests only: wipe local quota state. */
export function __resetQuota() {
  updateJsonSync(quotaFile(), empty, () => empty());
}
