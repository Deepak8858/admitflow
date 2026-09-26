import { notFound } from "next/navigation";
import { AuthKitProvider } from "@workos-inc/authkit-nextjs/components";
import { WorkspaceProvider } from "@/components/provider";
import { workosConfigured } from "@/lib/config";
import { workspacePage } from "@/lib/workspace-routes";

export default async function WorkspaceLayout({ children, params }: { children: React.ReactNode; params: Promise<{ view: string[] }> }) {
  // Invalid/public URLs must never mount the client that loads a private workspace.
  if (!workspacePage((await params).view)) notFound();
  const content = <WorkspaceProvider>{children}</WorkspaceProvider>;
  return workosConfigured() ? <AuthKitProvider>{content}</AuthKitProvider> : content;
}
