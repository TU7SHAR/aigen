"use client";

import { useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { Sun, Moon, Monitor, ChevronDown } from "lucide-react";
import useMounted from "./useMounted.js";

const OPTIONS = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "system", label: "System", Icon: Monitor },
];

/**
 * Theme control: a compact Light / Dark / System dropdown using lucide-react
 * icons. The trigger shows the icon for the *active* theme.
 *
 * Hydration safety: the resolved theme is only known on the client, so until
 * mounted we render a neutral, correctly-sized placeholder (no theme-dependent
 * icon) to avoid a server/client mismatch. `aria-label` keeps it accessible.
 *
 * `variant="inline"` renders a stacked radio-style list for mobile menus;
 * the default renders the compact header dropdown.
 */
export default function ThemeToggle({ variant = "dropdown", className = "" }) {
  const { theme, setTheme } = useTheme();
  const mounted = useMounted();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    function onKey(e) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Inline variant for the mobile menu: an explicit, always-visible choice list.
  if (variant === "inline") {
    return (
      <div className={className}>
        <div className="eyebrow mb-2">Theme</div>
        <div
          role="radiogroup"
          aria-label="Theme"
          className="grid grid-cols-3 gap-2"
        >
          {OPTIONS.map(({ value, label, Icon }) => {
            const active = mounted && theme === value;
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setTheme(value)}
                className={`flex min-h-11 flex-col items-center justify-center gap-1 rounded-lg border px-2 py-2 text-xs font-medium ${
                  active
                    ? "border-accent text-ink"
                    : "border-line text-muted hover:text-ink"
                }`}
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
                {label}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  // Compact header dropdown.
  const current = OPTIONS.find((o) => o.value === theme) ?? OPTIONS[2];
  const TriggerIcon = mounted ? current.Icon : Sun;

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        type="button"
        aria-label={
          mounted ? `Theme: ${current.label}. Change theme` : "Change theme"
        }
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-11 min-w-11 items-center justify-center gap-1 rounded-lg border border-line bg-surface px-2.5 text-muted hover:text-ink"
      >
        {/* Until mounted, render an invisible-but-sized icon to avoid a
            theme-dependent hydration mismatch. */}
        <TriggerIcon
          className={`h-4 w-4 ${mounted ? "" : "opacity-0"}`}
          aria-hidden="true"
        />
        <ChevronDown className="h-3 w-3" aria-hidden="true" />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Theme"
          className="card-raised absolute right-0 z-50 mt-2 w-40 overflow-hidden p-1 shadow-lg"
        >
          {OPTIONS.map(({ value, label, Icon }) => {
            const active = mounted && theme === value;
            return (
              <button
                key={value}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => {
                  setTheme(value);
                  setOpen(false);
                }}
                className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm ${
                  active ? "text-ink" : "text-muted hover:text-ink"
                }`}
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
                <span className="flex-1">{label}</span>
                {active && <span className="accent-dot" aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
