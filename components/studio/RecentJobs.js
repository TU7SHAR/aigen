"use client";

/** Recent videos made on this server (from GET /api/jobs). */

import { useEffect, useState } from "react";
import { Film } from "lucide-react";

const LABEL = { queued: "Queued", running: "Rendering", completed: "Ready", partial: "Ready (partial)", failed: "Failed", canceled: "Canceled", interrupted: "Resuming" };

export default function RecentJobs({ onOpen, refreshKey = 0 }) {
  const [jobs, setJobs] = useState(null);
  useEffect(() => {
    let alive = true;
    fetch("/api/jobs", { cache: "no-store" }).then((r) => r.json()).then((d) => { if (alive) setJobs(d.jobs || []); }).catch(() => { if (alive) setJobs([]); });
    return () => { alive = false; };
  }, [refreshKey]);
  if (!jobs?.length) return null;
  return (
    <section aria-labelledby="recent-title" className="card p-4">
      <h2 id="recent-title" className="eyebrow mb-2">Your recent videos</h2>
      <ul className="divide-y divide-line">
        {jobs.slice(0, 8).map((j) => (
          <li key={j.id}>
            <button type="button" onClick={() => onOpen(j.id)} className="flex min-h-11 w-full items-center gap-2 py-2 text-left text-sm hover:text-accent">
              <Film className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
              <span className="flex-1 truncate">{j.summary?.brand || j.summary?.productName || "Untitled"}{j.summary?.language ? ` · ${j.summary.language.split(" · ")[0]}` : ""}</span>
              <span className="mono-meta">{LABEL[j.status] || j.status}</span>
              <span className="mono-meta hidden sm:inline">{new Date(j.createdAt).toLocaleString()}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
