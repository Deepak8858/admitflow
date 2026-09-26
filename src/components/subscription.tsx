"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useData, workspaceAccess } from "./provider";
import { Badge, Button, PanelHeader } from "./ui";
import type { intakeSummary } from "@/lib/db/intake";
import { readJsonResponse } from "@/lib/client-response";

type IntakeSummary = Awaited<ReturnType<typeof intakeSummary>>;
export function SubscriptionStatus() {
  const { data, refresh, error, notify } = useData();
  const [checking, setChecking] = useState(false);
  const policy = data.capabilities, { admin } = workspaceAccess(data);
  if (!policy || ["demo", "local", "active"].includes(policy.reason)) return null;
  return <section className="setup-callout" aria-label="Subscription access">
    <div>
      <Badge tone={policy.allowed ? "blue" : "amber"}>{policy.allowed ? "Seven-day trial" : "Restricted mode"}</Badge>
      <p role="status">{policy.message}</p>
      {policy.reason === "trial" && policy.validUntil && <p>Trial ends <time dateTime={policy.validUntil}>{new Date(policy.validUntil).toLocaleString("en-IN", { timeZone: data.timezone || "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })}</time> ({data.timezone || "Asia/Kolkata"}).</p>}
      {!policy.allowed && <p>Outbound sends, AI, new enquiries, invitations and reactivations are paused. Existing records, exports, internal notes and safety controls remain available.</p>}
      {admin ? <Link href="/settings#billing" className="button secondary">Manage billing</Link> : <p>Contact your institute owner or administrator to manage the subscription.</p>}
      <Button variant="ghost" loading={checking} onClick={async () => { setChecking(true); try { await refresh(); } catch (cause) { notify(cause instanceof Error ? cause.message : "Access could not be refreshed.", "error"); } finally { setChecking(false); } }}>Refresh access</Button>
      {error && <p className="inline-error" role="alert">Access could not be refreshed. {error}</p>}
    </div>
  </section>;
}

export function DeferredIntakePanel() {
  const { data, setData, refresh, notify } = useData();
  const enabled = workspaceAccess(data).admin && data.actor?.backend === "workos" && !data.demo;
  const [busy, setBusy] = useState(false), [after, setAfter] = useState<string>();
  const submitting = useRef(false);
  useEffect(() => { setAfter(undefined); }, [data.id]);
  const query = useQuery({
    queryKey: ["intake", data.id, data.actor?.id, data.actor?.role, data.revision], enabled,
    queryFn: async ({ signal }) => {
      const response = await fetch("/api/intake", { cache: "no-store", signal });
      return readJsonResponse<IntakeSummary>(response, "Deferred enquiries could not be loaded.");
    },
  });
  async function importBatch() {
    if (submitting.current || query.isFetching || query.isError || !query.data?.count) return;
    submitting.current = true; setBusy(true);
    try {
      const response = await fetch("/api/intake", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "import", after }) });
      const result = await readJsonResponse<{ result: { hasMore: boolean; after?: string; imported: number; blocked: number }; workspace: typeof data }>(response, "This batch could not be imported.");
      setAfter(result.result.hasMore ? result.result.after : undefined);
      setData(result.workspace);
      notify(`${result.result.imported} deferred events imported without automation. ${result.result.blocked} need the original connection restored.${result.result.hasMore ? " Another batch is available." : ""}`);
    } catch (error) { notify(error instanceof Error ? error.message : "Import failed.", "error"); }
    finally { submitting.current = false; setBusy(false); try { await refresh(); } catch (cause) { notify(cause instanceof Error ? cause.message : "Deferred enquiries could not be refreshed.", "error"); } }
  }
  if (!enabled) return null;
  return <section className="panel settings-form" aria-label="Deferred enquiries" aria-busy={busy || query.isFetching}>
    <PanelHeader title="Deferred enquiries" description="Signed intake retained while new enquiries were restricted." />
    <div style={{ padding: "0 23px 24px" }}>
      {query.isError && <p role="alert" className="inline-error">{query.error.message}</p>}
      {query.isPending && <p role="status" className="field-note">Checking deferred enquiries…</p>}
      {query.data && <>
        <p><strong>{query.data.count}{query.data.capped ? "+" : ""}</strong> available events awaiting review.</p>
        <p><strong>{query.data.expiredCount}</strong> expired events. Their payloads are unrecoverable; contact safety holds remain.</p>
        <p className="field-note">Raw intake expires 30 days after receipt, or seven days after import if earlier. Imported CRM records follow a separate lifecycle.</p>
        <p className="field-note">{query.data.message} Each batch contains up to 25 events, not necessarily 25 new enquiries. Enquiry limits apply to the whole batch.</p>
        {query.data.needsConnection && <p className="field-note">Some events require their original provider connection. Restore that connection before retrying them.</p>}
        <Button action={{ type: "intake.import" }} loading={busy} disabled={!query.data.count || query.isFetching || query.isError} onClick={() => void importBatch()}>{after ? "Import next batch" : "Import up to 25 events"}</Button>
        {after && <Button disabled={busy} onClick={() => setAfter(undefined)}>Review from beginning</Button>}
      </>}
      <Button variant="ghost" disabled={busy || query.isFetching} onClick={() => void query.refetch()}>Refresh deferred enquiries</Button>
    </div>
  </section>;
}
