// Web App Manifest (PWA / home-screen install). Static — safe under
// cacheComponents. Icons live in /public/brand; the mark + ink/orange palette
// match the MakeAdClips brand identity (see docs/DESIGN_SYSTEM.md).
export default function manifest() {
  return {
    name: "MakeAdClips Studio",
    short_name: "MakeAdClips",
    description:
      "Turn one product photo into a polished AI video ad. Built for ecommerce brands.",
    start_url: "/",
    display: "standalone",
    background_color: "#0d0e10",
    theme_color: "#0d0e10",
    icons: [
      { src: "/favicon.ico", sizes: "any", type: "image/x-icon" },
      {
        src: "/brand/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/brand/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
    ],
  };
}
