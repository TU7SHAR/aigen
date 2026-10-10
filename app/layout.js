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

export const metadata = {
  title: "MakeAdClips Studio — AI product video ads",
  description:
    "Turn one product photo into a polished AI video ad. Built for ecommerce brands.",
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
