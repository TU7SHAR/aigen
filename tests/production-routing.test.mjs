/**
 * Auto-switching router, quota tracker and durable spend ledger.
 * Mock attempts only — no network, no paid calls. State lives in the per-run
 * test data dir (NODE_TEST_CONTEXT).
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { routeCall, RoutingError } from "../lib/ai/router.js";
import { acquireModel, checkModel, reportRateLimited, pacificDay, msUntilPacificMidnight, __resetQuota } from "../lib/ai/quota.js";
import { classifyProviderError } from "../lib/ai/errors.js";
import { ProviderError } from "../lib/ai/provider.js";
import { createJobBudget, BudgetError } from "../lib/costs/jobBudget.js";
import { reserveSpend, settleSpend, releaseSpend, spendSummary } from "../lib/costs/ledger.js";
import { getChain } from "../lib/ai/modelRegistry.js";

function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) { prev[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  const restore = () => { for (const k of Object.keys(prev)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } };
  try { const r = fn(); if (r?.then) return r.finally(restore); restore(); return r; } catch (e) { restore(); throw e; }
}

beforeEach(() => __resetQuota());

const err = (category, extra = {}) => new ProviderError(`${category}`, { category, ...extra });

test("classifier: Gemini 429 per-day quota → rate_limited/day, not charged; per-minute retry delay parsed", () => {
  const day = classifyProviderError({ status: 429, message: "RESOURCE_EXHAUSTED: Quota exceeded for metric generate_requests_per_model_per_day" });
  assert.equal(day.category, "rate_limited");
  assert.equal(day.scope, "day");
  assert.equal(day.notCharged, true);
  const min = classifyProviderError({ status: 429, message: 'Quota exceeded per minute. "retryDelay": "23s"' });
  assert.equal(min.scope, "minute");
  assert.equal(min.retryAfterMs, 23000);
  assert.equal(classifyProviderError({ status: 404, message: "models/veo-x is not found" }).category, "model_unavailable");
  assert.equal(classifyProviderError({ status: 401, message: "API key not valid" }).fatal, true);
  assert.equal(classifyProviderError({ message: "deadline exceeded" }).uncertain, true);
});

test("router switches to the next model after an unbilled 429 and records why", async () => {
  const calls = [];
  const out = await routeCall({
    purpose: "video", chain: ["veo-3.1-lite", "veo-3.1-fast"], label: "shot 1",
    attempt: async (info) => {
      calls.push(info.id);
      if (info.id === "veo-3.1-lite") throw err("rate_limited", { scope: "day", notCharged: true });
      return { ok: true, cost: { amountUsd: 0.4 } };
    },
  });
  assert.deepEqual(calls, ["veo-3.1-lite", "veo-3.1-fast"]);
  assert.equal(out.model, "veo-3.1-fast");
  assert.equal(out.switched, true);
  assert.equal(out.attempts[0].category, "rate_limited");
  // The day quota is remembered: the next request skips Lite without sending.
  assert.equal(checkModel("veo-3.1-lite").ok, false);
  const again = [];
  await routeCall({ purpose: "video", chain: ["veo-3.1-lite", "veo-3.1-fast"], attempt: async (info) => { again.push(info.id); return {}; } });
  assert.deepEqual(again, ["veo-3.1-fast"]);
});

test("router NEVER switches after an uncertain outcome (may still be billed) and surfaces the operation id", async () => {
  const calls = [];
  await assert.rejects(
    routeCall({
      purpose: "video", chain: ["veo-3.1-lite", "veo-3.1-fast"], label: "shot 2",
      attempt: async (info) => {
        calls.push(info.id);
        throw err("timeout_uncertain", { uncertain: true, notCharged: false, operationName: "operations/abc" });
      },
    }),
    (e) => e instanceof RoutingError && e.uncertain === true && e.operationName === "operations/abc"
  );
  assert.deepEqual(calls, ["veo-3.1-lite"]);
});

test("router stops on a rejected API key (fatal) instead of burning the chain", async () => {
  const calls = [];
  await assert.rejects(routeCall({ purpose: "video", chain: ["veo-3.1-lite", "veo-3.1-fast"], attempt: async (i) => { calls.push(i.id); throw err("auth"); } }), RoutingError);
  assert.equal(calls.length, 1);
});

test("safety block → one rephrased attempt on the same model, then the next model", async () => {
  const calls = [];
  const out = await routeCall({
    purpose: "video", chain: ["veo-3.1-lite", "veo-3.1-fast"],
    attempt: async (info, { safe }) => {
      calls.push(`${info.id}${safe ? ":safe" : ""}`);
      if (info.id === "veo-3.1-lite") throw err("safety_blocked", { notCharged: true });
      return {};
    },
  });
  assert.deepEqual(calls, ["veo-3.1-lite", "veo-3.1-lite:safe", "veo-3.1-fast"]);
  assert.equal(out.model, "veo-3.1-fast");
});

test("router skips models that cannot do the shot or would exceed the job budget", async () => {
  const budget = createJobBudget({ maxUsd: 0.3, maxVideoClips: 3, jobId: "t" });
  const calls = [];
  const out = await routeCall({
    purpose: "video", chain: ["veo-3.1", "veo-3.1-lite"], budget, budgetKind: "video",
    worstCaseUsd: (info) => (info.id === "veo-3.1" ? 1.6 : 0.2),
    attempt: async (info) => { calls.push(info.id); return { cost: { amountUsd: 0.2 } }; },
  });
  assert.deepEqual(calls, ["veo-3.1-lite"]);
  assert.equal(out.attempts[0].category, "budget");
  assert.equal(budget.summary().paidVideoClips, 1);
});

test("an unbilled failure releases the per-job reservation and clip slot", async () => {
  const budget = createJobBudget({ maxUsd: 1, maxVideoClips: 1, jobId: "t2" });
  await routeCall({
    purpose: "video", chain: ["veo-3.1-lite", "veo-3.1-fast"], budget, budgetKind: "video",
    worstCaseUsd: () => 0.2,
    attempt: async (info) => { if (info.id === "veo-3.1-lite") throw err("overloaded", { notCharged: true }); return { cost: { amountUsd: 0.2 } }; },
  });
  const s = budget.summary();
  assert.equal(s.paidVideoClips, 1, "only the successful clip holds a slot");
  assert.ok(Math.abs(s.reservedUsd - 0.2) < 1e-9);
});

test("quota: per-minute limit is enforced atomically; RPD counts toward the Pacific day", () => {
  withEnv({ "MODEL_LIMITS__VEO_3_1_LITE": "rpm:2,rpd:3" }, () => {
    const t = Date.now();
    assert.equal(acquireModel("veo-3.1-lite", t).ok, true);
    assert.equal(acquireModel("veo-3.1-lite", t + 1).ok, true);
    const third = acquireModel("veo-3.1-lite", t + 2);
    assert.equal(third.ok, false);
    assert.equal(third.scope, "minute");
    assert.equal(acquireModel("veo-3.1-lite", t + 61_000).ok, true);
    const fourth = acquireModel("veo-3.1-lite", t + 122_000);
    assert.equal(fourth.ok, false);
    assert.equal(fourth.scope, "day");
  });
});

test("quota: a per-day 429 blocks until Pacific midnight", () => {
  const now = Date.now();
  reportRateLimited("veo-3.1-fast", { scope: "day" }, now);
  const v = checkModel("veo-3.1-fast", now + 1000);
  assert.equal(v.ok, false);
  assert.ok(v.waitMs <= msUntilPacificMidnight(now) + 60_000);
  assert.match(pacificDay(now), /^\d{4}-\d{2}-\d{2}$/);
});

test("ledger: reserve/settle/release are durable and the daily cap blocks before spending", () => {
  withEnv({ DAILY_SPEND_LIMIT_USD: "1", MONTHLY_SPEND_LIMIT_USD: "10", DEV_SPEND_LIMIT_USD: undefined }, () => {
    const before = spendSummary().today.usedUsd;
    const room = 1 - before;
    if (room < 0.6) return; // other tests already used today's test budget
    const a = reserveSpend({ usd: 0.4, kind: "video", label: "a" });
    const b = reserveSpend({ usd: 0.2, kind: "video", label: "b" });
    assert.throws(() => reserveSpend({ usd: room, kind: "video", label: "too much" }), /Daily spend limit/);
    settleSpend(a.id, { usd: 0.3 });
    releaseSpend(b.id, "provider said not charged");
    const after = spendSummary().today;
    assert.ok(Math.abs(after.usedUsd - before - 0.3) < 1e-6, `used ${after.usedUsd} before ${before}`);
  });
});

test("job budget refuses a reservation that would break the durable daily cap", () => {
  withEnv({ DAILY_SPEND_LIMIT_USD: "0.01", DEV_SPEND_LIMIT_USD: undefined }, () => {
    const b = createJobBudget({ maxUsd: 5, maxVideoClips: 2 });
    assert.throws(() => b.reserve("video", 0.5, "clip"), (e) => e.name === "BudgetError");
  });
});

test("an aborted routed call stops instead of trying the next model (hedge loser / user cancel)", async () => {
  const ac = new AbortController();
  const calls = [];
  const p = routeCall({
    purpose: "text", chain: ["gemini-3.8-flash", "gemini-3.7-flash"], signal: ac.signal,
    attempt: async (info) => {
      calls.push(info.id);
      ac.abort();
      throw new ProviderError("aborted", { category: "timeout_uncertain", notCharged: true });
    },
  });
  await assert.rejects(p, (e) => e instanceof RoutingError && e.category === "cancelled");
  assert.deepEqual(calls, ["gemini-3.8-flash"]);
});

test("default video chain is cheapest-first current models; VIDEO_AUTO_SWITCH=false keeps only the head", () => {
  withEnv({ VIDEO_MODEL_CHAIN: undefined, VIDEO_MODEL: undefined, VIDEO_AUTO_SWITCH: undefined }, () => {
    assert.deepEqual(getChain("video").slice(0, 2), ["veo-3.1-lite", "veo-3.1-fast"]);
  });
  withEnv({ VIDEO_MODEL_CHAIN: "veo-3.1-fast,veo-3.1-lite", VIDEO_AUTO_SWITCH: "false" }, () => {
    assert.deepEqual(getChain("video"), ["veo-3.1-fast"]);
  });
  void BudgetError;
});
