"use client";

/**
 * Video language control — Single language / Mixed languages / Custom.
 * Searchable catalogue (from /api/languages), caption writing system, and a
 * live, honest capability check (writing · voice · captions · lip sync)
 * before anything is generated. The choice is remembered on this device.
 */

import { useEffect, useId, useMemo, useState } from "react";
import { Languages, Check, AlertTriangle, Info } from "lucide-react";

const STATUS_LABEL = {
  verified: "Verified",
  provider_listed: "Supported (listen before publishing)",
  supported: "Supported",
  font_installed: "Font installed",
  unverified: "Unverified",
  unavailable: "Not available",
  not_requested: "Off",
  not_offered: "Not offered",
};

export default function LanguagePicker({ value, onChange, narration = true }) {
  const [catalog, setCatalog] = useState(null);
  const [query, setQuery] = useState("");
  const [check, setCheck] = useState(null);
  const ids = { search: useId(), script: useId(), secondary: useId(), custom: useId() };
  const mode = value?.mode || "single";

  useEffect(() => {
    let alive = true;
    fetch("/api/languages").then((r) => r.json()).then((d) => { if (alive) setCatalog(d); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // Live capability assessment for the current profile (debounced).
  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      fetch("/api/languages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ language: value, narration }) })
        .then((r) => r.json()).then((d) => { if (alive) setCheck(d); }).catch(() => {});
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [value, narration]);

  const languages = useMemo(() => {
    const all = catalog?.languages || [];
    const q = query.trim().toLowerCase();
    if (!q) return all;
    const norm = (s) => String(s || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    return all.filter((l) => norm(`${l.name} ${l.native} ${l.code}`).includes(norm(q)));
  }, [catalog, query]);
  const scripts = (catalog?.scripts || []).filter((s) => s.fontInstalled);
  const presets = catalog?.presets || [];
  const set = (patch) => onChange({ ...value, ...patch });

  return (
    <fieldset className="card space-y-3 p-4">
      <legend className="sr-only">Video language</legend>
      <div className="flex items-center gap-2">
        <Languages className="h-4 w-4 text-accent" aria-hidden="true" />
        <span className="text-sm font-semibold">Video language</span>
        <span className="mono-meta ml-auto">narration · captions · CTA</span>
      </div>

      <div role="radiogroup" aria-label="Language mode" className="grid grid-cols-3 gap-1 rounded-xl border border-line bg-surface p-1">
        {[["single", "Single language"], ["mixed", "Mixed languages"], ["custom", "Custom"]].map(([id, label]) => (
          <button
            key={id} type="button" role="radio" aria-checked={mode === id}
            onClick={() => (id === "mixed" ? onChange({ mode: "mixed", preset: "hinglish", primary: "hi-IN", secondary: ["en-IN"], captionScript: "Latn" }) : set({ mode: id, preset: undefined, secondary: id === "single" ? [] : value?.secondary || [] }))}
            className={`min-h-11 rounded-lg px-2 text-sm font-medium ${mode === id ? "bg-accent text-accent-contrast" : "text-muted hover:text-ink"}`}
          >
            {label}
          </button>
        ))}
      </div>

      {mode === "mixed" && (
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Mixed language style">
          {presets.map((p) => (
            <button
              key={p.id} type="button" role="radio" aria-checked={value?.preset === p.id}
              onClick={() => onChange({ mode: "mixed", preset: p.id, primary: p.primary, secondary: p.secondary, captionScript: p.captionScript, mixBalance: p.mixBalance })}
              className={`min-h-9 rounded-full border px-3 text-sm ${value?.preset === p.id ? "border-accent text-ink" : "border-line text-muted hover:text-ink"}`}
            >
              {p.label} <span className="mono-meta">{p.detail}</span>
            </button>
          ))}
        </div>
      )}

      {mode !== "mixed" && (
        <div className="space-y-2">
          <label htmlFor={ids.search} className="block text-xs text-muted">
            {mode === "custom" ? "Main spoken language" : "Language"} — search {catalog?.languages?.length || ""} languages and regional varieties
          </label>
          <input id={ids.search} className="input" placeholder="Search, e.g. Tamil, français, pt-BR" value={query} onChange={(e) => setQuery(e.target.value)} />
          <select
            className="input" aria-label="Choose language" size={Math.min(6, Math.max(2, languages.length))}
            value={value?.primary || "en-US"}
            onChange={(e) => {
              const l = (catalog?.languages || []).find((x) => x.code === e.target.value);
              set({ primary: e.target.value, captionScript: l?.scripts?.[0] || "Latn" });
            }}
          >
            {languages.map((l) => (
              <option key={l.code} value={l.code}>{l.name} — {l.native}{l.tts?.flash ? "" : " (no voice)"}</option>
            ))}
          </select>
        </div>
      )}

      {mode === "custom" && (
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="block text-xs text-muted" htmlFor={ids.secondary}>
            Mixed with (optional)
            <select id={ids.secondary} className="input mt-1" value={value?.secondary?.[0] || ""} onChange={(e) => set({ secondary: e.target.value ? [e.target.value] : [] })}>
              <option value="">— none —</option>
              {(catalog?.languages || []).map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
            </select>
          </label>
          <label className="block text-xs text-muted" htmlFor={ids.custom}>
            Describe the style (dialect, slang, persona)
            <input id={ids.custom} className="input mt-1" maxLength={240} value={value?.description || ""} onChange={(e) => set({ description: e.target.value })} placeholder="e.g. Mumbai street Hinglish, playful" />
          </label>
        </div>
      )}

      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block text-xs text-muted" htmlFor={ids.script}>
          Caption writing system
          <select id={ids.script} className="input mt-1" value={value?.captionScript || "Latn"} onChange={(e) => set({ captionScript: e.target.value })}>
            {scripts.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
          </select>
        </label>
        <label className="block text-xs text-muted">
          Accent / delivery (optional)
          <input className="input mt-1" maxLength={80} value={value?.accent || ""} onChange={(e) => set({ accent: e.target.value || undefined })} placeholder="e.g. light Punjabi accent" />
        </label>
      </div>

      {check && (
        <div className="rounded-brand border border-line p-3 text-xs" aria-live="polite">
          <div className="mb-1 flex items-center gap-1.5 text-sm font-medium">
            {check.ok ? <Check className="h-4 w-4 text-accent" aria-hidden="true" /> : <AlertTriangle className="h-4 w-4" aria-hidden="true" />}
            {check.label}
          </div>
          <ul className="grid gap-0.5 sm:grid-cols-2">
            {Object.entries(check.stages || {}).map(([k, st]) => (
              <li key={k} title={st.note}>
                <span className="capitalize text-muted">{k}:</span> {STATUS_LABEL[st.status] || st.status}
              </li>
            ))}
          </ul>
          {check.blockers?.map((b, i) => <p key={i} className="mt-1 font-medium" style={{ color: "var(--danger, #c00)" }}>• {b}</p>)}
          {check.warnings?.slice(0, 2).map((w, i) => (
            <p key={i} className="mt-1 flex gap-1 text-muted"><Info className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> {w}</p>
          ))}
        </div>
      )}
    </fieldset>
  );
}
