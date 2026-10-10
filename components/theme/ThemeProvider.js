"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";

/**
 * App theme provider (next-themes).
 *
 * - attribute="class"      → toggles `.dark` on <html>, driving our Tailwind v4
 *                            token system in app/globals.css.
 * - defaultTheme="system"  → first-time visitors follow their OS preference.
 * - enableSystem           → keeps a live "System" option that reacts to OS
 *                            changes while the app is open.
 * - disableTransitionOnChange → prevents color transitions from firing on the
 *                            switch itself (avoids flashes on media-heavy
 *                            screens); incidental hover transitions still apply.
 * - storageKey             → persisted preference (localStorage) across sessions.
 *
 * next-themes injects a pre-paint script via next/script, so there is no theme
 * flash and no SSR/CSR hydration mismatch for the <html> class.
 */
export default function ThemeProvider({ children }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      storageKey="adforge-theme"
    >
      {children}
    </NextThemesProvider>
  );
}
