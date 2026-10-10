import ComingSoon from "@/components/layout/ComingSoon.js";

export const metadata = {
  title: "Projects — AdForge",
  description: "Your saved ad projects.",
};

export default function ProjectsPage() {
  return (
    <ComingSoon
      eyebrow="Projects"
      title="Your projects live here"
      body="Saved ad projects, drafts and generation history will appear on this screen. Persistence lands with the accounts milestone."
    />
  );
}
