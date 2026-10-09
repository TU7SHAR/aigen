import Link from "next/link";
import Studio from "@/components/studio/Studio.js";

export const metadata = {
  title: "Studio — AdForge",
  description: "Generate a product video ad from a photo.",
};

export default function StudioPage() {
  return (
    <div className="flex-1">
      <header className="border-b border-zinc-200 dark:border-zinc-800">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
          <Link href="/" className="font-semibold tracking-tight">
            AdForge <span className="text-indigo-600">Studio</span>
          </Link>
          <Link
            href="/"
            className="text-sm text-zinc-500 transition hover:text-zinc-900 dark:hover:text-zinc-200"
          >
            ← Home
          </Link>
        </div>
      </header>
      <Studio />
    </div>
  );
}
