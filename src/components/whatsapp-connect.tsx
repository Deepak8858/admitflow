"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MessageSquare, Smartphone, ArrowUpRight, Link2, RefreshCw, ShieldCheck } from "lucide-react";
import { useData, workspaceAccess, useWhatsAppTemplates, templateBody, templateIssue } from "./provider";
import { Badge, Button, Dialog, EmptyState, Field, SelectField } from "./ui";
import { readJsonResponse } from "@/lib/client-response";

declare global {
  interface Window {
    FB?: {
      init: (options: Record<string, unknown>) => void;
      login: (callback: (response: { authResponse?: { code?: string } }) => void, options: Record<string, unknown>) => void;
    };
  }
}

export function WhatsAppConnect({ onClose }: { onClose: () => void }) {
  const { data, refresh, setData, notify } = useData();
  const options = useWhatsAppTemplates(), connection = options.connection;
  const hosted = data.actor?.backend === "workos" && !data.demo;
  const metaAppId = data.integrations?.metaAppId, metaConfigId = data.integrations?.metaConfigId;
  const metaConfigured = Boolean(metaAppId && metaConfigId);
  const operation = useQuery({
    queryKey: ["whatsapp-operation", data.id, connection?.updatedAt], enabled: hosted && workspaceAccess(data).admin && Boolean(connection), retry: false,
    queryFn: async ({ signal }) => {
      const response = await fetch("/api/connections?type=whatsapp.status", { cache: "no-store", signal });
      const result = await readJsonResponse<{ operation: null | { reconciliation: string; dispatchedAt: string | null; confirmedAt: string | null; observedAt: string | null; appId: string } }>(response, "Subscription history could not be loaded.");
      return result.operation as null | { reconciliation: string; dispatchedAt: string | null; confirmedAt: string | null; observedAt: string | null; appId: string };
    },
  });
  const [coexistence, setCoexistence] = useState(!connection || ["requested", "verified"].includes(connection.metadata.coexistence)), [busy, setBusy] = useState(false), [selectedTemplate, setSelectedTemplate] = useState("");
  const code = useRef(""), account = useRef<{ wabaId: string; phoneNumberId: string } | null>(null), submitted = useRef(false), signupTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const signupAttempt = useRef(0), mounted = useRef(true);
  const clearTimer = useCallback(() => { if (signupTimer.current) clearTimeout(signupTimer.current); signupTimer.current = null; }, []);
  const complete = useCallback(async () => {
    if (!code.current || !account.current || submitted.current) return;
    submitted.current = true; setBusy(true); clearTimer();
    try {
      const response = await fetch("/api/connections", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "whatsapp.exchange", code: code.current, ...account.current, coexistence }) });
      const result = await readJsonResponse<{ workspace?: typeof data; whatsapp?: { connected: boolean; message: string } }>(response, "WhatsApp setup could not be completed. Restart Meta signup.");
      if (result.workspace) setData(result.workspace); else await refresh();
      notify(result.whatsapp?.message || "WhatsApp setup status updated.");
      if (result.whatsapp?.connected && mounted.current) onClose();
    } catch (error) {
      code.current = ""; account.current = null; submitted.current = false;
      notify(error instanceof Error ? error.message : "WhatsApp setup could not be completed. Restart Meta signup.", "error");
      try { await refresh(); } catch { /* The exchange error above is the actionable result. */ }
    } finally { setBusy(false); }
  }, [coexistence, clearTimer, notify, onClose, refresh, setData]);
  useEffect(() => {
    function receive(event: MessageEvent) {
      if (!["https://www.facebook.com", "https://web.facebook.com"].includes(event.origin)) return;
      let message;
      try { message = typeof event.data === "string" ? JSON.parse(event.data) : event.data; } catch { return; }
      if (message?.type !== "WA_EMBEDDED_SIGNUP") return;
      if (["FINISH", "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING"].includes(message.event)
        && typeof message.data?.waba_id === "string" && /^\d{1,80}$/.test(message.data.waba_id)
        && typeof message.data?.phone_number_id === "string" && /^\d{1,80}$/.test(message.data.phone_number_id)) {
        account.current = { wabaId: message.data.waba_id, phoneNumberId: message.data.phone_number_id };
        void complete();
      } else if ((message.event === "CANCEL" || message.event === "ERROR") && !submitted.current) {
        signupAttempt.current++; clearTimer(); code.current = ""; account.current = null; setBusy(false);
        notify(message.event === "CANCEL" ? "Meta signup cancelled. Restart when you’re ready." : "Meta signup could not be completed. Please restart setup.", message.event === "ERROR" ? "error" : "info");
      }
    }
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [complete, clearTimer, notify]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; signupAttempt.current++; clearTimer(); }; }, [clearTimer]);
  useEffect(() => {
    const preferred = options.templates.find(template => template.name === connection?.metadata.templateName && template.language === connection?.metadata.templateLanguage);
    if (preferred) setSelectedTemplate(`${preferred.name}:${preferred.language}`);
  }, [connection?.metadata.templateName, connection?.metadata.templateLanguage, options.templates]);

  async function connect() {
    if (busy || !hosted || !workspaceAccess(data).admin || !metaAppId || !metaConfigId) return;
    const attempt = ++signupAttempt.current;
    setBusy(true); submitted.current = false; code.current = ""; account.current = null; clearTimer();
    try {
      if (!window.FB) await new Promise<void>((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "https://connect.facebook.net/en_US/sdk.js"; script.async = true;
        const timeout = setTimeout(() => { script.remove(); reject(new Error("Meta sign-in took too long to load. Please retry.")); }, 20000);
        script.onload = () => { clearTimeout(timeout); resolve(); };
        script.onerror = () => { clearTimeout(timeout); script.remove(); reject(new Error("Meta sign-in could not load.")); };
        document.head.append(script);
      });
      if (attempt !== signupAttempt.current || !mounted.current) return;
      if (!window.FB) throw new Error("Meta sign-in is unavailable. Please reload and retry.");
      window.FB.init({ appId: metaAppId, version: data.integrations?.metaVersion || "v23.0", cookie: true, xfbml: false });
      signupTimer.current = setTimeout(() => { if (attempt !== signupAttempt.current || submitted.current) return; signupAttempt.current++; code.current = ""; account.current = null; setBusy(false); notify("Meta did not return the complete signup result. Restart setup to continue.", "error"); }, 120000);
      window.FB.login(response => {
        if (attempt !== signupAttempt.current || !mounted.current || submitted.current) return;
        if (response.authResponse?.code) { code.current = response.authResponse.code; void complete(); }
        else { signupAttempt.current++; clearTimer(); setBusy(false); notify("Meta signup cancelled. You can restart setup."); }
      }, { config_id: metaConfigId, response_type: "code", override_default_response_type: true, extras: { setup: {}, sessionInfoVersion: "3", ...(coexistence ? { featureType: "whatsapp_business_app_onboarding" } : {}) } });
    } catch (error) { if (attempt === signupAttempt.current && mounted.current) { clearTimer(); notify(error instanceof Error ? error.message : "Meta sign-in could not start.", "error"); setBusy(false); } }
  }
  const template = options.templates.find(item => `${item.name}:${item.language}` === selectedTemplate);
  if (!workspaceAccess(data).admin) return <Dialog title="WhatsApp Business" onClose={onClose}><EmptyState title="Administrator access needed" body="An institute owner or administrator can manage this connection." /></Dialog>;
  return <Dialog title="A familiar number. A connected workflow." onClose={onClose}>
    <div className="whatsapp-connect-mark"><span><Smartphone size={30} /></span><Link2 size={20} /><span><MessageSquare size={30} /></span></div><p className="dialog-intro">Connect your institute’s WhatsApp Business account to AdmitFlow.</p>
    {connection && <div className="setup-callout"><ShieldCheck size={18} /><div><strong>{connection.label}</strong><p>{connection.status === "connected" ? "Account configured. Message acceptance and delivery are tracked separately." : connection.status === "disconnected" ? "Disconnected. Reconnect this same phone-number ID and Business Account ID to recover retained enquiries." : connection.status === "unverified" ? "Account verification is incomplete. Reconnect to verify access." : "This connection needs attention. Reconnect to verify access."}</p><Badge tone={connection.metadata.coexistence === "verified" ? "green" : "amber"}>{connection.metadata.coexistence === "verified" ? "Business app coexistence verified" : connection.metadata.coexistence === "requested" ? "Coexistence requested · not yet verified" : "Standard Cloud API setup"}</Badge></div></div>}
    <label className={`coexistence-option ${coexistence ? "selected" : ""}`}><input type="checkbox" checked={coexistence} disabled={busy} onChange={event => setCoexistence(event.target.checked)} /><span><strong>I already use the WhatsApp Business app</strong><small>Request coexistence for your existing number using Meta’s Business-app onboarding flow.</small></span></label>
    <div className="connection-steps">{["Authorize your institute’s Meta Business account", "Choose your number and complete Meta verification", "Bring new messages into your shared inbox"].map((text, index) => <div key={text}><b>{index + 1}</b><span>{text}</span></div>)}</div><p className="field-note">Meta checks coexistence eligibility during signup. AdmitFlow marks coexistence verified only after receiving a signed Business-app message echo. Business-app replies then pause AI for that conversation.</p>
    <Button variant="primary" className="full-width" loading={busy} disabled={!hosted || !metaConfigured} onClick={() => void connect()}>Continue with Meta<ArrowUpRight size={15} /></Button>{!hosted ? <p className="field-note">Live WhatsApp setup requires a hosted institute with PostgreSQL and WorkOS.</p> : !metaConfigured && <p className="field-note">Meta Embedded Signup requires the app ID and configuration ID to be set on the server. Existing Cloud API credentials can be checked below.</p>}
    {hosted && connection && <section className="advanced-connection" aria-busy={operation.isFetching}><h3>Subscription evidence</h3>
      {operation.isError && <p className="inline-error" role="alert">{operation.error.message}</p>}
      {operation.data ? <><Badge tone={connection.status === "connected" ? "green" : "amber"}>{connection.status === "connected" ? "Operational" : ["reserved", "uncertain", "absent", "disconnected_pending"].includes(connection.metadata.subscriptionStatus) ? "Pending reconciliation · messaging disabled" : "Disconnected"}</Badge>
        <p className="field-note">App {operation.data.appId} · latest check: {operation.data.reconciliation}. {operation.data.dispatchedAt ? "A subscription dispatch was recorded and will never be repeated." : "No subscription dispatch has been recorded."}</p>
        <p className="field-note">{operation.data.confirmedAt ? "Meta positively acknowledged the original write." : "The original write has no positive acknowledgement."} {operation.data.observedAt && "A verified read has observed this app subscription; this is current-state evidence, not proof of the original write."}</p></> : !operation.isFetching && !operation.isError && <p className="field-note">No durable setup history yet. Verify the original account to establish it.</p>}
      <p className="field-note">Supply fresh credentials below to check Meta without reconnecting. If present, choose Verify and reconnect to restore messaging deliberately. If absent or unreadable, review Meta configuration or contact support; there is no force-reset or replay.</p>
      <Button disabled={busy} loading={operation.isFetching} onClick={() => void operation.refetch()}><RefreshCw size={14} />Refresh evidence</Button>
    </section>}
    {options.enabled && <section className="advanced-connection"><h3>Default recovery template</h3><p className="field-note">Choose an approved Meta template. Individual campaigns can select another approved template.</p><form onSubmit={async event => {
      event.preventDefault(); if (!template || templateIssue(template) || busy) return;
      setBusy(true);
      try {
        const response = await fetch("/api/connections", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "template.default", name: template.name, language: template.language }) });
        const result = await readJsonResponse<{ workspace?: typeof data }>(response, "The default template could not be saved.");
        if (result.workspace) setData(result.workspace); else await refresh();
        notify("Default Meta template saved.");
      } catch (error) { notify(error instanceof Error ? error.message : "The default template could not be saved.", "error"); }
      finally { setBusy(false); }
    }}><SelectField label="Default approved template" value={selectedTemplate} disabled={options.isFetching || busy} onChange={event => setSelectedTemplate(event.target.value)}><option value="">{options.isFetching ? "Loading approved templates…" : "Choose a template"}</option>{options.templates.map(item => <option key={item.id} value={`${item.name}:${item.language}`} disabled={Boolean(templateIssue(item))}>{item.name} · {item.language}{templateIssue(item) ? " · unavailable for this workflow" : ""}</option>)}</SelectField>{template && <p className="preview-message">{templateBody(template)}</p>}{template && templateIssue(template) && <p className="inline-error" role="alert">{templateIssue(template)}</p>}{options.isError && <p className="inline-error" role="alert">{options.error.message}</p>}{!options.isPending && !options.isError && !options.templates.length && <p className="field-note">No approved templates were returned. Approve a template in WhatsApp Manager and refresh.</p>}<div className="dialog-actions"><Button onClick={() => void options.refetch()} loading={options.isFetching} disabled={busy}><RefreshCw size={14} />Refresh templates</Button><Button type="submit" variant="primary" loading={busy} disabled={Boolean(templateIssue(template)) || options.isFetching || options.isError}>Save default template</Button></div></form></section>}
    <details className="advanced-connection"><summary>Already have Cloud API credentials?</summary><form onSubmit={async event => {
      event.preventDefault(); if (!hosted || busy) return;
      const element = event.currentTarget, form = new FormData(element); setBusy(true);
      const reconcile = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value") === "reconcile";
      try {
        const action = reconcile ? { type: "whatsapp.reconcile", phoneNumberId: form.get("phoneId"), wabaId: form.get("wabaId"), accessToken: form.get("token") }
          : { service: "whatsapp", secret: { accessToken: form.get("token") }, externalId: form.get("phoneId"), label: "WhatsApp Business", metadata: { wabaId: form.get("wabaId"), coexistence: coexistence ? "requested" : "standard" } };
        const response = await fetch("/api/connections", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(action) });
        const result = await readJsonResponse<{ workspace?: typeof data; whatsapp?: { connected: boolean; message: string } }>(response, "This WhatsApp account could not be verified.");
        if (result.workspace) setData(result.workspace); else await refresh();
        notify(result.whatsapp?.message || "WhatsApp setup status updated.");
        await operation.refetch();
        if (!reconcile && result.whatsapp?.connected) onClose();
      } catch (error) { notify(error instanceof Error ? error.message : "This WhatsApp account could not be verified.", "error"); try { await refresh(); } catch { /* Keep the verification error visible. */ } }
      finally { const token = element.elements.namedItem("token"); if (token instanceof HTMLInputElement) token.value = ""; setBusy(false); }
    }}><Field label="WhatsApp Business Account ID" name="wabaId" required inputMode="numeric" pattern="[0-9]+" maxLength={80} defaultValue={connection?.metadata.wabaId || ""} /><Field label="Phone-number ID" name="phoneId" required inputMode="numeric" pattern="[0-9]+" maxLength={80} defaultValue={connection?.externalId || ""} /><Field label="Fresh access token" name="token" type="password" required autoComplete="new-password" /><div className="dialog-actions">{connection && <Button type="submit" value="reconcile" loading={busy} disabled={!hosted}>Check subscription only</Button>}<Button type="submit" value="connect" variant="primary" loading={busy} disabled={!hosted}>{connection ? "Verify and reconnect" : "Verify and connect"}</Button></div></form></details>
  </Dialog>;
}
