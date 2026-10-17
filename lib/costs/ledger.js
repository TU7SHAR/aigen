/**
 * Durable spend ledger (local backend).
 *
 * Replaces the in-memory "running spend" counter, which reset on every restart
 * and was per-process. Every paid call RESERVES its worst-case cost before it
 * is sent; the reservation is SETTLED (estimated actual, or the worst case
 * when the actual is unknown) or RELEASED (only when the provider certainly
 * did not bill). Daily and monthly caps are checked atomically across every
 * process on this machine and survive restarts.
 *
 * Money is stored as integer micro-dollars. Amounts are ESTIMATES from
 * published prices — this is a local safety limit, not a provider-enforced
 * ceiling and not an invoice. Reservations left open by a crashed process
 * keep counting (fail-closed) until reconciled.
 */

import crypto from "node:crypto";
import { dataPath, updateJsonSync, readJsonSync, appendJsonLineSync } from "../store/fileStore.js";
import { getDailySpendLimitUsd, getMonthlySpendLimitUsd } from "../config.js";

const ledgerFile = () => dataPath("spend-ledger.json");
const eventsFile = () => dataPath("spend-events.jsonl");
const empty = () => ({ version: 1, days: {}, months: {}, open: {} });

export const toMicros = (usd) => Math.max(0, Math.round(Number(usd || 0) * 1e6));
export const fromMicros = (m) => Number((Number(m || 0) / 1e6).toFixed(6));

/** Local calendar day of the server (YYYY-MM-DD). */
export function spendDay(now = Date.now()) {
  return new Date(now).toLocaleDateString("en-CA");
}

export class SpendLimitError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "BudgetError";
    this.category = "budget";
    this.details = details;
  }
}

function bucket(map, key) {
  return map[key] || (map[key] = { reservedMicros: 0, settledMicros: 0 });
}

/**
 * Reserve `usd` before a paid call. Throws SpendLimitError when the daily or
 * monthly cap would be exceeded.
 * @returns {{ id: string, micros: number }}
 */
export function reserveSpend({ usd, jobId = null, kind = "other", label = "", model = null, force = false }, now = Date.now()) {
  const micros = toMicros(usd);
  const id = crypto.randomUUID();
  const day = spendDay(now);
  const month = day.slice(0, 7);
  const dailyLimit = toMicros(getDailySpendLimitUsd());
  const monthlyLimit = toMicros(getMonthlySpendLimitUsd());
  updateJsonSync(ledgerFile(), empty, (s) => {
    const d = bucket(s.days, day);
    const m = bucket(s.months, month);
    const dayTotal = d.reservedMicros + d.settledMicros;
    const monthTotal = m.reservedMicros + m.settledMicros;
    if (!force && dayTotal + micros > dailyLimit) {
      throw new SpendLimitError(
        `Daily spend limit reached: $${fromMicros(dayTotal).toFixed(2)} used + $${fromMicros(micros).toFixed(2)} needed > $${fromMicros(dailyLimit).toFixed(2)} (DAILY_SPEND_LIMIT_USD).`,
        { scope: "day" }
      );
    }
    if (!force && monthTotal + micros > monthlyLimit) {
      throw new SpendLimitError(
        `Monthly spend limit reached: $${fromMicros(monthTotal).toFixed(2)} used + $${fromMicros(micros).toFixed(2)} needed > $${fromMicros(monthlyLimit).toFixed(2)} (MONTHLY_SPEND_LIMIT_USD).`,
        { scope: "month" }
      );
    }
    d.reservedMicros += micros;
    m.reservedMicros += micros;
    s.open[id] = { micros, day, month, jobId, kind, label: String(label).slice(0, 120), model, at: now };
  });
  appendJsonLineSync(eventsFile(), { at: now, type: "reserve", id, usd: fromMicros(micros), jobId, kind, label: String(label).slice(0, 120), model });
  return { id, micros };
}

/**
 * Settle a reservation. `usd` is the best-known actual (estimated from
 * published rates or reported usage); null keeps the worst-case amount.
 */
export function settleSpend(id, { usd = null, basis = "worst_case" } = {}, now = Date.now()) {
  if (!id) return;
  let settled = null;
  updateJsonSync(ledgerFile(), empty, (s) => {
    const o = s.open[id];
    if (!o) return;
    const final = usd == null ? o.micros : toMicros(usd);
    const d = bucket(s.days, o.day);
    const m = bucket(s.months, o.month);
    d.reservedMicros = Math.max(0, d.reservedMicros - o.micros);
    m.reservedMicros = Math.max(0, m.reservedMicros - o.micros);
    d.settledMicros += final;
    m.settledMicros += final;
    delete s.open[id];
    settled = { final, reserved: o.micros, jobId: o.jobId };
  });
  if (settled) {
    appendJsonLineSync(eventsFile(), {
      at: now, type: "settle", id, usd: fromMicros(settled.final), reservedUsd: fromMicros(settled.reserved),
      basis: usd == null ? "worst_case" : basis, jobId: settled.jobId,
    });
  }
}

/** Release a reservation — ONLY when the provider certainly did not bill. */
export function releaseSpend(id, reason = "not charged", now = Date.now()) {
  if (!id) return;
  let released = null;
  updateJsonSync(ledgerFile(), empty, (s) => {
    const o = s.open[id];
    if (!o) return;
    const d = bucket(s.days, o.day);
    const m = bucket(s.months, o.month);
    d.reservedMicros = Math.max(0, d.reservedMicros - o.micros);
    m.reservedMicros = Math.max(0, m.reservedMicros - o.micros);
    delete s.open[id];
    released = o;
  });
  if (released) appendJsonLineSync(eventsFile(), { at: now, type: "release", id, usd: fromMicros(released.micros), reason: String(reason).slice(0, 160), jobId: released.jobId });
}

/** Totals for status UIs and the generate gate. */
export function spendSummary(now = Date.now()) {
  const s = readJsonSync(ledgerFile(), empty);
  const day = spendDay(now);
  const d = s.days[day] || { reservedMicros: 0, settledMicros: 0 };
  const m = s.months[day.slice(0, 7)] || { reservedMicros: 0, settledMicros: 0 };
  return {
    basis: "local estimates from published prices (not an invoice)",
    today: {
      day, settledUsd: fromMicros(d.settledMicros), reservedUsd: fromMicros(d.reservedMicros),
      usedUsd: fromMicros(d.settledMicros + d.reservedMicros), limitUsd: getDailySpendLimitUsd(),
    },
    month: {
      month: day.slice(0, 7), settledUsd: fromMicros(m.settledMicros), reservedUsd: fromMicros(m.reservedMicros),
      usedUsd: fromMicros(m.settledMicros + m.reservedMicros), limitUsd: getMonthlySpendLimitUsd(),
    },
    openReservations: Object.keys(s.open || {}).length,
  };
}
