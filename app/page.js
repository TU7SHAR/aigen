import Link from "next/link";
import { Sparkles, Zap, ShieldCheck, Image as ImageIcon } from "lucide-react";

export default function Home() {
  return (
    <main className="flex-1">
      {/* Hero */}
      <section className="mx-auto max-w-5xl px-6 py-24 text-center">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1 text-xs font-medium text-indigo-700 dark:border-indigo-900 dark:bg-indigo-950/40 dark:text-indigo-300">
          <Sparkles className="h-3.5 w-3.5" /> AI product video ads
        </span>
        <h1 className="mx-auto mt-6 max-w-3xl text-4xl font-semibold tracking-tight text-black sm:text-5xl dark:text-zinc-50">
          Turn one product photo into a polished video ad.
        </h1>
        <p className="mx-auto mt-5 max-w-xl text-lg text-zinc-600 dark:text-zinc-400">
          AdForge Studio helps ecommerce brands create short, on-brand product
          video ads with Google&apos;s Gemini — upload a photo, pick a style,
          and generate.
        </p>
        <div className="mt-8 flex items-center justify-center gap-3">
          <Link
            href="/studio"
            className="rounded-full bg-indigo-600 px-6 py-3 font-medium text-white transition hover:bg-indigo-700"
          >
            Open the Studio
          </Link>
          <a
            href="#how"
            className="rounded-full border border-zinc-300 px-6 py-3 font-medium transition hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            How it works
          </a>
        </div>
        <p className="mt-4 text-xs text-zinc-500">
          Prototype — real generation requires a Gemini API key. Runs in free
          mock mode by default (no cost).
        </p>
      </section>

      {/* Features */}
      <section
        id="how"
        className="mx-auto grid max-w-5xl gap-6 px-6 pb-24 sm:grid-cols-3"
      >
        <Feature
          icon={<ImageIcon className="h-5 w-5" />}
          title="Photo → video"
          body="Upload a product shot and generate motion footage that keeps your product recognizable."
        />
        <Feature
          icon={<Zap className="h-5 w-5" />}
          title="Opinionated templates"
          body="Luxury, Bold, Minimal, Product Demo and Problem→Solution — good ad structures, not empty prompts."
        />
        <Feature
          icon={<ShieldCheck className="h-5 w-5" />}
          title="Cost-aware by default"
          body="Paid generation is off until you enable it, with cost estimates and a local spend guard."
        />
      </section>
    </main>
  );
}

function Feature({ icon, title, body }) {
  return (
    <div className="rounded-2xl border border-zinc-200 p-6 dark:border-zinc-800">
      <div className="mb-3 inline-flex rounded-xl bg-indigo-50 p-2 text-indigo-600 dark:bg-indigo-950/40 dark:text-indigo-300">
        {icon}
      </div>
      <h3 className="font-semibold">{title}</h3>
      <p className="mt-1.5 text-sm text-zinc-600 dark:text-zinc-400">{body}</p>
    </div>
  );
}
