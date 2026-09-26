"use client";
import { createContext, useContext, useEffect, useState, useRef, useCallback, type ReactNode } from "react";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import * as Tooltip from "@radix-ui/react-tooltip";
import type { Workspace, Member, Role } from "@/lib/domain";
import { actionCapability } from "@/lib/subscription-policy";
import { readJsonBody } from "@/lib/client-response";

type Notice = { message: string; tone: "error" | "info" } | null;
interface Context {
  data: Workspace | null; busy: boolean; error: string; notice: Notice;
  act: <T = Record<string, unknown>>(action: Record<string, unknown>) => Promise<T | null>;
  refresh: () => Promise<void>; setData: (data: Workspace) => void;
  notify: (message: string, tone?: "error" | "info") => void; clearNotice: () => void;
}
const WorkspaceContext = createContext<Context | null>(null);
async function load() {
  const response = await fetch("/api/workspace", { cache: "no-store" });
  const result = await readJsonBody<Workspace & { error?: string; code?: string }>(response, "Your workspace could not load. Please retry.");
  if (!response.ok) {
    if (response.status === 401 && !location.pathname.startsWith("/onboarding")) location.assign("/login");
    if (response.status === 409 && result.code === "ORGANIZATION_REQUIRED" && !location.pathname.startsWith("/onboarding")) location.assign("/onboarding");
    throw new Error(result.error || "Your workspace could not load. Please retry.");
  }
  return result as Workspace;
}
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 15000, refetchOnWindowFocus: false } } }));
  return <QueryClientProvider client={client}><Tooltip.Provider delayDuration={350}><WorkspaceState>{children}</WorkspaceState></Tooltip.Provider></QueryClientProvider>;
}
function WorkspaceState({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["workspace"], queryFn: load });
  const [notice, setNotice] = useState<Notice>(null);
  const [expired, setExpired] = useState(false);
  const expiryAnchor = useRef<{ key: string; deadline: number } | null>(null);
  const notify = useCallback((message: string, tone: "error" | "info" = "info") => setNotice({ message, tone }), []);
  const setData = useCallback((data: Workspace) => {
    const previous = client.getQueryData<Workspace>(["workspace"]);
    if (previous && (previous.id !== data.id || previous.actor?.id !== data.actor?.id || previous.actor?.role !== data.actor?.role)) {
      client.removeQueries({ queryKey: ["leads"] });
      client.removeQueries({ queryKey: ["team"] });
      client.removeQueries({ queryKey: ["templates"] });
      client.removeQueries({ queryKey: ["intake"] });
    }
    client.setQueryData(["workspace"], data);
    void client.invalidateQueries({ queryKey: ["leads"] });
  }, [client]);
  const refresh = useCallback(async () => {
    await client.invalidateQueries({ queryKey: ["workspace"] });
    await client.invalidateQueries({ queryKey: ["leads"] });
    await client.invalidateQueries({ queryKey: ["intake"] });
  }, [client]);
  const mutation = useMutation({ mutationFn: async (action: Record<string, unknown>) => {
    const response = await fetch("/api/workspace", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(action) });
    const result = await readJsonBody<{ error?: string; code?: string; workspace?: Workspace; result?: Record<string, unknown> }>(response, "That change could not be saved. Please refresh and check before trying again.");
    if (!response.ok) {
      if (result.code === "SUBSCRIPTION_RESTRICTED") void refresh();
      throw new Error(result.error || "That change could not be saved.");
    }
    if (result.workspace) setData(result.workspace);
    return result.result ?? {};
  } });
  const act = async <T,>(action: Record<string, unknown>): Promise<T | null> => {
    setNotice(null);
    try { return await mutation.mutateAsync(action) as T; }
    catch (error) { notify((error as Error).message, "error"); return null; }
  };
  useEffect(() => {
    if (!notice || notice.tone === "error") return;
    const timer = setTimeout(() => setNotice(null), 4500); return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (query.data?.actor?.backend !== "workos") return;
    const events = new EventSource("/api/events");
    events.addEventListener("change", () => void refresh());
    events.addEventListener("revoked", () => { events.close(); location.assign("/login"); });
    return () => events.close();
  }, [query.data?.id, query.data?.actor?.backend, refresh]);
  useEffect(() => {
    const policy = query.data?.capabilities;
    if (!policy?.allowed || !policy.validUntil) { expiryAnchor.current = null; setExpired(false); return; }
    // Anchor each server observation once; reusing a response must not renew its interval.
    const key = JSON.stringify([query.data?.id, policy.checkedAt, policy.validUntil, policy.reason]);
    const interval = Date.parse(policy.validUntil) - Date.parse(policy.checkedAt);
    if (!Number.isFinite(interval)) { setExpired(true); return; }
    if (expiryAnchor.current?.key !== key) expiryAnchor.current = { key, deadline: query.dataUpdatedAt + interval };
    const remaining = expiryAnchor.current.deadline - Date.now();
    setExpired(remaining <= 0);
    if (remaining <= 0) return;
    const timer = setTimeout(() => { setExpired(true); void refresh(); }, Math.min(remaining, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [query.data?.id, query.data?.capabilities?.checkedAt, query.data?.capabilities?.validUntil, query.data?.capabilities?.allowed, query.data?.capabilities?.reason, query.dataUpdatedAt, refresh]);
  const data = expired && query.data?.capabilities?.allowed ? { ...query.data, capabilities: { ...query.data.capabilities, allowed: false, reason: query.data.capabilities.reason === "trial" ? "trial_expired" as const : "verification_required" as const, message: query.data.capabilities.reason === "trial" ? "Your seven-day trial has ended. Subscribe to restore paid features." : "Refreshing subscription access. Existing data remains available." } } : query.data || null;
  return <WorkspaceContext.Provider value={{ data, busy: mutation.isPending, error: query.error?.message || "", notice, act, refresh, setData, notify, clearNotice: () => setNotice(null) }}>{children}</WorkspaceContext.Provider>;
}
export function useOptionalWorkspace() { return useContext(WorkspaceContext); }
export function paidActionBlocked(workspace: Workspace, action: Record<string, unknown>) {
  return workspace.capabilities?.allowed === false && Boolean(actionCapability(workspace, action) || ["team.invite", "team.reactivate"].includes(String(action.type)));
}
export function useWorkspace() { const context = useContext(WorkspaceContext); if (!context) throw new Error("WorkspaceProvider is missing."); return context; }
export function useData() { const context = useWorkspace(); if (!context.data) throw new Error("Workspace has not loaded."); return { ...context, data: context.data }; }

/** UI affordances only; the API independently authorizes every operation. */
export function workspaceAccess(workspace: Workspace) {
  const role: Role = workspace.actor?.role || (workspace.demo && !workspace.workosOrganizationId ? "owner" : "analyst");
  const admin = role === "owner" || role === "admin";
  const memberId = workspace.actor?.memberId || workspace.members?.find(member => workspace.actor?.backend === "workos"
    ? Boolean(member.workosId) && member.workosId === workspace.actor.id
    : member.id === workspace.actor?.id)?.id;
  return { role, admin, canWork: admin || role === "counsellor", memberId };
}

export function assignableMembers(workspace: Workspace): Member[] {
  return (workspace.members || []).filter(member => member.status === "active"
    && ["owner", "admin", "counsellor"].includes(member.role)
    && (!(workspace.workosOrganizationId || workspace.actor?.backend === "workos") || Boolean(member.workosId)));
}

export function recordOwnerId(workspace: Workspace, record: { owner: string; ownerId?: string | null }): string | null {
  if (record.ownerId !== undefined) return record.ownerId;
  // Only pre-hydration local records may resolve an unambiguous legacy label.
  if (workspace.workosOrganizationId || workspace.actor?.backend === "workos" || workspace.members?.some(member => member.workosId)) return null;
  const matches = assignableMembers(workspace).filter(member => member.name === record.owner);
  return matches.length === 1 ? matches[0].id : null;
}

export function ownerLabel(workspace: Workspace, record: { owner: string; ownerId?: string | null }): string {
  const id = recordOwnerId(workspace, record);
  return (id && workspace.members?.find(member => member.id === id)?.name) || record.owner || "Unassigned";
}

export function memberLabel(member: Member, members: Member[]): string {
  return members.filter(item => item.name === member.name).length > 1
    ? `${member.name} · ${member.email || member.id.slice(-8)}` : member.name;
}

export function canWorkRecord(workspace: Workspace, record: { owner: string; ownerId?: string | null }): boolean {
  const access = workspaceAccess(workspace);
  return access.admin || (access.role === "counsellor" && Boolean(access.memberId) && recordOwnerId(workspace, record) === access.memberId);
}

export function canVisitPage(workspace: Workspace, page: string): boolean {
  const { admin, role } = workspaceAccess(workspace);
  if (["team", "integrations", "automations"].includes(page)) return admin;
  if (["recovery", "analytics"].includes(page) && role === "counsellor") return false;
  return true;
}

export interface WhatsAppTemplate {
  id: string; name: string; language: string; status: string; category: string;
  components: { type: string; text?: string; format?: string; buttons?: { type: string; text?: string; url?: string }[] }[];
}

export function useWhatsAppTemplates() {
  const { data } = useData();
  const connection = data.connections?.find(item => item.service === "whatsapp");
  const enabled = workspaceAccess(data).admin && !data.demo && connection?.status === "connected";
  const query = useQuery({
    queryKey: ["templates", data.id, connection?.id, connection?.updatedAt],
    enabled,
    queryFn: async ({ signal }) => {
      const response = await fetch("/api/connections?type=templates", { cache: "no-store", signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Approved templates could not be loaded.");
      return (result.templates as WhatsAppTemplate[]).filter(template => template.status === "APPROVED");
    },
  });
  return { ...query, enabled, templates: query.data || [], connection };
}

export function templateBody(template?: WhatsAppTemplate): string {
  return template?.components.find(component => component.type === "BODY")?.text || "";
}

export function templateIssue(template?: WhatsAppTemplate): string | null {
  if (!template) return "Choose an approved Meta template.";
  const body = templateBody(template);
  if (!body.trim()) return "This template has no supported text body.";
  if (body.length > 1500) return "Choose a template body of up to 1,500 characters.";
  const supported = new Set(["1", "2", "3", "name", "course", "institute"]);
  if ([...body.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].some(match => !supported.has(match[1]))) return "This template needs variables beyond name, course and institute.";
  if (template.components.some(component => component.type !== "BODY" && /\{\{/.test(component.text || ""))) return "Dynamic header and button variables are not supported by this connection.";
  if (template.components.some(component => component.type === "HEADER" && component.format && component.format !== "TEXT")) return "This template requires header media that this connection cannot supply.";
  if (template.components.some(component => component.buttons?.some(button => /\{\{/.test(button.url || "")))) return "This template requires dynamic button variables that this connection cannot supply.";
  return null;
}
