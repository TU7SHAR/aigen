"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Upload,
  Loader2,
  Download,
  AlertCircle,
  Sparkles,
  ImageIcon,
  Info,
} from "lucide-react";

const TEMPLATES = [
  { id: "luxury", label: "Luxury Reveal", hint: "Premium, cinematic" },
  { id: "bold", label: "Bold & Punchy", hint: "High energy" },
  { id: "minimal", label: "Clean Studio", hint: "Modern, neutral" },
  { id: "product-demo", label: "Product Demo", hint: "Show features" },
  { id: "problem-solution", label: "Problem → Solution", hint: "Narrative" },
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
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      {/* Status banner */}
      {status && (
        <div className="mb-6 flex items-start gap-2 rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
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

      <div className="grid gap-8 lg:grid-cols-[1fr_380px]">
        {/* LEFT: form */}
        <div className="space-y-6">
          {/* Upload */}
          <section>
            <label className="mb-2 block text-sm font-medium">Product image</label>
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
              className={`flex min-h-40 cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed p-6 text-center transition ${
                dragOver
                  ? "border-indigo-500 bg-indigo-50 dark:bg-indigo-950/30"
                  : "border-zinc-300 hover:border-zinc-400 dark:border-zinc-700"
              }`}
            >
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
                  <Upload className="h-7 w-7 text-zinc-400" />
                  <p className="text-sm text-zinc-600 dark:text-zinc-400">
                    Drag & drop or click to upload (PNG/JPEG/WEBP, max 5 MB)
                  </p>
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
                className="mt-2 text-xs text-zinc-500 underline"
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
                  className={`rounded-xl border p-3 text-left text-sm transition ${
                    form.template === t.id
                      ? "border-indigo-500 bg-indigo-50 dark:bg-indigo-950/30"
                      : "border-zinc-200 hover:border-zinc-300 dark:border-zinc-800"
                  }`}
                >
                  <div className="font-medium">{t.label}</div>
                  <div className="text-xs text-zinc-500">{t.hint}</div>
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
                className="mt-1 text-xs text-indigo-600 underline"
                onClick={() => setPromptEdit(null)}
              >
                Reset to auto-generated prompt
              </button>
            )}
          </Field>
        </div>

        {/* RIGHT: generate + result */}
        <aside className="space-y-4 lg:sticky lg:top-6 lg:self-start">
          <div className="rounded-2xl border border-zinc-200 p-5 dark:border-zinc-800">
            <div className="mb-3 flex items-center justify-between text-sm">
              <span className="text-zinc-500">Estimated cost</span>
              <span className="font-semibold">{estCostLabel}</span>
            </div>
            <p className="mb-4 text-xs text-zinc-500">
              Estimate only — confirm real pricing in Google AI Studio.
            </p>
            <button
              onClick={generate}
              disabled={processing}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-3 font-medium text-white transition hover:bg-indigo-700 disabled:opacity-60"
            >
              {processing ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Generating…
                </>
              ) : (
                <>
                  <Sparkles className="h-4 w-4" /> Generate video
                </>
              )}
            </button>
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {result && (
            <div className="space-y-3 rounded-2xl border border-zinc-200 p-5 dark:border-zinc-800">
              {result.mock && (
                <div className="rounded-lg bg-amber-100 px-3 py-2 text-xs font-medium text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                  ⚠ Mock output — placeholder video, no real generation.
                </div>
              )}
              <video
                src={result.video}
                controls
                className="w-full rounded-lg bg-black"
              />
              <a
                href={result.video}
                download={result.downloadName}
                className="flex items-center justify-center gap-2 rounded-xl border border-zinc-300 px-4 py-2 text-sm font-medium transition hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
              >
                <Download className="h-4 w-4" /> Download MP4
              </a>
              <div className="space-y-1 text-xs text-zinc-500">
                <div>
                  Provider: {result.provider} · Model: {result.model}
                </div>
                {result.cost?.reported?.state === "billed" && (
                  <div className="font-medium text-zinc-700 dark:text-zinc-300">
                    Billed: ${Number(result.cost.reported.amountUsd).toFixed(4)}{" "}
                    (from reported usage)
                    {result.usage?.total_tokens
                      ? ` · ${result.usage.total_tokens} tokens`
                      : ""}
                  </div>
                )}
                {result.cost?.reported?.state === "unknown" && (
                  <div>Actual cost unknown — check Google AI Studio billing.</div>
                )}
                <div>{result.cost?.note}</div>
              </div>
            </div>
          )}

          {!result && !error && (
            <div className="flex items-center gap-2 rounded-2xl border border-dashed border-zinc-300 px-4 py-6 text-sm text-zinc-500 dark:border-zinc-700">
              <ImageIcon className="h-4 w-4" />
              Your generated ad will appear here.
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium">{label}</span>
      {children}
    </label>
  );
}
