import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // The compositor shells out to the bundled static ffmpeg/ffprobe binaries and
  // reads vendored fonts. Keep the native packages external (do not let the
  // bundler rewrite their binary paths), and trace the binaries + fonts into
  // the server output for every API route that can render (generate + jobs).
  serverExternalPackages: ["ffmpeg-static", "ffprobe-static", "sharp"],
  outputFileTracingIncludes: {
    "/api/**": [
      "./node_modules/ffmpeg-static/ffmpeg",
      "./node_modules/ffmpeg-static/ffmpeg.exe",
      "./node_modules/ffprobe-static/bin/**",
      "./assets/fonts/**",
    ],
  },
  turbopack: {
    // Pin the workspace root to THIS project. Without it Next infers a root
    // from a stray lockfile in the user's home folder and file activity there
    // (e.g. browser-automation logs) triggers endless dev recompiles + reloads.
    root: projectRoot,
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
