/**
 * Persistent Modal GPU spend ledger (monthly).
 *
 * Modal bills GPU time per second and does NOT report spend back to us in real
 * time, so we ESTIMATE cost from measured GPU-seconds × the configured GPU rate
 * and accumulate it here. The total is persisted to a JSON file so the monthly
 * cap survives server restarts (an in-memory counter would reset and silently
 * blow the budget).
 *
 * This is an ESTIMATE and a safety guard — NOT Modal's authoritative invoice.
 * You should ALSO set a hard spend limit in the Modal dashboard as the real
 * backstop. When the tracked monthly spend reaches the cap, the provider router
 * stops using Modal and falls back to the Gemini path.
 *
 * The ledger resets automatically at the start of each calendar month (UTC),
 * matching Modal's $30/month free-credit cadence.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

// Resolve the ledger path PER CALL (not at module load) so env overrides and
// tests that swap MODAL_LEDGER_PATH are always honored even if the module is
// cached by the loader.
function ledgerPath() {
  return process.env.MODAL_LEDGER_PATH || path.join(process.cwd(), ".modal-spend.json");
}

/** YYYY-MM in UTC — the billing period key. */
function currentPeriod() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function readLedger() {
  try {
    const raw = await fs.readFile(ledgerPath(), "utf8");
    const j = JSON.parse(raw);
    if (j && typeof j === "object" && typeof j.spentUsd === "number") return j;
  } catch {
    /* missing/corrupt → fresh */
  }
  return { period: currentPeriod(), spentUsd: 0, renders: 0, gpuSeconds: 0 };
}

async function writeLedger(data) {
  await fs.writeFile(ledgerPath(), JSON.stringify(data, null, 2), "utf8");
}

/** Roll the ledger to the current period if the stored one is stale. */
function rolled(ledger) {
  const period = currentPeriod();
  if (ledger.period !== period) {
    return { period, spentUsd: 0, renders: 0, gpuSeconds: 0 };
  }
  return ledger;
}

/** @returns {Promise<{ period: string, spentUsd: number, renders: number, gpuSeconds: number }>} */
export async function getModalSpend() {
  return rolled(await readLedger());
}

/**
 * Record an estimated Modal render cost.
 * @param {{ gpuSeconds: number, usd: number }} entry
 */
export async function recordModalSpend({ gpuSeconds = 0, usd = 0 }) {
  const ledger = rolled(await readLedger());
  ledger.spentUsd = Number((ledger.spentUsd + Math.max(0, usd)).toFixed(4));
  ledger.gpuSeconds = Number((ledger.gpuSeconds + Math.max(0, gpuSeconds)).toFixed(2));
  ledger.renders += 1;
  await writeLedger(ledger);
  return ledger;
}

/**
 * Monthly Modal budget cap (USD). Defaults to the $30 free-credit allotment.
 * @returns {number}
 */
export function getModalBudgetUsd() {
  const raw = Number.parseFloat(process.env.MODAL_MONTHLY_BUDGET_USD || "30");
  return Number.isFinite(raw) && raw >= 0 ? raw : 30;
}

/**
 * Would running a render of `prospectiveUsd` keep us within budget?
 * @param {number} prospectiveUsd
 * @returns {Promise<{ ok: boolean, spentUsd: number, budgetUsd: number, remainingUsd: number, reason?: string }>}
 */
export async function checkModalBudget(prospectiveUsd = 0) {
  const { spentUsd } = await getModalSpend();
  const budgetUsd = getModalBudgetUsd();
  const remainingUsd = Number((budgetUsd - spentUsd).toFixed(4));
  if (spentUsd + prospectiveUsd > budgetUsd) {
    return {
      ok: false,
      spentUsd,
      budgetUsd,
      remainingUsd,
      reason:
        `Modal monthly budget reached: $${spentUsd.toFixed(2)} spent of $${budgetUsd.toFixed(2)} ` +
        `(a ~$${prospectiveUsd.toFixed(2)} render would exceed it). Falling back to Gemini.`,
    };
  }
  return { ok: true, spentUsd, budgetUsd, remainingUsd };
}
