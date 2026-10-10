import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import ThemeProvider from "@/components/theme/ThemeProvider.js";
import AppHeader from "@/components/layout/AppHeader.js";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// metadataBase lets Next resolve absolute URLs for OG/Twitter/icon tags.
// Override with NEXT_PUBLIC_SITE_URL in production.
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://makeadclips.com";

export const metadata = {
  metadataBase: new URL(siteUrl),
  applicationName: "MakeAdClips",
  title: {
    default: "MakeAdClips — AI product video ads",
    template: "%s — MakeAdClips",
  },
  description:
    "Turn one product photo into a polished AI video ad. Built for ecommerce brands.",
  keywords: [
    "AI video ads",
    "product video generator",
    "ad creative",
    "ecommerce marketing",
    "video ad maker",
    "MakeAdClips",
  ],
  authors: [{ name: "MakeAdClips" }],
  creator: "MakeAdClips",
  // app/icon.svg, app/favicon.ico, app/apple-icon.png and app/manifest.js are
  // auto-wired by Next's metadata file conventions — no manual icon list needed.
  openGraph: {
    type: "website",
    siteName: "MakeAdClips",
    title: "MakeAdClips — AI product video ads",
    description:
      "Turn one product photo into a polished AI video ad. Built for ecommerce brands.",
    url: siteUrl,
    // app/opengraph-image.png is picked up automatically.
  },
  twitter: {
    card: "summary_large_image",
    title: "MakeAdClips — AI product video ads",
    description:
      "Turn one product photo into a polished AI video ad. Built for ecommerce brands.",
    // app/twitter-image.png is picked up automatically.
  },
  appleWebApp: {
    capable: true,
    title: "MakeAdClips",
    statusBarStyle: "black-translucent",
  },
};

// viewportFit=cover enables env(safe-area-inset-*) on notched devices.
// themeColor adapts the browser chrome to the active theme.
export const viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f6f2" },
    { media: "(prefers-color-scheme: dark)", color: "#0d0e10" },
  ],
};

export default function RootLayout({ children }) {
  return (
    <html
      lang="en"
      // next-themes writes the theme class to <html> before paint; this
      // attribute silences the expected server/client class mismatch.
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col bg-bg text-ink">
        <ThemeProvider>
          <AppHeader />
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
