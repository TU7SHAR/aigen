import Studio from "@/components/studio/Studio.js";

export const metadata = {
  title: "Studio — MakeAdClips",
  description: "Generate a product video ad from a photo.",
};

export default function StudioPage() {
  // The shared AppHeader (nav + theme toggle) is rendered by the root layout.
  return (
    <div className="flex-1">
      <Studio />
    </div>
  );
}
