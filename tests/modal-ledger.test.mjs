/**
 * Modal spend ledger — persistence, monthly reset, budget gate. No GPU, no cost.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

let ledgerPath;

beforeEach(() => {
  ledgerPath = path.join(os.tmpdir(), `modal-ledger-test-${Math.random().toString(36).slice(2)}.json`);
  process.env.MODAL_LEDGER_PATH = ledgerPath;
  process.env.MODAL_MONTHLY_BUDGET_USD = "30";
});
afterEach(async () => {
  await fs.rm(ledgerPath, { force: true });
  delete process.env.MODAL_LEDGER_PATH;
  delete process.env.MODAL_MONTHLY_BUDGET_USD;
});

async function fresh() {
  return import("../lib/costs/modalLedger.js?bust=" + Math.random());
}

test("starts at zero spend", async () => {
  const m = await fresh();
  const s = await m.getModalSpend();
  assert.equal(s.spentUsd, 0);
  assert.equal(s.renders, 0);
});

test("records spend and persists across reloads", async () => {
  let m = await fresh();
  await m.recordModalSpend({ gpuSeconds: 30, usd: 0.01 });
  await m.recordModalSpend({ gpuSeconds: 20, usd: 0.006 });
  // Reload the module → must read the persisted file, not reset.
  m = await fresh();
  const s = await m.getModalSpend();
  assert.equal(s.renders, 2);
  assert.equal(s.gpuSeconds, 50);
  assert.ok(Math.abs(s.spentUsd - 0.016) < 1e-6, `spent=${s.spentUsd}`);
});

test("budget gate passes under cap, blocks over cap", async () => {
  const m = await fresh();
  await m.recordModalSpend({ gpuSeconds: 1000, usd: 29.9 });
  const ok = await m.checkModalBudget(0.05);
  assert.equal(ok.ok, true, "0.05 render still fits under 30");
  const blocked = await m.checkModalBudget(0.5);
  assert.equal(blocked.ok, false, "0.5 render would exceed 30");
  assert.match(blocked.reason, /budget reached/i);
});

test("ledger resets at a new billing period", async () => {
  // Seed a STALE period directly.
  await fs.writeFile(ledgerPath, JSON.stringify({ period: "2000-01", spentUsd: 30, renders: 99, gpuSeconds: 1 }));
  const m = await fresh();
  const s = await m.getModalSpend();
  assert.equal(s.spentUsd, 0, "stale period rolls over to a fresh $0 budget");
  assert.notEqual(s.period, "2000-01");
});

test("getModalBudgetUsd honors env override", async () => {
  process.env.MODAL_MONTHLY_BUDGET_USD = "12.5";
  const m = await fresh();
  assert.equal(m.getModalBudgetUsd(), 12.5);
});
