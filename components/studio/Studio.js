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
    durationSeconds: 8,
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

  const handleImported = useCallback((payload) => {
    setImported({
      productProfile: payload.productProfile,
      brandProfile: payload.brandProfile,
      brandInfluence: payload.brandInfluence,
    });
    setImportedImages(
      [payload.heroUrl, ...(payload.gallery || [])].filter(Boolean)
    );
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

  // Auto-generated prompt derived from the form (mirrors the server builder).
  const autoPrompt = useMemo(() => {
    const dir = {
      luxury: "Elegant, premium cinematic ad with a slow push-in and soft lighting.",
      bold: "High-energy, punchy ad with quick camera moves and vivid color.",
      minimal: "Clean studio ad on a neutral background with steady motion.",
      "product-demo": "Clear product demo highlighting key features with orbiting motion.",
      "problem-solution": "Problem-then-solution narrative resolving with the product.",
    }[form.template];
    const parts = [
      `Create a ${form.durationSeconds}-second product advertisement video for ${
        form.productName || "the product"
      }${form.brand ? ` by ${form.brand}` : ""}.`,
      dir,
    ];
    if (form.description) parts.push(`Product context: ${form.description}.`);
    if (form.offer) parts.push(`Highlight this offer visually: ${form.offer}.`);
    parts.push(
      image
        ? "Use the provided reference image as the exact product; keep packaging, logo, label text, shape and colors unchanged."
        : "Keep any depicted product plausible; do not invent logos or label text."
    );
    parts.push(
      "Avoid readable text/logos/prices inside the footage; leave room for overlays."
    );
    if (form.cta) parts.push(`Leave a calm final beat for a CTA overlay ("${form.cta}").`);
    return parts.join(" ");
  }, [form, image]);

  const editingPrompt = promptEdit !== null;
  const promptPreview = editingPrompt ? promptEdit : autoPrompt;

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
    const rate = 0.1;
    const mult = { "360p": 0.5, "720p": 1, "1080p": 1.6 }[form.resolution] ?? 1;
    const usd = (rate * form.durationSeconds * mult).toFixed(2);
    return `~$${usd}`;
  }, [form.resolution, form.durationSeconds]);

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
      // Hint the source-image classifier (e.g. imported poster/ad vs packshot).
      sourceImageMeta: image
        ? { hintText: image.name, url: image.name }
        : undefined,
    };
    const downloadName = `adforge-${Date.now()}.mp4`;

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
            <label className="eyebrow mb-2 block">Product image</label>
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
            <Field label="Product name *">
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
                max={10}
                className="input"
                value={form.durationSeconds}
                onChange={update("durationSeconds")}
              />
            </Field>
          </div>

          {/* Prompt preview */}
          <Field label="Prompt preview (editable)">
            <textarea
              className="input min-h-28 font-mono text-xs"
              value={promptPreview}
              onChange={(e) => setPromptEdit(e.target.value)}
            />
            {editingPrompt && (
              <button
                type="button"
                className="mt-1 text-xs text-accent underline"
                onClick={() => setPromptEdit(null)}
              >
                Reset to auto-generated prompt
              </button>
            )}
          </Field>
        </div>

        {/* RIGHT: generate + result */}
        <aside className="space-y-4 lg:sticky lg:top-6 lg:self-start">
          <div className="card p-5">
            {/* production-equipment style metadata readout */}
            <div className="mono-meta mb-4 grid grid-cols-2 gap-y-1.5">
              <span>{String(form.durationSeconds).padStart(2, "0")}:00 SEC</span>
              <span className="text-right">{form.resolution.toUpperCase()}</span>
              <span>{form.aspectRatio}</span>
              <span className="text-right">OMNI FLASH</span>
            </div>
            <div className="mb-4 flex items-center justify-between border-t border-line pt-3">
              <span className="mono-meta">Est. cost</span>
              <span className="font-semibold text-accent">{estCostLabel}</span>
            </div>
            <button
              onClick={generate}
              disabled={processing}
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

          {result && (
            <div className="card space-y-3 p-5">
              {result.mock && (
                <div className="accent-chip !rounded-md">
                  <span className="accent-dot" />
                  <span className="mono-meta !text-ink">Mock — placeholder, not real generation</span>
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
