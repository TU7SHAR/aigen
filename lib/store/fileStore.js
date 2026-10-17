/**
 * Durable local file store primitives (server-only).
 *
 * Used for state that must survive a process restart and be shared by every
 * process on this machine (Next dev server, CLI scripts, workers): model quota
 * counters, the spend ledger and job records. Writes are atomic (temp file +
 * rename) and serialized across processes with an O_EXCL lock file.
 *
 * This is the LOCAL backend. The interfaces built on it (jobStore, ledger,
 * quota) are deliberately small so a Supabase/Postgres implementation can
 * replace them without touching callers. It is not a multi-host store.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Root directory for durable local state (gitignored). Under `node --test`
 * (NODE_TEST_CONTEXT is set) state goes to a per-run temp dir so tests never
 * touch the real quota counters, spend ledger or jobs.
 */
export function getDataDir() {
  const testDir = process.env.NODE_TEST_CONTEXT ? path.join(os.tmpdir(), `mac-test-data-${process.pid}`) : null;
  const dir = process.env.MAC_DATA_DIR || testDir || path.join(process.cwd(), ".data");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Resolve a path inside the data dir (creating parent dirs). */
export function dataPath(...parts) {
  const full = path.join(getDataDir(), ...parts);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  return full;
}

const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));
/** Synchronous sleep (server only) used while waiting for a lock. */
export function sleepSync(ms) {
  Atomics.wait(SLEEP_CELL, 0, 0, Math.max(1, ms));
}

/**
 * Run `fn` while holding a cross-process lock for `file`.
 * A lock older than `staleMs` (crashed holder) is broken.
 */
export function withFileLockSync(file, fn, { timeoutMs = 8000, staleMs = 15000 } = {}) {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const started = Date.now();
  let fd = null;
  while (fd === null) {
    try {
      fd = fs.openSync(lock, "wx");
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      try {
        const st = fs.statSync(lock);
        if (Date.now() - st.mtimeMs > staleMs) {
          fs.rmSync(lock, { force: true });
          continue;
        }
      } catch {
        continue; // lock disappeared between open and stat
      }
      if (Date.now() - started > timeoutMs) {
        throw new Error(`Timed out waiting for the ${path.basename(file)} lock.`);
      }
      sleepSync(6 + Math.floor(Math.random() * 6));
    }
  }
  try {
    return fn();
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
    try { fs.rmSync(lock, { force: true }); } catch { /* best effort */ }
  }
}

/** Read JSON, returning `fallback` when the file is missing or unreadable. */
export function readJsonSync(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return typeof fallback === "function" ? fallback() : structuredClone(fallback);
  }
}

/** Atomic JSON write (temp + rename; retries transient Windows sharing errors). */
export function writeJsonAtomicSync(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      if (i >= 8 || !["EPERM", "EACCES", "EBUSY"].includes(err?.code)) {
        try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
        throw err;
      }
      sleepSync(15 * (i + 1));
    }
  }
}

/** Locked read-modify-write. `mutate` may edit in place or return a new value. */
export function updateJsonSync(file, fallback, mutate) {
  return withFileLockSync(file, () => {
    const current = readJsonSync(file, fallback);
    const next = mutate(current);
    const value = next === undefined ? current : next;
    writeJsonAtomicSync(file, value);
    return value;
  });
}

/** Append one JSON line (audit/event logs). Best effort, never throws. */
export function appendJsonLineSync(file, record) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
  } catch {
    /* audit logging must never break production */
  }
}
