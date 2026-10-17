/**
 * GET /api/jobs/{id}/video — the exported MP4 (Range requests supported so
 * the player can seek). ?download=1 → attachment with a safe filename.
 */

import fs from "node:fs";
import { connection } from "next/server";
import { getJob, isValidJobId, jobOutputPath } from "@/lib/jobs/jobStore.js";

function safeName(job) {
  const base = String(job.summary?.brand || job.summary?.productName || "makeadclips").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "makeadclips";
  return `${base}-${job.id.slice(0, 8)}.mp4`;
}

export async function GET(request, { params }) {
  await connection();
  const { id } = await params;
  if (!isValidJobId(id)) return new Response("Invalid job id.", { status: 400 });
  const job = getJob(id);
  const file = job ? jobOutputPath(id) : null;
  if (!job || !file || !fs.existsSync(file)) return new Response("Video not available.", { status: 404 });
  const size = fs.statSync(file).size;
  const url = new URL(request.url);
  const headers = {
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  };
  if (url.searchParams.get("download") === "1") headers["Content-Disposition"] = `attachment; filename="${safeName(job)}"`;
  const range = request.headers.get("range");
  const m = range && range.match(/^bytes=(\d*)-(\d*)$/);
  if (m) {
    let start = m[1] ? Number(m[1]) : size - Number(m[2] || 0);
    let end = m[1] && m[2] ? Number(m[2]) : size - 1;
    if (!Number.isFinite(start) || start < 0) start = 0;
    if (!Number.isFinite(end) || end >= size) end = size - 1;
    if (start > end) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(end - start + 1);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return new Response(buf, { status: 206, headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(buf.length) } });
  }
  return new Response(
    new ReadableStream({
      start(controller) {
        const rs = fs.createReadStream(file);
        rs.on("data", (chunk) => controller.enqueue(chunk));
        rs.on("end", () => controller.close());
        rs.on("error", (err) => controller.error(err));
      },
    }),
    { status: 200, headers: { ...headers, "Content-Length": String(size) } }
  );
}
