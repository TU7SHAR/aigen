import Link from "next/link";
import { ArrowRight } from "lucide-react";

/**
 * Shared, themed empty-state used by not-yet-built routes so navigation links
 * are always live (never dead/404) and consistent across light/dark.
 */
export default function ComingSoon({ eyebrow, title, body }) {
  return (
    <main className="flex-1">
      <section className="mx-auto max-w-5xl px-4 py-16 sm:px-6 sm:py-24">
        <p className="eyebrow mb-4">{eyebrow}</p>
        <h1 className="display text-3xl sm:text-4xl lg:text-5xl">{title}</h1>
        <p className="mt-5 max-w-xl text-base text-muted sm:text-lg">{body}</p>

        <div className="frame-corners relative mt-10 overflow-hidden rounded-brand border border-line bg-surface">
          <span className="corner tl" />
          <span className="corner tr" />
          <span className="corner bl" />
          <span className="corner br" />
          <div className="flex min-h-48 flex-col items-center justify-center gap-3 p-10 text-center sm:min-h-56">
            <p className="mono-meta">Not shipped yet</p>
            <p className="max-w-sm text-sm text-muted">
              This surface is part of the roadmap. For now, start by creating an
              ad in the Studio.
            </p>
            <Link href="/studio" className="btn btn-primary mt-2">
              Open the Studio <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
