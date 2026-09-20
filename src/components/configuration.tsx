"use client";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { BookOpen, Plus, Search, FileText, ArrowUpRight, Trash2, Clock3, MessageSquare, ShieldCheck, Play, Check, ArrowDown, UserRound, Building2, Plug, LogOut, Sparkles, CalendarDays, Upload, ArrowRight, Mail, Database, Cloud, X, CreditCard, Mic, Globe, KeyRound, RefreshCw } from "lucide-react";
import { useData, workspaceAccess, recordOwnerId, paidActionBlocked } from "./provider";
import { type Article, type Workspace, type WorkspaceFile, type AiSettings, type Connection, type Member, type Role, DEFAULT_AI, relativeTime, dateLabel } from "@/lib/domain";
import { Avatar, Badge, Button, Dialog, EmptyState, Field, PageHeading, PanelHeader, SelectField, TextareaField, Toggle, IconButton } from "./ui";
import { WhatsAppConnect } from "./whatsapp-connect";
import { DeferredIntakePanel } from "./subscription";
import { BillingPanel } from "./billing";
import { Illustration } from "./illustration";
import { SampleAudio } from "./sample-audio";
import { readJsonResponse } from "@/lib/client-response";

type BeginFileRequest = { type: "begin"; name: string; mime: string; size: number; purpose: WorkspaceFile["purpose"]; leadId?: string };
type BeginFileResponse = { id: string; url: string; headers: Record<string, string>; expiresAt: string; error?: string };
type FinishFileRequest = { type: "finish"; id: string };
type FinishFileResponse = { id: string; error?: string };

export async function uploadFile(file: File, purpose: WorkspaceFile["purpose"], leadId?: string) {
  if (!file.size || file.size > 10_000_000) throw new Error("Choose a non-empty file up to 10 MB.");
  if (file.name.length > 160) throw new Error("Shorten the filename to 160 characters or fewer.");
  const mimeByExtension: Record<string, string> = { pdf: "application/pdf", txt: "text/plain", csv: "text/csv", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", mp3: "audio/mpeg", ogg: "audio/ogg", m4a: "audio/mp4", webm: "audio/webm", wav: "audio/wav", aac: "audio/aac", amr: "audio/amr" };
  const mime = file.type || mimeByExtension[file.name.split(".").at(-1)?.toLowerCase() || ""] || "application/octet-stream";
  const begin: BeginFileRequest = { type: "begin", name: file.name, mime, size: file.size, purpose, ...(leadId ? { leadId } : {}) };
  const init = await fetch("/api/files", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(begin) });
  const info = await readJsonResponse<BeginFileResponse>(init, "This upload could not be started.");
  // All returned headers are part of the signed PUT, including the tenant/file metadata.
  const uploaded = await fetch(info.url, { method: "PUT", headers: info.headers, body: file });
  if (!uploaded.ok) throw new Error("The upload did not finish. Please retry.");
  const finish: FinishFileRequest = { type: "finish", id: info.id };
  const response = await fetch("/api/files", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(finish) });
  const finished = await readJsonResponse<FinishFileResponse>(response, "The uploaded file could not be finalized.");
  return finished.id;
}

function AdminPage({ title }: { title: string }) {
  return <><PageHeading title={title} description="Institute administration" /><EmptyState title="Administrator access needed" body="An institute owner or administrator can manage this part of the workspace." /></>;
}

export function KnowledgePage() {
  const { data, act, busy, refresh, notify } = useData();
  const { admin } = workspaceAccess(data);
  const [query, setQuery] = useState(""), [category, setCategory] = useState("All sources"), [editing, setEditing] = useState<Article | "new" | null>(null), [uploading, setUploading] = useState(false);
  const articles = data.articles.filter(article => `${article.title} ${article.body}`.toLowerCase().includes(query.toLowerCase()) && (category === "All sources" || article.category === category));
  const canUpload = admin && !data.demo && Boolean(data.integrations?.storage);
  return <>
    <div className="page-eyebrow"><span>THE KNOWLEDGE BEHIND EVERY ANSWER</span></div>
    <PageHeading title="Your institute, in its own words." description="Give your assistant the context to make every answer count.">{admin && <><label className={`button secondary upload-button ${uploading || !canUpload ? "disabled" : ""}`} aria-disabled={!canUpload || uploading} title={data.demo ? "Document storage is available in a connected institute workspace." : !data.integrations?.storage ? "Configure R2 storage before uploading." : undefined}><Upload size={15} />{uploading ? "Uploading…" : "Upload document"}<input type="file" accept=".pdf,.txt,.csv" aria-label="Upload knowledge document" disabled={uploading || !canUpload} onChange={async event => {
      const input = event.currentTarget, file = input.files?.[0]; if (!file) return;
      setUploading(true);
      try { await uploadFile(file, "knowledge"); await refresh(); notify("Document uploaded. Indexing is queued for your background worker."); }
      catch (error) { notify(error instanceof Error ? error.message : "The document could not be uploaded.", "error"); }
      finally { setUploading(false); input.value = ""; }
    }} /></label><Button variant="primary" onClick={() => setEditing("new")}><Plus size={15} />Add knowledge</Button></>}</PageHeading>
    <div className="knowledge-banner"><Illustration name="knowledge-observatory" className="knowledge-banner-art" decorative /><div><h2>Good conversations start with good context.</h2><p>Courses, fees, FAQs and policies. One source of truth for your team and AI.</p></div><div className="knowledge-banner-count"><strong>{data.articles.length.toString().padStart(2, "0")}</strong><span>active sources</span></div></div>
    <div className="table-toolbar standalone-toolbar"><div className="view-tabs">{["All sources", "Courses", "Admissions", "Policies", "FAQs", "Documents"].map(value => <button key={value} className={category === value ? "active" : ""} aria-pressed={category === value} onClick={() => setCategory(value)}>{value}</button>)}</div><label className="search-input"><Search size={15} /><span className="sr-only">Search knowledge</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Find a source…" /></label></div>
    <div className="knowledge-grid">{articles.map(article => <article className="panel knowledge-card" key={article.id}><header><span className={`document-icon document-${article.category.toLowerCase()}`}><FileText size={21} strokeWidth={1.5} /></span><Badge>{article.category}</Badge></header><h3><button className="knowledge-title" onClick={() => setEditing(article)}>{article.title}</button></h3><p>{article.body}</p><footer><span><span className="live-dot" />Updated {relativeTime(article.updatedAt)}</span><IconButton label={`${admin ? "Edit" : "Read"} ${article.title}`} onClick={() => setEditing(article)}><ArrowUpRight size={16} /></IconButton></footer></article>)}{admin && <button className="knowledge-add-card" onClick={() => setEditing("new")}><span><Plus size={23} /></span><strong>Add a little more context</strong><small>A useful answer starts with you.</small></button>}</div>
    {!articles.length && <EmptyState title="No sources in this view" body="Try another search or category to find your institute’s knowledge." />}
    {data.files?.some(file => file.purpose === "knowledge") && <section className="panel uploaded-documents"><PanelHeader title="Uploaded documents" description="Upload readiness and knowledge indexing are tracked separately." />{data.files.filter(file => file.purpose === "knowledge").map(file => {
      const indexed = data.articles.some(article => article.fileId === file.id), job = data.jobs.slice().reverse().find(item => item.kind === "file.ingest" && item.payload?.fileId === file.id);
      const failed = file.status === "failed" || job?.status === "failed";
      const status = indexed ? "Added to knowledge" : failed ? "Needs attention" : file.status === "ready" ? "Indexing queued" : "Upload pending";
      return <div className="document-row" key={file.id}><FileText size={17} /><span><strong>{file.name}</strong><small>{Math.ceil(file.size / 1024)} KB{failed ? ` · ${file.error || job?.error || "Review the operation in AI & automations."}` : ""}</small></span><Badge tone={indexed ? "green" : failed ? "amber" : "neutral"}>{status}</Badge>{file.status === "ready" && <a href={`/api/files?id=${encodeURIComponent(file.id)}`} className="table-text-action">Download</a>}</div>;
    })}</section>}
    {editing && <Dialog title={!admin ? "Institute knowledge" : editing === "new" ? "Share a little institute knowledge" : "Refine this knowledge source"} wide onClose={() => setEditing(null)}><p className="dialog-intro">{admin ? "Write the information exactly as your institute would explain it." : "Approved information for your student conversations."}</p><form onSubmit={async event => {
      event.preventDefault(); if (!admin) return; const form = new FormData(event.currentTarget);
      const result = await act({ type: "article.save", ...(editing === "new" ? {} : { id: editing.id }), title: form.get("title"), category: form.get("category"), body: form.get("body") });
      if (result) { setEditing(null); setCategory("All sources"); setQuery(""); notify("Knowledge saved. Your assistant can use it in the next reply."); }
    }}><div className="form-grid"><Field label="Source title" name="title" required maxLength={150} readOnly={!admin} defaultValue={editing === "new" ? "" : editing.title} placeholder="e.g. NEET course & fee structure" /><SelectField label="Category" name="category" disabled={!admin} defaultValue={editing === "new" ? "FAQs" : editing.category}>{["Courses", "Admissions", "Policies", "FAQs", "Documents"].map(value => <option key={value}>{value}</option>)}</SelectField></div><TextareaField label="Approved institute information" name="body" rows={10} required readOnly={!admin} defaultValue={editing === "new" ? "" : editing.body} /><div className="dialog-actions">{admin && editing !== "new" && <Button variant="danger" disabled={busy} onClick={async () => { if (await act({ type: "article.delete", id: editing.id })) { setEditing(null); notify("Knowledge source removed."); } }}><Trash2 size={14} />Delete source</Button>}<Button onClick={() => setEditing(null)}>{admin ? "Cancel" : "Close"}</Button>{admin && <Button type="submit" variant="primary" loading={busy}>Save knowledge</Button>}</div></form></Dialog>}
  </>;
}

export function AutomationsPage() {
  const { data, act, busy, notify, refresh } = useData();
  const form = useForm<AiSettings>({ values: { ...DEFAULT_AI, ...data.ai } });
  const [tab, setTab] = useState("Assistant"), [retry, setRetry] = useState<string | null>(null);
  const pending = data.jobs.filter(job => job.status === "pending" && Date.parse(job.dueAt) <= Date.now()), failed = data.jobs.filter(job => ["failed", "reconcile"].includes(job.status));
  const retryJob = data.jobs.find(job => job.id === retry), retryMessage = data.messages.find(message => message.id === retryJob?.messageId);
  const safeRetry = retryJob?.status === "failed" && !retryMessage?.providerId
    && !["accepted", "sent", "delivered", "read", "reconcile"].includes(retryMessage?.status || "")
    && (!retryJob.dispatchedAt || retryMessage?.dispatchState === "rejected")
    && (!retryMessage?.dispatchedAt || retryMessage.dispatchState === "rejected");
  if (!workspaceAccess(data).admin) return <AdminPage title="AI & automations" />;
  return <>
    <div className="page-eyebrow"><span>YOUR ALWAYS-ON ADMISSIONS CO-PILOT</span></div><PageHeading title="Thoughtful by design. Autonomous by choice." description="Your knowledge, your playbook, and an assistant that keeps things moving."><Badge tone={data.ai?.mode === "autonomous" ? "green" : "neutral"}><i className="status-dot" />{data.demo ? "Demo assistant" : data.ai?.mode || "autonomous"}</Badge><Button loading={busy} disabled={!pending.length} onClick={async () => { const result = await act<{ processed: number }>({ type: "jobs.run" }); if (result) notify(`${result.processed} due follow-ups processed${data.demo ? " in demo mode" : ""}.`); }}><Play size={14} />Run due follow-ups</Button></PageHeading>
    <div className="view-tabs section-tabs">{["Assistant", "Recovery playbook", "Run history"].map(value => <button key={value} className={tab === value ? "active" : ""} aria-pressed={tab === value} onClick={() => setTab(value)}>{value}{value === "Run history" && failed.length > 0 && <span>{failed.length}</span>}</button>)}</div>
    {tab === "Assistant" && <div className="assistant-settings-grid"><section className="panel settings-form"><PanelHeader title="A way of working that fits your team" description="Choose how your assistant participates in conversations." /><form onSubmit={form.handleSubmit(async settings => { if (await act({ type: "ai.save", settings })) notify("Assistant settings saved."); })}>
      <div className="mode-options" role="radiogroup" aria-label="Assistant mode">{[{ id: "autonomous", icon: Sparkles, title: "Autonomous", body: "Answers, qualifies and requests counselling slots. Your team can take over anytime." }, { id: "assisted", icon: UserRound, title: "Co-pilot", body: "Prepares grounded replies for your counsellors to review and send." }, { id: "paused", icon: Clock3, title: "Paused", body: "Leaves conversations with your team until you’re ready." }].map(mode => <label key={mode.id} className={`mode-option ${form.watch("mode") === mode.id ? "selected" : ""}`}><input type="radio" value={mode.id} aria-label={mode.title} disabled={paidActionBlocked(data, { type: "ai.save", settings: { mode: mode.id } })} {...form.register("mode")} /><mode.icon size={19} /><span><strong>{mode.title}</strong><small>{mode.body}</small></span><span className="mode-radio" aria-hidden="true" /></label>)}</div>
      <div className="form-grid"><Field label="OpenAI model" required maxLength={100} {...form.register("model")} /><SelectField label="Reply language" {...form.register("language")}><option value="auto">Match the student</option><option value="en">English</option><option value="hi">Hindi</option></SelectField><Field label="Daily AI message limit" type="number" required min={1} max={10000} {...form.register("dailyLimit", { valueAsNumber: true })} /><Field label="ElevenLabs voice ID" maxLength={100} {...form.register("voiceId")} placeholder="From your voice library" /></div><TextareaField label="Your institute’s tone & instructions" rows={3} maxLength={4000} {...form.register("instructions")} /><div className="setting-toggle-row"><div><strong>Reply to voice notes with audio</strong><p>Use ElevenLabs speech when the student sends a voice note.</p></div><Toggle label="Voice replies" checked={form.watch("voiceReplies")} onChange={value => form.setValue("voiceReplies", value, { shouldDirty: true })} /></div><div className="dialog-actions"><Button action={{ type: "ai.save", settings: { mode: form.watch("mode") } }} variant="primary" type="submit" loading={busy}>Save assistant settings<Check size={14} /></Button></div>
    </form></section><div className="assistant-settings-side"><section className="panel assistant-principles"><Illustration name="knowledge-observatory" className="principles-art" decorative /><h2>Autonomy, with context.</h2><p>Helpful conversations start with a clear understanding of your institute.</p>{[
      { icon: BookOpen, title: "Grounded in your knowledge", body: `${data.articles.length} course, fee and policy sources.` },
      { icon: UserRound, title: "Your team stays in control", body: "A manual reply pauses AI for that conversation." },
      { icon: MessageSquare, title: "One shared conversation", body: "Verified Business-app echoes keep ownership in sync." },
      { icon: ShieldCheck, title: "Respects contact preferences", body: "Opt-outs stop outreach and automated replies." },
    ].map(item => <div key={item.title}><item.icon size={17} /><span><strong>{item.title}</strong><small>{item.body}</small></span></div>)}<Link href="/inbox" className="button secondary">Try it in the inbox<ArrowUpRight size={15} /></Link></section><SampleAudio slug="counselling-invitation" /><section className="assistant-detail-note"><Clock3 size={19} /><p>When an answer needs information beyond your sources, your assistant flags the conversation for a counsellor.</p></section></div></div>}
    {tab === "Recovery playbook" && <div className="automation-grid"><section className="panel workflow-panel"><PanelHeader title="Give every enquiry a thoughtful follow-up" description="A simple sequence. Clear stopping points." /><div className="workflow"><div className="workflow-node"><span className="workflow-node-icon"><UserRound size={18} /></span><div><strong>An enquiry enters recovery</strong><small>Open enquiry · 7+ days without contact</small></div><Badge>Trigger</Badge></div><ArrowDown className="workflow-arrow" size={17} /><div className="workflow-condition"><ShieldCheck size={15} />Check opt-in and eligibility</div><ArrowDown className="workflow-arrow" size={17} />{data.sequence.delays.map((delay, index) => <div className="workflow-step" key={index}><div className="workflow-node"><span className="workflow-node-icon blue-icon"><MessageSquare size={18} /></span><div><strong>{index === 0 ? "Start the conversation" : `Follow-up ${index}`}</strong><small>{delay === 0 ? "At the next worker run" : `${delay} hours after the sequence starts`}</small></div><span className="workflow-step-number">0{index + 1}</span></div><ArrowDown className="workflow-arrow" size={17} /></div>)}<div className="workflow-end"><Check size={15} />Stop on reply, booking, opt-out or takeover</div></div></section><section className="panel settings-form"><PanelHeader title="Fine-tune your rhythm" description="Changes apply to newly created campaigns." /><form onSubmit={async event => { event.preventDefault(); const input = new FormData(event.currentTarget); if (await act({ type: "sequence.save", enabled: data.sequence.enabled, delays: [0, Number(input.get("second")), Number(input.get("third"))] })) notify("Recovery playbook saved."); }}><div className="setting-toggle-row"><div><strong>Recovery sequences</strong><p>Enable scheduled, approved-template follow-ups.</p></div><Toggle label="Recovery sequences" checked={data.sequence.enabled} disabled={busy || paidActionBlocked(data, { type: "sequence.save", enabled: !data.sequence.enabled })} onChange={enabled => void act({ type: "sequence.save", enabled, delays: data.sequence.delays })} /></div><Field label="Second message after (hours)" name="second" type="number" required min={1} max={719} defaultValue={data.sequence.delays[1] || 24} /><Field label="Third message after (hours)" name="third" type="number" required min={2} max={720} defaultValue={data.sequence.delays[2] || 72} /><p className="field-note">Students who reply leave the recovery sequence. The conversation continues with AI or a counsellor according to its ownership.</p><Button action={{ type: "sequence.save", enabled: data.sequence.enabled }} type="submit" variant="primary" loading={busy}>Save playbook</Button></form></section></div>}
    {tab === "Run history" && <section className="panel"><PanelHeader title="Every run, in view" description="Provider outcomes and anything that needs your attention." action={<IconButton label="Refresh run history" onClick={() => void refresh()}><RefreshCw size={15} /></IconButton>} /><div className="data-table-wrap"><table className="data-table"><caption className="sr-only">Automation run history</caption><thead><tr><th>Action</th><th>Enquiry</th><th>Status</th><th>Scheduled</th><th>Details</th><th><span className="sr-only">Review operation</span></th></tr></thead><tbody>{data.jobs.slice().reverse().map(job => {
      const message = data.messages.find(item => item.id === job.messageId), serviceWork = ["appointment.book", "calendar.sync", "file.ingest", "knowledge.index"].includes(job.kind || "");
      const status = job.status === "accepted" ? "Accepted · awaiting status" : job.status === "reconcile" ? "Unresolved delivery" : job.status === "demo" ? serviceWork ? "Demo · no external action" : "Demo · not delivered" : job.status === "sent" ? serviceWork ? "Completed" : message?.status === "delivered" || message?.status === "read" ? message.status : "Sent · awaiting delivery" : job.status;
      return <tr key={job.id}><td>{job.kind || "followup"}</td><td>{data.leads.find(lead => lead.id === job.leadId)?.name || (job.kind === "knowledge.index" ? "Knowledge source" : "Institute operation")}</td><td><Badge tone={job.status === "sent" || job.status === "demo" ? "green" : ["failed", "reconcile"].includes(job.status) ? "amber" : "neutral"}>{status}</Badge></td><td>{dateLabel(job.dueAt, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}</td><td className="job-error-cell">{job.error || message?.voiceFallback || "—"}</td><td>{["failed", "reconcile"].includes(job.status) && <button className="table-text-action" onClick={() => setRetry(job.id)}>Review</button>}</td></tr>;
    })}</tbody></table></div>{!data.jobs.length && <EmptyState title="Ready when you are" body="Your campaign and assistant runs will appear here." />}</section>}
    {retry && <Dialog title="Review this operation" onClose={() => setRetry(null)}><p className="dialog-intro">{retryJob?.error || "This operation may have changed since you opened the run history."}</p>{safeRetry ? <><p className="field-note">This failure is eligible for another attempt. The original message identifier is retained.</p><div className="dialog-actions"><Button onClick={() => setRetry(null)}>Close</Button><Button action={{ type: "job.retry", id: retry }} variant="primary" loading={busy} onClick={async () => { if (await act({ type: "job.retry", id: retry })) { setRetry(null); notify("Operation queued for another attempt."); } }}>Queue retry</Button></div></> : <><p className="field-note"><ShieldCheck size={15} />{retryJob?.status === "reconcile" || retryMessage?.providerId || retryMessage?.dispatchedAt ? "Delivery may already have been accepted. This operation must await signed provider reconciliation; a manual confirmation cannot authorize another send." : "This operation is not eligible for a retry. Refresh to see its latest status."}</p><div className="dialog-actions"><Button onClick={() => setRetry(null)}>Close</Button><Button onClick={() => void refresh()}><RefreshCw size={14} />Refresh status</Button></div></>}</Dialog>}
  </>;
}

const services = [
  { id: "whatsapp", name: "WhatsApp Business", subtitle: "Your conversations, connected", description: "Bring your existing Business app number into one shared admissions workflow.", icon: MessageSquare, colour: "whatsapp" },
  { id: "openai", name: "OpenAI", subtitle: "The intelligence behind your replies", description: "An institute-grounded assistant that knows your courses, context and next steps.", icon: Sparkles, colour: "openai" },
  { id: "elevenlabs", name: "ElevenLabs", subtitle: "Make your conversations heard", description: "Transcribe student voice notes and respond with natural, multilingual speech.", icon: Mic, colour: "elevenlabs" },
  { id: "google", name: "Google Calendar", subtitle: "A place for every next hello", description: "Send new, rescheduled and cancelled counselling sessions from AdmitFlow to Google.", icon: CalendarDays, colour: "google" },
  { id: "razorpay", name: "Razorpay", subtitle: "A clear view of collected fees", description: "Create payment links and reconcile confirmed collections and refunds.", icon: CreditCard, colour: "razorpay" },
  { id: "meta_leads", name: "Meta Lead Ads", subtitle: "Start with a warm introduction", description: "Bring new form enquiries into your pipeline with their original source.", icon: Globe, colour: "meta" },
] as const;

function ConnectionDetails({ connection }: { connection: Connection }) {
  const meta = connection.metadata, subscriptionPending = ["reserved", "uncertain", "absent", "disconnected_pending"].includes(meta.subscriptionStatus);
  if (connection.status === "disconnected") return <p className="field-note">Disconnected. Credentials and messaging are disabled. {subscriptionPending ? "An unresolved subscription still has retryable callback routing. Manage the connection to reconcile it." : connection.service === "whatsapp" || connection.service === "meta_leads" ? "Reconnect the same provider account to recover retained enquiries." : "Reconnect to verify access again."}</p>;
  const validDate = (value?: string) => value && Number.isFinite(Date.parse(value));
  return <div className="connection-health">
    <p className="field-note">{connection.label || connection.externalId}{meta.readiness === "credentials_verified" ? " · account credentials verified" : connection.status === "unverified" ? " · verification incomplete" : ""}</p>
    {connection.service === "whatsapp" && <>
      <Badge tone={meta.coexistence === "verified" ? "green" : meta.coexistence === "requested" ? "amber" : "neutral"}>{meta.coexistence === "verified" ? "Business app coexistence verified" : meta.coexistence === "requested" ? "Coexistence requested" : "Cloud API connection"}</Badge>
      {meta.coexistence === "requested" && <p className="field-note">Waiting for a signed Business-app message echo to verify coexistence.</p>}
      {meta.coexistence === "verified" && validDate(meta.coexistenceVerifiedAt) && <p className="field-note">Verified {dateLabel(meta.coexistenceVerifiedAt, { day: "numeric", month: "short", year: "numeric" })}.</p>}
      {subscriptionPending && <p className="field-note">Subscription reconciliation required. Messaging and automation are disabled; pending callbacks remain retryable.</p>}
      {meta.templateName && <p className="field-note">Default template: {meta.templateName} · {meta.templateLanguage || "language not set"}</p>}
    </>}
    {connection.service === "meta_leads" && <>
      <Badge tone={meta.subscriptionStatus === "active" ? "green" : "amber"}>{meta.subscriptionStatus === "active" ? "Lead Ads subscription active" : meta.subscriptionStatus === "error" ? "Lead Ads subscription error" : "Lead Ads subscription pending"}</Badge>
      {meta.pageName && <p className="field-note">Page: {meta.pageName}</p>}
      {meta.lastLeadError && <p className="inline-error">{meta.lastLeadError}{validDate(meta.lastLeadErrorAt) ? ` · ${dateLabel(meta.lastLeadErrorAt)}` : ""}</p>}
      {validDate(meta.lastLeadAt) && <p className="field-note">Last enquiry received {relativeTime(meta.lastLeadAt)}.</p>}
      {validDate(meta.tokenExpiresAt) && <p className="field-note">Page token expires {dateLabel(meta.tokenExpiresAt, { day: "numeric", month: "short", year: "numeric" })}.</p>}
    </>}
    {connection.service === "google" && <p className="field-note">{meta.calendarId || "Primary calendar"} · one-way updates. Google changes are not imported.</p>}
    {connection.service === "razorpay" && meta.mode && <Badge tone={meta.mode === "test" ? "amber" : "neutral"}>{meta.mode === "test" ? "Test credentials" : "Live account credentials"}</Badge>}
    {connection.status === "error" && !meta.lastLeadError && <p className="inline-error">This connection needs attention. Reconnect to verify access.</p>}
  </div>;
}

export function IntegrationsPage() {
  const { data, refresh, setData, notify } = useData();
  const [editing, setEditing] = useState<string | null>(null), [saving, setSaving] = useState(false), [origin, setOrigin] = useState("");
  const params = useSearchParams(), pathname = usePathname(), router = useRouter(), handledGoogle = useRef<string | null>(null);
  const google = params.get("google"), { admin } = workspaceAccess(data), integration = services.find(service => service.id === editing);
  useEffect(() => { setOrigin(window.location.origin); }, []);
  useEffect(() => {
    if (!admin || !google || !["connected", "cancelled", "error"].includes(google) || handledGoogle.current === google) return;
    handledGoogle.current = google;
    notify(google === "connected" ? "Google Calendar connected. Sessions sync from AdmitFlow to Google." : google === "cancelled" ? "Google Calendar connection cancelled. You can restart setup when ready." : "Google Calendar could not be connected. Please retry setup.", google === "error" ? "error" : "info");
    void refresh();
    const next = new URLSearchParams(params.toString()); next.delete("google");
    router.replace(`${pathname}${next.size ? `?${next}` : ""}`, { scroll: false });
  }, [google, admin, params, pathname, router, refresh, notify]);
  async function disconnect(service: string) {
    if (!admin || saving) return;
    setSaving(true);
    try {
      const response = await fetch("/api/connections", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "disconnect", service }) });
      const result = await readJsonResponse<{ workspace?: Workspace }>(response, "The connection could not be removed.");
      if (result.workspace) setData(result.workspace); else await refresh();
      notify(service === "google" ? "Google disconnected. Previously created calendar events remain in Google." : "Disconnected. Credentials removed; account identity retained for recovery.");
    } catch (error) { notify(error instanceof Error ? error.message : "The connection could not be removed.", "error"); }
    finally { setSaving(false); }
  }
  if (!admin) return <AdminPage title="Integrations" />;
  return <>
    <div className="page-eyebrow"><span>YOUR TOOLS, WORKING TOGETHER</span></div><PageHeading title="A well-connected admissions team." description="Bring the tools you trust into the conversations that matter."><IconButton label="Refresh connections" onClick={() => void refresh()}><RefreshCw size={16} /></IconButton></PageHeading>
    <div className="integration-intro"><span className="integration-intro-icon"><Plug size={26} /></span><div><h2>One workflow. All the right connections.</h2><p>Connections and credentials belong to this institute. Configuration, account verification and delivery are tracked separately.</p></div><Badge>{data.connections?.filter(connection => connection.status === "connected").length || 0} configured</Badge></div>
    <div className="integrations-grid">{services.map(service => {
      const connection = data.connections?.find(item => item.service === service.id), platform = service.id === "openai" && data.integrations?.ai || service.id === "elevenlabs" && data.integrations?.speech;
      const status = connection?.status === "error" ? "Needs attention" : connection?.status === "unverified" ? "Unverified" : connection?.status === "connected" || platform ? "Configured" : "Not connected";
      return <section className="panel integration-card" key={service.id}><header><span className={`service-icon ${service.colour}`}><service.icon size={24} strokeWidth={1.6} /></span><Badge tone={connection?.status === "error" || connection?.status === "unverified" ? "amber" : connection?.status === "connected" || platform ? "green" : "neutral"}><i className="status-dot" />{status}</Badge></header><h2>{service.name}</h2><span className="integration-subtitle">{service.subtitle}</span><p>{service.description}</p>{connection ? <ConnectionDetails connection={connection} /> : platform && <p className="field-note">Platform credentials configured. Individual request outcomes appear in the run history.</p>}<footer><Button disabled={saving} onClick={() => setEditing(service.id)}>{connection?.status === "disconnected" ? "Reconnect" : connection || platform ? "Manage connection" : "Connect"}<ArrowUpRight size={14} /></Button>{(connection || platform) && connection?.status !== "disconnected" && <button className="quiet-icon" disabled={saving || data.demo} aria-label={`Disconnect ${service.name}`} onClick={() => void disconnect(service.id)}><X size={15} /></button>}</footer></section>;
    })}</div>
    <section className="platform-strip"><span>YOUR PLATFORM FOUNDATION</span><div><Database size={18} /><strong>Neon + Drizzle</strong><Badge>{data.actor?.backend === "workos" ? "Configured" : "Local preview"}</Badge></div><div><ShieldCheck size={18} /><strong>WorkOS AuthKit</strong><Badge>{data.integrations?.auth ? "Configured" : "Setup required"}</Badge></div><div><Cloud size={18} /><strong>Cloudflare R2</strong><Badge>{data.integrations?.storage ? "Configured" : "Setup required"}</Badge></div></section>
    {editing === "whatsapp" && <WhatsAppConnect onClose={() => setEditing(null)} />}
    {editing && editing !== "whatsapp" && integration && <Dialog title={`Connect ${integration.name}`} onClose={() => setEditing(null)}><p className="dialog-intro">{integration.description}</p>{data.demo && <div className="setup-callout"><Sparkles size={18} /><div><strong>You’re exploring a demo workspace</strong><p>Create an institute workspace to add live credentials. Your sample data stays separate.</p><Link href="/settings" className="table-text-action" onClick={() => setEditing(null)}>Set up your workspace<ArrowRight size={13} /></Link></div></div>}
      {editing === "google" ? <div className="google-connect"><span className="service-icon google"><CalendarDays size={30} /></span><p>Connect your institute’s shared Google calendar. New, changed and cancelled sessions sync from AdmitFlow. Changes made in Google are not imported.</p>{data.demo ? <Link className="button secondary" href="/settings">Set up your workspace<ArrowUpRight size={15} /></Link> : <a className="button primary" href="/api/integrations/google/start">Continue with Google<ArrowUpRight size={15} /></a>}</div> : <form onSubmit={async event => {
        event.preventDefault(); if (data.demo || saving) return;
        setSaving(true); const form = new FormData(event.currentTarget);
        const secret = editing === "razorpay" ? { keyId: String(form.get("keyId")), keySecret: String(form.get("keySecret")), webhookSecret: String(form.get("webhookSecret")) } : editing === "meta_leads" ? { accessToken: String(form.get("apiKey")) } : { apiKey: String(form.get("apiKey")), ...(editing === "elevenlabs" ? { voiceId: String(form.get("voiceId")) } : {}) };
        try {
          const response = await fetch("/api/connections", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ service: editing, secret, externalId: editing === "meta_leads" ? form.get("pageId") : data.id, label: integration.name }) });
          const result = await readJsonResponse<{ workspace?: Workspace }>(response, "The account could not be verified.");
          if (result.workspace) setData(result.workspace); else await refresh();
          setEditing(null); notify(`${integration.name} account verified and configured.`);
        } catch (error) { notify(error instanceof Error ? error.message : "The account could not be verified.", "error"); await refresh(); }
        finally { setSaving(false); }
      }}>
        {editing === "razorpay" ? <><Field label="Razorpay key ID" name="keyId" required autoComplete="off" /><Field label="Razorpay key secret" name="keySecret" type="password" required autoComplete="new-password" /><Field label="Webhook secret" name="webhookSecret" type="password" required autoComplete="new-password" /><p className="field-note">Webhook: <code>{origin}/api/webhooks/razorpay/{data.id}</code></p></> : <><Field label={editing === "meta_leads" ? "Page access token" : "API key"} name="apiKey" type="password" required autoComplete="new-password" />{editing === "meta_leads" && <><Field label="Meta page ID" name="pageId" required defaultValue={data.connections?.find(item => item.service === "meta_leads")?.externalId || ""} /><p className="field-note">Webhook: <code>{origin}/api/webhooks/meta-leads</code></p><p className="field-note">Page access and the Lead Ads webhook subscription are verified when you save. Imported forms do not automatically grant WhatsApp opt-in.</p></>}{editing === "elevenlabs" && <Field label="Default voice ID" name="voiceId" />}</>}
        <p className="field-note"><KeyRound size={13} />Credentials are encrypted server-side and scoped to your institute.</p><div className="dialog-actions"><Button onClick={() => setEditing(null)}>Cancel</Button><Button type="submit" variant="primary" disabled={data.demo} loading={saving}>Save connection</Button></div>
      </form>}
    </Dialog>}
  </>;
}

type TeamResponse = { workspace: Workspace; members: Member[]; member?: Member; mode: string; message?: string; emailSent?: boolean };
export function TeamPage() {
  const { data, setData, notify } = useData();
  const access = workspaceAccess(data), client = useQueryClient();
  const [invite, setInvite] = useState(false), [saving, setSaving] = useState<string | null>(null);
  const teamKey = ["team", data.id, data.actor?.id];
  const team = useQuery({
    queryKey: teamKey, enabled: access.admin, staleTime: 0, refetchOnMount: "always",
    queryFn: async ({ signal }) => {
      const response = await fetch("/api/team", { cache: "no-store", signal });
      return readJsonResponse<TeamResponse>(response, "Team access could not be refreshed.");
    },
  });
  useEffect(() => { if (team.data?.workspace) setData(team.data.workspace); }, [team.data, setData]);
  async function updateTeam(action: Record<string, unknown>) {
    if (!access.admin || saving) return false;
    setSaving(String(action.id || "invite"));
    try {
      const response = await fetch("/api/team", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(action) });
      const updated = await readJsonResponse<TeamResponse>(response, "Team access could not be updated.");
      setData(updated.workspace);
      if (workspaceAccess(updated.workspace).admin) client.setQueryData(teamKey, updated);
      notify(updated.message || "Team access updated.");
      return true;
    } catch (error) { notify(error instanceof Error ? error.message : "Team access could not be updated.", "error"); return false; }
    finally { setSaving(null); }
  }
  if (!access.admin) return <AdminPage title="Team & access" />;
  const members = team.data?.members || data.members || [], activeOwners = members.filter(member => member.role === "owner" && member.status === "active").length;
  const controlsBusy = Boolean(saving) || team.isFetching || team.isError;
  return <>
    <div className="page-eyebrow"><span>GOOD OUTCOMES ARE A TEAM EFFORT</span></div><PageHeading title="The people behind the possibilities." description="Give every counsellor the context and access they need."><Button loading={team.isFetching} disabled={Boolean(saving)} onClick={() => void team.refetch()}><RefreshCw size={15} />Refresh team</Button><Button action={{ type: "team.invite" }} variant="primary" disabled={controlsBusy} onClick={() => setInvite(true)}><Plus size={15} />Invite teammate</Button></PageHeading>
    {team.isError && <p className="inline-error" role="alert">{team.error.message} Refresh the team before changing access.</p>}
    {(team.data?.message || data.actor?.backend !== "workos") && <p className="field-note"><ShieldCheck size={14} />{team.data?.message || "Local team preview. Invitations do not send email or grant another account access."}</p>}
    <section className="panel" aria-busy={team.isFetching}><PanelHeader title="Your admissions team" description={`${members.length} people in ${data.name}`} /><div className="data-table-wrap"><table className="data-table"><caption className="sr-only">Admissions team</caption><thead><tr><th>Team member</th><th>Role</th><th>Assigned enquiries</th><th>Status</th><th><span className="sr-only">Manage access</span></th></tr></thead><tbody>{members.map(member => {
      const self = member.id === access.memberId || member.id === data.actor?.id || Boolean(member.workosId && member.workosId === data.actor?.id);
      const canManage = member.role !== "owner" || access.role === "owner", lastOwner = member.role === "owner" && member.status === "active" && activeOwners <= 1;
      const canReactivate = member.status === "inactive" && (!data.workosOrganizationId || Boolean(member.workosId));
      return <tr key={member.id}><td><span className="person-cell"><Avatar name={member.name} /><span><strong>{member.name}{self ? " (you)" : ""}</strong><small>{member.email || "Local team member"}</small></span></span></td><td>{canManage && member.status !== "invited" ? <label className="compact-select"><span className="sr-only">Role for {member.name}</span><select value={member.role} disabled={controlsBusy || lastOwner} onChange={event => void updateTeam({ type: "role", id: member.id, role: event.target.value as Role })}>{(access.role === "owner" ? ["owner", "admin", "counsellor", "analyst"] : ["admin", "counsellor", "analyst"]).map(role => <option key={role} value={role}>{role.charAt(0).toUpperCase() + role.slice(1)}</option>)}</select></label> : <span className="capitalize">{member.role}</span>}</td><td>{data.leads.filter(lead => recordOwnerId(data, lead) === member.id).length}</td><td><Badge tone={member.status === "active" ? "green" : member.status === "invited" ? "amber" : "neutral"}><i className="status-dot" />{member.status}</Badge></td><td>{canManage && <>
        {member.status === "active" && !self && !lastOwner && <Button variant="ghost" disabled={controlsBusy} onClick={() => void updateTeam({ type: "deactivate", id: member.id })}>Deactivate</Button>}
        {member.status === "invited" && <Button variant="ghost" disabled={controlsBusy} onClick={() => void updateTeam({ type: "revoke", id: member.id })}>Revoke invitation</Button>}
        {canReactivate && <Button action={{ type: "team.reactivate" }} variant="ghost" disabled={controlsBusy} onClick={() => void updateTeam({ type: "reactivate", id: member.id })}>Reactivate</Button>}
        {lastOwner && <span className="muted small-copy">Last active owner</span>}
        {member.status === "inactive" && !canReactivate && <span className="muted small-copy">Archived member record</span>}
      </>}</td></tr>;
    })}</tbody></table></div>{!members.length && <EmptyState title={team.isFetching ? "Refreshing your team…" : "Build your admissions team"} body="Active memberships and pending invitations appear here." />}</section>
    <div className="role-guide">{[["Owner & admin", "Manage institute settings, connections, campaigns and access. Only owners manage ownership roles."], ["Counsellor", "Work assigned enquiries, conversations, tasks and counselling sessions."], ["Analyst", "Explore institute outcomes and reports with read-only access."]].map(([title, body]) => <section key={title}><ShieldCheck size={17} /><h3>{title}</h3><p>{body}</p></section>)}</div>
    {invite && <Dialog title="Better conversations start with a team" onClose={() => setInvite(false)}><p className="dialog-intro">{data.actor?.backend === "workos" ? "Invite a teammate to this institute through WorkOS. Pending invitations do not make someone an active assignee." : "Preview team setup. Local invitations do not send email or grant another account access."}</p><form onSubmit={async event => { event.preventDefault(); const form = new FormData(event.currentTarget); if (await updateTeam({ type: "invite", email: form.get("email"), name: form.get("name"), role: form.get("role") })) setInvite(false); }}><Field label="Teammate name" name="name" required maxLength={100} /><Field label="Email address" type="email" name="email" required maxLength={200} /><SelectField label="Workspace role" name="role"><option value="counsellor">Counsellor</option><option value="analyst">Analyst</option><option value="admin">Admin</option>{access.role === "owner" && <option value="owner">Owner</option>}</SelectField><div className="dialog-actions"><Button onClick={() => setInvite(false)}>Cancel</Button><Button action={{ type: "team.invite" }} variant="primary" type="submit" loading={saving === "invite"}>Send invitation<Mail size={14} /></Button></div></form></Dialog>}
  </>;
}

export function SettingsPage() {
  const { data, act, busy, setData, refresh, notify } = useData();
  const [auth, setAuth] = useState<"register" | "login" | null>(null), { admin } = workspaceAccess(data);
  return <>
    <div className="page-eyebrow"><span>A WORKSPACE THAT FEELS LIKE YOURS</span></div><PageHeading title="The details make the difference." description="Your institute’s profile, preferences and workspace information.">{!data.demo && <Button onClick={async () => {
      if (data.actor?.backend === "workos") { location.assign("/logout"); return; }
      try { const response = await fetch("/api/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "logout" }) }); const result = await readJsonResponse<Workspace>(response, "Sign-out could not be completed."); setData(result); }
      catch (error) { notify(error instanceof Error ? error.message : "Sign-out could not be completed.", "error"); }
    }}><LogOut size={15} />Sign out</Button>}</PageHeading>
    {data.demo && <section className="account-banner"><span className="account-banner-icon"><Sparkles size={23} /></span><div><h2>Your next chapter starts here.</h2><p>You’re exploring a sample academy. Create a workspace for your own institute.</p></div><Button onClick={() => data.integrations?.auth ? location.assign("/login") : setAuth("login")}>Sign in</Button><Button variant="primary" onClick={() => data.integrations?.auth ? location.assign("/signup") : setAuth("register")}>Create workspace<ArrowUpRight size={15} /></Button></section>}
    <div className="settings-grid"><section className="panel settings-form"><PanelHeader title="Institute profile" description="The details that shape your shared workspace." /><form key={data.id} onSubmit={async event => { event.preventDefault(); if (!admin) return; const form = new FormData(event.currentTarget); if (await act({ type: "settings.save", name: form.get("name"), userName: form.get("userName"), team: data.team, courses: String(form.get("courses")).split("\n").map(value => value.trim()).filter(Boolean) })) notify("Institute profile saved."); }}><div className="institute-profile-mark"><span className="academy-icon"><Building2 size={27} /></span><div><strong>{data.name}</strong><small>Admissions workspace</small></div></div><div className="form-grid"><Field label="Institute name" name="name" required defaultValue={data.name} maxLength={100} readOnly={!admin} /><Field label="Your name" name="userName" required defaultValue={data.actor?.name || data.userName} maxLength={100} readOnly={!admin || data.actor?.backend === "workos"} hint={data.actor?.backend === "workos" ? "Managed by your WorkOS account profile." : undefined} /></div><TextareaField label="Courses — one per line" name="courses" rows={5} defaultValue={data.courses.join("\n")} readOnly={!admin} /><div className="setting-facts"><div><span>Timezone</span><strong>Asia/Kolkata (IST)</strong></div><div><span>Currency</span><strong>Indian rupee · INR</strong></div></div>{admin ? <div className="dialog-actions"><Button type="submit" variant="primary" loading={busy}>Save institute profile</Button></div> : <p className="field-note">Your institute owner or administrator manages these settings.</p>}</form></section>
      <div className="settings-side"><section className="panel workspace-plan"><PanelHeader title="Your workspace" action={<Badge tone="blue">{data.demo ? "Demo" : data.subscription?.plan || "Pilot"}</Badge>} /><div className="plan-usage"><span>Enquiries</span><strong>{data.leads.length}</strong><div><i style={{ width: `${Math.min(100, data.leads.length / 1000 * 100)}%` }} /></div><small>{data.members?.filter(member => member.status === "active").length || 0} active team members · {data.articles.length} knowledge sources</small></div>{admin && <><Link href="/team" className="button secondary full-width">Manage your team<ArrowUpRight size={14} /></Link><Link href="/integrations" className="button ghost full-width">Connected tools<Plug size={14} /></Link></>}</section><section className="panel workspace-info"><h2>Under the hood</h2><dl><dt>Authentication</dt><dd>{data.actor?.backend === "workos" ? "WorkOS AuthKit" : "Local evaluation"}</dd><dt>Database</dt><dd>{data.actor?.backend === "workos" ? "Neon PostgreSQL" : "SQLite preview"}</dd><dt>File storage</dt><dd>{data.integrations?.storage ? "Cloudflare R2" : "R2 · setup required"}</dd><dt>Workspace ID</dt><dd><code>{data.id}</code></dd></dl></section><p className="settings-note"><ShieldCheck size={16} />Connections, knowledge and conversations are scoped to your institute.</p></div>
    </div>
    <BillingPanel workspace={data} onUpdated={refresh} />
    <DeferredIntakePanel />
    {auth && <AuthDialog mode={auth} onMode={setAuth} onClose={() => setAuth(null)} />}
  </>;
}

function AuthDialog({ mode, onMode, onClose }: { mode: "register" | "login"; onMode: (mode: "register" | "login") => void; onClose: () => void }) {
  const { setData } = useData();
  const [error, setError] = useState(""), [loading, setLoading] = useState(false);
  return <Dialog title={mode === "register" ? "A fresh start for your institute." : "Welcome back."} onClose={onClose}><p className="dialog-intro">Local evaluation account. Production sign-in uses WorkOS AuthKit.</p><form key={mode} onSubmit={async event => { event.preventDefault(); const form = new FormData(event.currentTarget); setLoading(true); setError(""); try { const response = await fetch("/api/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: mode, email: form.get("email"), password: form.get("password"), ...(mode === "register" ? { name: form.get("name"), institute: form.get("institute") } : {}) }) }); const result = await readJsonResponse<Workspace>(response, "This account could not be opened."); setData(result as Workspace); onClose(); } catch (error) { setError(error instanceof Error ? error.message : "This account could not be opened."); } finally { setLoading(false); } }}>{mode === "register" && <><Field label="Your name" name="name" required autoComplete="name" /><Field label="Institute name" name="institute" required autoComplete="organization" /></>}<Field label="Email address" name="email" type="email" required autoComplete="email" /><Field label="Password" name="password" type="password" required minLength={10} maxLength={200} autoComplete={mode === "register" ? "new-password" : "current-password"} hint="At least 10 characters." />{error && <p className="inline-error" role="alert">{error}</p>}<Button variant="primary" className="full-width" loading={loading} type="submit">{mode === "register" ? "Create workspace" : "Sign in"}<ArrowUpRight size={15} /></Button><p className="auth-switch">{mode === "register" ? "Already have a workspace?" : "New to AdmitFlow?"}<button type="button" onClick={() => { setError(""); onMode(mode === "register" ? "login" : "register"); }}>{mode === "register" ? "Sign in" : "Create workspace"}</button></p></form></Dialog>;
}
