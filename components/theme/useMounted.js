"use client";

import { useSyncExternalStore } from "react";

// No-op subscription: the mounted flag never changes after first client render.
const subscribe = () => () => {};

/**
 * Returns `false` during SSR and the first client render, then `true` once
 * mounted — without calling setState inside an effect (which the strict React
 * Compiler lint here forbids). Used to gate theme-dependent UI so the server
 * and first client render agree, avoiding hydration mismatches.
 */
export default function useMounted() {
  return useSyncExternalStore(
    subscribe,
    () => true, // client snapshot
    () => false // server snapshot
  );
}
