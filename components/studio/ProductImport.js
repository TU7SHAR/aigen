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
import BrandMark from "@/components/layout/BrandMark.js";

const STAGES = [
  "Normalizing URL…",
  "Opening website…",
  "Understanding what this is…",
  "Collecting visual assets…",
  "Building profile…",
];

// Roles a user can assign to a reference image. Technical/structural only — no
// industry-specific creative mapping. Mirrors the crawler's asset roles plus
// a user_upload role.
const ASSET_ROLES = [
  "hero_visual",
  "hero_product",
  "product_screenshot",
  "app_screenshot",
  "dashboard_screenshot",
  "lifestyle",
  "brand_art",
  "illustration",
  "logo",
  "user_upload",
  "image",
];

const ENTITY_LABELS = {
  ecommerce_product: "Product",
  ecommerce_store: "Online Store",
  saas: "SaaS / Software",
  service: "Service",
  business: "Business",
  creator: "Creator / Personal Brand",
  portfolio: "Portfolio",
  course: "Course",
  app: "App",
  landing_page: "Landing Page",
  unknown: "Website / Business",
};

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
  const [conceptsStale, setConceptsStale] = useState(false);
  const [conceptsLoading, setConceptsLoading] = useState(false);
  const [edits, setEdits] = useState({});
  const [heroUrl, setHeroUrl] = useState(null);
  const [brandInfluence, setBrandInfluence] = useState("balanced");
  const [ignoreBrand, setIgnoreBrand] = useState(false);
  // Product PR A: per-asset manager state (keyed by url). Each entry:
  // { url, role, selected, isUpload, mimeType?, dataBase64? }
  const [assets, setAssets] = useState([]);
  // Product PR A: emphasis / avoid / extra context (free user input).
  const [emphasis, setEmphasis] = useState([]); // string[]
  const [avoid, setAvoid] = useState([]); // string[]
  const [uploadError, setUploadError] = useState("");
  // Campaign focus proposed by the importer (editable title; ask-when-ambiguous).
  const [focus, setFocus] = useState(null);

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
      // A store homepage's title ("H&M | Online Fashion, Homeware & Kids…") is
      // not what the ad sells: use the confirmed focus as the advertised name.
      const focusName = json.focus?.title && json.entityType !== "ecommerce_product" ? json.focus.title : null;
      setEdits({
        name: focusName || p.name || "",
        brand: p.brand || "",
        description: p.description || "",
        price: p.price ?? "",
        currency: p.currency || "",
        offer: p.offer || "",
        // Product PR A: user-correctable classification + offering + context.
        entityType: json.entityType || "unknown",
        category: p.category || "",
        offering: p.offering || "",
        userContext: "",
      });

      // Product PR A: build the per-asset manager from the full assets[] array
      // the importer returns (roles + storedUrl). The relevance-selected
      // primary (if any) is pre-selected; a logo/icon is never auto-primary.
      const primaryUrl = p.primaryImage || null;
      const focusUrls = new Set(json.focus?.assetUrls || []);
      const useFocus = focusUrls.size > 0;
      const importedAssets = (json.assets || [])
        .filter((a) => a && (a.storedUrl || a.sourceUrl))
        .map((a) => {
          const url = a.storedUrl || a.sourceUrl;
          const isScene = !["logo", "icon", "navigation_asset", "unrelated", "texture_background"].includes(a.role);
          return {
            url,
            role: a.role || "image",
            // Pre-select the images that belong to the campaign focus (or every
            // scene-worthy image when no focus was found); the user can change freely.
            selected: useFocus ? focusUrls.has(url) : isScene,
            primary: false,
            inFocus: focusUrls.has(url),
            isUpload: false,
            width: a.width,
            height: a.height,
          };
        });
      const focusFirst = json.focus?.assetUrls?.[0];
      const primaryPick = (useFocus ? importedAssets.find((a) => a.url === focusFirst) : null) || importedAssets.find((a) => a.url === primaryUrl);
      if (primaryPick) primaryPick.primary = true;
      setFocus(json.focus || null);
      // Fallback: if the importer didn't return a structured assets[] array,
      // derive from the flat productImages list (no roles).
      if (importedAssets.length === 0 && Array.isArray(p.productImages)) {
        for (const url of p.productImages) {
          importedAssets.push({ url, role: "image", selected: true, primary: url === primaryUrl, isUpload: false });
        }
      }
      if (!importedAssets.some((a) => a.primary) && importedAssets.some((a) => a.selected)) {
        const first = importedAssets.find((a) => a.selected);
        if (first) first.primary = true;
      }
      setAssets(importedAssets);
      setEmphasis([]);
      setAvoid([]);
      setUploadError("");
      setHeroUrl(primaryUrl || importedAssets.find((a) => a.primary)?.url || null);

      // Only generate concepts once we understand the entity well enough.
      // Below the threshold we ask the user to review first.
      const confidence = json.extractionConfidence ?? 0;
      if (confidence >= 0.45) {
        await loadConcepts(json, {
          name: focusName || p.name || "",
          brand: p.brand || "",
          description: p.description || "",
          offer: p.offer || "",
        }, json.focus || null);
      } else {
        setConcepts([]);
        setChosenConcept(null);
      }
      setConceptsStale(false);
      setPhase("review");
    } catch (e) {
      clearInterval(timer);
      setPhase("error");
      setError(`Import failed: ${e.message}`);
    }
  }

  // Fetch concepts using the CURRENT edited values (so corrections flow into
  // the AI concept reasoning). `editsNow` lets the import path pass fresh values
  // before `edits` state has settled.
  async function loadConcepts(json, editsNow, focusNow) {
    const p = json.productProfile || {};
    const e = editsNow || edits;
    const f = focusNow === undefined ? focus : focusNow;
    setConceptsLoading(true);
    try {
      const cRes = await fetch("/api/creative/concepts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // merge user edits over the scraped profile so concepts reflect
          // corrections (the whole point of the review screen).
          product: {
            ...p,
            name: e.name || p.name,
            brand: e.brand || p.brand,
            description: e.description || p.description,
            offer: e.offer || p.offer,
            // Product PR A: user-corrected classification/offering flow into
            // concept reasoning (the point of the review screen).
            category: e.category || p.category,
            offering: e.offering || p.offering,
            entityType: e.entityType || json.entityType,
          },
          brand: json.brandProfile,
          design: json.designProfile,
          entity: json.entityProfile,
          entityType: e.entityType || json.entityType,
          objective: e.objective || e.userContext || undefined,
          hasUsableImage: Boolean(heroUrl || p.primaryImage || p.productImages?.length),
          focus: f ? { title: f.title, type: f.type, rationale: f.rationale } : null,
        }),
      });
      const cJson = await cRes.json();
      setConcepts(cJson.concepts || []);
      setChosenConcept(cJson.concepts?.[0]?.id || null);
      setConceptsStale(false);
    } finally {
      setConceptsLoading(false);
    }
  }

  async function regenerateConcepts() {
    if (data) await loadConcepts(data, edits);
  }

  // Editing a field that affects creative reasoning marks concepts stale so the
  // user knows to regenerate (gap: corrections must invalidate stale plans).
  function editField(key, value) {
    setEdits((prev) => ({ ...prev, [key]: value }));
    if (["name", "brand", "description", "offer", "objective", "entityType", "category", "offering", "userContext"].includes(key)) {
      setConceptsStale(true);
    }
  }

  // ---- Product PR A: asset-manager handlers ----
  function updateAsset(url, patch) {
    setAssets((prev) => prev.map((a) => (a.url === url ? { ...a, ...patch } : a)));
  }
  function toggleAssetSelected(url) {
    setAssets((prev) =>
      prev.map((a) => (a.url === url ? { ...a, selected: !a.selected } : a))
    );
  }
  function setAssetPrimary(url) {
    // Exactly one primary; selecting a primary also selects it.
    setAssets((prev) => prev.map((a) => ({ ...a, primary: a.url === url, selected: a.url === url ? true : a.selected })));
    setHeroUrl(url);
  }
  function setAssetRole(url, role) {
    updateAsset(url, { role });
  }
  function removeAsset(url) {
    setAssets((prev) => {
      const next = prev.filter((a) => a.url !== url);
      // If we removed the primary, promote the first remaining selected asset.
      if (!next.some((a) => a.primary)) {
        const cand = next.find((a) => a.selected) || next[0];
        if (cand) cand.primary = true;
        setHeroUrl(cand?.url || null);
      }
      return next;
    });
  }

  const UPLOAD_MIME = ["image/png", "image/jpeg", "image/webp"];
  const UPLOAD_MAX = 5 * 1024 * 1024;
  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(",")[1] || "");
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }
  async function onUploadFiles(fileList) {
    setUploadError("");
    const files = Array.from(fileList || []);
    for (const file of files) {
      if (!UPLOAD_MIME.includes(file.type)) {
        setUploadError(`Unsupported file type: ${file.name} (PNG/JPEG/WebP only).`);
        continue;
      }
      if (file.size > UPLOAD_MAX) {
        setUploadError(`${file.name} exceeds the 5 MB limit.`);
        continue;
      }
      const dataBase64 = await fileToBase64(file);
      const url = `upload:${file.name}:${file.size}`; // stable local key (not fetched)
      setAssets((prev) => {
        if (prev.some((a) => a.url === url)) return prev;
        const next = [
          ...prev,
          { url, role: "user_upload", selected: true, primary: false, isUpload: true, mimeType: file.type, dataBase64, name: file.name },
        ];
        // If nothing is primary yet, make this upload primary.
        if (!next.some((a) => a.primary)) {
          next[next.length - 1].primary = true;
          setHeroUrl(url);
        }
        return next;
      });
    }
  }

  // ---- emphasis / avoid list editing (comma or newline separated) ----
  function parseList(text) {
    return Array.from(
      new Set(
        String(text || "")
          .split(/[\n,]/)
          .map((s) => s.trim())
          .filter(Boolean)
      )
    );
  }

  function continueToStudio() {
    const p = data.productProfile || {};
    const concept = concepts.find((c) => c.id === chosenConcept);

    // Product PR A: resolve the user's asset selections.
    const selected = assets.filter((a) => a.selected);
    const primary = selected.find((a) => a.primary) || selected[0] || null;
    // Non-upload, URL-backed selected assets → referenceAssets (resolved
    // server-side SSRF-safely). Uploads can't be fetched by URL, so the PRIMARY
    // upload flows through the single base64 `image` path instead.
    const urlRefs = selected
      .filter((a) => !a.isUpload)
      .map((a) => ({ url: a.url, role: a.role, primary: Boolean(a.primary) }));
    const primaryUpload = primary?.isUpload ? primary : selected.find((a) => a.isUpload) || null;

    const entityType = edits.entityType || data.entityType;

    onImported({
      productProfile: {
        ...p,
        ...definedEdits(edits),
        entityType,
        category: edits.category || p.category,
        offering: edits.offering || p.offering,
        primaryImage: primary && !primary.isUpload ? primary.url : heroUrl,
      },
      brandProfile: ignoreBrand ? null : data.brandProfile,
      brandInfluence,
      entityType,
      // Pass the designProfile through (was schema-ready but never forwarded).
      designProfile: data.designProfile || null,
      entityConfidence: data.extractionConfidence ?? p.extractionConfidence ?? undefined,
      concept,
      // The primary reference (hero). If it's an upload, send base64; else URL.
      heroUrl: primary && !primary.isUpload ? primary.url : null,
      uploadImage: primaryUpload ? { data: primaryUpload.dataBase64, mimeType: primaryUpload.mimeType } : null,
      // All user-selected URL references (multi-image).
      referenceAssets: urlRefs,
      // Free user controls.
      userContext: (edits.userContext || "").trim() || undefined,
      emphasis,
      avoid,
      focus: focus
        ? { type: focus.type, title: (focus.title || "").trim(), rationale: focus.rationale || "", confidence: focus.confidence, source: focus.source, assetUrls: urlRefs.map((r) => r.url) }
        : null,
      form: {
        productName: edits.name,
        brand: edits.brand,
        description: edits.description,
        offer: edits.offer,
        template: concept?.template,
      },
    });
  }

  // Only non-empty edits (so a cleared field doesn't wipe a scraped value).
  function definedEdits(e) {
    const out = {};
    for (const k of ["name", "brand", "description", "price", "currency", "offer"]) {
      if (e[k] !== undefined && e[k] !== "") out[k] = e[k];
    }
    return out;
  }

  // ---- render ----
  if (phase === "idle" || phase === "error") {
    return (
      <div className="card p-4 sm:p-6">
        <label htmlFor="product-url" className="mb-2 block text-sm font-medium">
          Paste your product page
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <Link2 className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden="true" />
            <input
              id="product-url"
              type="url"
              inputMode="url"
              className="input pl-9"
              style={{ paddingLeft: "2.25rem" }}
              placeholder="https://brand.com/products/product-name"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </div>
          <button
            onClick={() => runImport(false)}
            disabled={!url.trim()}
            className="btn btn-primary w-full disabled:opacity-60 sm:w-auto sm:shrink-0"
          >
            Import product
          </button>
        </div>
        {error && (
          <div className="alert alert-danger mt-3" role="alert">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="break-anywhere">{error} You can switch to manual upload instead.</span>
          </div>
        )}
        <p className="mt-3 text-xs text-muted">
          We read the product page, extract details and images, and prepare ad
          concepts. No video is generated and nothing is charged at this step.
        </p>
      </div>
    );
  }

  if (phase === "crawling") {
    return (
      <div className="card p-6 sm:p-8">
        <div className="flex items-center gap-3">
          <Loader2 className="h-5 w-5 animate-spin text-accent" />
          <span className="font-medium">{STAGES[stage]}</span>
        </div>
        <ul className="mt-4 space-y-1.5 text-sm text-muted">
          {STAGES.map((s, i) => (
            <li key={s} className={i <= stage ? "text-ink" : ""}>
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
  // Product PR A: the primary preview comes from the asset manager.
  const primaryAsset = assets.find((a) => a.primary && a.selected) || assets.find((a) => a.primary) || null;
  const primaryPreviewUrl = primaryAsset
    ? primaryAsset.isUpload
      ? `data:${primaryAsset.mimeType};base64,${primaryAsset.dataBase64}`
      : primaryAsset.url
    : null;

  const conf = data.extractionConfidence ?? p.extractionConfidence ?? 0;
  const lowConf = conf < 0.45;

  return (
    <div className="space-y-6">
      {/* What we understood this as */}
      <div className="card p-4">
        <div className="eyebrow mb-1">We understood this as</div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <BrandMark className="h-4 w-4 shrink-0 text-accent" />
          <span className="break-anywhere text-base font-semibold sm:text-lg">{ENTITY_LABELS[data.entityType] || "Website / Business"}</span>
          <span className="mono-meta ml-auto">CONF {conf.toFixed(2)}</span>
        </div>
        {lowConf && (
          <p className="mt-2 text-sm text-muted">
            We found some information but couldn&apos;t confidently identify
            everything. Please review the fields below before continuing — we
            won&apos;t suggest ad concepts until this looks right.
          </p>
        )}
      </div>

      {warnings.length > 0 && (
        <div className="alert alert-warning flex-col items-stretch" role="status">
          <div className="mono-meta !text-warning mb-1">Review before generating</div>
          <ul className="mt-1 list-disc pl-5 break-anywhere">
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-sm text-muted break-anywhere">
          Imported via {obs.crawlProvider} · confidence{" "}
          {(p.extractionConfidence ?? 0).toFixed(2)} · {obs.keptImageCount} images kept
        </div>
        <button
          onClick={() => runImport(true)}
          className="flex items-center gap-1.5 self-start text-sm text-accent hover:underline sm:self-auto"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Refresh product data
        </button>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* editable fields */}
        <div className="space-y-3">
          {/* Product PR A: user-correctable classification */}
          <div className="grid grid-cols-1 gap-3 min-[400px]:grid-cols-2">
            <Field label="What is this? (type)">
              <select className="input" value={edits.entityType || "unknown"} onChange={(e) => editField("entityType", e.target.value)}>
                {Object.entries(ENTITY_LABELS).map(([val, label]) => (
                  <option key={val} value={val}>{label}</option>
                ))}
              </select>
            </Field>
            <Field label="Category / industry">
              <input className="input" value={edits.category || ""} onChange={(e) => editField("category", e.target.value)} placeholder="e.g. project management SaaS" />
            </Field>
          </div>
          <Field label="Offering (what it provides)">
            <input className="input" value={edits.offering || ""} onChange={(e) => editField("offering", e.target.value)} placeholder="e.g. team task tracking with automations" />
          </Field>
          <Field label="Product / service name">
            <input className="input" value={edits.name} onChange={(e) => editField("name", e.target.value)} />
          </Field>
          <Field label="Brand">
            <input className="input" value={edits.brand} onChange={(e) => editField("brand", e.target.value)} />
          </Field>
          <div className="grid grid-cols-1 gap-3 min-[400px]:grid-cols-2">
            <Field label="Price">
              <input className="input" value={edits.price} onChange={(e) => setEdits({ ...edits, price: e.target.value })} />
            </Field>
            <Field label="Currency">
              <input className="input" value={edits.currency} onChange={(e) => setEdits({ ...edits, currency: e.target.value })} />
            </Field>
          </div>
          <Field label="Description">
            <textarea className="input min-h-24" value={edits.description} onChange={(e) => editField("description", e.target.value)} />
          </Field>
          <Field label="Offer">
            <input className="input" value={edits.offer} onChange={(e) => editField("offer", e.target.value)} placeholder="e.g. 20% off" />
          </Field>
        </div>

        {/* Campaign focus: what this ad is about (editable, honest about confidence) */}
        {focus && (
          <div className="rounded-brand border border-line bg-surface p-3" style={{ borderLeft: "3px solid var(--accent)" }}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="eyebrow">Ad focus</span>
              <span className="mono-meta">{String(focus.type || "").replace(/_/g, " ")}</span>
              <span className={`mono-meta ml-auto ${focus.confidence >= 0.5 ? "!text-accent" : ""}`}>
                {focus.source === "ai" ? "AI-selected" : "best guess"} · confidence {Number(focus.confidence || 0).toFixed(2)}
              </span>
            </div>
            <label className="mt-2 block">
              <span className="sr-only">Ad focus title</span>
              <input className="input" value={focus.title || ""} onChange={(e) => { setFocus({ ...focus, title: e.target.value }); setConceptsStale(true); }} placeholder="What exactly should this ad sell?" />
            </label>
            {focus.rationale && <p className="mt-1 text-xs text-muted break-anywhere">{focus.rationale}</p>}
            {focus.question && (
              <p className="mt-2 text-sm" role="status">
                <b>Please confirm:</b> {focus.question} Edit the focus above and keep only the matching images selected.
              </p>
            )}
            {focus.rejected?.length > 0 && (
              <p className="mt-1 text-xs text-muted">Not used: {focus.rejected.slice(0, 4).map((r) => r.reason).filter(Boolean).join(" · ")}</p>
            )}
          </div>
        )}

        {/* Product PR A: asset manager (select / role / primary / remove / upload) */}
        <div className="space-y-3">
          <span className="block text-sm font-medium">Reference images</span>
          <p className="text-xs text-muted">
            Pick which images influence the video, set each one&apos;s purpose, and
            choose the primary reference. Add your own screenshots, logos or
            product photos. Unselected images are ignored.
          </p>
          <div className="aspect-video overflow-hidden rounded-brand border border-line bg-surface">
            {primaryPreviewUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={primaryPreviewUrl} alt="Primary reference" loading="lazy" className="h-full w-full object-contain" />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted">No primary reference selected</div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2 min-[500px]:grid-cols-3">
            {assets.map((a) => (
              <div
                key={a.url}
                className={`group relative rounded-lg border p-1.5 ${
                  a.primary ? "border-accent ring-2 ring-[color:var(--accent)]" : a.selected ? "border-ink" : "border-line opacity-60"
                }`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={a.isUpload ? `data:${a.mimeType};base64,${a.dataBase64}` : a.url}
                  alt={a.role}
                  loading="lazy"
                  onClick={() => toggleAssetSelected(a.url)}
                  className="aspect-square w-full cursor-pointer rounded bg-surface object-contain"
                />
                <button
                  onClick={() => removeAsset(a.url)}
                  className="absolute right-1 top-1 rounded bg-black/60 px-1 text-xs text-white opacity-0 transition group-hover:opacity-100"
                  aria-label="Remove image"
                >
                  ✕
                </button>
                <select
                  className="input mt-1 !min-h-0 !py-1 text-xs"
                  value={a.role}
                  onChange={(e) => setAssetRole(a.url, e.target.value)}
                >
                  {ASSET_ROLES.map((r) => (
                    <option key={r} value={r}>{r.replace(/_/g, " ")}</option>
                  ))}
                </select>
                <div className="mt-1 flex items-center justify-between gap-1 text-[11px]">
                  <label className="flex items-center gap-1">
                    <input type="checkbox" checked={a.selected} onChange={() => toggleAssetSelected(a.url)} />
                    use
                  </label>
                  <button
                    type="button"
                    onClick={() => setAssetPrimary(a.url)}
                    className={a.primary ? "font-medium text-accent" : "text-muted hover:underline"}
                  >
                    {a.primary ? "★ primary" : "set primary"}
                  </button>
                </div>
              </div>
            ))}
          </div>

          <label className="btn btn-ghost w-full cursor-pointer text-sm">
            + Upload image(s)
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              className="hidden"
              onChange={(e) => onUploadFiles(e.target.files)}
            />
          </label>
          {uploadError && (
            <p className="text-xs text-danger" role="alert">{uploadError}</p>
          )}
        </div>
      </div>

      {/* Product PR A: emphasis / avoid / extra context */}
      <div className="card space-y-3 p-4">
        <div className="eyebrow">Direct the ad (optional)</div>
        <Field label="Extra context about your product/service or the video you want">
          <textarea
            className="input min-h-20"
            value={edits.userContext || ""}
            onChange={(e) => editField("userContext", e.target.value)}
            placeholder="Anything the page didn't say — audience, tone, the angle you want, what makes you different…"
          />
        </Field>
        <div className="grid gap-3 min-[500px]:grid-cols-2">
          <Field label="Emphasize (features / benefits / messages)">
            <textarea
              className="input min-h-16"
              defaultValue={emphasis.join("\n")}
              onChange={(e) => setEmphasis(parseList(e.target.value))}
              placeholder="One per line, e.g.&#10;real-time sync&#10;works offline"
            />
          </Field>
          <Field label="Must NOT appear">
            <textarea
              className="input min-h-16"
              defaultValue={avoid.join("\n")}
              onChange={(e) => setAvoid(parseList(e.target.value))}
              placeholder="One per line, e.g.&#10;no people&#10;no competitor logos"
            />
          </Field>
        </div>
      </div>

      {/* brand review */}
      {brand && (brand.primaryColors?.length || brand.logo || brand.name) && (
        <div className="card p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium">
            <Palette className="h-4 w-4" /> Brand detected
            {brand.name ? `: ${brand.name}` : ""}{" "}
            <span className="text-xs font-normal text-muted">
              (confidence {(brand.confidence ?? 0).toFixed(2)})
            </span>
          </div>
          {brand.confidence < 0.4 && (
            <p className="mb-2 text-xs text-muted">
              Limited brand identity detected — using product-focused creative direction.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {(brand.primaryColors || []).concat(brand.secondaryColors || []).map((c) => (
              <span key={c} className="flex items-center gap-1 text-xs">
                <span className="inline-block h-5 w-5 rounded border border-line" style={{ background: c }} />
                {c}
              </span>
            ))}
          </div>
          <div className="mt-3 flex flex-col gap-3 text-sm sm:flex-row sm:flex-wrap sm:items-center sm:gap-4">
            <label className="flex items-center gap-2">
              Brand influence:
              <select className="input !min-h-0 !w-auto !py-1.5" value={brandInfluence} onChange={(e) => setBrandInfluence(e.target.value)} disabled={ignoreBrand}>
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

      {/* concepts gated on confidence */}
      {concepts.length === 0 && (
        <div className="card px-4 py-3 text-sm text-muted">
          Ad concepts will appear once the details above look right. Edit the
          fields, then continue — we&apos;ll tailor concepts to a{" "}
          <b>{(ENTITY_LABELS[data.entityType] || "business").toLowerCase()}</b>.
        </div>
      )}
      {concepts.length > 0 && (
        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="eyebrow">Choose an ad concept</span>
            {(conceptsStale || conceptsLoading) && (
              <button
                type="button"
                onClick={regenerateConcepts}
                disabled={conceptsLoading}
                className="flex items-center gap-1.5 text-xs text-accent hover:underline disabled:opacity-60"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${conceptsLoading ? "animate-spin" : ""}`} />
                {conceptsLoading ? "Updating…" : "You edited details — regenerate concepts"}
              </button>
            )}
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {concepts.map((c) => (
              <button
                key={c.id}
                onClick={() => setChosenConcept(c.id)}
                className={`rounded-xl border p-3 text-left transition ${
                  chosenConcept === c.id ? "border-accent bg-surface" : "border-line bg-surface hover:border-ink"
                }`}
              >
                <div className="flex items-center gap-1.5 font-medium">
                  {chosenConcept === c.id && <Check className="h-4 w-4 text-accent" />}
                  {c.title}
                </div>
                <div className="text-xs text-muted">
                  {c.centralMessage || c.objective || c.rationale}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      <button
        onClick={continueToStudio}
        className="btn btn-primary w-full"
      >
        Continue to Ad Studio →
      </button>

      {/* Dev-only debug panel (hidden in production). Collapsible accordion;
          single column on mobile → two columns from sm; long URLs wrap. */}
      {process.env.NODE_ENV !== "production" && (
        <details className="card px-4 py-3 text-xs text-muted">
          <summary className="mono-meta cursor-pointer">Debug · import internals</summary>
          <div className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 break-anywhere sm:grid-cols-2">
            <span>Input → {data.normalizedInputUrl}</span>
            <span>Final → {data.finalUrl}</span>
            <span>Crawler: {obs.crawlProvider}{obs.usedFirecrawl ? " (firecrawl)" : ""}</span>
            <span>Product schema: {obs.hasProductSchema ? "yes" : "no"}</span>
            <span>Pages: {(data.pagesUsed || []).length}</span>
            <span>Images: {obs.candidateImageCount} → {obs.keptImageCount}</span>
            <span>AI enrich: {data.aiEnrichment?.used ? data.aiEnrichment.model : "no"}</span>
            <span>Confidence: {conf.toFixed(2)}</span>
            {obs.sizeTrace && (
              <>
                <span>Raw HTML: {obs.sizeTrace.rawHtmlChars} ch</span>
                <span>Cleaned: {obs.sizeTrace.cleanedChars} ch</span>
                <span>AI input: {obs.sizeTrace.semanticInputChars} ch</span>
                <span>
                  Enrich tokens: {data.aiEnrichment?.inputTokens ?? "—"}/
                  {data.aiEnrichment?.outputTokens ?? "—"}
                </span>
              </>
            )}
          </div>
        </details>
      )}
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
