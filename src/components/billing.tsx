"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ArrowUpRight, CreditCard, RefreshCw } from "lucide-react";
import type { Workspace } from "@/lib/domain";
import type { BillingEntitlementSnapshot, BillingInvoicePage, BillingOverview, BillingPlanOption } from "@/lib/providers/billing";
import { Badge, Button, PanelHeader } from "./ui";

export interface BillingPanelProps { workspace: Workspace; onUpdated?: () => void | Promise<void> }
function billingMoney(amount: number, currency: string) {
  const formatter = new Intl.NumberFormat("en-IN", { style: "currency", currency });
  return formatter.format(amount / 10 ** (formatter.resolvedOptions().maximumFractionDigits ?? 2));
}
function planPrice(plan: BillingPlanOption) {
  const value = billingMoney(plan.amount, plan.currency);
  const unit: Record<string, string> = { daily: "day", weekly: "week", monthly: "month", quarterly: "quarter", yearly: "year" };
  const period = unit[plan.period] || "billing period";
  return `${value} / ${plan.interval === 1 ? period : `${plan.interval} ${period}s`}`;
}
const statusLabel: Record<string, string> = { trial: "Trial", active: "Active", past_due: "Payment needs attention", cancelled: "Ended", created: "Checkout incomplete", authenticated: "Awaiting activation", pending: "Payment pending", halted: "Payments halted", paused: "Paused", completed: "Completed", expired: "Checkout expired" };

export function BillingPanel({ workspace, onUpdated }: BillingPanelProps) {
  const canManage = ["owner", "admin"].includes(workspace.actor?.role || "owner");
  const [billing, setBilling] = useState<BillingOverview | null>(null), [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"subscribe" | "cancel" | null>(null), [selected, setSelected] = useState("");
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [entitlements, setEntitlements] = useState<BillingEntitlementSnapshot | null>(null), [invoiceRefresh, setInvoiceRefresh] = useState(0);
  const requestIds = useRef<Record<string, string>>({}), submitting = useRef(false);
  const load = useCallback(async (signal?: AbortSignal) => {
    if (!canManage) { setLoading(false); return; }
    setLoading(true); setError("");
    try {
      const response = await fetch("/api/billing", { cache: "no-store", signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Subscription details could not be loaded.");
      if (signal?.aborted) return;
      setBilling(result as BillingOverview);
      setEntitlements(result.entitlements || null);
      setSelected(value => (result.plans as BillingPlanOption[]).some(plan => plan.id === value) ? value : result.plans[0]?.id || "");
    } catch (cause) { if (!signal?.aborted) setError(cause instanceof Error ? cause.message : "Subscription details could not be loaded."); }
    finally { if (!signal?.aborted) setLoading(false); }
  }, [workspace.id, canManage]);
  useEffect(() => { requestIds.current = {}; setBilling(null); setEntitlements(null); setNotice(""); }, [workspace.id]);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load, workspace.subscription?.providerId, workspace.subscription?.status, workspace.subscription?.renewsAt, workspace.subscription?.planId, workspace.subscription?.providerPlanId, workspace.subscription?.entitlements?.limits.members, workspace.subscription?.entitlements?.limits.leads]);
  const usageKey = `${workspace.leads.length}:${workspace.members?.map(member => `${member.id}:${member.status}`).join("|") || ""}`;
  useEffect(() => {
    if (!canManage) return;
    const controller = new AbortController();
    void fetch("/api/billing?type=entitlements", { cache: "no-store", signal: controller.signal }).then(async response => {
      if (!response.ok) return;
      const result = await response.json();
      if (!controller.signal.aborted && result.entitlements) setEntitlements(result.entitlements);
    }).catch(() => { /* The explicit billing refresh reports service errors; existing usage retains its checked-at time. */ });
    return () => controller.abort();
  }, [workspace.id, canManage, usageKey]);

  async function act(type: "subscribe" | "cancel") {
    if (submitting.current) return;
    submitting.current = true; setBusy(type); setError(""); setNotice("");
    try {
      const requestId = type === "subscribe" ? (requestIds.current[selected] ||= crypto.randomUUID()) : undefined;
      const response = await fetch("/api/billing", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(type === "subscribe" ? { type, planId: selected, requestId } : { type }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Billing could not be updated. Refresh the subscription before retrying.");
      if (type === "subscribe" && result.checkoutUrl) { window.location.assign(result.checkoutUrl); return; }
      setNotice(result.message || "Subscription updated. Provider confirmation is reflected below.");
      setInvoiceRefresh(value => value + 1);
      await load();
      await onUpdated?.();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Billing could not be updated."); }
    finally { submitting.current = false; setBusy(null); }
  }

  const current = billing?.subscription || workspace.subscription;
  const status = billing?.providerStatus || current?.status || "trial";
  const ready = billing?.mode === "live" || billing?.mode === "test";
  const canStart = ready && (!current?.providerId || current.status === "cancelled");
  return <section id="billing" className="panel settings-form billing-panel" aria-label="AdmitFlow subscription" aria-busy={loading || Boolean(busy)}>
    <PanelHeader title="Your AdmitFlow subscription" description="Platform billing for your institute’s workspace." action={billing && <Badge tone={billing.mode === "live" ? "green" : "amber"}>{billing.mode === "live" ? "Razorpay" : billing.mode === "test" ? "Test billing" : billing.mode === "demo" ? "Demo · no billing" : "Setup required"}</Badge>} />
    <div style={{ padding: "0 23px 24px" }}>
      {!canManage ? <p className="small-copy">An institute owner or administrator can view and manage the subscription.</p> : <>
        {loading && !billing && <div role="status"><div className="skeleton" style={{ height: 70 }} /><p className="field-note">Checking subscription details…</p></div>}
        {error && <p className="inline-error" role="alert">{error}</p>}
        {notice && <p role="status" className="field-note" style={{ color: "var(--color-green)" }}>{notice}</p>}
        {billing && <>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 14, padding: "16px 0 20px" }}>
            <span className="integration-icon"><CreditCard size={20} /></span>
            <div style={{ flex: 1, minWidth: 0 }}><strong style={{ display: "block", overflowWrap: "anywhere" }}>{current?.plan || "Institute workspace"}</strong><small className="muted">{billing.mode === "demo" ? "Sample subscription information" : "AdmitFlow platform plan"}</small></div>
            <Badge tone={current?.status === "active" ? "green" : current?.status === "past_due" ? "amber" : "neutral"}>{statusLabel[status] || status}</Badge>
          </div>
          <p className="small-copy" style={{ lineHeight: 1.75 }}>{billing.message}</p>
          {current?.renewsAt && <p className="field-note">Next billing date: {new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: workspace.timezone || "Asia/Kolkata" }).format(new Date(current.renewsAt))}</p>}
          {billing.mode === "setup" && <p className="field-note">Subscription plans and checkout appear after the platform administrator completes billing setup. No paid price is assumed.</p>}
          {billing.checkoutUrl && <div style={{ marginTop: 18 }}><a className="button primary" href={billing.checkoutUrl}>Continue secure checkout<ArrowUpRight size={15} /></a><p className="field-note">After checkout, return here and refresh. Your plan becomes active only after server verification.</p></div>}
          {canStart && <form onSubmit={event => { event.preventDefault(); void act("subscribe"); }} style={{ padding: 0, marginTop: 22 }}>
            <fieldset disabled={Boolean(busy) || loading} style={{ border: 0, padding: 0, margin: "0 0 16px", display: "grid", gap: 10 }}>
              <legend style={{ padding: "0 0 10px", fontWeight: 600, fontSize: 12 }}>Choose a subscription</legend>
              {billing.plans.map(plan => <label key={plan.id} style={{ display: "flex", alignItems: "start", gap: 11, padding: 14, border: `1px solid ${selected === plan.id ? "var(--color-accent)" : "var(--color-rule)"}`, borderRadius: "var(--radius-sm)", background: selected === plan.id ? "var(--color-accent-soft)" : "var(--color-surface)", cursor: "pointer" }}>
                <input type="radio" name="billing-plan" value={plan.id} checked={selected === plan.id} onChange={() => setSelected(plan.id)} style={{ marginTop: 4, accentColor: "var(--color-accent)" }} />
                <span style={{ display: "grid", gap: 4, minWidth: 0, overflowWrap: "anywhere" }}><strong>{plan.name}</strong><span style={{ fontSize: 13 }}>{planPrice(plan)}</span>{plan.description && <small className="muted">{plan.description}</small>}<small className="muted">{plan.totalCount} billing cycles · amount verified with Razorpay</small><small className="muted">{plan.limits?.members == null ? "Unlimited members" : `${plan.limits.members.toLocaleString("en-IN")} members`} · {plan.limits?.leads == null ? "Unlimited enquiries" : `${plan.limits.leads.toLocaleString("en-IN")} stored enquiries`}</small></span>
              </label>)}
            </fieldset>
            <Button type="submit" variant="primary" loading={busy === "subscribe"} disabled={!selected || Boolean(busy) || loading}>Continue to Razorpay<ArrowUpRight size={15} /></Button>
            <p className="field-note">Review and authorize the recurring payment in Razorpay checkout. This does not create a student fee receipt.</p>
          </form>}
          {billing.canCancel && <div style={{ marginTop: 22, paddingTop: 18, borderTop: "1px solid var(--color-rule)" }}><strong style={{ fontSize: 12 }}>End recurring billing</strong><p className="field-note">Cancellation takes effect immediately. Payments already collected are not refunded.</p><Button variant="danger" loading={busy === "cancel"} disabled={Boolean(busy) || loading} onClick={() => void act("cancel")}>Cancel subscription now</Button></div>}
        </>}
        {entitlements && <CapacitySummary value={entitlements} />}
        <Button variant="ghost" style={{ marginTop: 16 }} loading={loading && Boolean(billing)} disabled={Boolean(busy) || loading} onClick={async () => { setInvoiceRefresh(value => value + 1); await load(); await onUpdated?.(); }}><RefreshCw size={14} />Refresh billing</Button>
        <InvoiceHistory key={`${workspace.id}:${current?.providerId || "none"}`} refreshKey={`${invoiceRefresh}:${current?.status || "trial"}`} timezone={workspace.timezone || "Asia/Kolkata"} />
      </>}
    </div>
  </section>;
}

function CapacitySummary({ value }: { value: BillingEntitlementSnapshot }) {
  const title = useId();
  const resources = [{ key: "members" as const, label: "Members", used: value.usage.members }, { key: "leads" as const, label: "Stored enquiries", used: value.usage.leads }];
  return <section aria-labelledby={title}>
    <header className="panel-header"><div><h3 id={title}>Workspace capacity</h3><p>{value.message}</p></div></header>
    <div className="data-table-wrap"><table className="data-table"><caption className="sr-only">Application quota usage for this institute</caption><thead><tr><th scope="col">Resource</th><th scope="col">Used</th><th scope="col">Plan limit</th></tr></thead><tbody>{resources.map(resource => {
      const limit = value.limits?.[resource.key];
      return <tr key={resource.key}><th scope="row">{resource.label}</th><td>{resource.used.toLocaleString("en-IN")}</td><td>{limit === undefined ? "Unavailable" : limit === null ? "Unlimited · no limit configured" : <>{limit.toLocaleString("en-IN")}{resource.used > limit && <> <Badge tone="amber">Over limit</Badge></>}</>}</td></tr>;
    })}</tbody></table></div>
    <p className="field-note">Active members, pending invitations and reserved sends count toward seats.{value.usage.reservedMembers > 0 && ` ${value.usage.reservedMembers} seat(s) are reserved while provider confirmation is pending.`} All stored enquiries count, including admitted and lost enquiries.</p>
    <p className="field-note">These guards cover app invitations/reactivations and manual/CSV additions. External WorkOS changes and inbound provider enquiries can exceed the limits; those records still count toward usage.</p>
  </section>;
}

function InvoiceHistory({ refreshKey, timezone }: { refreshKey: string; timezone: string }) {
  const title = useId();
  const [page, setPage] = useState(1), [reload, setReload] = useState(0), [data, setData] = useState<BillingInvoicePage | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    void fetch(`/api/billing/invoices?page=${page}`, { cache: "no-store", signal: controller.signal }).then(async response => {
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Your subscription invoices could not be loaded.");
      if (!controller.signal.aborted) setData(result as BillingInvoicePage);
    }).catch(cause => { if (!controller.signal.aborted) { setData(null); setError(cause instanceof Error ? cause.message : "Your subscription invoices could not be loaded."); } }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [page, reload, refreshKey]);
  const date = (value: string) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: timezone }).format(new Date(value));
  const invoiceStatus: Record<string, string> = { draft: "Draft", issued: "Issued", partially_paid: "Partially paid", paid: "Paid", expired: "Expired", cancelled: "Cancelled", deleted: "Deleted" };
  return <section aria-labelledby={title} aria-busy={loading}>
    <header className="panel-header"><div><h3 id={title}>Subscription invoices</h3><p>Razorpay invoices for the currently linked AdmitFlow subscription.</p></div><Button variant="ghost" disabled={loading} onClick={() => setReload(value => value + 1)}><RefreshCw size={14} />Refresh invoices</Button></header>
    {error && <p role="alert" className="inline-error">{error}</p>}
    {loading && <p role="status" className="field-note">Loading verified invoices…</p>}
    {!loading && data && <>
      {(data.mode === "test" || data.mode === "demo" || data.mode === "setup") && <Badge tone="amber">{data.mode === "test" ? "Razorpay test invoices" : data.mode === "demo" ? "Demo · no invoices" : "Invoice setup required"}</Badge>}
      {data.invoices.length ? <div className="data-table-wrap"><table className="data-table"><caption className="sr-only">Verified subscription invoice history, page {data.page}</caption><thead><tr><th scope="col">Invoice</th><th scope="col">Date</th><th scope="col">Total</th><th scope="col">Paid</th><th scope="col">Due</th><th scope="col">Status</th><th scope="col">Hosted invoice</th></tr></thead><tbody>{data.invoices.map(invoice => <tr key={invoice.id}>
        <th scope="row">{invoice.number || invoice.id}</th>
        <td><time dateTime={invoice.issuedAt || invoice.createdAt}>{date(invoice.issuedAt || invoice.createdAt)}</time><p className="small-copy">{invoice.issuedAt ? "Issued" : "Created"}</p></td>
        <td>{billingMoney(invoice.total, invoice.currency)}</td><td>{billingMoney(invoice.paid, invoice.currency)}{invoice.paidAt && <p className="small-copy">Paid <time dateTime={invoice.paidAt}>{date(invoice.paidAt)}</time></p>}</td><td>{billingMoney(invoice.due, invoice.currency)}</td>
        <td><Badge tone={invoice.status === "paid" ? "green" : invoice.status === "partially_paid" ? "amber" : "neutral"}>{invoiceStatus[invoice.status] || invoice.status}</Badge></td>
        <td>{invoice.hostedUrl ? <a className="table-text-action" href={invoice.hostedUrl} target="_blank" rel="noopener noreferrer" aria-label={`View invoice ${invoice.number || invoice.id} on Razorpay (opens in a new tab)`}>View invoice<ArrowUpRight size={14} /></a> : <span className="muted">Link unavailable</span>}</td>
      </tr>)}</tbody></table></div> : <p role="status" className="field-note">{data.message}</p>}
      {(data.hasMore || page > 1) && <nav aria-label="Invoice pages"><Button disabled={page <= 1} onClick={() => setPage(value => value - 1)}>Previous invoices</Button><span className="small-copy"> Page {data.page} </span><Button disabled={!data.hasMore || page >= 10000} onClick={() => setPage(value => value + 1)}>Next invoices</Button></nav>}
      <p className="field-note">Hosted links open Razorpay in a new tab. Reading an invoice does not collect a payment or record a student fee receipt.</p>
    </>}
  </section>;
}
