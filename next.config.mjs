/** @type {import('next').NextConfig} */
const nextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  // The deterministic compositor shells out to the bundled static ffmpeg/ffprobe
  // binaries and reads vendored fonts. Keep the native packages external (do not
  // let the bundler rewrite their binary paths), and ensure the binaries + fonts
  // are traced into the server output so they exist at runtime.
  serverExternalPackages: ["ffmpeg-static", "ffprobe-static", "sharp"],
  outputFileTracingIncludes: {
    "/api/generate": [
      "./node_modules/ffmpeg-static/ffmpeg",
      "./node_modules/ffmpeg-static/ffmpeg.exe",
      "./node_modules/ffprobe-static/bin/**",
      "./assets/fonts/**",
    ],
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
