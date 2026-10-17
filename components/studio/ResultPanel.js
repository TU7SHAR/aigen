"use client";

/**
 * Result panel — plays and downloads the export (streamed from disk, not a
 * base64 blob), and shows the separated verdicts: technical / factual /
 * language checks (automated) and creative review (not judged
 * automatically), plus per-shot provenance and the production record.
 */

import { Download, AlertCircle, CheckCircle2, RotateCcw } from "lucide-react";

const VERDICT = { pass: "Passed", warn: "Warnings", fail: "Failed", not_reviewed: "Not reviewed" };

function CheckGroup({ title, group }) {
  if (!group) return null;
  const ok = group.status === "pass";
  return (
    <div className="rounded-brand border border-line p-2.5">
      <div className="flex items-center gap-1.5 text-sm font-medium">
        {ok ? <CheckCircle2 className="h-4 w-4 text-accent" aria-hidden="true" /> : <AlertCircle className="h-4 w-4" aria-hidden="true" />}
        {title}: <span className="text-muted">{VERDICT[group.status] || group.status}</span>
      </div>
      {group.findings?.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-xs">
          {group.findings.map((f, i) => (
            <li key={i} className={f.level === "error" ? "font-medium" : "text-muted"}>• {f.message}</li>
          ))}
        </ul>
      )}
      {group.note && <p className="mt-1 text-xs text-muted">{group.note}</p>}
    </div>
  );
}

export default function ResultPanel({ job, record, onRemake }) {
  if (!job?.hasVideo) return null;
  const r = job.result || {};
  const checks = r.checks || {};
  const shots = r.render?.shotReport || [];
  const src = `/api/jobs/${job.id}/video`;
  const vertical = Number(r.height) > Number(r.width);
  return (
    <section className="card space-y-4 p-5" aria-labelledby="result-title">
      <div className="flex items-center gap-2">
        <h2 id="result-title" className="text-base font-semibold">Your video</h2>
        <span className="mono-meta ml-auto">{r.width}×{r.height} · {Number(r.durationSec || 0).toFixed(1)}s · {r.fps}fps</span>
      </div>
      {r.partial && (
        <div className="alert alert-danger" role="alert">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>Partial result: {r.partialReason} Those shots use other visuals — see the shot list.</span>
        </div>
      )}
      <div className="media-canvas flex justify-center overflow-hidden rounded-brand">
        <video
          src={src}
          controls
          playsInline
          preload="metadata"
          className={vertical ? "block h-[70vh] max-h-[720px] w-auto max-w-full" : "block h-auto max-h-[70vh] w-full"}
          style={r.width && r.height ? { aspectRatio: `${r.width} / ${r.height}` } : undefined}
          aria-label="Generated video ad"
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <a href={`${src}?download=1`} className="btn btn-primary"><Download className="h-4 w-4" aria-hidden="true" /> Download MP4</a>
        {onRemake && (
          <button type="button" className="btn btn-secondary" onClick={onRemake}>
            <RotateCcw className="h-4 w-4" aria-hidden="true" /> Edit and make another version
          </button>
        )}
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <CheckGroup title="Technical" group={checks.technical} />
        <CheckGroup title="Facts & destination" group={checks.factual} />
        <CheckGroup title="Language" group={checks.language} />
        <CheckGroup title="Creative review" group={checks.creative} />
      </div>
      {checks.basis && <p className="mono-meta !normal-case">{checks.basis}</p>}

      {shots.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm font-medium">How each shot was made</summary>
          <ol className="mt-2 space-y-1.5 text-xs">
            {shots.map((s) => (
              <li key={s.shot} className="break-anywhere">
                <span className="mono-meta !text-accent">{String(s.shot).padStart(2, "0")}</span>{" "}
                <span className="text-ink">{s.intent}</span> — {s.visualSource}
                {s.onScreenText && <span className="block text-muted">Caption: “{s.onScreenText}”</span>}
                {s.voiceover && <span className="block text-muted">Voice: “{s.voiceover}”</span>}
                {s.productionNotes?.map((n, k) => <span key={k} className="block text-muted">{n}</span>)}
              </li>
            ))}
          </ol>
        </details>
      )}

      {record && (
        <details>
          <summary className="cursor-pointer text-sm font-medium">Production record</summary>
          <div className="mt-2 space-y-1 text-xs">
            {record.creative?.brief && (
              <p className="break-anywhere"><b>Focus:</b> {record.creative.brief.focus} · <b>Audience:</b> {record.creative.brief.audience} · <b>Message:</b> {record.creative.brief.mainMessage}</p>
            )}
            {record.language?.label && <p><b>Language:</b> {record.language.label}</p>}
            {record.destination?.display && <p><b>Destination:</b> {record.destination.display} ({record.destination.source})</p>}
            {record.usage && <p><b>Usage:</b> ${Number(record.usage.reservedUsd || 0).toFixed(2)} reserved/estimated · {record.usage.paidVideoClips} clip(s) · {record.usage.paidAudio} audio · {record.usage.paidImages} image(s) — {record.usage.basis}</p>}
            {record.timings && <p><b>Time:</b> media+audio {(record.timings.mediaAndAudioMs / 1000).toFixed(0)}s · render {(record.timings.renderMs / 1000).toFixed(0)}s</p>}
          </div>
        </details>
      )}
    </section>
  );
}
