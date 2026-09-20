"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowUpRight, CalendarDays, ChevronRight, MessageSquare, Search, Send, UserRound, Sparkles, Check, CheckCheck, Clock3, NotebookPen, RefreshCw, Paperclip, Smile, X, FileText, Play, Mic, ShieldCheck, CircleAlert } from "lucide-react";
import { useData, workspaceAccess, assignableMembers, recordOwnerId, ownerLabel, memberLabel, canWorkRecord, paidActionBlocked } from "./provider";
import { Avatar, Badge, Button, EmptyState, IconButton, PageHeading, Score, SelectField, Dialog, TextareaField } from "./ui";
import { type Lead, type Message, type Workspace, type WorkspaceFile, relativeTime, currency, dateLabel, replyBlock } from "@/lib/domain";
import { uploadFile } from "./configuration";
import { indexInboxMessages } from "@/lib/inbox-index";

export function InboxPage({ initialLead, onOpen, onBook }: { initialLead?: string; onOpen: (id: string) => void; onBook: (id: string) => void }) {
  const { data, act, busy, refresh, notify } = useData();
  const access = workspaceAccess(data), members = assignableMembers(data);
  const [selected, setSelected] = useState(initialLead || ""), [mobileThread, setMobileThread] = useState(Boolean(initialLead)), [query, setQuery] = useState(""), [filter, setFilter] = useState("All"), [simulation, setSimulation] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { byLead, leadIds, latest } = useMemo(() => indexInboxMessages(data.messages), [data.messages]);
  const filesById = useMemo(() => new Map(data.files?.map(file => [file.id, file])), [data.files]);
  const lastFor = (id: string) => latest.get(id);
  const conversations = data.leads.filter(lead => (leadIds.has(lead.id) || lead.id === initialLead)
    && `${lead.name} ${lead.course} ${lead.phone} ${lead.email}`.toLowerCase().includes(query.toLowerCase()))
    .filter(lead => filter === "All" || filter === "Needs reply" && lastFor(lead.id)?.direction === "inbound" || filter === "AI owned" && !lead.humanOwned)
    .sort((a, b) => (lastFor(b.id)?.createdAt || "").localeCompare(lastFor(a.id)?.createdAt || "") || a.name.localeCompare(b.name));
  const lead = conversations.find(item => item.id === selected) || conversations[0], thread = lead ? byLead.get(lead.id) || [] : [];
  const writable = Boolean(lead && canWorkRecord(data, lead)), owner = lead ? ownerLabel(data, lead) : "Unassigned", ownerId = lead ? recordOwnerId(data, lead) : null;
  const whatsapp = data.connections?.find(connection => connection.service === "whatsapp");
  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [lead?.id, thread.length, mobileThread]);
  useEffect(() => { if (initialLead) { setSelected(initialLead); setMobileThread(true); } }, [initialLead]);
  return <>
    <div className="inbox-heading"><PageHeading title="Good conversations, all in one place." description="Your team, your assistant and the full picture."><Badge tone={data.demo ? "neutral" : whatsapp?.status === "error" || whatsapp?.status === "unverified" ? "amber" : data.integrations?.whatsapp ? "green" : "neutral"}><span className="status-dot" />{data.demo ? "Demo conversations" : whatsapp?.status === "error" ? "WhatsApp needs attention" : whatsapp?.status === "unverified" ? "WhatsApp unverified" : data.integrations?.whatsapp ? "WhatsApp configured" : "Connect WhatsApp"}</Badge><IconButton label="Refresh conversations" onClick={() => void refresh()}><RefreshCw size={16} /></IconButton></PageHeading></div>
    <section className={`inbox-layout ${mobileThread ? "thread-open" : ""}`}>
      <aside className="conversation-list"><header><div className="inbox-list-heading"><h2>Inbox<span>{conversations.length}</span></h2><IconButton label="Find a student to message" onClick={() => location.assign("/leads")}><NotebookPen size={16} /></IconButton></div><label className="search-input"><Search size={15} /><span className="sr-only">Search conversations</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search conversations…" /></label><div className="inbox-filters">{["All", "Needs reply", "AI owned"].map(value => <button key={value} aria-pressed={filter === value} className={filter === value ? "active" : ""} onClick={() => { setFilter(value); setSelected(""); }}>{value}</button>)}</div></header>
        <div className="conversation-scroll">{conversations.map(item => { const last = lastFor(item.id), waiting = last?.direction === "inbound"; return <button key={item.id} className={`conversation-row ${lead?.id === item.id ? "active" : ""}`} aria-current={lead?.id === item.id ? "true" : undefined} onClick={() => { setSelected(item.id); setMobileThread(true); if (item.unread && canWorkRecord(data, item)) void act({ type: "message.read", id: item.id }); }}><span className="conversation-avatar"><Avatar name={item.name} />{!item.humanOwned && <i><Sparkles size={9} /></i>}</span><span className="conversation-copy"><span><strong>{item.name}</strong><small>{last ? relativeTime(last.createdAt) : "New"}</small></span><p>{last?.direction === "outbound" ? last.author === "AdmitFlow AI" ? "AI: " : "Team: " : ""}{last?.body || "Start a conversation"}</p><span><small className="conversation-course">{item.course}</small>{waiting && <span className="unread-dot" aria-label="Needs reply" />}</span></span></button>; })}{!conversations.length && <EmptyState title="A little quiet here" body="Try another filter or start from an enquiry." />}</div>
        {data.demo && access.admin && <button className="inbox-demo-tool" onClick={() => setSimulation(true)} disabled={!lead}><Play size={13} />Try an incoming message<ArrowUpRight size={13} /></button>}
      </aside>
      {lead ? <>
        <div className="message-thread"><header className="thread-header"><IconButton label="Back to conversations" className="mobile-back" onClick={() => setMobileThread(false)}><ArrowLeft size={18} /></IconButton><Avatar name={lead.name} /><div><h2>{lead.name}</h2><span><MessageSquare size={11} />WhatsApp <i />{lead.phone.startsWith("meta:") ? "Phone number needed" : lead.phone}</span></div><div className="thread-header-actions"><IconButton label="Open student details" onClick={() => onOpen(lead.id)}><ArrowUpRight size={17} /></IconButton>{writable && <Button className="context-book" aria-label={`Book counselling for ${lead.name}`} onClick={() => onBook(lead.id)}><CalendarDays size={15} /><span>Book counselling</span></Button>}</div></header>
          <div className={`thread-context ${lead.humanOwned ? "human-context" : "ai-context"}`}><span>{lead.humanOwned ? <UserRound size={13} /> : <Sparkles size={13} />}{lead.humanOwned ? `With ${owner}` : data.ai?.mode === "paused" ? "Your assistant is paused" : data.ai?.mode === "assisted" ? "Co-pilot replies are reviewed by your team" : "Your assistant is handling this conversation"}</span>{writable && <button disabled={busy || paidActionBlocked(data, { type: "lead.update", changes: { humanOwned: !lead.humanOwned } })} onClick={() => void act({ type: "lead.update", id: lead.id, changes: { humanOwned: !lead.humanOwned } })}>{lead.humanOwned ? "Enable AI" : "Take over"}<ChevronRight size={12} /></button>}</div>
          <div className="messages-scroll" ref={scrollRef}>{thread.length ? thread.map((message, index) => <div key={message.id}>{(index === 0 || dateLabel(thread[index - 1].createdAt) !== dateLabel(message.createdAt)) && <div className="message-date"><span>{dateLabel(message.createdAt, { day: "numeric", month: "long" })}</span></div>}<MessageBubble message={message} file={message.fileId ? filesById.get(message.fileId) : undefined} /></div>) : <EmptyState title="A good conversation starts with hello" body="Write a reply, or let your knowledge base give you a head start." />}</div>
          {writable ? <ReplyComposer key={`${data.id}:${data.actor?.id}:${lead.id}`} lead={lead} /> : <div className="message-composer"><p className="composer-hint"><ShieldCheck size={13} />Your role has read-only access to this conversation.</p></div>}
        </div>
        <aside className="inbox-details"><header><span>ENQUIRY CONTEXT</span><button className="quiet-icon" aria-label="View complete enquiry" onClick={() => onOpen(lead.id)}><ArrowUpRight size={15} /></button></header><div className="inbox-profile"><Avatar name={lead.name} /><h3>{lead.name}</h3><span>{lead.course}</span><Badge tone={lead.stage === "Admitted" ? "green" : "blue"}><i className="status-dot" />{lead.stage}</Badge></div><div className="inbox-facts"><div><span>Intent</span><Score lead={lead} /></div><div><span>Course value</span><strong>{currency(lead.value)}</strong></div><div><span>Source</span><strong>{lead.source}</strong></div><div><span>Enquired on</span><strong>{dateLabel(lead.createdAt)}</strong></div></div>
          <SelectField label="Assigned counsellor" value={ownerId || ""} disabled={!access.admin || busy} onChange={event => void act({ type: "lead.update", id: lead.id, changes: { ownerId: event.target.value || null } })}><option value="">Unassigned</option>{ownerId && !members.some(member => member.id === ownerId) && <option value={ownerId} disabled>{owner} · inactive</option>}{members.map(member => <option key={member.id} value={member.id}>{memberLabel(member, members)}</option>)}</SelectField>
          <div className="inbox-note"><h3><NotebookPen size={13} />A little context</h3><p>{lead.notes || "Add a note to help the next conversation."}</p></div><div className="inbox-next-action"><span>NEXT STEP</span><p><Clock3 size={13} />{lead.nextAction}</p></div>{writable && <Button variant="primary" onClick={() => onBook(lead.id)}><CalendarDays size={15} />Book counselling</Button>}<Button variant="ghost" onClick={() => onOpen(lead.id)}>Full enquiry details<ArrowUpRight size={14} /></Button>
        </aside>
      </> : <div className="inbox-empty"><EmptyState title="Every hello belongs somewhere" body="Choose a conversation to see its story." /></div>}
    </section>
    {simulation && lead && access.admin && <Dialog title="Try your assistant’s next conversation" onClose={() => setSimulation(false)}><p className="dialog-intro">Simulate a student message for {lead.name}. This stays inside your demo workspace.</p><form onSubmit={async event => { event.preventDefault(); const form = new FormData(event.currentTarget); const result = await act({ type: "message.simulate", leadId: lead.id, body: form.get("body"), echo: form.get("echo") === "on" }); if (result) { setSimulation(false); notify("Demo message processed."); } }}><TextareaField name="body" label="Student message" required rows={4} maxLength={4000} defaultValue="Hi! Could you tell me about your NEET course and fees?" /><label className="checkbox-line"><input type="checkbox" name="echo" />Simulate a counsellor reply from the Business app</label><p className="field-note">{lead.humanOwned ? "This conversation is with a counsellor. Enable AI in the thread to test autonomous replies." : data.ai?.mode === "autonomous" ? "Your autonomous demo assistant will respond using institute knowledge." : "Switch the assistant to autonomous mode to test automatic demo replies."} Simulated echoes do not verify live Business-app coexistence.</p><div className="dialog-actions"><Button onClick={() => setSimulation(false)}>Cancel</Button><Button type="submit" variant="primary" loading={busy}>Simulate message<Play size={14} /></Button></div></form></Dialog>}
  </>;
}

type SendRequest = { type: "message.send"; leadId: string; body: string; requestId: string; fileId?: string };
type Suggestion = { body: string; source: string; mode: string; retrievalMode?: string; retrievalNote?: string };

function ReplyComposer({ lead }: { lead: Lead }) {
  const { data, act, busy, refresh, setData, notify } = useData();
  const draft = data.messages.find(message => message.leadId === lead.id && message.status === "draft");
  const [body, setBody] = useState(draft?.body || ""), [source, setSource] = useState(draft?.source || ""), [mode, setMode] = useState<"reply" | "note">("reply");
  const [draftMode, setDraftMode] = useState(draft ? "Saved draft" : ""), [retrieval, setRetrieval] = useState("");
  const [fileId, setFileId] = useState(""), [uploading, setUploading] = useState(false), [sending, setSending] = useState(false), [checking, setChecking] = useState(false), [ready, setReady] = useState(false);
  const [pending, setPending] = useState<SendRequest | null>(null), [outcomeNote, setOutcomeNote] = useState("");
  const pendingRef = useRef<SendRequest | null>(null), submitting = useRef(false), fileInput = useRef<HTMLInputElement>(null);
  const storageKey = `admitflow:send:${data.id}:${data.actor?.id || "local"}:${lead.id}`, draftKey = `admitflow:draft:${data.id}:${data.actor?.id || "local"}:${lead.id}`;
  const file = data.files?.find(item => item.id === fileId), captionLimit = fileId && !file?.mime.startsWith("audio/") ? 1024 : 4000;
  const pendingMessage = pending ? data.messages.find(message => message.id === pending.requestId) : undefined;
  const reconciliationOnly = pendingMessage?.status === "reconcile" || pendingMessage?.dispatchState === "uncertain";
  const block = paidActionBlocked(data, { type: "message.send" }) ? data.capabilities!.message : lead.consent === "opted_out" ? "This student has opted out." : lead.isMinor && !lead.guardianConsent ? "Guardian consent needs attention." : ["Admitted", "Lost"].includes(lead.stage) ? "This enquiry is closed." : data.demo ? null : replyBlock(lead);
  const canSend = !block && Boolean(data.demo || data.integrations?.whatsapp), locked = Boolean(pending) || sending;

  function remember(request: SendRequest | null) {
    pendingRef.current = request; setPending(request);
    try { if (request) sessionStorage.setItem(storageKey, JSON.stringify(request)); else sessionStorage.removeItem(storageKey); } catch { /* In-memory identity is still retained when browser storage is disabled. */ }
  }
  function complete(message: Message) {
    if (pendingRef.current?.requestId !== message.id) return;
    remember(null); setBody(""); setSource(""); setFileId(""); setDraftMode(""); setRetrieval(""); setOutcomeNote("");
    try { sessionStorage.removeItem(draftKey); } catch { /* Browser storage is optional. */ }
    if (message.status === "reconcile") notify("Delivery is unresolved. Await provider status; this request will not be resent.", "error");
    else if (message.status === "failed") notify(message.error || "The reply failed. Its status is recorded in this thread.", "error");
    else if (message.status === "demo") notify("Demo reply saved. No external message was delivered.");
    else if (message.status === "accepted") notify("Meta accepted the reply. Send and delivery confirmation are still pending.");
  }
  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) || "null") as SendRequest | null;
      if (saved?.type === "message.send" && saved.leadId === lead.id && typeof saved.body === "string" && typeof saved.requestId === "string") {
        pendingRef.current = saved; setPending(saved); setBody(saved.body); setFileId(saved.fileId || ""); setOutcomeNote("An earlier request is awaiting confirmation. Check its status or retry that same request.");
      } else {
        const localDraft = JSON.parse(sessionStorage.getItem(draftKey) || "null") as { body?: string; source?: string; fileId?: string } | null;
        if (localDraft && typeof localDraft.body === "string") {
          setBody(localDraft.body); setSource(localDraft.source || "");
          setFileId(data.files?.some(item => item.id === localDraft.fileId && item.status === "ready" && item.leadId === lead.id) ? localDraft.fileId! : "");
          setDraftMode("Saved draft");
        }
      }
    } catch { /* A malformed local draft must not prevent reading the conversation. */ }
    setReady(true);
    // This composer is keyed to workspace, actor and enquiry; restore once, not on incoming messages.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey, draftKey]);
  useEffect(() => {
    if (!pending) return;
    const recorded = data.messages.find(message => message.id === pending.requestId && message.leadId === pending.leadId);
    if (recorded) complete(recorded);
    // Completion is fenced by pendingRef so a late HTTP response cannot complete a second request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.messages, pending]);

  async function checkOutcome(request: SendRequest, allowMissing = false) {
    const response = await fetch("/api/workspace", { cache: "no-store" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "The request status could not be checked.");
    const workspace = result as Workspace;
    setData(workspace);
    const message = workspace.messages.find(item => item.id === request.requestId && item.leadId === request.leadId);
    if (message) complete(message);
    else if (allowMissing && pendingRef.current?.requestId === request.requestId) {
      // A completed, explicit API rejection plus an absent record permits editing the unqueued draft.
      remember(null); setOutcomeNote("The reply was not queued. Review the error, edit the draft, then try again.");
    } else setOutcomeNote("The request is not confirmed yet. Its original identifier is retained; a retry checks the same request.");
  }
  async function refreshOutcome() {
    const request = pendingRef.current; if (!request || checking) return;
    setChecking(true);
    try { await checkOutcome(request); }
    catch (error) { notify(error instanceof Error ? error.message : "The request status could not be checked.", "error"); }
    finally { setChecking(false); }
  }
  async function send() {
    if (submitting.current || !ready || reconciliationOnly || paidActionBlocked(data, { type: "message.send" })) return;
    // The exact payload and UUID survive network errors, navigation and reloads in this browser tab.
    const request = pendingRef.current || { type: "message.send" as const, leadId: lead.id, body: body.trim() || "Shared an attachment.", requestId: crypto.randomUUID(), ...(fileId ? { fileId } : {}) };
    submitting.current = true; setSending(true); remember(request); setOutcomeNote("");
    try {
      const response = await fetch("/api/workspace", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) });
      const result = await response.json() as { workspace?: Workspace; error?: string };
      if (!response.ok) {
        if (pendingRef.current?.requestId !== request.requestId) return;
        notify(result.error || "This request could not be completed.", "error");
        await checkOutcome(request, response.status >= 400 && response.status < 500);
        return;
      }
      if (!result.workspace) throw new Error("The reply response did not include a confirmed workspace state.");
      setData(result.workspace);
      const recorded = result.workspace.messages.find(message => message.id === request.requestId);
      if (recorded) complete(recorded);
      else setOutcomeNote("Confirmation is still pending. Refresh status before taking another action.");
    } catch (error) {
      if (pendingRef.current?.requestId === request.requestId) {
        setOutcomeNote("We couldn’t confirm the result. The original request is saved. Refresh status or retry the same request; do not send a duplicate.");
        notify(error instanceof Error ? error.message : "The reply could not be confirmed.", "error");
        void refresh();
      }
    } finally { submitting.current = false; setSending(false); }
  }
  async function suggest() {
    if (locked) return;
    const result = await act<Suggestion>({ type: "message.suggest", leadId: lead.id });
    if (result) { setBody(result.body); setSource(result.source); setDraftMode(result.mode); setRetrieval([result.retrievalMode ? `${result.retrievalMode} retrieval` : "", result.retrievalNote || ""].filter(Boolean).join(" · ")); setMode("reply"); }
  }
  async function submit(save = false) {
    if (pendingRef.current) { if (!save) await send(); return; }
    if ((!body.trim() && !fileId) || busy || uploading || !ready) return;
    if (mode === "note") {
      if (await act({ type: "message.note", leadId: lead.id, body: body.trim() })) { setBody(""); setDraftMode(""); setSource(""); setRetrieval(""); }
      return;
    }
    if (save || !canSend) {
      if (await act({ type: "message.draft", leadId: lead.id, body: body.trim() || "Shared an attachment.", source: source.slice(0, 200), ...(fileId ? { fileId } : {}) })) {
        try { sessionStorage.setItem(draftKey, JSON.stringify({ body, source, fileId })); } catch { /* The text draft is also stored on the server. */ }
        setDraftMode(fileId ? "Saved draft · attachment on this device" : "Saved draft"); notify("Draft saved.");
      }
      return;
    }
    if (body.trim().length > captionLimit) { notify(`Use at most ${captionLimit.toLocaleString("en-IN")} characters for this reply.`, "error"); return; }
    await send();
  }
  return <form className={`message-composer ${mode === "note" ? "note-composer" : ""}`} onSubmit={event => { event.preventDefault(); void submit(); }}>
    <div className="composer-tools"><div className="composer-mode"><button type="button" aria-pressed={mode === "reply"} className={mode === "reply" ? "active" : ""} disabled={locked} onClick={() => setMode("reply")}><MessageSquare size={13} />Reply</button><button type="button" aria-pressed={mode === "note"} className={mode === "note" ? "active" : ""} disabled={locked || Boolean(fileId)} onClick={() => setMode("note")}><NotebookPen size={13} />Internal note</button></div><Button action={{ type: "message.suggest" }} type="button" variant="ghost" loading={busy} disabled={locked || uploading || !ready} onClick={() => void suggest()}><Sparkles size={14} />Suggest reply</Button></div>
    <label><span className="sr-only">Message reply</span><textarea aria-label="Message reply" value={body} readOnly={locked || !ready} onChange={event => { setBody(event.target.value); setOutcomeNote(""); }} placeholder={mode === "note" ? "A note for your team. Only visible inside AdmitFlow…" : `Write a reply to ${lead.name.split(" ")[0]}…`} rows={3} maxLength={mode === "note" ? 4000 : captionLimit} /></label>
    {source && <div className="draft-source"><FileText size={12} /><span>{source}{retrieval && <small> · {retrieval}</small>}</span><button type="button" aria-label="Hide reply sources" disabled={locked} onClick={() => { setSource(""); setRetrieval(""); }}><X size={12} /></button></div>}
    {fileId && <div className="attachment-chip"><FileText size={14} />{file?.name || "Attachment ready"}<button type="button" aria-label="Remove attachment" disabled={locked} onClick={() => setFileId("")}><X size={12} /></button></div>}
    {fileId && body.trim().length > captionLimit && <p className="inline-error">Image and document captions support at most 1,024 characters. Shorten this caption before sending.</p>}
    {outcomeNote && <div className="send-outcome field-note" role="status"><Clock3 size={14} /><span>{outcomeNote}</span></div>}
    <footer><div className="composer-footer-tools"><IconButton label="Attach a file" disabled={locked || uploading || mode === "note" || data.demo || !data.integrations?.storage || !ready} onClick={() => fileInput.current?.click()}><Paperclip size={17} /></IconButton><IconButton label="Add a smile" disabled={locked || !ready || body.length >= captionLimit - 2} onClick={() => setBody(value => `${value} 🙂`)}><Smile size={17} /></IconButton>{draftMode && <span>{draftMode}</span>}<input ref={fileInput} type="file" className="sr-only" aria-label="Attach message file" disabled={locked || data.demo || !data.integrations?.storage} accept=".pdf,.png,.jpg,.jpeg,.webp,.mp3,.ogg,.m4a,.wav,.aac,.amr,.webm,.txt" onChange={async event => {
      const input = event.currentTarget, attachment = input.files?.[0]; if (!attachment) return;
      setUploading(true);
      try { const id = await uploadFile(attachment, "attachment", lead.id); await refresh(); setFileId(id); }
      catch (error) { notify(error instanceof Error ? error.message : "The attachment could not be uploaded.", "error"); }
      finally { setUploading(false); input.value = ""; }
    }} /></div><div>
      {pending ? <><Button variant="ghost" type="button" loading={checking} disabled={sending} onClick={() => void refreshOutcome()}>Refresh status</Button><Button action={{ type: "message.send" }} type="submit" variant="primary" loading={sending} disabled={checking || reconciliationOnly}>{reconciliationOnly ? "Awaiting provider status" : "Retry same request"}<RefreshCw size={14} /></Button></> : <>{canSend && mode === "reply" && <Button variant="ghost" type="button" disabled={(!body.trim() && !fileId) || busy || uploading || !ready} onClick={() => void submit(true)}>Save draft</Button>}<Button type="submit" variant="primary" loading={sending || busy} disabled={(!body.trim() && !fileId) || uploading || !ready || mode === "reply" && body.trim().length > captionLimit}>{mode === "note" ? "Add note" : canSend ? data.demo ? "Send demo" : "Send reply" : "Save draft"}<Send size={14} /></Button></>}
    </div></footer>
    {mode === "note" ? <p className="composer-hint"><ShieldCheck size={11} />Only your team can see internal notes.</p> : <p className="composer-hint">{data.demo ? "Demo workspace · messages are never delivered externally." : block || (!data.integrations?.whatsapp ? "Connect WhatsApp in Integrations to send replies." : "Meta acceptance is followed by separate send and delivery confirmations.")}</p>}
  </form>;
}

function MessageBubble({ message, file }: { message: Message; file?: WorkspaceFile }) {
  if (message.direction === "internal") return <div className="internal-note"><span><NotebookPen size={12} />{message.author} added a note</span><p>{message.body}</p><small>{dateLabel(message.createdAt, { hour: "numeric", minute: "2-digit" })}</small></div>;
  const audio = message.mediaType === "audio" || file?.mime.startsWith("audio/"), playable = audio && file?.status === "ready" && message.fileId;
  const status: Record<Message["status"], string> = { received: "Received", draft: "Draft", queued: "Queued", accepted: "Accepted · awaiting status", sent: "Sent · awaiting delivery", delivered: "Delivered", read: "Read", failed: "Failed", reconcile: "Unresolved delivery", demo: "Demo · not delivered" };
  const StatusIcon = message.status === "delivered" || message.status === "read" ? CheckCheck : message.status === "sent" ? Check : message.status === "failed" || message.status === "reconcile" ? CircleAlert : Clock3;
  return <div className={`message-wrap ${message.direction}`}><span className="message-author">{message.author === "AdmitFlow AI" && <Sparkles size={11} />}{message.author}</span><div className="message-bubble">
    {audio && <span className="voice-label"><Mic size={13} />Voice note</span>}
    {playable && <audio className="message-audio" style={{ width: "100%", maxWidth: "100%" }} controls preload="none" src={`/api/files?id=${encodeURIComponent(message.fileId!)}`} aria-label={`Voice message from ${message.author}`}>Your browser cannot play this audio. Open the attachment below.</audio>}
    <p>{message.body}</p>
    {message.fileId && <a className="message-file" href={`/api/files?id=${encodeURIComponent(message.fileId)}`}><FileText size={15} />{audio ? "Download audio" : file?.name || "View attachment"}<ArrowUpRight size={12} /></a>}
    <span className="message-meta">{dateLabel(message.createdAt, { hour: "numeric", minute: "2-digit" })}{message.direction === "outbound" && <><StatusIcon size={12} />{status[message.status]}</>}</span>
  </div>{message.voiceFallback && <small className="voice-fallback field-note"><Mic size={12} />Text fallback: {message.voiceFallback}</small>}{message.error && <small className="message-error">{message.error}</small>}{message.status === "accepted" && <small className="message-status-note field-note">Meta accepted this request. Send and delivery status are still pending.</small>}{message.status === "reconcile" && <small className="message-status-note field-note">Delivery is unresolved. Await signed provider status; this message cannot be safely retried.</small>}</div>;
}
