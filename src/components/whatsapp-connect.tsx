"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { MessageSquare, Smartphone, ArrowUpRight, Link2, RefreshCw, ShieldCheck } from "lucide-react";
import { useData, workspaceAccess, useWhatsAppTemplates, templateBody, templateIssue } from "./provider";
import { Badge, Button, Dialog, EmptyState, Field, SelectField } from "./ui";

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
  const [coexistence, setCoexistence] = useState(!connection || ["requested", "verified"].includes(connection.metadata.coexistence)), [busy, setBusy] = useState(false), [selectedTemplate, setSelectedTemplate] = useState("");
  const code = useRef(""), account = useRef<{ wabaId: string; phoneNumberId: string } | null>(null), submitted = useRef(false), signupTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimer = useCallback(() => { if (signupTimer.current) clearTimeout(signupTimer.current); signupTimer.current = null; }, []);
  const complete = useCallback(async () => {
    if (!code.current || !account.current || submitted.current) return;
    submitted.current = true; setBusy(true); clearTimer();
    try {
      const response = await fetch("/api/connections", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "whatsapp.exchange", code: code.current, ...account.current, coexistence }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "WhatsApp setup could not be completed. Restart Meta signup.");
      if (result.workspace) setData(result.workspace); else await refresh();
      notify(coexistence ? "WhatsApp account configured. Business-app coexistence is requested and awaits a verified message echo." : "WhatsApp account verified and configured. Message delivery is tracked in the inbox.");
      onClose();
    } catch (error) {
      code.current = ""; account.current = null; submitted.current = false;
      notify(error instanceof Error ? error.message : "WhatsApp setup could not be completed. Restart Meta signup.", "error");
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
      } else if (message.event === "CANCEL" || message.event === "ERROR") {
        clearTimer(); code.current = ""; account.current = null; setBusy(false);
        notify(message.event === "CANCEL" ? "Meta signup cancelled. Restart when you’re ready." : "Meta signup could not be completed. Please restart setup.", message.event === "ERROR" ? "error" : "info");
      }
    }
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [complete, clearTimer, notify]);
  useEffect(() => () => clearTimer(), [clearTimer]);
  useEffect(() => {
    const preferred = options.templates.find(template => template.name === connection?.metadata.templateName && template.language === connection?.metadata.templateLanguage);
    if (preferred) setSelectedTemplate(`${preferred.name}:${preferred.language}`);
  }, [connection?.metadata.templateName, connection?.metadata.templateLanguage, options.templates]);

  async function connect() {
    if (busy || data.demo || !workspaceAccess(data).admin) return;
    if (!data.integrations?.metaAppId || !data.integrations.metaConfigId) { notify("Configure the Meta app ID and Embedded Signup configuration ID on your server first.", "error"); return; }
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
      if (!window.FB) throw new Error("Meta sign-in is unavailable. Please reload and retry.");
      window.FB.init({ appId: data.integrations.metaAppId, version: data.integrations.metaVersion || "v23.0", cookie: true, xfbml: false });
      signupTimer.current = setTimeout(() => { code.current = ""; account.current = null; setBusy(false); notify("Meta did not return the complete signup result. Restart setup to continue.", "error"); }, 120000);
      window.FB.login(response => {
        if (response.authResponse?.code) { code.current = response.authResponse.code; void complete(); }
        else { clearTimer(); setBusy(false); notify("Meta signup cancelled. You can restart setup."); }
      }, { config_id: data.integrations.metaConfigId, response_type: "code", override_default_response_type: true, extras: { setup: {}, sessionInfoVersion: "3", ...(coexistence ? { featureType: "whatsapp_business_app_onboarding" } : {}) } });
    } catch (error) { clearTimer(); notify(error instanceof Error ? error.message : "Meta sign-in could not start.", "error"); setBusy(false); }
  }
  const template = options.templates.find(item => `${item.name}:${item.language}` === selectedTemplate);
  if (!workspaceAccess(data).admin) return <Dialog title="WhatsApp Business" onClose={onClose}><EmptyState title="Administrator access needed" body="An institute owner or administrator can manage this connection." /></Dialog>;
  return <Dialog title="A familiar number. A connected workflow." onClose={onClose}>
    <div className="whatsapp-connect-mark"><span><Smartphone size={30} /></span><Link2 size={20} /><span><MessageSquare size={30} /></span></div><p className="dialog-intro">Connect your institute’s WhatsApp Business account to AdmitFlow.</p>
    {connection && <div className="setup-callout"><ShieldCheck size={18} /><div><strong>{connection.label}</strong><p>{connection.status === "connected" ? "Account configured. Message acceptance and delivery are tracked separately." : connection.status === "unverified" ? "Account verification is incomplete. Reconnect to verify access." : "This connection needs attention. Reconnect to verify access."}</p><Badge tone={connection.metadata.coexistence === "verified" ? "green" : "amber"}>{connection.metadata.coexistence === "verified" ? "Business app coexistence verified" : connection.metadata.coexistence === "requested" ? "Coexistence requested · not yet verified" : "Standard Cloud API setup"}</Badge></div></div>}
    <label className={`coexistence-option ${coexistence ? "selected" : ""}`}><input type="checkbox" checked={coexistence} disabled={busy} onChange={event => setCoexistence(event.target.checked)} /><span><strong>I already use the WhatsApp Business app</strong><small>Request coexistence for your existing number using Meta’s Business-app onboarding flow.</small></span></label>
    <div className="connection-steps">{["Authorize your institute’s Meta Business account", "Choose your number and complete Meta verification", "Bring new messages into your shared inbox"].map((text, index) => <div key={text}><b>{index + 1}</b><span>{text}</span></div>)}</div><p className="field-note">Meta checks coexistence eligibility during signup. AdmitFlow marks coexistence verified only after receiving a signed Business-app message echo. Business-app replies then pause AI for that conversation.</p>
    <Button variant="primary" className="full-width" loading={busy} disabled={data.demo} onClick={() => void connect()}>Continue with Meta<ArrowUpRight size={15} /></Button>{data.demo && <p className="field-note">Create an institute workspace in Settings to connect a live account.</p>}
    {options.enabled && <section className="advanced-connection"><h3>Default recovery template</h3><p className="field-note">Choose an approved Meta template. Individual campaigns can select another approved template.</p><form onSubmit={async event => {
      event.preventDefault(); if (!template || templateIssue(template) || busy) return;
      setBusy(true);
      try {
        const response = await fetch("/api/connections", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "template.default", name: template.name, language: template.language }) });
        const result = await response.json(); if (!response.ok) throw new Error(result.error || "The default template could not be saved.");
        if (result.workspace) setData(result.workspace); else await refresh();
        notify("Default Meta template saved.");
      } catch (error) { notify(error instanceof Error ? error.message : "The default template could not be saved.", "error"); }
      finally { setBusy(false); }
    }}><SelectField label="Default approved template" value={selectedTemplate} disabled={options.isFetching || busy} onChange={event => setSelectedTemplate(event.target.value)}><option value="">{options.isFetching ? "Loading approved templates…" : "Choose a template"}</option>{options.templates.map(item => <option key={item.id} value={`${item.name}:${item.language}`} disabled={Boolean(templateIssue(item))}>{item.name} · {item.language}{templateIssue(item) ? " · unsupported variables" : ""}</option>)}</SelectField>{template && <p className="preview-message">{templateBody(template)}</p>}{options.isError && <p className="inline-error" role="alert">{options.error.message}</p>}{!options.isPending && !options.isError && !options.templates.length && <p className="field-note">No approved templates were returned. Approve a template in WhatsApp Manager and refresh.</p>}<div className="dialog-actions"><Button onClick={() => void options.refetch()} loading={options.isFetching} disabled={busy}><RefreshCw size={14} />Refresh templates</Button><Button type="submit" variant="primary" loading={busy} disabled={Boolean(templateIssue(template)) || options.isFetching || options.isError}>Save default template</Button></div></form></section>}
    <details className="advanced-connection"><summary>Already have Cloud API credentials?</summary><form onSubmit={async event => {
      event.preventDefault(); if (data.demo || busy) return;
      const form = new FormData(event.currentTarget); setBusy(true);
      try {
        const response = await fetch("/api/connections", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ service: "whatsapp", secret: { accessToken: form.get("token") }, externalId: form.get("phoneId"), label: "WhatsApp Business", metadata: { wabaId: form.get("wabaId"), coexistence: coexistence ? "requested" : "standard" } }) });
        const result = await response.json(); if (!response.ok) throw new Error(result.error || "This WhatsApp account could not be verified.");
        if (result.workspace) setData(result.workspace); else await refresh();
        notify(coexistence ? "WhatsApp configured. Coexistence remains requested until a signed Business-app echo is received." : "WhatsApp account verified and configured."); onClose();
      } catch (error) { notify(error instanceof Error ? error.message : "This WhatsApp account could not be verified.", "error"); }
      finally { setBusy(false); }
    }}><Field label="WhatsApp Business Account ID" name="wabaId" required inputMode="numeric" pattern="[0-9]+" maxLength={80} defaultValue={connection?.metadata.wabaId || ""} /><Field label="Phone-number ID" name="phoneId" required inputMode="numeric" pattern="[0-9]+" maxLength={80} defaultValue={connection?.externalId || ""} /><Field label="Access token" name="token" type="password" required autoComplete="new-password" /><Button type="submit" variant="primary" loading={busy} disabled={data.demo}>Verify and connect</Button></form></details>
  </Dialog>;
}
