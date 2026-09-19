"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { Illustration } from "./illustration";
import { ThemeSelect } from "./appearance";
import { ArrowRight, Building2, Check, Layers3, LogOut, Plus, RefreshCw, ShieldCheck } from "lucide-react";
import { Badge, Brand, Button, Field, PanelHeader } from "./ui";

interface Organization { id: string; name: string; role?: string }
interface OrganizationList { organizations: Organization[]; current?: string; name?: string }

export function Onboarding({ configured = true }: { configured?: boolean }) {
  const [data, setData] = useState<OrganizationList | null>(null), [loading, setLoading] = useState(configured);
  const [error, setError] = useState(""), [needsSignIn, setNeedsSignIn] = useState(false);
  const [creating, setCreating] = useState(false), [selected, setSelected] = useState("");
  const [name, setName] = useState(""), [saving, setSaving] = useState(false);
  const submitting = useRef(false);
  const load = useCallback(async (signal?: AbortSignal) => {
    if (!configured) return;
    setLoading(true); setError(""); setNeedsSignIn(false);
    try {
      const response = await fetch("/api/organizations", { cache: "no-store", signal });
      const result = await response.json();
      if (!response.ok) { setNeedsSignIn(response.status === 401); throw new Error(result.error || "Your institutes could not be loaded."); }
      const list = result as OrganizationList;
      if (signal?.aborted) return;
      setData(list); setSelected(list.current || list.organizations[0]?.id || ""); setCreating(!list.organizations.length);
    } catch (cause) { if (!signal?.aborted) setError(cause instanceof Error ? cause.message : "Your institutes could not be loaded."); }
    finally { if (!signal?.aborted) setLoading(false); }
  }, [configured]);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load]);

  async function enter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true; setSaving(true); setError("");
    try {
      const response = await fetch("/api/organizations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(creating ? { type: "create", name: name.trim() } : { organizationId: selected }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Your institute could not be opened. Please retry.");
      // Reload the root provider after the organization cookie changes; never reuse another institute's query cache.
      window.location.assign("/");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Your institute could not be opened.");
      submitting.current = false; setSaving(false);
    }
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
              {creating ? <Field label="Institute name" name="institute" value={name} onChange={event => setName(event.target.value)} autoComplete="organization" placeholder="e.g. Northstar Academy" minLength={2} maxLength={100} required disabled={saving} hint="You can update this later in institute settings." /> : <fieldset style={{ border: 0, padding: 0, margin: "0 0 20px", display: "grid", gap: 10 }} disabled={saving}>
                <legend className="sr-only">Available institutes</legend>
                {data.organizations.map(organization => <label key={organization.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: 14, border: `1px solid ${selected === organization.id ? "var(--color-accent)" : "var(--color-rule)"}`, background: selected === organization.id ? "var(--color-accent-soft)" : "var(--color-surface)", borderRadius: "var(--radius-sm)", cursor: saving ? "wait" : "pointer" }}>
                  <input type="radio" name="organization" value={organization.id} checked={selected === organization.id} onChange={() => setSelected(organization.id)} style={{ accentColor: "var(--color-accent)" }} />
                  <span style={{ minWidth: 0, flex: 1 }}><strong style={{ display: "block", overflowWrap: "anywhere" }}>{organization.name}</strong><small className="muted" style={{ textTransform: "capitalize" }}>{organization.role || "Member"}{organization.id === data.current ? " · Current institute" : ""}</small></span>
                  {selected === organization.id && <Check size={16} style={{ color: "var(--color-accent)" }} aria-hidden="true" />}
                </label>)}
              </fieldset>}
              <Button type="submit" variant="primary" className="full-width" loading={saving} disabled={creating ? name.trim().length < 2 : !selected}>{creating ? "Create institute" : "Open institute"}<ArrowRight size={16} /></Button>
              {!!data.organizations.length && <Button className="full-width" variant="ghost" style={{ marginTop: 12 }} disabled={saving} onClick={() => { setCreating(value => !value); setError(""); }}>{creating ? <Building2 size={15} /> : <Plus size={15} />}{creating ? "Choose an existing institute" : "Create another institute"}</Button>}
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
