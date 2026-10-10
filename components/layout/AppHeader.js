"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import ThemeToggle from "@/components/theme/ThemeToggle.js";
import BrandMark from "@/components/layout/BrandMark.js";

const NAV_LINKS = [
  { href: "/studio", label: "Create" },
  { href: "/projects", label: "Projects" },
  { href: "/assets", label: "Assets" },
];

function Logo() {
  return (
    <Link
      href="/"
      className="flex items-center gap-2 font-semibold tracking-tight"
      aria-label="MakeAdClips Studio home"
    >
      <BrandMark className="h-7 w-7 shrink-0 text-accent" tile />
      <span>MakeAdClips</span>
      <span className="mono-meta !text-ink hidden sm:inline">STUDIO</span>
    </Link>
  );
}

/**
 * Shared application header used across every route (rendered once in the root
 * layout). Desktop shows inline nav + theme toggle; mobile collapses nav into a
 * hamburger menu that includes the theme control. Links are never hidden with
 * CSS-only tricks that leave them inaccessible — the mobile menu exposes them.
 */
export default function AppHeader() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // Lock body scroll while the mobile menu is open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  function isActive(href) {
    return pathname === href || pathname.startsWith(href + "/");
  }

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-surface/95 backdrop-blur supports-[backdrop-filter]:bg-surface/80">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] sm:px-6">
        <Logo />

        {/* Desktop nav */}
        <nav
          className="hidden items-center gap-1 md:flex"
          aria-label="Primary"
        >
          {NAV_LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              aria-current={isActive(l.href) ? "page" : undefined}
              className={`rounded-lg px-3 py-2 text-sm font-medium ${
                isActive(l.href)
                  ? "text-ink"
                  : "text-muted hover:text-ink"
              }`}
            >
              {l.label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <div className="hidden md:block">
            <ThemeToggle />
          </div>
          <Link
            href="/studio"
            className="btn btn-primary hidden !min-h-0 !px-3 !py-2 text-sm md:inline-flex"
          >
            Account
          </Link>

          {/* Mobile menu trigger */}
          <button
            type="button"
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            aria-controls="mobile-nav"
            onClick={() => setOpen((v) => !v)}
            className="flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-line bg-surface text-ink md:hidden"
          >
            {open ? (
              <X className="h-5 w-5" aria-hidden="true" />
            ) : (
              <Menu className="h-5 w-5" aria-hidden="true" />
            )}
          </button>
        </div>
      </div>

      {/* Mobile nav panel */}
      {open && (
        <div
          id="mobile-nav"
          className="border-t border-line bg-surface md:hidden"
        >
          <nav
            aria-label="Mobile"
            className="mx-auto flex max-w-6xl flex-col gap-1 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
          >
            {NAV_LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                onClick={() => setOpen(false)}
                aria-current={isActive(l.href) ? "page" : undefined}
                className={`rounded-lg px-3 py-3 text-base font-medium ${
                  isActive(l.href)
                    ? "bg-raised text-ink"
                    : "text-muted hover:text-ink"
                }`}
              >
                {l.label}
              </Link>
            ))}
            <Link
              href="/studio"
              onClick={() => setOpen(false)}
              className="rounded-lg px-3 py-3 text-base font-medium text-muted hover:text-ink"
            >
              Account
            </Link>

            <div className="my-2 border-t border-line" />

            <ThemeToggle variant="inline" className="px-1 pb-1" />
          </nav>
        </div>
      )}
    </header>
  );
}
