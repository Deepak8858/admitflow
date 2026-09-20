import { notFound } from "next/navigation";
import { WorkspaceApp } from "@/components/workspace";

const pages = ["overview", "leads", "pipeline", "recovery", "inbox", "appointments", "analytics", "knowledge", "automations", "settings", "team", "integrations"];
export const dynamic = "force-dynamic";
export default async function Page({ params }: { params: Promise<{ view?: string[] }> }) {
  const { view } = await params;
  if ((view?.length || 0) > 1 || (view?.[0] && !pages.includes(view[0]))) notFound();
  return <WorkspaceApp view={view?.[0] || "overview"} />;
}
