import ComingSoon from "@/components/layout/ComingSoon.js";

export const metadata = {
  title: "Assets — MakeAdClips",
  description: "Imported product images and generated videos.",
};

export default function AssetsPage() {
  return (
    <ComingSoon
      eyebrow="Assets"
      title="Your assets library"
      body="Imported product images, brand palettes and generated videos will be collected here so you can reuse them across projects."
    />
  );
}
