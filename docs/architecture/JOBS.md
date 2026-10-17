# Durable Job System

`lib/jobs/` — `jobStore.js`, `runner.js`

## Problem

Synchronous generate (old design) ran Veo polling inside a single HTTP request. If it took >4 minutes, or the browser closed, the job was lost with no recovery path and the UI hung.

## Design

Jobs are persisted to disk immediately on submit. The server produces the video in the background. The UI polls for status.

```
POST /api/jobs          → submit (idempotency key, returns job id immediately)
GET  /api/jobs          → list recent jobs
GET  /api/jobs/[id]     → status + result
GET  /api/jobs/[id]/video  → stream the final MP4 (Range supported)
POST /api/jobs/[id]/cancel → cancel in-flight job
```

## Job lifecycle

```
queued → running → completed
                 ↘ failed
                 ↘ cancelled
```

- **Lease**: the runner holds a lease (updated every 10s). On server restart, `recoverJobs()` resumes any job whose Veo operation id was recorded.
- **Idempotency**: submitting twice with the same `idempotencyKey` returns the first job.
- **Heartbeat**: the client side (`JobTracker.js`) polls `/api/jobs/[id]` every 3s during production.

## Storage layout

```
.data/
  jobs/
    index.json          ← job summaries (id, status, createdAt)
    <uuid>/
      job.json          ← full record (plan, scenes, events, result, checks)
      final.mp4         ← finished video
      media/            ← raw shot clips, keyframes, voiceover.wav, music.mp3
      input-image.*     ← uploaded hero image (if any)
  model-quota.json      ← RPM/RPD counters (auto-reset at Pacific midnight)
  spend-ledger.json     ← daily/monthly spend totals
  spend-events.jsonl    ← append-only spend audit log
```

## Execution modes

| Mode | When | How |
|------|------|-----|
| Inline (default) | `JOB_EXECUTION=inline` | Job runs in the Next.js API route worker thread |
| Worker | `JOB_EXECUTION=worker` | `scripts/worker.mjs` runs as a separate Node process; jobs are handed off via file-based queue |

The worker process is recommended for production to avoid blocking the Next server.

## Supabase migration path

`jobStore.js` exposes `saveJob`, `loadJob`, `listJobs`, `setJobStatus`, `appendEvent`. Replacing the file-backed implementations with Supabase `jobs` table calls requires no changes to `runner.js` or the API routes.
