import Link from "next/link";
import { ArrowRight, Link2, Zap, ShieldCheck, Film } from "lucide-react";

export default function Home() {
  return (
    <main className="flex-1">
      {/* Hero */}
      <section className="mx-auto max-w-5xl px-4 pt-14 pb-14 sm:px-6 sm:pt-24 sm:pb-20">
        <p className="eyebrow mb-5 sm:mb-6">◩ AI Product Video Studio</p>
        <h1 className="display max-w-3xl text-3xl sm:text-5xl lg:text-6xl">
          Turn one product photo into a{" "}
          <span className="text-accent">professional</span> video ad.
        </h1>
        <p className="mt-5 max-w-xl text-base text-muted sm:mt-6 sm:text-lg">
          AdForge Studio reads your product page, understands your brand, plans
          the concept, and generates a commercial-grade ad with Google&apos;s
          Gemini — not a generic AI template.
        </p>

        <div className="mt-8 flex flex-col gap-3 sm:mt-9 sm:flex-row sm:flex-wrap sm:items-center">
          <Link href="/studio" className="btn btn-primary w-full sm:w-auto">
            Open the Studio <ArrowRight className="h-4 w-4" />
          </Link>
          <a href="#how" className="btn btn-secondary w-full sm:w-auto">
            How it works
          </a>
        </div>

        <div className="mono-meta mt-6 flex flex-wrap gap-x-5 gap-y-1">
          <span>720P / 1080P</span>
          <span>9:16 · 16:9</span>
          <span>OMNI FLASH</span>
          <span>FREE MOCK MODE BY DEFAULT</span>
        </div>
      </section>

      {/* Framed hero graphic — the brand motif in action */}
      <section className="mx-auto max-w-5xl px-4 pb-16 sm:px-6 sm:pb-24">
        <div className="frame-corners relative overflow-hidden rounded-brand border border-line bg-surface">
          <span className="corner tl" />
          <span className="corner tr" />
          <span className="corner bl" />
          <span className="corner br" />
          <div className="flex min-h-56 flex-col items-center justify-center gap-3 p-8 text-center sm:min-h-64 sm:p-16">
            <Film className="h-8 w-8 text-accent" />
            <p className="eyebrow">Product → Brand → Concept → Film</p>
            <p className="max-w-md text-muted">
              Paste a product URL and we handle the rest, up to a downloadable
              MP4 you review before spending a cent.
            </p>
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="how" className="mx-auto max-w-5xl px-4 pb-20 sm:px-6 sm:pb-28">
        <p className="eyebrow mb-6">How it works</p>
        <div className="grid gap-px overflow-hidden rounded-brand border border-line bg-line sm:grid-cols-3">
          <Feature
            icon={<Link2 className="h-5 w-5" />}
            index="01"
            title="Import from URL"
            body="We crawl the product page, extract real details, rank the best images and read your brand colors — no manual typing."
          />
          <Feature
            icon={<Zap className="h-5 w-5" />}
            index="02"
            title="Brand-aware concepts"
            body="A deliberate creative brief and scene plan, shaped by your brand. Two brands never get the same ad."
          />
          <Feature
            icon={<ShieldCheck className="h-5 w-5" />}
            index="03"
            title="Review, then generate"
            body="Approve the concept and images first. Paid generation stays off by default, with cost shown up front."
          />
        </div>
      </section>
    </main>
  );
}

function Feature({ icon, index, title, body }) {
  return (
    <div className="bg-surface p-7">
      <div className="mb-4 flex items-center justify-between">
        <span className="text-accent">{icon}</span>
        <span className="mono-meta">{index}</span>
      </div>
      <h3 className="text-lg font-semibold tracking-tight">{title}</h3>
      <p className="mt-2 text-sm text-muted">{body}</p>
    </div>
  );
}
