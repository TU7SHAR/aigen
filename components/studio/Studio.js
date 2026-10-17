"use client";

/**
 * MakeAdClips Studio — the customer journey.
 *
 *   1. Source     paste a URL (import + focus + concept review) or upload & describe
 *   2. Direction  video language, length/format, CTA + destination; the AI
 *                 creative plan (read-only: approve or regenerate)
 *   3. Create     honest availability, estimate and preflight → background job
 *   4. Production truthful stage/shot progress (leave and come back)
 *   5. Result     preview, download, checks, provenance; make another version
 *
 * Drafts and the active job are remembered on THIS device (localStorage);
 * finished videos live on the server (GET /api/jobs).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Upload, Loader2, AlertCircle, Link2, ArrowRight, ArrowLeft, RefreshCw, Sparkles, ShieldCheck } from "lucide-react";
import ProductImport from "./ProductImport.js";
import LanguagePicker from "./LanguagePicker.js";
import JobTracker from "./JobTracker.js";
import ResultPanel from "./ResultPanel.js";
import RecentJobs from "./RecentJobs.js";
import { useStoredState, writeStored } from "./useStoredState.js";

const ALLOWED_MIME = ["image/png", "image/jpeg", "image/webp"];
const MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_LANGUAGE = { mode: "single", primary: "en-US", secondary: [], captionScript: "Latn" };
const DEFAULT_SETTINGS = { durationSeconds: 12, aspectRatio: "9:16", resolution: "1080p", narration: true };
const STEPS = ["Source", "Direction", "Create", "Production", "Result"];

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function Stepper({ step }) {
  const idx = STEPS.indexOf(step);
  return (
    <ol className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-1" aria-label="Progress">
      {STEPS.map((s, i) => (
        <li key={s} className="flex items-center gap-2 text-sm" aria-current={i === idx ? "step" : undefined}>
          <span className={`flex h-6 w-6 items-center justify-center rounded-full border text-xs ${i < idx ? "border-accent bg-accent text-accent-contrast" : i === idx ? "border-accent text-ink" : "border-line text-muted"}`}>{i + 1}</span>
          <span className={i === idx ? "font-medium text-ink" : "text-muted"}>{s}</span>
          {i < STEPS.length - 1 && <span className="text-line" aria-hidden="true">—</span>}
        </li>
      ))}
    </ol>
  );
}

export default function Studio() {
  const [status, setStatus] = useState(null);
  const [mode, setMode] = useState("url"); // url | manual
  const [step, setStep] = useState("Source");
  const [imported, setImported] = useState(null);
  const [form, setForm] = useState({ productName: "", brand: "", description: "", offer: "", cta: "", destinationUrl: "" });
  const [image, setImage] = useState(null);
  const [language, setLanguage] = useStoredState("mac.language", DEFAULT_LANGUAGE);
  const [settings, setSettings] = useStoredState("mac.settings", DEFAULT_SETTINGS);
  const [activeJob, setActiveJob] = useStoredState("mac.activeJob", null);
  const [storyboard, setStoryboard] = useState(null);
  const [storyboardState, setStoryboardState] = useState({ loading: false, error: "" });
  const [preview, setPreview] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [finished, setFinished] = useState(null); // { job, record }
  const [jobsRefresh, setJobsRefresh] = useState(0);
  const fileRef = useRef(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/generate").then((r) => r.json()).then((d) => { if (alive) setStatus(d); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const currentStep = activeJob ? (finished ? "Result" : "Production") : step;

  const handleImported = useCallback((payload) => {
    setStoryboard(null);
    setImported(payload);
    if (payload.uploadImage?.data) {
      setImage({ previewUrl: `data:${payload.uploadImage.mimeType};base64,${payload.uploadImage.data}`, base64: payload.uploadImage.data, mimeType: payload.uploadImage.mimeType, name: "uploaded-reference" });
    }
    setForm((f) => ({
      ...f,
      productName: payload.form.productName || f.productName,
      brand: payload.form.brand || f.brand,
      description: payload.form.description || f.description,
      offer: payload.form.offer || f.offer,
      destinationUrl: payload.productProfile?.canonicalUrl || payload.productProfile?.sourceUrl || f.destinationUrl,
    }));
    setStep("Direction");
  }, []);

  const concept = useMemo(() => {
    if (imported?.concept) return imported.concept;
    if (!form.productName.trim()) return null;
    return { id: "manual", title: form.productName, centralMessage: form.description || form.productName };
  }, [imported, form.productName, form.description]);

  const referenceAssets = useMemo(() => (imported?.referenceAssets?.length ? imported.referenceAssets : []), [imported]);

  // ---- AI creative plan (read-only; approve or regenerate) ----
  const buildStoryboard = useCallback(async () => {
    if (!concept) return;
    setStoryboardState({ loading: true, error: "" });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 180_000);
    try {
      const res = await fetch("/api/creative/storyboard", {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          concept,
          product: {
            name: form.productName || imported?.productProfile?.name,
            brand: form.brand || imported?.brandProfile?.name,
            description: form.description || imported?.productProfile?.description,
            offer: form.offer || undefined,
            cta: form.cta || undefined,
            price: imported?.productProfile?.price || undefined,
            currency: imported?.productProfile?.currency || undefined,
            category: imported?.productProfile?.category,
            offering: imported?.productProfile?.offering,
            targetCustomer: imported?.productProfile?.targetCustomer,
            benefits: imported?.productProfile?.benefits,
            features: imported?.productProfile?.features,
            destination: form.destinationUrl || undefined,
          },
          brand: imported?.brandProfile || null,
          design: imported?.designProfile || null,
          entityType: imported?.entityType,
          durationSeconds: Number(settings.durationSeconds),
          aspectRatio: settings.aspectRatio,
          availableAssets: (referenceAssets.length ? referenceAssets : image ? [{ role: "user_upload" }] : []).map((a) => ({ role: a.role || "image", kind: "image" })),
          emphasis: imported?.emphasis?.length ? imported.emphasis : undefined,
          avoid: imported?.avoid?.length ? imported.avoid : undefined,
          focus: imported?.focus || undefined,
          language,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data?.storyboard?.shots?.length) {
        setStoryboardState({ loading: false, error: data?.error || "Could not plan the ad. Try again." });
        return;
      }
      setStoryboard({ ...data.storyboard, origin: data.origin, note: data.note });
      setStoryboardState({ loading: false, error: "" });
    } catch (e) {
      setStoryboardState({ loading: false, error: e?.name === "AbortError" ? "Planning took too long and was stopped — nothing was charged. Try again." : `Planning failed: ${e.message}` });
    } finally {
      clearTimeout(timer);
    }
  }, [concept, form, imported, settings.durationSeconds, settings.aspectRatio, referenceAssets, image, language]);

  // The request "Create video" will send (also used for the server preview).
  const payload = useMemo(() => ({
    productName: form.productName.trim(),
    brand: form.brand,
    description: form.description,
    offer: form.offer,
    cta: form.cta,
    destinationUrl: form.destinationUrl || undefined,
    aspectRatio: settings.aspectRatio,
    resolution: settings.resolution,
    durationSeconds: Number(settings.durationSeconds),
    narration: settings.narration !== false,
    language,
    format: "screen_demo",
    image: image ? { data: image.base64, mimeType: image.mimeType } : undefined,
    productProfile: imported?.productProfile || undefined,
    brandProfile: imported?.brandProfile || undefined,
    brandInfluence: imported?.brandInfluence || "balanced",
    entityType: imported?.entityType || undefined,
    designProfile: imported?.designProfile || undefined,
    entityConfidence: imported?.entityConfidence,
    concept: concept || undefined,
    storyboard: storyboard || undefined,
    focus: imported?.focus || undefined,
    category: imported?.productProfile?.category || undefined,
    offering: imported?.productProfile?.offering || undefined,
    userIntent: imported?.userContext || undefined,
    emphasis: imported?.emphasis?.length ? imported.emphasis : undefined,
    avoid: imported?.avoid?.length ? imported.avoid : undefined,
    referenceAssets: !image && referenceAssets.length ? referenceAssets : undefined,
    galleryUrls: referenceAssets.length ? referenceAssets.map((a) => a.url) : undefined,
  }), [form, settings, language, image, imported, concept, storyboard, referenceAssets]);

  // Server preview of exactly what will run (preflight + estimate). Debounced.
  useEffect(() => {
    if (!storyboard || !payload.productName) return undefined;
    let alive = true;
    const t = setTimeout(async () => {
      try {
        const res = await fetch("/api/creative/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        const data = await res.json();
        if (alive) setPreview(res.ok ? data : { error: data?.error, details: data?.details });
      } catch { /* preview is advisory; the server validates again on create */ }
    }, 400);
    return () => { alive = false; clearTimeout(t); };
  }, [payload, storyboard]);

  async function onPickFile(file) {
    setError("");
    if (!file) return;
    if (!ALLOWED_MIME.includes(file.type)) return setError("Unsupported image type. Use PNG, JPEG or WEBP.");
    if (file.size > MAX_BYTES) return setError("Image is larger than 5 MB.");
    const base64 = await fileToBase64(file);
    setImage({ previewUrl: URL.createObjectURL(file), base64, mimeType: file.type, name: file.name });
  }

  async function createVideo() {
    if (submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // One id per click-through: double clicks and retries reuse the same job.
        body: JSON.stringify({ ...payload, clientRequestId: `${(storyboard?.logline || "plan").slice(0, 40)}:${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}` }),
      });
      const data = await res.json();
      if (!res.ok || !data.jobId) {
        const reasons = data?.preflight?.blockers?.join(" ") || data?.details?.map((d) => `${d.path}: ${d.message}`).join("; ") || "";
        setError(`${data?.error || "Could not start the video."} ${reasons}`.trim());
        return;
      }
      setFinished(null);
      setActiveJob({ id: data.jobId, at: new Date().toISOString() });
      setJobsRefresh((n) => n + 1);
    } catch (e) {
      setError(`Request failed: ${e.message}`);
    } finally {
      setSubmitting(false);
    }
  }

  const onFinished = useCallback((job, record) => {
    setFinished({ job, record });
    setJobsRefresh((n) => n + 1);
  }, []);

  function openJob(id) {
    setFinished(null);
    setActiveJob({ id, at: new Date().toISOString() });
  }
  function remake() {
    writeStored("mac.activeJob", null);
    setFinished(null);
    setStep(storyboard ? "Create" : "Direction");
  }

  const sv = status?.providers?.sceneVideo;
  const blockers = preview?.preflight?.blockers || [];
  const warnings = preview?.preflight?.warnings || [];
  const prod = preview?.production;
  const canCreate = Boolean(storyboard && payload.productName && preview && !preview.error && blockers.length === 0 && !submitting);

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:px-6 sm:py-8">
      <Stepper step={currentStep} />

      {status && (
        <div className="card mb-6 flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm text-muted">
          <ShieldCheck className="h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
          {sv?.real ? (
            <span>AI video is <b className="text-ink">on</b> · {sv.chain?.filter((m) => m.available).map((m) => m.label).join(" → ") || "no model available right now"}{status.providers.autoSwitch ? " · switches automatically" : ""} · ~{sv.availableToday} clips left today</span>
          ) : (
            <span>AI video is <b className="text-ink">off</b> on this server — exports use your real images and motion graphics only.</span>
          )}
          {status.providers?.budget?.spend && (
            <span className="ml-auto mono-meta">today ${status.providers.budget.spend.today.usedUsd.toFixed(2)} / ${status.providers.budget.spend.today.limitUsd}</span>
          )}
        </div>
      )}

      {activeJob ? (
        <div className="space-y-6">
          {!finished && <JobTracker key={activeJob.id} jobId={activeJob.id} onFinished={onFinished} />}
          {finished && (
            <>
              <ResultPanel job={finished.job} record={finished.record} onRemake={remake} />
              {!finished.job.hasVideo && <JobTracker key={`${activeJob.id}-done`} jobId={activeJob.id} onFinished={() => {}} onDismiss={remake} />}
            </>
          )}
        </div>
      ) : (
        <>
          {step === "Source" && (
            <section aria-labelledby="source-title" className="space-y-4">
              <h1 id="source-title" className="text-xl font-semibold">What are we advertising?</h1>
              <div role="tablist" aria-label="Create from" className="grid w-full grid-cols-2 gap-1 rounded-xl border border-line bg-surface p-1 sm:inline-grid sm:w-auto">
                {[["url", "Website or product link", Link2], ["manual", "Upload & describe", Upload]].map(([id, label, Icon]) => (
                  <button key={id} role="tab" aria-selected={mode === id} onClick={() => setMode(id)}
                    className={`flex min-h-11 items-center justify-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium ${mode === id ? "bg-accent text-accent-contrast" : "text-muted hover:text-ink"}`}>
                    <Icon className="h-4 w-4" aria-hidden="true" /> {label}
                  </button>
                ))}
              </div>
              {mode === "url" ? (
                <ProductImport onImported={handleImported} />
              ) : (
                <div className="card space-y-4 p-4 sm:p-6">
                  <div className="grid gap-4 sm:grid-cols-[180px_1fr]">
                    <button type="button" onClick={() => fileRef.current?.click()} className="flex min-h-40 flex-col items-center justify-center gap-2 rounded-brand border border-dashed border-line bg-surface p-3 text-sm text-muted hover:border-ink">
                      {image ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={image.previewUrl} alt="Selected product" className="max-h-36 rounded object-contain" />
                      ) : (<><Upload className="h-6 w-6" aria-hidden="true" /> Add a product photo<span className="mono-meta">PNG / JPEG / WEBP · 5 MB</span></>)}
                    </button>
                    <input ref={fileRef} type="file" accept={ALLOWED_MIME.join(",")} className="hidden" onChange={(e) => onPickFile(e.target.files?.[0])} aria-label="Product photo" />
                    <div className="space-y-3">
                      <Field label="Product or business name *"><input className="input" value={form.productName} onChange={(e) => setForm({ ...form, productName: e.target.value })} /></Field>
                      <Field label="Brand"><input className="input" value={form.brand} onChange={(e) => setForm({ ...form, brand: e.target.value })} /></Field>
                    </div>
                  </div>
                  <Field label="What is it and who is it for?"><textarea className="input min-h-20" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
                  <button type="button" className="btn btn-primary" disabled={!form.productName.trim()} onClick={() => setStep("Direction")}>Continue <ArrowRight className="h-4 w-4" aria-hidden="true" /></button>
                </div>
              )}
            </section>
          )}

          {(step === "Direction" || step === "Create") && (
            <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
              <div className="space-y-5">
                <div className="flex items-center gap-2">
                  <button type="button" className="btn btn-secondary" onClick={() => setStep("Source")}><ArrowLeft className="h-4 w-4" aria-hidden="true" /> Source</button>
                  <h1 className="text-xl font-semibold">{imported?.focus?.title || form.productName || "Your ad"}</h1>
                </div>
                {imported?.focus && <p className="text-sm text-muted break-anywhere">Focus: {imported.focus.title} · {referenceAssets.length} image(s) selected</p>}

                <LanguagePicker value={language} onChange={(l) => { setLanguage(l); setStoryboard(null); }} narration={settings.narration !== false} />

                <fieldset className="card grid gap-3 p-4 sm:grid-cols-2">
                  <legend className="sr-only">Video settings</legend>
                  <Field label="Length">
                    <select className="input" value={settings.durationSeconds} onChange={(e) => { setSettings({ ...settings, durationSeconds: Number(e.target.value) }); setStoryboard(null); }}>
                      {[8, 10, 12, 15, 20].map((s) => <option key={s} value={s}>{s} seconds</option>)}
                    </select>
                  </Field>
                  <Field label="Format">
                    <select className="input" value={settings.aspectRatio} onChange={(e) => { setSettings({ ...settings, aspectRatio: e.target.value }); setStoryboard(null); }}>
                      <option value="9:16">Vertical 9:16 (Reels, TikTok, Shorts)</option>
                      <option value="16:9">Landscape 16:9 (YouTube, web)</option>
                    </select>
                  </Field>
                  <Field label="Quality">
                    <select className="input" value={settings.resolution} onChange={(e) => setSettings({ ...settings, resolution: e.target.value })}>
                      <option value="1080p">1080p (recommended)</option>
                      <option value="720p">720p (smaller file)</option>
                    </select>
                  </Field>
                  <label className="flex min-h-11 items-center gap-2 text-sm">
                    <input type="checkbox" checked={settings.narration !== false} onChange={(e) => setSettings({ ...settings, narration: e.target.checked })} />
                    Voiceover narration
                  </label>
                  <Field label="Call to action"><input className="input" maxLength={80} value={form.cta} onChange={(e) => { setForm({ ...form, cta: e.target.value }); }} placeholder="e.g. Shop the collection" /></Field>
                  <Field label="Link shown at the end"><input className="input" type="url" value={form.destinationUrl} onChange={(e) => setForm({ ...form, destinationUrl: e.target.value })} placeholder="https://" /></Field>
                  <Field label="Offer (only if real)"><input className="input" maxLength={240} value={form.offer} onChange={(e) => setForm({ ...form, offer: e.target.value })} placeholder="e.g. Free shipping over ₹999" /></Field>
                </fieldset>

                <section className="card p-4" aria-labelledby="plan-title">
                  <div className="flex items-center gap-2">
                    <Sparkles className="h-4 w-4 text-accent" aria-hidden="true" />
                    <h2 id="plan-title" className="text-sm font-semibold">Creative plan</h2>
                    {storyboard?.origin && <span className={`mono-meta ${storyboard.origin === "ai" ? "!text-accent" : ""}`}>{storyboard.origin === "ai" ? "AI creative director" : "basic fallback"}</span>}
                    <button type="button" className="btn btn-secondary ml-auto" onClick={buildStoryboard} disabled={storyboardState.loading || !concept}>
                      {storyboardState.loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />}
                      {storyboard ? "Regenerate" : "Plan my ad"}
                    </button>
                  </div>
                  {storyboardState.error && <p className="mt-2 text-sm" role="alert">{storyboardState.error}</p>}
                  {!storyboard && !storyboardState.loading && <p className="mt-2 text-sm text-muted">We&apos;ll write the brief, script and shot list in {language?.mode === "mixed" ? "your mixed-language style" : "your language"} — no video is generated or charged at this step.</p>}
                  {storyboard?.brief && (
                    <dl className="mt-3 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
                      {[["Focus", storyboard.brief.focus], ["Audience", storyboard.brief.audience], ["Main message", storyboard.brief.mainMessage], ["Hook", storyboard.brief.hook], ["Why believe it", storyboard.brief.reasonToBelieve], ["CTA", storyboard.brief.cta]].filter(([, v]) => v).map(([k, v]) => (
                        <div key={k}><dt className="mono-meta">{k}</dt><dd className="break-anywhere">{v}</dd></div>
                      ))}
                    </dl>
                  )}
                  {storyboard?.shots && (
                    <ol className="mt-3 space-y-2">
                      {storyboard.shots.map((s, i) => (
                        <li key={i} className="rounded-brand border border-line p-2.5 text-sm">
                          <div className="mono-meta flex flex-wrap gap-x-2"><span className="!text-accent">SHOT {i + 1}</span><span>{Number(s.durationSec).toFixed(1)}s</span><span>{s.intent}</span><span>{s.technique?.replace("_", " ")}</span>{s.transitionOut && <span>→ {s.transitionOut}</span>}</div>
                          {s.purpose && <p className="mt-0.5 text-muted break-anywhere">{s.purpose}</p>}
                          {s.onScreenText && <p className="mt-1 break-anywhere">Caption: <b>{s.onScreenText}</b></p>}
                          {s.voiceover && <p className="break-anywhere text-muted">Voice: “{s.voiceover}”</p>}
                        </li>
                      ))}
                    </ol>
                  )}
                  {storyboard?.validation?.findings?.length > 0 && (
                    <ul className="mt-3 space-y-0.5 text-xs">
                      {storyboard.validation.findings.map((f, i) => <li key={i} className={f.level === "error" ? "font-medium" : "text-muted"}>{f.level === "error" ? "✕" : "•"} {f.message}</li>)}
                    </ul>
                  )}
                </section>
              </div>

              <aside className="space-y-4 lg:sticky lg:top-6 lg:self-start" aria-label="Create">
                <div className="card space-y-3 p-5">
                  <h2 className="text-sm font-semibold">Review & create</h2>
                  {!storyboard && <p className="text-sm text-muted">Plan the ad first.</p>}
                  {preview?.error && <p className="text-sm" role="alert">{preview.error} {preview.details?.map((d) => d.message).join("; ")}</p>}
                  {prod && (
                    <div className="space-y-1 text-sm">
                      <div className="flex justify-between"><span className="text-muted">Estimated cost</span><b>${prod.expectedUsd.toFixed(2)}</b></div>
                      <div className="flex justify-between text-xs"><span className="text-muted">If models switch (worst case)</span><span>up to ${prod.worstCaseUsd.toFixed(2)}</span></div>
                      <div className="flex justify-between text-xs"><span className="text-muted">AI-video shots</span><span>{prod.videoAvailable ? `${prod.clipsAllowed} of ${prod.videoShots}` : "off"}</span></div>
                      {prod.clipCapWarning && <p className="text-xs">{prod.clipCapWarning}</p>}
                      <p className="mono-meta !normal-case">{prod.basis}</p>
                    </div>
                  )}
                  {blockers.length > 0 && (
                    <ul className="space-y-0.5 text-xs" role="alert">
                      {blockers.map((b, i) => <li key={i} className="font-medium" style={{ color: "var(--danger, #c00)" }}>• {b}</li>)}
                    </ul>
                  )}
                  {warnings.slice(0, 4).map((w, i) => <p key={i} className="text-xs text-muted">• {w}</p>)}
                  <button type="button" onClick={createVideo} disabled={!canCreate} className="btn btn-primary w-full justify-between">
                    {submitting ? <span className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Starting…</span> : <><span>Create video</span><ArrowRight className="h-4 w-4" aria-hidden="true" /></>}
                  </button>
                  {error && (
                    <div className="alert alert-danger" role="alert"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /><span className="break-anywhere">{error}</span></div>
                  )}
                </div>
              </aside>
            </div>
          )}
        </>
      )}

      <div className="mt-8"><RecentJobs onOpen={openJob} refreshKey={jobsRefresh} /></div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-muted">{label}</span>
      {children}
    </label>
  );
}
