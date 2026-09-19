"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { Illustration } from "./illustration";
import { ThemeSelect } from "./appearance";
import { ArrowRight, Building2, Check, Layers3, LogOut, Plus, RefreshCw, ShieldCheck } from "lucide-react";
import { Badge, Brand, Button, Field, PanelHeader } from "./ui";
import type { ProvisioningStatus } from "@/lib/provisioning-types";

interface Organization { id: string; name: string; role?: string }
interface OrganizationList { organizations: Organization[]; current?: string; name?: string; scope: string; provisioning: ProvisioningStatus | null }
interface CreateIntent { requestId: string; name: string }
const intentKey = (scope: string) => `admitflow:institute-setup:${scope}`;
function savedIntent(scope: string): CreateIntent | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(intentKey(scope)) || "null");
    return value && typeof value.requestId === "string" && /^[0-9a-f-]{36}$/i.test(value.requestId) && typeof value.name === "string" ? value : null;
  } catch { return null; }
}

export function Onboarding({ configured = true }: { configured?: boolean }) {
  const [data, setData] = useState<OrganizationList | null>(null), [loading, setLoading] = useState(configured);
  const [error, setError] = useState(""), [needsSignIn, setNeedsSignIn] = useState(false);
  const [creating, setCreating] = useState(false), [selected, setSelected] = useState("");
  const [name, setName] = useState(""), [saving, setSaving] = useState(false);
  const submitting = useRef(false);
  const [intent, setIntent] = useState<CreateIntent | null>(null);
  const [provisioning, setProvisioning] = useState<ProvisioningStatus | null>(null);
  const load = useCallback(async (signal?: AbortSignal) => {
    if (!configured) return;
    setLoading(true); setError(""); setNeedsSignIn(false);
    try {
      const response = await fetch("/api/organizations", { cache: "no-store", signal });
      const result = await response.json();
      if (!response.ok) { setNeedsSignIn(response.status === 401); throw new Error(result.error || "Your institutes could not be loaded."); }
      const list = result as OrganizationList;
      if (signal?.aborted) return;
      const stored = list.provisioning ? { requestId: list.provisioning.requestId, name: list.provisioning.name } : savedIntent(list.scope);
      setIntent(stored); setName(stored?.name || ""); setProvisioning(list.provisioning);
      setData(list); setSelected(list.current || list.organizations[0]?.id || ""); setCreating(!list.organizations.length || Boolean(stored));
    } catch (cause) { if (!signal?.aborted) setError(cause instanceof Error ? cause.message : "Your institutes could not be loaded."); }
    finally { if (!signal?.aborted) setLoading(false); }
  }, [configured]);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load]);

  async function submit(action: Record<string, unknown>) {
    if (submitting.current || !data) return;
    submitting.current = true; setSaving(true); setError("");
    try {
      if (action.type === "create") {
        const stable = intent || { requestId: crypto.randomUUID(), name: name.trim() };
        // Persist before transmission; a lost response or reload must retain exactly this intent.
        sessionStorage.setItem(intentKey(data.scope), JSON.stringify(stable));
        setIntent(stable); action = { type: "create", ...stable };
      }
      const response = await fetch("/api/organizations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(action) });
      const result = await response.json();
      if (result.provisioning) {
        const status = result.provisioning as ProvisioningStatus;
        setProvisioning(status.acknowledged ? null : status);
        if (status.acknowledged) {
          sessionStorage.removeItem(intentKey(data.scope)); setIntent(null); setName(""); await load();
        } else {
          const stable = { requestId: status.requestId, name: status.name };
          setIntent(stable); setName(stable.name); sessionStorage.setItem(intentKey(data.scope), JSON.stringify(stable));
        }
      }
      if (!response.ok) {
        setNeedsSignIn(response.status === 401);
        if (result.code === "PROVISIONING_PENDING") await load();
        throw new Error(result.error || "Your institute could not be opened. Please retry.");
      }
      // Only a successful session switch navigates; 202 or a ready receipt is not session activation.
      if (result.id) window.location.assign("/");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Your institute could not be opened."); }
    finally { submitting.current = false; setSaving(false); }
  }
  async function enter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await submit(creating ? provisioning ? { type: provisioning.state === "ready" ? "open" : "continue", id: provisioning.id } : { type: "create" } : { type: "switch", organizationId: selected });
  }

  return <div style={{ minHeight: "100dvh", display: "flex", flexDirection: "column" }}>
    <a href="#onboarding-content" className="skip-link">Skip to institute setup</a>
    <header style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 16, padding: "24px clamp(20px, 5vw, 72px)", borderBottom: "1px solid var(--color-rule)" }}>
      <Link href="/welcome" aria-label="AdmitFlow home"><Brand /></Link><ThemeSelect />
      {configured ? <a href="/logout" className="button ghost"><LogOut size={15} />Sign out</a> : <Badge>Local preview</Badge>}
    </header>
    <main id="onboarding-content" style={{ width: "min(1060px, 100%)", margin: "auto", padding: "clamp(32px, 7vw, 88px) 24px", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 340px), 1fr))", gap: "clamp(32px, 7vw, 84px)", alignItems: "start" }}>
      <section aria-labelledby="onboarding-title">
        <div className="page-eyebrow" style={{ color: "var(--color-accent)", fontSize: 11, letterSpacing: ".09em", marginBottom: 22 }}>A SHARED START. A CLEAR NEXT STEP.</div>
        <h1 id="onboarding-title" style={{ fontSize: "clamp(30px, 4vw, 46px)", maxWidth: "14ch", lineHeight: 1.12 }}>{data?.name ? `Welcome, ${data.name}.` : "Good to have you here."}<br /><span style={{ color: "var(--color-muted)" }}>Let’s find your institute.</span></h1>
        <p style={{ marginTop: 22, maxWidth: "43ch", fontSize: 15, lineHeight: 1.8 }}>One place for your admissions team, student conversations and every next step.</p>
        <Illustration name="next-chapter-campus" className="onboarding-art" eager /><div className="quick-guide" style={{ marginTop: 36 }}>
          <div><b><Building2 size={15} /></b><span><strong>Your institute, together</strong><p>Open a workspace you belong to, or create one for your own team.</p></span></div>
          <div><b><Layers3 size={15} /></b><span><strong>Room for every enquiry</strong><p>Connect your tools and bring your admissions workflow into one shared view.</p></span></div>
          <div><b><ShieldCheck size={15} /></b><span><strong>The right access for each person</strong><p>Membership and roles stay specific to the institute you choose.</p></span></div>
        </div>
      </section>

      <section className="panel settings-form" aria-label="Choose or create an institute" aria-busy={loading || saving}>
        {!configured ? <>
          <PanelHeader title="You’re in the local preview" description="Hosted institute setup becomes available when WorkOS and the production database are configured." />
          <div style={{ padding: "8px 24px 24px" }}><p className="small-copy">Your local workspace is available in Settings. An administrator can configure hosted sign-in when your team is ready.</p><Link href="/settings" className="button primary full-width" style={{ marginTop: 22 }}>Open workspace settings<ArrowRight size={15} /></Link></div>
        </> : <>
          <PanelHeader title={loading ? "Finding your institutes…" : creating ? "A workspace of your own" : "Choose your institute"} description={creating ? "Start with the name your team knows." : "Only institutes with an active membership appear here."} />
          {loading ? <div role="status" style={{ padding: "8px 24px 28px" }}><div className="skeleton" style={{ height: 68, marginBottom: 12 }} /><div className="skeleton" style={{ height: 68 }} /><span className="sr-only">Loading your institutes</span></div> : <>
            {error && <div className="inline-error" role="alert" style={{ margin: "0 24px 20px" }}>{error}</div>}
            {data && !needsSignIn && <form onSubmit={enter}>
              {creating && provisioning && <div role="status" style={{ marginBottom: 20 }}><strong>{provisioning.name}</strong><p className="small-copy">{provisioning.message}</p><p className="field-note">Setup reference: {provisioning.id}</p></div>}
              {creating ? <Field label="Institute name" name="institute" value={name} onChange={event => setName(event.target.value)} autoComplete="organization" placeholder="e.g. Northstar Academy" minLength={2} maxLength={100} required disabled={saving || Boolean(intent)} hint={intent ? "This request keeps its original name until setup is acknowledged." : "You can update this later in institute settings."} /> : <fieldset style={{ border: 0, padding: 0, margin: "0 0 20px", display: "grid", gap: 10 }} disabled={saving}>
                <legend className="sr-only">Available institutes</legend>
                {data.organizations.map(organization => <label key={organization.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: 14, border: `1px solid ${selected === organization.id ? "var(--color-accent)" : "var(--color-rule)"}`, background: selected === organization.id ? "var(--color-accent-soft)" : "var(--color-surface)", borderRadius: "var(--radius-sm)", cursor: saving ? "wait" : "pointer" }}>
                  <input type="radio" name="organization" value={organization.id} checked={selected === organization.id} onChange={() => setSelected(organization.id)} style={{ accentColor: "var(--color-accent)" }} />
                  <span style={{ minWidth: 0, flex: 1 }}><strong style={{ display: "block", overflowWrap: "anywhere" }}>{organization.name}</strong><small className="muted" style={{ textTransform: "capitalize" }}>{organization.role || "Member"}{organization.id === data.current ? " · Current institute" : ""}</small></span>
                  {selected === organization.id && <Check size={16} style={{ color: "var(--color-accent)" }} aria-hidden="true" />}
                </label>)}
              </fieldset>}
              <Button type="submit" variant="primary" className="full-width" loading={saving} disabled={creating ? name.trim().length < 2 || provisioning?.state === "review_required" : !selected}>{!creating || provisioning?.state === "ready" ? "Open institute" : provisioning?.state === "continue" ? "Continue setup" : provisioning || intent ? "Check setup status" : "Create institute"}<ArrowRight size={16} /></Button>
              {creating && provisioning?.state === "ready" && <Button className="full-width" variant="ghost" style={{ marginTop: 12 }} disabled={saving} onClick={() => void submit({ type: "acknowledge", id: provisioning.id })}>Acknowledge setup — allow another institute</Button>}
              {!!data.organizations.length && <Button className="full-width" variant="ghost" style={{ marginTop: 12 }} disabled={saving} onClick={() => { setCreating(value => !value); setError(""); }}>{creating ? <Building2 size={15} /> : <Plus size={15} />}{creating ? "Choose an existing institute" : provisioning || intent ? "Resume institute setup" : "Create another institute"}</Button>}
            </form>}
            <div style={{ padding: "0 24px 24px" }}>
              {needsSignIn ? <Link href="/login" className="button primary full-width">Sign in to continue<ArrowRight size={15} /></Link> : <>
                <p className="field-note" style={{ margin: "0 0 8px" }}>Expecting an invitation? Accept the link in your WorkOS invitation email, then refresh this list.</p>
                <Button variant="ghost" disabled={saving} onClick={() => void load()}><RefreshCw size={14} />Refresh institutes</Button>
              </>}
            </div>
          </>}
        </>}
      </section>
    </main>
    <footer className="small-copy muted" style={{ padding: "20px 24px 28px", textAlign: "center" }}>Every enquiry deserves a thoughtful next step.</footer>
  </div>;
}
