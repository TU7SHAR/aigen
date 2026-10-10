import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata = {
  title: "AdForge Studio — AI product video ads",
  description:
    "Turn one product photo into a polished AI video ad. Built for ecommerce brands.",
};

// Dark mode follows the OS preference by toggling the `.dark` class (so our
// token system — not a mechanical inversion — drives both themes). The inline
// script runs before paint to avoid a flash of the wrong theme.
const themeScript = `
try {
  var m = window.matchMedia('(prefers-color-scheme: dark)');
  var apply = function (dark) {
    document.documentElement.classList.toggle('dark', dark);
  };
  apply(m.matches);
  m.addEventListener('change', function (e) { apply(e.matches); });
} catch (e) {}
`;

export default function RootLayout({ children }) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-full flex flex-col bg-bg text-ink">{children}</body>
    </html>
  );
}
