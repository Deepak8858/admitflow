"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { Illustration } from "./illustration";
import { ThemeSelect } from "./appearance";
import { ArrowRight, Building2, Check, LogOut, Plus, RefreshCw } from "lucide-react";
import { Badge, Brand, Button, Field } from "./ui";
import type { ProvisioningStatus } from "@/lib/provisioning-types";
import { readJsonBody } from "@/lib/client-response";
import { signOutAction } from "@/app/auth/actions";

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
function initials(value: string) {
  return value.trim().split(/\s+/).slice(0, 2).map(part => part[0]?.toLocaleUpperCase() || "").join("") || "AF";
}
function setupCopy(state: ProvisioningStatus["state"]) {
  if (state === "ready") return { title: "Your institute is ready", body: "Open it to finish signing in and enter your workspace." };
  if (state === "continue") return { title: "One more setup step", body: "Your institute is confirmed. Continue to finish setting up your access." };
  if (state === "review_required") return { title: "This setup needs a review", body: "We could not confirm the setup details. Contact support with the reference below and keep this request while it is reviewed." };
  return { title: "We’re checking your institute", body: "Check again here for progress. Your original institute name is held for this request." };
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
      setNeedsSignIn(response.status === 401);
      const result = await readJsonBody<OrganizationList & { error?: string }>(response, "Your institutes could not be loaded.");
      if (!response.ok) { setNeedsSignIn(response.status === 401); throw new Error(result.error || "Your institutes could not be loaded."); }
      const list = result as OrganizationList;
      if (signal?.aborted) return;
      const stored = list.provisioning ? { requestId: list.provisioning.requestId, name: list.provisioning.name } : savedIntent(list.scope);
      setIntent(stored); setName(stored?.name || ""); setProvisioning(list.provisioning);
      setData(list); setSelected(list.current || list.organizations[0]?.id || ""); setCreating(!list.organizations.length || Boolean(stored));
    } catch (cause) {
      if (!signal?.aborted) {
        setData(null);
        setError(cause instanceof TypeError ? "We couldn’t reach your institutes. Check your connection and try again." : cause instanceof Error ? cause.message : "Your institutes could not be loaded.");
      }
    } finally { if (!signal?.aborted) setLoading(false); }
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
      setNeedsSignIn(response.status === 401);
      const result = await readJsonBody<{ id?: string; provisioning?: ProvisioningStatus; error?: string; code?: string }>(response, "Your institute could not be opened. Please retry.");
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
      if (response.status === 200 && result.id) window.location.assign("/overview");
    } catch (cause) {
      setError(cause instanceof TypeError ? "We couldn’t confirm this request. Check your connection and retry to recover its status." : cause instanceof Error ? cause.message : "Your institute could not be opened.");
    }
    finally { submitting.current = false; setSaving(false); }
  }
  async function enter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await submit(creating ? provisioning ? { type: provisioning.state === "ready" ? "open" : "continue", id: provisioning.id } : { type: "create" } : { type: "switch", organizationId: selected });
  }

  const accountComplete = Boolean(configured && data && !needsSignIn);
  const chosen = data?.organizations.find(organization => organization.id === selected);
  const instituteComplete = accountComplete && (creating ? provisioning?.state === "ready" : Boolean(chosen));
  const previewName = creating ? name.trim() : chosen?.name || "";
  const visibleName = previewName || "Your institute";
  const statusCopy = provisioning ? setupCopy(provisioning.state) : null;
  const primaryLabel = !creating || provisioning?.state === "ready" ? "Open institute"
    : provisioning?.state === "continue" ? "Continue setup"
    : provisioning?.state === "review_required" ? "Setup needs review"
    : provisioning || intent ? "Check setup status" : "Create institute";

  return <div className="institute-onboarding">
    <a href="#onboarding-content" className="skip-link">Skip to institute setup</a>
    <header className="institute-onboarding-header">
      <Link href="/" aria-label="AdmitFlow home"><Brand /></Link>
      <div className="institute-onboarding-header-actions">
        <ThemeSelect />
        {configured ? !needsSignIn && <form action={signOutAction}><Button type="submit" variant="ghost"><LogOut size={15} />Sign out</Button></form> : <Badge>Local preview</Badge>}
      </div>
    </header>

    <div className="institute-onboarding-shell">
      <ol className="institute-onboarding-steps" aria-label="Setup progress">
        <li className={accountComplete ? "complete" : "active"} aria-current={!accountComplete ? "step" : undefined}><span className="step-mark">{accountComplete ? <Check size={13} aria-hidden="true" /> : "01"}</span><span>Account</span></li>
        <li className={instituteComplete ? "complete" : accountComplete ? "active" : ""} aria-current={accountComplete && !instituteComplete ? "step" : undefined}><span className="step-mark">{instituteComplete ? <Check size={13} aria-hidden="true" /> : "02"}</span><span>Institute</span></li>
        <li className={instituteComplete ? "active" : ""} aria-current={instituteComplete ? "step" : undefined}><span className="step-mark">03</span><span>Workspace</span></li>
      </ol>

      <main id="onboarding-content" className="institute-onboarding-main">
        <section className="institute-onboarding-form-side" aria-labelledby="onboarding-title">
          <span className="institute-onboarding-eyebrow">YOUR ADMISSIONS WORKSPACE</span>
          <h1 id="onboarding-title">{!configured ? "Good to have you here." : data ? creating ? "Give your institute a home." : "Pick up where your team works." : "Bring your team together."}</h1>
          <p className="institute-onboarding-intro">{data?.name ? `Welcome, ${data.name}. ` : ""}Keep student conversations, applications and your team’s next steps in one place.</p>

          <div className="institute-onboarding-card" aria-busy={loading || saving}>
            {!configured ? <>
              <div className="institute-onboarding-card-heading">
                <h2>You’re in the local preview</h2>
                <p>Institute setup is unavailable here until your administrator connects hosted sign-in and the database.</p>
              </div>
              <p className="institute-onboarding-local-copy">Your local workspace is available in Settings.</p>
              <Link href="/settings" className="button primary institute-onboarding-primary">Open workspace settings <ArrowRight size={16} /></Link>
            </> : <>
              <div className="institute-onboarding-card-heading">
                <h2>{loading ? "Finding your institutes…" : needsSignIn ? "Sign in to continue" : !data ? "We couldn’t load your institutes" : creating ? "Name your institute" : "Choose an institute"}</h2>
                <p>{needsSignIn ? "Sign in to see your institutes." : !data && !loading ? "Try again to return to setup." : creating ? "Use the name your admissions team knows." : "Choose where you want to work today."}</p>
              </div>

              {loading ? <div role="status" className="institute-onboarding-loading"><div className="skeleton" /><div className="skeleton" /><span className="sr-only">Loading your institutes</span></div> : <>
                {error && <div className="inline-error institute-onboarding-error" role="alert">{error}</div>}
                {needsSignIn ? <Link href="/login" className="button primary institute-onboarding-primary">Sign in to continue <ArrowRight size={16} /></Link> : data ? <>
                  {!!data.organizations.length && <div className="institute-onboarding-choice" role="group" aria-label="Choose setup path">
                    <Button className={creating ? "" : "selected"} variant="ghost" aria-pressed={!creating} disabled={saving} onClick={() => { setCreating(false); setError(""); }}><Building2 size={16} />Existing institute</Button>
                    <Button className={creating ? "selected" : ""} variant="ghost" aria-pressed={creating} disabled={saving} onClick={() => { setCreating(true); setError(""); }}><Plus size={16} />Create new</Button>
                  </div>}

                  <form onSubmit={enter}>
                    {creating ? <>
                      <Field label="Institute name" name="institute" value={name} onChange={event => setName(event.target.value)} autoComplete="organization" placeholder="e.g. Northstar Academy" minLength={2} maxLength={100} required disabled={saving || Boolean(intent)} hint={intent ? "This name belongs to the current setup request and can’t be changed here." : "You can update this later in institute settings."} />
                      {statusCopy && <div className={`institute-onboarding-status ${provisioning?.state}`} role="status" aria-live="polite">
                        <div className="institute-onboarding-status-mark">{provisioning?.state === "ready" ? <Check size={16} /> : <RefreshCw size={16} />}</div>
                        <div><strong>{statusCopy.title}</strong><p>{statusCopy.body}</p><details><summary>Details for support</summary><p>{provisioning?.message}</p><span>Setup reference: <code>{provisioning?.id}</code></span></details></div>
                      </div>}
                      {!provisioning && intent && <div className="institute-onboarding-status pending" role="status">
                        <div className="institute-onboarding-status-mark"><RefreshCw size={16} /></div>
                        <div><strong>We’re checking this request</strong><p>Check setup status to recover progress. Your original institute name is held for this request.</p></div>
                      </div>}
                    </> : <fieldset className="institute-onboarding-list" disabled={saving}>
                      <legend className="sr-only">Available institutes</legend>
                      {data.organizations.map(organization => <label key={organization.id} className={`institute-onboarding-option ${selected === organization.id ? "selected" : ""}`}>
                        <input type="radio" name="organization" value={organization.id} checked={selected === organization.id} onChange={() => setSelected(organization.id)} />
                        <span className="institute-onboarding-option-avatar" aria-hidden="true">{initials(organization.name)}</span>
                        <span className="institute-onboarding-option-copy"><strong>{organization.name}</strong>{organization.id === data.current && <small>Current institute</small>}</span>
                        {selected === organization.id && <Check size={17} className="institute-onboarding-option-check" aria-hidden="true" />}
                      </label>)}
                    </fieldset>}
                    <Button type="submit" variant="primary" className="institute-onboarding-primary" loading={saving} disabled={creating ? name.trim().length < 2 || provisioning?.state === "review_required" : !selected}>{primaryLabel}<ArrowRight size={16} /></Button>
                    {creating && provisioning?.state === "ready" && <div className="institute-onboarding-acknowledge"><p>Need to set up another institute? Mark this setup complete first.</p><Button variant="ghost" disabled={saving} onClick={() => void submit({ type: "acknowledge", id: provisioning.id })}>Mark setup complete</Button></div>}
                  </form>
                </> : <Button variant="secondary" className="institute-onboarding-primary" onClick={() => void load()}><RefreshCw size={16} />Try again</Button>}
              </>}
            </>}
          </div>

          {configured && data && !needsSignIn && <div className="institute-onboarding-invites">
            <p>Expecting an invitation? Open the link in your invitation email, then refresh this list.</p>
            <Button variant="ghost" disabled={loading || saving} onClick={() => void load()}><RefreshCw size={15} />Refresh institutes</Button>
          </div>}
        </section>

        <aside className="institute-onboarding-preview" aria-label="Workspace preview">
          <div className="institute-onboarding-preview-topline"><span>YOUR SPACE, TAKING SHAPE</span><span>PREVIEW</span></div>
          <div className="institute-onboarding-art"><Illustration name="next-chapter-campus" decorative eager sizes="(max-width: 760px) 100vw, 48vw" /></div>
          <div className="institute-onboarding-window">
            <div className="institute-onboarding-window-header"><span className="institute-onboarding-window-dots" aria-hidden="true"><i /><i /><i /></span><span>AdmitFlow</span></div>
            <div className="institute-onboarding-window-content">
              <div className="institute-onboarding-window-rail" aria-hidden="true"><span className="institute-onboarding-window-rail-mark">A</span><i /><i /><i /></div>
              <div className="institute-onboarding-window-body">
                <div className="institute-onboarding-window-name"><span className="institute-onboarding-preview-avatar" aria-hidden="true">{initials(previewName)}</span><div><small>INSTITUTE WORKSPACE</small><strong>{visibleName}</strong></div></div>
                <div className="institute-onboarding-empty"><span aria-hidden="true"><Building2 size={24} /></span><strong>A place for every next step</strong><p>Your team’s work will come together here.</p></div>
              </div>
            </div>
          </div>
          <p className="institute-onboarding-preview-caption">{previewName ? `A shared space for ${previewName}.` : "Your institute’s name will appear here as you type."}</p>
        </aside>
      </main>
    </div>
    <footer className="institute-onboarding-footer">Every enquiry deserves a thoughtful next step.</footer>
  </div>;
}
