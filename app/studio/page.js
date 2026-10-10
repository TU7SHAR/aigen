import Link from "next/link";
import Studio from "@/components/studio/Studio.js";

export const metadata = {
  title: "Studio — AdForge",
  description: "Generate a product video ad from a photo.",
};

export default function StudioPage() {
  return (
    <div className="flex-1">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
          <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
            <span className="text-accent">◩</span> AdForge{" "}
            <span className="mono-meta !text-ink">STUDIO</span>
          </Link>
          <Link href="/" className="btn btn-ghost !px-2 !py-1 text-sm">
            ← Home
          </Link>
        </div>
      </header>
      <Studio />
    </div>
  );
}
