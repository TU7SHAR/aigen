"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Upload,
  Loader2,
  Download,
  AlertCircle,
  ImageIcon,
  Info,
  Link2,
  ArrowRight,
} from "lucide-react";
import ProductImport from "./ProductImport.js";

const TEMPLATES = [
  { id: "luxury", label: "Luxury Studio", hint: "Premium, cinematic" },
  { id: "bold", label: "Bold Performance", hint: "High energy" },
  { id: "minimal", label: "Minimal Hero", hint: "Modern, neutral" },
  { id: "product-demo", label: "Product Demo", hint: "Show features" },
  { id: "problem-solution", label: "Problem → Solution", hint: "Narrative" },
  { id: "lifestyle", label: "Lifestyle", hint: "Natural setting" },
];
const RATIOS = [
  { id: "9:16", label: "9:16 Portrait" },
  { id: "16:9", label: "16:9 Landscape" },
];
const RESOLUTIONS = ["360p", "720p", "1080p"];
const ALLOWED_MIME = ["image/png", "image/jpeg", "image/webp"];
const MAX_BYTES = 5 * 1024 * 1024;

// Production formats. Deterministic ones render a finished MP4 from your real
// assets + exact copy (no paid model). "generative" is gated behind the paid
// kill-switch (returns a reviewable dry-run plan while paid gen is disabled).
const FORMATS = [
  { id: "screen_demo", label: "AI video ad (storyboard)", hint: "Real product/site footage + AI video shots, voiceover and music — paid shots run only when enabled and within the per-job cap", kind: "deterministic" },
  { id: "cinematic_card", label: "Narrated brand card", hint: "Branded title-card ad from your assets — no AI video cost", kind: "deterministic" },
  { id: "generative", label: "Generative cinematic", hint: "AI-generated footage (paid; dry-run while disabled)", kind: "generative" },
];

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      const comma = result.indexOf(",");
      resolve(result.slice(comma + 1)); // strip data: prefix
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function Studio() {
  const [status, setStatus] = useState(null); // provider/paid info
  const [image, setImage] = useState(null); // { previewUrl, base64, mimeType, name }
  const [dragOver, setDragOver] = useState(false);
  const [form, setForm] = useState({
    productName: "",
    brand: "",
    description: "",
    offer: "",
    cta: "",
    template: "luxury",
    aspectRatio: "9:16",
    resolution: "720p",
    durationSeconds: 14,
    // Production format. Default = deterministic screen-based render (real
    // assets + exact text, NO paid model). "generative" is gated/dry-run.
    format: "screen_demo",
  });
  // When the user hand-edits the prompt we store it here; otherwise the prompt
  // is derived from the form via useMemo (no setState-in-effect).
  const [promptEdit, setPromptEdit] = useState(null);
  const [phase, setPhase] = useState("idle"); // idle | processing | completed | failed
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const fileInputRef = useRef(null);
  const inFlight = useRef(false);

  // Create-from mode: "url" (import) or "manual" (upload). Imported context is
  // carried into generation so the creative pipeline can use the brand.
  const [mode, setMode] = useState("url");
  const [imported, setImported] = useState(null); // { productProfile, brandProfile, brandInfluence }
  const [importedImages, setImportedImages] = useState([]); // hero + gallery urls

  // AI Creative Director storyboard for the chosen concept. Generated from the
  // imported concept + brand evidence (cheap TEXT model; no video cost). It is
  // the executable, per-shot plan that drives production — NOT user-editable
  // (read-only review per product vision). `origin` is "ai" or "fallback".
  const [storyboard, setStoryboard] = useState(null); // { logline, shots, origin, note? }
  const [storyboardLoading, setStoryboardLoading] = useState(false);

  const handleImported = useCallback((payload) => {
    setStoryboard(null); // new source → regenerate the storyboard from scratch
    setImported({
      productProfile: payload.productProfile,
      brandProfile: payload.brandProfile,
      brandInfluence: payload.brandInfluence,
      entityType: payload.entityType,
      designProfile: payload.designProfile || null,
      entityConfidence: payload.entityConfidence,
      concept: payload.concept,
      // The chosen hero image becomes the server-resolved generation reference
      // (fixes the bug where a crawler-found image never reached the model).
      referenceAssetUrl: payload.heroUrl || null,
      // Product PR A: all user-selected URL references (multi-image), plus the
      // user's emphasis/avoid/context corrections.
      referenceAssets: payload.referenceAssets || [],
      emphasis: payload.emphasis || [],
      avoid: payload.avoid || [],
      userContext: payload.userContext || undefined,
    });
    setImportedImages(
      [payload.heroUrl, ...(payload.referenceAssets || []).map((a) => a.url)].filter(Boolean)
    );
    // Product PR A: if the user's primary reference is an UPLOAD, seed it as the
    // single base64 generation image (uploads can't be fetched by URL).
    if (payload.uploadImage?.data) {
      setImage({
        previewUrl: `data:${payload.uploadImage.mimeType};base64,${payload.uploadImage.data}`,
        base64: payload.uploadImage.data,
        mimeType: payload.uploadImage.mimeType,
        name: "uploaded-reference",
      });
    }
    setForm((f) => ({
      ...f,
      productName: payload.form.productName || f.productName,
      brand: payload.form.brand || f.brand,
      description: payload.form.description || f.description,
      offer: payload.form.offer || f.offer,
      template: payload.form.template || f.template,
    }));
    setMode("manual"); // reveal the full editor, prefilled
  }, []);

  // Fetch provider/paid status for honest UI messaging.
  useEffect(() => {
    fetch("/api/generate")
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => {});
  }, []);

  // SINGLE SOURCE OF TRUTH: the displayed prompt is the SERVER's compiled prompt
  // from /api/creative/preview — not a client approximation. Debounced so edits
  // to any creative field refresh it. No paid call (preview compiles only).
  const [serverPreview, setServerPreview] = useState(null); // { finalVideoPrompt, preflight, entityType, generationMode, creativeBrief, scenePlan }
  const [previewLoading, setPreviewLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const hasName = form.productName.trim().length > 0;
    const t = setTimeout(async () => {
      if (!hasName) {
        if (!cancelled) setServerPreview(null);
        return;
      }
      if (!cancelled) setPreviewLoading(true);
      try {
        const res = await fetch("/api/creative/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...form,
            durationSeconds: Number(form.durationSeconds),
            image: image ? { data: image.base64, mimeType: image.mimeType } : undefined,
            productProfile: imported?.productProfile || undefined,
            brandProfile: imported?.brandProfile || undefined,
            brandInfluence: imported?.brandInfluence || "balanced",
            entityType: imported?.entityType || undefined,
            designProfile: imported?.designProfile || undefined,
            entityConfidence: imported?.entityConfidence,
            concept: imported?.concept || undefined,
            // AI Creative Director storyboard drives the scene plan + per-shot
            // production when present (so the preview matches what will render).
            storyboard: storyboard || undefined,
            category: imported?.productProfile?.category || undefined,
            offering: imported?.productProfile?.offering || undefined,
            userIntent: imported?.userContext || undefined,
            emphasis: imported?.emphasis?.length ? imported.emphasis : undefined,
            avoid: imported?.avoid?.length ? imported.avoid : undefined,
            referenceAssets: imported?.referenceAssets?.length ? imported.referenceAssets : undefined,
            sourceImageMeta: image ? { hintText: image.name, url: image.name } : undefined,
          }),
        });
        const data = await res.json();
        if (!cancelled && res.ok) setServerPreview(data);
      } catch {
        /* preview is best-effort; generation still validates server-side */
      } finally {
        if (!cancelled) setPreviewLoading(false);
      }
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [form, image, imported, storyboard]);

  // AI CREATIVE DIRECTOR: once a concept + offering exist, ask the Director for
  // an executable storyboard. Debounced; cheap TEXT model (no video cost). The
  // result is read-only (approve or regenerate), per product vision — not an
  // editable timeline. Degrades to a labeled deterministic storyboard with no key.
  const buildStoryboard = useCallback(async () => {
    const concept = imported?.concept;
    const name = form.productName.trim() || imported?.productProfile?.name;
    if (!concept || !name) {
      setStoryboard(null);
      return;
    }
    setStoryboardLoading(true);
    try {
      const availableAssets = (imported?.referenceAssets?.length
        ? imported.referenceAssets
        : importedImages.map((u) => ({ url: u }))
      ).map((a) => ({ role: a.role || "image", kind: "image" }));
      const res = await fetch("/api/creative/storyboard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          concept,
          product: {
            name,
            brand: form.brand || imported?.brandProfile?.name,
            description: form.description || imported?.productProfile?.description,
            offer: form.offer || undefined,
            cta: form.cta || undefined,
            category: imported?.productProfile?.category,
            offering: imported?.productProfile?.offering,
            targetCustomer: imported?.productProfile?.targetCustomer,
          },
          brand: imported?.brandProfile || null,
          design: imported?.designProfile || null,
          entityType: imported?.entityType,
          durationSeconds: Number(form.durationSeconds),
          aspectRatio: form.aspectRatio,
          availableAssets,
          emphasis: imported?.emphasis?.length ? imported.emphasis : undefined,
          avoid: imported?.avoid?.length ? imported.avoid : undefined,
        }),
      });
      const data = await res.json();
      if (res.ok && data?.storyboard?.shots?.length) {
        setStoryboard({ ...data.storyboard, origin: data.origin, note: data.note });
      } else {
        setStoryboard(null);
      }
    } catch {
      setStoryboard(null);
    } finally {
      setStoryboardLoading(false);
    }
  }, [imported, form.productName, form.brand, form.description, form.offer, form.cta, form.durationSeconds, form.aspectRatio, importedImages]);

  // Regenerate the storyboard when the concept arrives or key creative fields
  // change (debounced). Only runs once a concept is present.
  useEffect(() => {
    if (!imported?.concept) return;
    const t = setTimeout(() => { buildStoryboard(); }, 600);
    return () => clearTimeout(t);
  }, [imported?.concept, buildStoryboard]);

  const editingPrompt = promptEdit !== null;
  const promptPreview = editingPrompt
    ? promptEdit
    : serverPreview?.finalVideoPrompt || "";

  // Entity-aware field labels: SaaS/service/creator users shouldn't see
  // "Product name / Product image" as if they sell a physical item.
  const entity = imported?.entityType || serverPreview?.entityType || "";
  const isPhysical = /physical_product|ecommerce/.test(entity);
  const labels = isPhysical
    ? { name: "Product name *", image: "Product image" }
    : entity.includes("creator") || entity.includes("personal_brand")
      ? { name: "Creator / brand name *", image: "Profile / brand visual" }
      : entity
        ? { name: "Name *", image: "Primary visual" }
        : { name: "Product / brand name *", image: "Primary visual" };

  const onPickFile = useCallback(async (file) => {
    setError("");
    if (!file) return;
    if (!ALLOWED_MIME.includes(file.type)) {
      setError("Unsupported image type. Use PNG, JPEG or WEBP.");
      return;
    }
    if (file.size > MAX_BYTES) {
      setError("Image is larger than 5 MB.");
      return;
    }
    const base64 = await fileToBase64(file);
    setImage({
      previewUrl: URL.createObjectURL(file),
      base64,
      mimeType: file.type,
      name: file.name,
    });
  }, []);

  const update = (k) => (e) =>
    setForm((f) => ({ ...f, [k]: e?.target ? e.target.value : e }));

  const estCostLabel = useMemo(() => {
    // Use the ACTIVE model's per-second rate from the server status probe
    // (reads VIDEO_MODEL at request time) — not a hardcoded Omni rate. Falls
    // back to 0.10 only until the probe resolves. Same resolution multipliers
    // as the server's estimateCost().
    const rate = status?.model?.usdPerSecond720p ?? 0.1;
    const mult =
      (status?.resolutionMultipliers || { "360p": 0.5, "720p": 1, "1080p": 1.6 })[
        form.resolution
      ] ?? 1;
    const usd = (rate * form.durationSeconds * mult).toFixed(2);
    return `~$${usd}`;
  }, [status, form.resolution, form.durationSeconds]);

  async function generate() {
    if (inFlight.current) return;
    if (!form.productName.trim()) {
      setError("Please enter a product name.");
      return;
    }
    inFlight.current = true;
    setPhase("processing");
    setError("");
    setResult(null);

    const payload = {
      ...form,
      durationSeconds: Number(form.durationSeconds),
      image: image ? { data: image.base64, mimeType: image.mimeType } : undefined,
      promptOverride: editingPrompt ? promptPreview : undefined,
      clientRequestId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      // Carry imported product/brand context into the creative pipeline.
      productProfile: imported?.productProfile || undefined,
      brandProfile: imported?.brandProfile || undefined,
      brandInfluence: imported?.brandInfluence || "balanced",
      entityType: imported?.entityType || undefined,
      designProfile: imported?.designProfile || undefined,
      entityConfidence: imported?.entityConfidence,
      concept: imported?.concept || undefined,
      // AI Creative Director storyboard: executable per-shot plan that drives
      // scene planning + per-shot production routing in the compositor.
      storyboard: storyboard || undefined,
      category: imported?.productProfile?.category || undefined,
      offering: imported?.productProfile?.offering || undefined,
      userIntent: imported?.userContext || undefined,
      emphasis: imported?.emphasis?.length ? imported.emphasis : undefined,
      avoid: imported?.avoid?.length ? imported.avoid : undefined,
      // Multi-image: all user-selected URL references (resolved server-side).
      // The primary flows to the hero image; the rest are recorded context.
      referenceAssets:
        !image && imported?.referenceAssets?.length ? imported.referenceAssets : undefined,
      // All selected real screenshots the screen-based renderer may animate.
      galleryUrls: imported?.referenceAssets?.length
        ? imported.referenceAssets.map((a) => a.url)
        : undefined,
      // Back-compat single reference when no multi-selection is present.
      referenceAssetUrl:
        !image && !imported?.referenceAssets?.length && imported?.referenceAssetUrl
          ? imported.referenceAssetUrl
          : undefined,
      // Hint the source-image classifier (e.g. imported poster/ad vs packshot).
      sourceImageMeta: image
        ? { hintText: image.name, url: image.name }
        : undefined,
    };
    const downloadName = `makeadclips-${Date.now()}.mp4`;

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        setPhase("failed");
        setError(
          data?.error +
            (data?.details
              ? ` (${data.details.map((d) => d.message).join("; ")})`
              : "")
        );
        return;
      }
      setResult({ ...data, downloadName });
      setPhase("completed");
    } catch (e) {
      setPhase("failed");
      setError(`Request failed: ${e.message}`);
    } finally {
      inFlight.current = false;
    }
  }

  const processing = phase === "processing";

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:px-6 sm:py-8">
      {/* Status banner */}
      {status && (
        <div className="card mb-6 flex items-start gap-2 px-4 py-3 text-sm text-muted break-anywhere">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
          <div>
            Active provider: <b>{status.provider}</b>.{" "}
            {status.provider === "mock" ? (
              <span>
                Mock mode — generations are <b>free placeholders</b>, no API
                calls. Set <code>VIDEO_PROVIDER=gemini</code> and{" "}
                <code>ENABLE_PAID_GENERATION=true</code> for real video.
              </span>
            ) : status.paidGenerationEnabled ? (
              <span>Real Gemini generation is ON — calls will incur cost.</span>
            ) : (
              <span>
                Real provider selected but paid generation is{" "}
                <b>disabled</b>. Set <code>ENABLE_PAID_GENERATION=true</code>.
              </span>
            )}
          </div>
        </div>
      )}

      {/* Create-from mode switcher (segmented control; full-width on mobile) */}
      <div className="mb-6">
        <div className="eyebrow mb-3">Create from</div>
        <div
          role="tablist"
          aria-label="Create from"
          className="grid w-full grid-cols-2 gap-1 rounded-xl border border-line bg-surface p-1 sm:inline-grid sm:w-auto"
        >
          <button
            role="tab"
            aria-selected={mode === "url"}
            onClick={() => setMode("url")}
            className={`flex min-h-11 items-center justify-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium ${
              mode === "url" ? "bg-accent text-accent-contrast" : "text-muted hover:text-ink"
            }`}
          >
            <Link2 className="h-4 w-4" aria-hidden="true" /> Product URL
          </button>
          <button
            role="tab"
            aria-selected={mode === "manual"}
            onClick={() => setMode("manual")}
            className={`flex min-h-11 items-center justify-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium ${
              mode === "manual" ? "bg-accent text-accent-contrast" : "text-muted hover:text-ink"
            }`}
          >
            <Upload className="h-4 w-4" aria-hidden="true" /> Upload manually
          </button>
        </div>
      </div>

      {mode === "url" ? (
        <ProductImport onImported={handleImported} />
      ) : (
      <div className="grid gap-8 lg:grid-cols-[1fr_380px]">
        {/* LEFT: form */}
        <div className="space-y-6">
          {imported && (
            <div className="card px-4 py-3 text-sm" style={{ borderLeft: "3px solid var(--accent)" }}>
              <span className="mono-meta !text-accent">Imported</span>
              <span className="ml-2 text-muted">
                {imported.brandProfile?.name ? `brand: ${imported.brandProfile.name} · ` : ""}
                {imported.brandProfile ? `influence: ${imported.brandInfluence}` : "no brand detected"} ·
                fields prefilled below — edit before generating.
              </span>
              {importedImages.length > 0 && (
                <div className="mt-2 flex gap-2 overflow-x-auto">
                  {importedImages.slice(0, 6).map((u) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img key={u} src={u} alt="" className="h-14 w-14 shrink-0 rounded border border-line object-contain" />
                  ))}
                </div>
              )}
            </div>
          )}
          {/* Upload */}
          <section>
            <label className="eyebrow mb-2 block">{labels.image}</label>
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                onPickFile(e.dataTransfer.files?.[0]);
              }}
              onClick={() => fileInputRef.current?.click()}
              className={`frame-corners relative flex min-h-44 cursor-pointer flex-col items-center justify-center gap-2 rounded-brand border bg-surface p-6 text-center transition ${
                dragOver ? "border-accent" : "border-line hover:border-ink"
              }`}
            >
              <span className="corner tl" />
              <span className="corner tr" />
              <span className="corner bl" />
              <span className="corner br" />
              {image ? (
                // Local object-URL preview of a user-selected file; next/image
                // cannot optimize blob: URLs, so a raw <img> is correct here.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={image.previewUrl}
                  alt="Product preview"
                  className="max-h-40 rounded-lg object-contain"
                />
              ) : (
                <>
                  <Upload className="h-7 w-7 text-muted" />
                  <p className="text-sm text-muted">
                    Drag &amp; drop or click to upload
                  </p>
                  <p className="mono-meta">PNG / JPEG / WEBP · MAX 5 MB</p>
                </>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept={ALLOWED_MIME.join(",")}
                className="hidden"
                onChange={(e) => onPickFile(e.target.files?.[0])}
              />
            </div>
            {image && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setImage(null);
                }}
                className="mt-2 text-xs text-muted underline hover:text-ink"
              >
                Remove image
              </button>
            )}
          </section>

          {/* Fields */}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={labels.name}>
              <input
                className="input"
                value={form.productName}
                onChange={update("productName")}
                placeholder="Hydrating Face Serum"
              />
            </Field>
            <Field label="Brand">
              <input
                className="input"
                value={form.brand}
                onChange={update("brand")}
                placeholder="Lumière"
              />
            </Field>
          </div>
          <Field label="Description">
            <textarea
              className="input min-h-20"
              value={form.description}
              onChange={update("description")}
              placeholder="Lightweight serum with hyaluronic acid for all-day hydration."
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Offer">
              <input
                className="input"
                value={form.offer}
                onChange={update("offer")}
                placeholder="20% off this week"
              />
            </Field>
            <Field label="Call to action">
              <input
                className="input"
                value={form.cta}
                onChange={update("cta")}
                placeholder="Shop now"
              />
            </Field>
          </div>

          {/* Production format — determines the ACTUAL production route */}
          <Field label="Video format">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {FORMATS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => update("format")(f.id)}
                  className={`rounded-brand border p-3 text-left text-sm transition ${
                    form.format === f.id ? "border-accent bg-surface" : "border-line bg-surface hover:border-ink"
                  }`}
                >
                  <div className="font-medium">
                    {form.format === f.id && <span className="text-accent">▸ </span>}
                    {f.label}
                  </div>
                  <div className="mono-meta mt-0.5">{f.hint}</div>
                  {f.kind === "deterministic" ? (
                    <div className="mt-1 text-[11px] text-accent">✓ Available now · no AI-video credits</div>
                  ) : (
                    <div className="mt-1 text-[11px] text-muted">Dry-run while paid generation is disabled</div>
                  )}
                </button>
              ))}
            </div>
          </Field>

          {/* Template */}
          <Field label="Ad template">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {TEMPLATES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => update("template")(t.id)}
                  className={`rounded-brand border p-3 text-left text-sm transition ${
                    form.template === t.id
                      ? "border-accent bg-surface"
                      : "border-line bg-surface hover:border-ink"
                  }`}
                >
                  <div className="font-medium">
                    {form.template === t.id && <span className="text-accent">▸ </span>}
                    {t.label}
                  </div>
                  <div className="mono-meta mt-0.5">{t.hint}</div>
                </button>
              ))}
            </div>
          </Field>

          {/* Options */}
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Aspect ratio">
              <select
                className="input"
                value={form.aspectRatio}
                onChange={update("aspectRatio")}
              >
                {RATIOS.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Resolution">
              <select
                className="input"
                value={form.resolution}
                onChange={update("resolution")}
              >
                {RESOLUTIONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Duration (s)">
              <input
                type="number"
                min={3}
                max={15}
                className="input"
                value={form.durationSeconds}
                onChange={update("durationSeconds")}
              />
            </Field>
          </div>

          {/* Prompt preview — this is the EXACT server-compiled prompt */}
          <Field label="Prompt preview (exact server prompt, editable)">
            {serverPreview && !editingPrompt && (
              <div className="mono-meta mb-1">
                {serverPreview.entityType} · {serverPreview.generationMode}
                {previewLoading ? " · updating…" : ""}
              </div>
            )}
            <textarea
              className="input min-h-28 font-mono text-xs"
              value={promptPreview}
              placeholder={previewLoading ? "Compiling creative plan…" : "Enter a name to see the plan."}
              onChange={(e) => setPromptEdit(e.target.value)}
            />
            {editingPrompt && (
              <button
                type="button"
                className="mt-1 text-xs text-accent underline"
                onClick={() => setPromptEdit(null)}
              >
                Reset to the server-generated prompt
              </button>
            )}
          </Field>

          {/* AI Creative Director storyboard — READ-ONLY (approve or regenerate),
              never an editable timeline. Shown once a concept yields shots. */}
          {(storyboard || storyboardLoading) && (
            <section className="card p-4">
              <div className="flex items-center justify-between gap-2">
                <div className="eyebrow">AI storyboard</div>
                <div className="flex items-center gap-2">
                  {storyboard?.origin && (
                    <span className={`mono-meta ${storyboard.origin === "ai" ? "!text-accent" : "text-muted"}`}>
                      {storyboard.origin === "ai" ? "AI Creative Director" : "deterministic fallback"}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={buildStoryboard}
                    disabled={storyboardLoading || !imported?.concept}
                    className="text-xs text-accent underline disabled:opacity-50"
                  >
                    {storyboardLoading ? "Generating…" : "Regenerate"}
                  </button>
                </div>
              </div>
              {storyboard?.logline && (
                <p className="mt-1 text-sm text-muted break-anywhere">“{storyboard.logline}”</p>
              )}
              {storyboard?.note && (
                <p className="mt-1 text-[11px] text-muted">{storyboard.note}</p>
              )}
              {storyboardLoading && !storyboard ? (
                <div className="mt-3 flex items-center gap-2 text-sm text-muted">
                  <Loader2 className="h-4 w-4 animate-spin" /> Directing the storyboard…
                </div>
              ) : (
                <ol className="mt-3 space-y-2">
                  {storyboard?.shots?.map((s, i) => (
                    <li key={i} className="rounded-brand border border-line bg-surface p-2.5 text-sm">
                      <div className="mono-meta flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className="!text-accent">SHOT {i + 1}</span>
                        <span>{Number(s.durationSec).toFixed(1)}s</span>
                        <span>· {s.intent}</span>
                        <span className="rounded bg-line px-1.5 py-0.5">{s.technique}</span>
                      </div>
                      <div className="mt-1 text-ink break-anywhere">{s.visual}</div>
                      {s.onScreenText && (
                        <div className="mt-1 text-xs text-muted">
                          On-screen: <span className="text-ink">“{s.onScreenText}”</span>
                        </div>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </section>
          )}
        </div>

        {/* RIGHT: generate + result */}
        <aside className="space-y-4 lg:sticky lg:top-6 lg:self-start">
          <div className="card p-5">
            {/* production-equipment style metadata readout */}
            <div className="mono-meta mb-4 grid grid-cols-2 gap-y-1.5">
              <span>{String(form.durationSeconds).padStart(2, "0")}:00 SEC</span>
              <span className="text-right">{form.resolution.toUpperCase()}</span>
              <span>{form.aspectRatio}</span>
              <span className="text-right">
                {(status?.model?.label || "MODEL").toUpperCase()}
              </span>
            </div>

            {/* Active production providers — real vs mock, straight from the server. */}
            {status?.providers && (
              <div className="mono-meta mb-3 space-y-0.5 border-t border-line pt-3 !normal-case">
                <div>
                  IMAGES: {status.providers.image.real ? "REAL" : "MOCK"} · {status.providers.image.provider}/{status.providers.image.model}
                </div>
                <div>
                  SCENE VIDEO: {status.providers.sceneVideo.real ? "REAL" : "OFF"} · {status.providers.sceneVideo.model}
                </div>
                <div>AUDIO: none (silent)</div>
                <div className="text-muted">
                  job cap ${status.providers.budget.maxUsd} · ≤{status.providers.budget.maxImages} img · ≤{status.providers.budget.maxVideoClips} clip
                </div>
              </div>
            )}

            {/* Creative readiness (from the server preflight). Blocks generation
                on obvious problems so credits aren't wasted. */}
            {serverPreview?.preflight && (
              <div className="mb-3 border-t border-line pt-3">
                {serverPreview.preflight.readyForPaidGeneration ? (
                  <div className="mono-meta" style={{ color: "var(--accent)" }}>
                    ✓ CREATIVE READY
                  </div>
                ) : (
                  <div className="mono-meta">⚠ NOT READY</div>
                )}
                {serverPreview.preflight.blockers?.map((b, i) => (
                  <p key={i} className="mt-1 text-xs" style={{ color: "var(--danger, #c00)" }}>
                    • {b}
                  </p>
                ))}
                {serverPreview.preflight.warnings?.slice(0, 2).map((w, i) => (
                  <p key={i} className="mt-1 text-xs text-muted">• {w}</p>
                ))}
              </div>
            )}

            <div className="mb-4 flex items-center justify-between border-t border-line pt-3">
              <span className="mono-meta">Est. cost</span>
              <span className="font-semibold text-accent">{estCostLabel}</span>
            </div>
            <button
              onClick={generate}
              disabled={processing || serverPreview?.preflight?.readyForPaidGeneration === false}
              className="btn btn-primary w-full justify-between"
            >
              {processing ? (
                <>
                  <span className="flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" /> GENERATING…
                  </span>
                </>
              ) : (
                <>
                  <span>GENERATE VIDEO</span>
                  <ArrowRight className="h-4 w-4" />
                </>
              )}
            </button>
            <p className="mono-meta mt-3">Estimate only — confirm in AI Studio.</p>
          </div>

          {error && (
            <div className="alert alert-danger" role="alert">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="break-anywhere">{error}</span>
            </div>
          )}

          {result?.dryRun && (
            <div className="card space-y-3 p-5">
              <div className="accent-chip !rounded-md">
                <span className="accent-dot" />
                <span className="mono-meta !text-ink">Dry run — no video generated, no credits spent</span>
              </div>
              <p className="text-sm text-muted">{result.note}</p>
              {result.plan && (
                <div className="space-y-3 text-sm">
                  <div>
                    <div className="eyebrow mb-1">Offering</div>
                    <div className="break-anywhere">
                      <b>{result.plan.offering.brand || result.plan.offering.name}</b>
                      {result.plan.offering.category ? ` · ${result.plan.offering.category}` : ""}
                      {result.plan.offering.offering ? ` — ${result.plan.offering.offering}` : ""}
                    </div>
                  </div>
                  {result.plan.message?.centralMessage && (
                    <div>
                      <div className="eyebrow mb-1">Central message</div>
                      <div className="break-anywhere">{result.plan.message.centralMessage}</div>
                    </div>
                  )}
                  <div>
                    <div className="eyebrow mb-1">Storyboard</div>
                    <ol className="list-decimal space-y-1 pl-5">
                      {result.plan.storyboard.map((s) => (
                        <li key={s.scene} className="break-anywhere">
                          <b>{s.purpose}</b> ({s.durationSec}s): {s.visual}
                        </li>
                      ))}
                    </ol>
                  </div>
                  <div>
                    <div className="eyebrow mb-1">Exact on-screen copy (rendered by compositor, not the model)</div>
                    <ul className="list-disc pl-5">
                      {result.plan.deterministicCopy.brand && <li>Brand: {result.plan.deterministicCopy.brand}</li>}
                      {result.plan.deterministicCopy.offer && <li>Offer: {result.plan.deterministicCopy.offer}</li>}
                      {result.plan.deterministicCopy.cta && <li>CTA: {result.plan.deterministicCopy.cta}</li>}
                    </ul>
                  </div>
                  <div className="mono-meta">
                    Est. cost if generated: ${Number(result.plan.estimatedCost?.amountUsd ?? 0).toFixed(2)}
                  </div>
                </div>
              )}
              <p className="text-xs text-muted">
                Tip: choose a <b>Screen demo</b> or <b>Narrated brand card</b> format to produce a
                real finished video now, with no paid generation.
              </p>
            </div>
          )}

          {result && !result.dryRun && (
            <div className="card space-y-3 p-5">
              {result.mock && (
                <div className="accent-chip !rounded-md">
                  <span className="accent-dot" />
                  <span className="mono-meta !text-ink">Mock — placeholder, not real generation</span>
                </div>
              )}
              {result.deterministic && (
                <div className="accent-chip !rounded-md">
                  <span className="accent-dot" />
                  <span className="mono-meta !text-ink">
                    Rendered from your real assets · {result.render?.usedImages ?? 0} image(s) ·{" "}
                    {result.render?.generatedKeyframes ?? 0} AI keyframe(s) · no paid AI-video cost
                  </span>
                </div>
              )}
              {/* Quality verification: an honest flag when the output is mostly
                  empty cards (the black-slideshow failure) rather than a real ad. */}
              {result.render?.quality?.warnings?.length > 0 && (
                <div className="alert alert-danger" role="alert">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  <div className="break-anywhere">
                    <b>Quality check</b>
                    {result.render.quality.warnings.map((w, i) => (
                      <p key={i} className="text-xs">• {w}</p>
                    ))}
                  </div>
                </div>
              )}
              {/* Media canvas stays neutral-dark in both themes for media fidelity. */}
              <div className="frame-corners media-canvas relative overflow-hidden rounded-brand">
                <span className="corner tl" />
                <span className="corner tr" />
                <span className="corner bl" />
                <span className="corner br" />
                <video src={result.video} controls className="w-full" />
              </div>
              <a
                href={result.video}
                download={result.downloadName}
                className="btn btn-secondary w-full"
              >
                <Download className="h-4 w-4" /> Download MP4
              </a>

              {/* Per-shot production report: honest AI-generated vs deterministic
                  accounting straight from the compositor's shotReport. */}
              {result.render?.shotReport?.length > 0 && (
                <div className="border-t border-line pt-3">
                  <div className="eyebrow mb-2">
                    Shot production
                    {result.render.storyboardOrigin === "ai" ? (
                      <span className="mono-meta ml-2 !text-accent">AI-directed storyboard</span>
                    ) : result.render.storyboardDriven ? (
                      <span className="mono-meta ml-2 text-muted">deterministic storyboard</span>
                    ) : null}
                  </div>
                  <ol className="space-y-1.5 text-xs">
                    {result.render.shotReport.map((s) => (
                      <li key={s.shot} className="flex items-start gap-2 break-anywhere">
                        <span className="mono-meta shrink-0 !text-accent">{String(s.shot).padStart(2, "0")}</span>
                        <span className="flex-1">
                          <span className="text-ink">{s.intent || "shot"}</span>{" "}
                          <span className="text-muted">({Number(s.durationSec).toFixed(1)}s)</span>
                          <br />
                          <span
                            className={`mono-meta ${s.aiGenerated ? "!text-accent" : "text-muted"}`}
                          >
                            {s.aiGenerated ? "AI-GENERATED" : "DETERMINISTIC"} · {s.visualSource || s.executedMethod}
                          </span>
                          {s.downgradedFrom && (
                            <span className="block text-muted">
                              requested {s.downgradedFrom} — not produced by a real model
                            </span>
                          )}
                          {s.productionNotes?.map((n, k) => (
                            <span key={k} className="block text-muted">{n}</span>
                          ))}
                        </span>
                      </li>
                    ))}
                  </ol>
                  <p className="mono-meta mt-2 text-muted">
                    {result.render.shotReport.filter((s) => s.aiGenerated).length} AI-generated ·{" "}
                    {result.render.shotReport.filter((s) => !s.aiGenerated).length} deterministic
                  </p>
                </div>
              )}

              <div className="mono-meta space-y-1 !normal-case">
                <div className="uppercase">
                  {result.provider} · {result.model}
                </div>
                {result.cost?.reported?.state === "billed" && (
                  <div className="font-medium text-ink">
                    BILLED ${Number(result.cost.reported.amountUsd).toFixed(4)}
                    {result.usage?.total_tokens
                      ? ` · ${result.usage.total_tokens} TOK`
                      : ""}
                  </div>
                )}
                {result.cost?.reported?.state === "unknown" && (
                  <div>Actual cost unknown — check AI Studio billing.</div>
                )}
                <div className="normal-case tracking-normal">{result.cost?.note}</div>
              </div>
            </div>
          )}

          {!result && !error && (
            <div className="frame-corners relative flex items-center justify-center gap-2 rounded-brand border border-line bg-surface px-4 py-10 text-sm text-muted">
              <span className="corner tl" />
              <span className="corner tr" />
              <span className="corner bl" />
              <span className="corner br" />
              <ImageIcon className="h-4 w-4" />
              Your generated ad appears here.
            </div>
          )}
        </aside>
      </div>
      )}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="eyebrow mb-1.5 block">{label}</span>
      {children}
    </label>
  );
}
