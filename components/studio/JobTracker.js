"use client";

/**
 * Production tracker — polls GET /api/jobs/{id} and shows the REAL stages,
 * per-shot status (including which model is generating and every automatic
 * switch), recent events and a truthful cancel. No invented percentages or
 * time estimates. Leaving the page is safe: the job keeps running.
 */

import { useEffect, useState } from "react";
import { Loader2, CheckCircle2, XCircle, Clock, Film, AlertTriangle } from "lucide-react";

const STAGES = [
  ["plan", "Plan approved"],
  ["media", "Footage & images"],
  ["audio", "Voiceover & music"],
  ["render", "Edit & render"],
  ["checks", "Quality checks"],
];
const TERMINAL = new Set(["completed", "partial", "failed", "canceled"]);

function Icon({ status }) {
  if (status === "done") return <CheckCircle2 className="h-4 w-4 text-accent" aria-hidden="true" />;
  if (status === "failed") return <XCircle className="h-4 w-4" style={{ color: "var(--danger, #c00)" }} aria-hidden="true" />;
  if (status === "running" || status === "waiting") return <Loader2 className="h-4 w-4 animate-spin text-accent" aria-hidden="true" />;
  if (status === "skipped") return <AlertTriangle className="h-4 w-4 text-muted" aria-hidden="true" />;
  return <Clock className="h-4 w-4 text-muted" aria-hidden="true" />;
}

export default function JobTracker({ jobId, onFinished, onDismiss }) {
  const [job, setJob] = useState(null);
  const [error, setError] = useState("");
  const [canceling, setCanceling] = useState(false);

  useEffect(() => {
    let alive = true;
    let timer = null;
    const poll = async () => {
      try {
        const res = await fetch(`/api/jobs/${jobId}`, { cache: "no-store" });
        const data = await res.json();
        if (!alive) return;
        if (!res.ok) {
          setError(data?.error || "Could not load the job.");
          return;
        }
        setError("");
        setJob(data.job);
        if (TERMINAL.has(data.job.status)) {
          onFinished?.(data.job, data.record);
          return;
        }
      } catch {
        if (alive) setError("Connection lost — retrying…");
      }
      if (alive) timer = setTimeout(poll, 2500);
    };
    poll();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [jobId, onFinished]);

  async function cancel() {
    setCanceling(true);
    await fetch(`/api/jobs/${jobId}/cancel`, { method: "POST" }).catch(() => {});
  }

  const running = job && !TERMINAL.has(job.status);
  return (
    <section className="card space-y-4 p-5" aria-labelledby="tracker-title">
      <div className="flex items-center gap-2">
        <Film className="h-4 w-4 text-accent" aria-hidden="true" />
        <h2 id="tracker-title" className="text-base font-semibold">
          {job ? (running ? "Making your video" : job.status === "completed" ? "Video ready" : job.status === "partial" ? "Video ready — with missing shots" : job.status === "canceled" ? "Canceled" : "Production failed") : "Starting…"}
        </h2>
        <span className="mono-meta ml-auto">{job?.summary?.language || ""}</span>
      </div>
      {running && <p className="text-xs text-muted">You can leave this page — the video keeps rendering and will be here when you come back.</p>}
      {error && <p className="text-sm" role="alert">{error}</p>}

      <ol className="space-y-1.5" aria-label="Production stages">
        {STAGES.map(([key, label]) => {
          const st = job?.stages?.[key]?.status || "pending";
          return (
            <li key={key} className="flex items-center gap-2 text-sm">
              <Icon status={st === "done" ? "done" : st === "running" ? "running" : "pending"} />
              <span className={st === "pending" ? "text-muted" : "text-ink"}>{label}</span>
              {job?.stages?.[key]?.message && st === "running" && <span className="mono-meta truncate">{job.stages[key].message}</span>}
            </li>
          );
        })}
      </ol>

      {job?.shots?.length > 0 && (
        <div>
          <div className="eyebrow mb-1">Shots</div>
          <ul className="space-y-1 text-xs">
            {job.shots.map((s) => (
              <li key={s.shot} className="flex items-start gap-2">
                <Icon status={s.status} />
                <span className="mono-meta shrink-0 !text-accent">{String(s.shot).padStart(2, "0")}</span>
                <span className="flex-1 break-anywhere">
                  <span className="text-ink">{s.intent || s.technique || "shot"}</span>
                  {s.message && <span className="block text-muted">{s.message}</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {job?.error && (
        <div className="alert alert-danger" role="alert">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="break-anywhere">
            {job.error.message}
            {job.error.uncertainSpend && " A provider request may still have been billed; it was not re-sent."}
          </span>
        </div>
      )}

      {job?.events?.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted">Activity log</summary>
          <ol className="mt-1 max-h-40 space-y-0.5 overflow-y-auto">
            {[...job.events].reverse().map((e, i) => (
              <li key={i} className="break-anywhere"><span className="mono-meta">{new Date(e.at).toLocaleTimeString()}</span> {e.message}</li>
            ))}
          </ol>
        </details>
      )}

      <div className="flex flex-wrap gap-2">
        {running && (
          <button type="button" className="btn btn-secondary" onClick={cancel} disabled={canceling || job?.cancelRequested}>
            {canceling || job?.cancelRequested ? "Cancel requested…" : "Cancel"}
          </button>
        )}
        {!running && onDismiss && <button type="button" className="btn btn-secondary" onClick={onDismiss}>Close</button>}
      </div>
      {running && <p className="mono-meta">Cancel stops work not yet sent to a provider; clips already generating may still finish and be billed.</p>}
    </section>
  );
}
