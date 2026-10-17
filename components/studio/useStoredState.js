"use client";

/**
 * useStoredState — a value persisted in localStorage on THIS device, read
 * through useSyncExternalStore so server render and hydration agree (the
 * server snapshot is the default) and no setState runs inside an effect.
 */

import { useCallback, useSyncExternalStore } from "react";

const EVENT = "mac-storage";

function subscribe(cb) {
  window.addEventListener("storage", cb);
  window.addEventListener(EVENT, cb);
  return () => {
    window.removeEventListener("storage", cb);
    window.removeEventListener(EVENT, cb);
  };
}

const cache = new Map(); // key -> { raw, value } so snapshots are referentially stable

function read(key, fallback) {
  let raw = null;
  try {
    raw = window.localStorage.getItem(key);
  } catch {
    raw = null;
  }
  const hit = cache.get(key);
  if (hit && hit.raw === raw) return hit.value;
  let value = fallback;
  if (raw != null) {
    try {
      value = JSON.parse(raw);
    } catch {
      value = fallback;
    }
  }
  cache.set(key, { raw, value });
  return value;
}

/** Write a stored value (and notify every subscriber in this tab). */
export function writeStored(key, value) {
  try {
    if (value === undefined || value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(value));
    window.dispatchEvent(new Event(EVENT));
    return true;
  } catch {
    return false; // storage full/blocked: callers show "not saved"
  }
}

export function useStoredState(key, fallback) {
  const value = useSyncExternalStore(
    subscribe,
    () => read(key, fallback),
    () => fallback
  );
  const set = useCallback(
    (next) => writeStored(key, typeof next === "function" ? next(read(key, fallback)) : next),
    [key, fallback]
  );
  return [value, set];
}
