"use client";

import { useState } from "react";
import {
  Link2,
  Loader2,
  AlertCircle,
  RefreshCw,
  Check,
  Palette,
} from "lucide-react";

const STAGES = [
  "Reading product page…",
  "Finding product details…",
  "Collecting product images…",
  "Analyzing brand…",
  "Preparing your ad workspace…",
];

/**
 * URL import flow: paste URL -> crawl -> review extracted ProductProfile +
 * BrandProfile + images + concepts. On "Continue", calls onImported(payload)
 * so the parent Studio prefills the generation form. NO paid generation here.
 */
export default function ProductImport({ onImported }) {
  const [url, setUrl] = useState("");
  const [phase, setPhase] = useState("idle"); // idle | crawling | review | error
  const [stage, setStage] = useState(0);
  const [error, setError] = useState("");
  const [data, setData] = useState(null); // import result
  const [concepts, setConcepts] = useState([]);
  const [chosenConcept, setChosenConcept] = useState(null);
  const [edits, setEdits] = useState({});
  const [heroUrl, setHeroUrl] = useState(null);
  const [removed, setRemoved] = useState(new Set());
  const [brandInfluence, setBrandInfluence] = useState("balanced");
  const [ignoreBrand, setIgnoreBrand] = useState(false);

  async function runImport(refresh = false) {
    setPhase("crawling");
    setError("");
    setStage(0);
    // advance the (honest, non-percentage) stage labels while we wait
    const timer = setInterval(
      () => setStage((s) => Math.min(s + 1, STAGES.length - 1)),
      900
    );
    try {
      const endpoint = refresh ? "/api/products/refresh" : "/api/products/import";
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, ...(refresh ? {} : {}) }),
      });
      const json = await res.json();
      clearInterval(timer);
      if (!res.ok) {
        setPhase("error");
        setError(json?.error || "Import failed.");
        return;
      }
      setData(json);
      const p = json.productProfile || {};
      setEdits({
        name: p.name || "",
        brand: p.brand || "",
        description: p.description || "",
        price: p.price ?? "",
        currency: p.currency || "",
        offer: p.offer || "",
      });
      setHeroUrl(p.primaryImage || p.productImages?.[0] || null);
      setRemoved(new Set());

      // fetch concepts (deterministic, no cost)
      const cRes = await fetch("/api/creative/concepts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ product: p, brand: json.brandProfile }),
      });
      const cJson = await cRes.json();
      setConcepts(cJson.concepts || []);
      setChosenConcept(cJson.concepts?.[0]?.id || null);
      setPhase("review");
    } catch (e) {
      clearInterval(timer);
      setPhase("error");
      setError(`Import failed: ${e.message}`);
    }
  }

  function toggleImage(u) {
    setRemoved((prev) => {
      const next = new Set(prev);
      next.has(u) ? next.delete(u) : next.add(u);
      return next;
    });
  }

  function continueToStudio() {
    const p = data.productProfile || {};
    const concept = concepts.find((c) => c.id === chosenConcept);
    const gallery = (p.productImages || []).filter((u) => !removed.has(u));
    onImported({
      productProfile: { ...p, ...edits, primaryImage: heroUrl },
      brandProfile: ignoreBrand ? null : data.brandProfile,
      brandInfluence,
      concept,
      heroUrl,
      gallery,
      form: {
        productName: edits.name,
        brand: edits.brand,
        description: edits.description,
        offer: edits.offer,
        template: concept?.template || "luxury",
      },
    });
  }

  // ---- render ----
  if (phase === "idle" || phase === "error") {
    return (
      <div className="rounded-2xl border border-zinc-200 p-6 dark:border-zinc-800">
        <label className="mb-2 block text-sm font-medium">Paste your product page</label>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Link2 className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
            <input
              className="input pl-9"
              placeholder="https://brand.com/products/product-name"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </div>
          <button
            onClick={() => runImport(false)}
            disabled={!url.trim()}
            className="rounded-xl bg-indigo-600 px-5 py-2.5 font-medium text-white transition hover:bg-indigo-700 disabled:opacity-60"
          >
            Import product
          </button>
        </div>
        {error && (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error} You can switch to manual upload instead.</span>
          </div>
        )}
        <p className="mt-3 text-xs text-zinc-500">
          We read the product page, extract details and images, and prepare ad
          concepts. No video is generated and nothing is charged at this step.
        </p>
      </div>
    );
  }

  if (phase === "crawling") {
    return (
      <div className="rounded-2xl border border-zinc-200 p-8 dark:border-zinc-800">
        <div className="flex items-center gap-3">
          <Loader2 className="h-5 w-5 animate-spin text-indigo-600" />
          <span className="font-medium">{STAGES[stage]}</span>
        </div>
        <ul className="mt-4 space-y-1.5 text-sm text-zinc-500">
          {STAGES.map((s, i) => (
            <li key={s} className={i <= stage ? "text-zinc-700 dark:text-zinc-300" : ""}>
              {i < stage ? "✓ " : i === stage ? "• " : "  "}
              {s}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  // review
  const p = data.productProfile || {};
  const brand = data.brandProfile;
  const warnings = data.extractionWarnings || [];
  const obs = data.observability || {};
  const gallery = p.productImages || [];

  return (
    <div className="space-y-6">
      {warnings.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          <div className="font-medium">Review these before generating:</div>
          <ul className="mt-1 list-disc pl-5">
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div className="text-sm text-zinc-500">
          Imported via {obs.crawlProvider} · confidence{" "}
          {(p.extractionConfidence ?? 0).toFixed(2)} · {obs.keptImageCount} images kept
        </div>
        <button
          onClick={() => runImport(true)}
          className="flex items-center gap-1.5 text-sm text-indigo-600 hover:underline"
        >
          <RefreshCw className="h-3.5 w-3.5" /> Refresh product data
        </button>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* editable fields */}
        <div className="space-y-3">
          <Field label="Product name">
            <input className="input" value={edits.name} onChange={(e) => setEdits({ ...edits, name: e.target.value })} />
          </Field>
          <Field label="Brand">
            <input className="input" value={edits.brand} onChange={(e) => setEdits({ ...edits, brand: e.target.value })} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Price">
              <input className="input" value={edits.price} onChange={(e) => setEdits({ ...edits, price: e.target.value })} />
            </Field>
            <Field label="Currency">
              <input className="input" value={edits.currency} onChange={(e) => setEdits({ ...edits, currency: e.target.value })} />
            </Field>
          </div>
          <Field label="Description">
            <textarea className="input min-h-24" value={edits.description} onChange={(e) => setEdits({ ...edits, description: e.target.value })} />
          </Field>
          <Field label="Offer">
            <input className="input" value={edits.offer} onChange={(e) => setEdits({ ...edits, offer: e.target.value })} placeholder="e.g. 20% off" />
          </Field>
        </div>

        {/* hero + gallery */}
        <div className="space-y-3">
          <span className="block text-sm font-medium">Hero image</span>
          <div className="aspect-square overflow-hidden rounded-xl border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900">
            {heroUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={heroUrl} alt="Hero" className="h-full w-full object-contain" />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-zinc-400">No image</div>
            )}
          </div>
          <span className="block text-sm font-medium">Gallery (click to choose hero / remove)</span>
          <div className="grid grid-cols-4 gap-2">
            {gallery.map((u) => (
              <div key={u} className="group relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={u}
                  alt="candidate"
                  onClick={() => setHeroUrl(u)}
                  className={`aspect-square w-full cursor-pointer rounded-lg border object-contain p-1 ${
                    heroUrl === u ? "border-indigo-500 ring-2 ring-indigo-300" : "border-zinc-200 dark:border-zinc-800"
                  } ${removed.has(u) ? "opacity-30" : ""}`}
                />
                <button
                  onClick={() => toggleImage(u)}
                  className="absolute right-1 top-1 rounded bg-black/60 px-1 text-xs text-white opacity-0 transition group-hover:opacity-100"
                >
                  {removed.has(u) ? "undo" : "✕"}
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* brand review */}
      {brand && (brand.primaryColors?.length || brand.logo || brand.name) && (
        <div className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium">
            <Palette className="h-4 w-4" /> Brand detected
            {brand.name ? `: ${brand.name}` : ""}{" "}
            <span className="text-xs font-normal text-zinc-500">
              (confidence {(brand.confidence ?? 0).toFixed(2)})
            </span>
          </div>
          {brand.confidence < 0.4 && (
            <p className="mb-2 text-xs text-zinc-500">
              Limited brand identity detected — using product-focused creative direction.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {(brand.primaryColors || []).concat(brand.secondaryColors || []).map((c) => (
              <span key={c} className="flex items-center gap-1 text-xs">
                <span className="inline-block h-5 w-5 rounded border border-zinc-300" style={{ background: c }} />
                {c}
              </span>
            ))}
          </div>
          <div className="mt-3 flex items-center gap-4 text-sm">
            <label className="flex items-center gap-2">
              Brand influence:
              <select className="input !w-auto !py-1" value={brandInfluence} onChange={(e) => setBrandInfluence(e.target.value)} disabled={ignoreBrand}>
                <option value="low">Low</option>
                <option value="balanced">Balanced</option>
                <option value="strong">Strong</option>
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={ignoreBrand} onChange={(e) => setIgnoreBrand(e.target.checked)} />
              Ignore brand style
            </label>
          </div>
        </div>
      )}

      {/* concepts */}
      {concepts.length > 0 && (
        <div>
          <span className="mb-2 block text-sm font-medium">Choose an ad concept</span>
          <div className="grid gap-2 sm:grid-cols-2">
            {concepts.map((c) => (
              <button
                key={c.id}
                onClick={() => setChosenConcept(c.id)}
                className={`rounded-xl border p-3 text-left transition ${
                  chosenConcept === c.id ? "border-indigo-500 bg-indigo-50 dark:bg-indigo-950/30" : "border-zinc-200 hover:border-zinc-300 dark:border-zinc-800"
                }`}
              >
                <div className="flex items-center gap-1.5 font-medium">
                  {chosenConcept === c.id && <Check className="h-4 w-4 text-indigo-600" />}
                  {c.title}
                </div>
                <div className="text-xs text-zinc-500">{c.rationale}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      <button
        onClick={continueToStudio}
        className="w-full rounded-xl bg-indigo-600 px-4 py-3 font-medium text-white transition hover:bg-indigo-700"
      >
        Continue to Ad Studio →
      </button>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium">{label}</span>
      {children}
    </label>
  );
}
