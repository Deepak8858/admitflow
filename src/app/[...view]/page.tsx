import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { WorkspaceApp } from "@/components/workspace";
import { workspacePage, workspacePages } from "@/lib/workspace-routes";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ view: string[] }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { view } = await params;
  const page = workspacePage(view);
  return { title: page ? `${workspacePages[page]} — AdmitFlow` : "Page not found — AdmitFlow", robots: { index: false, follow: false } };
}

export default async function Page({ params }: Props) {
  const page = workspacePage((await params).view);
  if (!page) notFound();
  return <WorkspaceApp view={page} />;
}
