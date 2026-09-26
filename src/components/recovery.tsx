"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, RotateCcw, Plus, Pause, Play, CheckCheck, Users, Clock3, ShieldCheck, ArrowUpRight, MessageSquare, ChevronDown, GripVertical, Search, RefreshCw } from "lucide-react";
import { useData, workspaceAccess, assignableMembers, recordOwnerId, ownerLabel, memberLabel, canWorkRecord, useWhatsAppTemplates, templateBody, templateIssue } from "./provider";
import { Avatar, Badge, Button, Dialog, EmptyState, Field, PageHeading, Score, SelectField, TextareaField } from "./ui";
import { STAGES, type Stage, currency, recoverableLeads, isStale, contactBlock, relativeTime, scoreLead } from "@/lib/domain";

export function PipelinePage({ onOpen, onAdd }: { onOpen: (id: string) => void; onAdd: () => void }) {
  const { data, act, busy, notify } = useData();
  const access = workspaceAccess(data), members = assignableMembers(data);
  const [query, setQuery] = useState(""), [ownerId, setOwnerId] = useState(""), [selectedStage, setSelectedStage] = useState("All stages"), [sort, setSort] = useState("intent");
  const [dragTarget, setDragTarget] = useState<Stage | null>(null);
  const leads = data.leads.filter(lead => `${lead.name} ${lead.course} ${lead.phone}`.toLowerCase().includes(query.toLowerCase()) && (!ownerId || recordOwnerId(data, lead) === ownerId))
    .sort((a, b) => (sort === "intent" ? scoreLead(b).score - scoreLead(a).score : 0) || b.createdAt.localeCompare(a.createdAt));
  async function move(id: string, stage: Stage) {
    const lead = data.leads.find(item => item.id === id);
    if (!lead || !canWorkRecord(data, lead) || lead.stage === stage || busy) return;
    if (await act({ type: "lead.update", id, changes: { stage } })) notify(`${lead.name} moved to ${stage}.`);
  }
  return <>
    <div className="page-eyebrow"><span>FROM FIRST HELLO TO ADMISSION</span><span className="inline-subtle">{data.leads.filter(lead => !["Admitted", "Lost"].includes(lead.stage)).length} open possibilities</span></div>
    <PageHeading title="Give every enquiry a next step." description="A shared view of your admissions journey, from hello to enrolled.">{access.canWork && <Button action={{ type: "lead.create" }} variant="primary" onClick={onAdd}><Plus size={16} />Add enquiry</Button>}</PageHeading>
    <div className="pipeline-toolbar"><label className="search-input"><Search size={16} /><span className="sr-only">Search pipeline</span><input placeholder="Find a student…" value={query} onChange={event => setQuery(event.target.value)} /></label><label className="compact-select"><span className="sr-only">Visible pipeline stage</span><select value={selectedStage} onChange={event => setSelectedStage(event.target.value)}><option>All stages</option>{STAGES.map(stage => <option key={stage}>{stage}</option>)}</select></label>{access.role !== "counsellor" && <label className="compact-select"><span className="sr-only">Pipeline counsellor</span><select value={ownerId} onChange={event => setOwnerId(event.target.value)}><option value="">All counsellors</option>{members.map(member => <option key={member.id} value={member.id}>{memberLabel(member, members)}</option>)}</select></label>}<label className="compact-select"><span className="sr-only">Sort pipeline</span><select value={sort} onChange={event => setSort(event.target.value)}><option value="intent">Highest intent</option><option value="newest">Newest first</option></select></label>{access.canWork && <span className="muted pipeline-hint"><GripVertical size={14} />Drag a card or use its stage menu.</span>}</div>
    {leads.length ? <div className={`pipeline-board ${selectedStage !== "All stages" ? "single-stage" : ""}`}>{STAGES.filter(stage => selectedStage === "All stages" || selectedStage === stage).map(stage => {
      const group = leads.filter(lead => lead.stage === stage), index = STAGES.indexOf(stage);
      return <section key={stage} className={`pipeline-column ${dragTarget === stage ? "drag-target" : ""}`} onDragOver={event => { if (access.canWork && !busy) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDragTarget(stage); } }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragTarget(null); }} onDrop={event => { event.preventDefault(); setDragTarget(null); void move(event.dataTransfer.getData("text/plain"), stage); }} aria-label={`${stage} enquiries`}>
        <header><span className={`stage-dot stage-${index}`} /><h2>{stage}</h2><span className="count-badge">{group.length}</span></header><p className="column-total">{currency(group.reduce((sum, lead) => sum + lead.value, 0))}<span> course value</span></p>
        <div className="pipeline-cards">{group.map(lead => { const owner = ownerLabel(data, lead), writable = canWorkRecord(data, lead); return <article key={lead.id} className="pipeline-card" draggable={writable && !busy} onDragStart={event => { event.dataTransfer.setData("text/plain", lead.id); event.dataTransfer.effectAllowed = "move"; }} onDragEnd={() => setDragTarget(null)}>
          <button className="card-person" onClick={() => onOpen(lead.id)}><Avatar name={lead.name} small index={index} /><strong>{lead.name}</strong><ArrowUpRight size={14} /></button><span className="course-label">{lead.course}</span><div className="pipeline-card-stats"><strong>{currency(lead.value)}</strong><Score lead={lead} /></div>
          <p className="field-note pipeline-next-action"><Clock3 size={12} />{lead.nextAction || "Set the next step"}</p><div className="pipeline-card-meta"><span title={owner}><Avatar name={owner} small />{owner.split(" ")[0]}</span><span className={isStale(lead) ? "stale" : ""}>{lead.lastContactAt ? relativeTime(lead.lastContactAt) : "Not contacted"}</span></div>
          <label className="stage-select"><span className="sr-only">Stage for {lead.name}</span><select disabled={busy || !writable} value={lead.stage} onChange={event => void move(lead.id, event.target.value as Stage)}>{STAGES.map(value => <option key={value}>{value}</option>)}</select></label>
        </article>; })}</div>{!group.length && <p className="empty-column">Your next {stage.toLowerCase()} enquiry goes here.</p>}
      </section>;
    })}</div> : <EmptyState title="No enquiries match these filters" body="Try another student, course or counsellor to find the next conversation." />}
    <p className="field-note">Pipeline amounts are potential course values. An administrator can record a payment in enquiry details to add revenue to the admission ledger.</p>
  </>;
}

export function RecoveryPage({ onOpen, onImport }: { onOpen: (id: string) => void; onImport: () => void }) {
  const { data, act, busy, notify } = useData();
  const { admin } = workspaceAccess(data);
  const [course, setCourse] = useState("All courses"), [showCreate, setShowCreate] = useState(false), [selection, setSelection] = useState<Set<string>>(new Set()), [tab, setTab] = useState("Recovery queue");
  const allEligible = recoverableLeads(data), eligible = allEligible.filter(lead => course === "All courses" || lead.course === course);
  const chosen = selection.size ? eligible.filter(lead => selection.has(lead.id)) : eligible;
  const blocked = data.leads.filter(lead => isStale(lead) && contactBlock(lead));
  const active = data.campaigns.filter(campaign => campaign.status === "active").length;
  const pending = data.jobs.filter(job => job.status === "pending" && (job.kind || "followup") === "followup" && data.campaigns.some(campaign => campaign.id === job.campaignId && campaign.status === "active")).length;
  const due = data.jobs.filter(job => job.status === "pending" && Date.parse(job.dueAt) <= Date.now()).length;
  function toggle(id: string) { setSelection(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; }); }
  return <>
    <div className="page-eyebrow"><span>GOOD CONVERSATIONS DESERVE A FOLLOW-UP</span>{data.demo && <span className="inline-subtle">Demo campaigns · no external delivery</span>}</div>
    <PageHeading title="A second chance at a first choice." description="Reconnect with interested students who haven’t heard from you in a while.">{admin && <><Button action={{ type: "lead.import" }} onClick={onImport}>Import enquiries</Button><Button action={{ type: "campaign.create" }} variant="primary" disabled={!chosen.length || busy || !data.sequence.enabled} onClick={() => setShowCreate(true)}><RotateCcw size={16} />Create recovery campaign</Button></>}</PageHeading>
    {!data.sequence.enabled && <p className="field-note">Recovery sequences are paused.{admin && <Link href="/automations" className="table-text-action">Review your playbook<ArrowUpRight size={13} /></Link>}</p>}
    <section className="recovery-overview"><div className="recovery-overview-main"><span className="icon-tile"><RotateCcw size={25} /></span><div><span>Ready to reconnect</span><strong>{allEligible.length}<small>eligible enquiries</small></strong></div></div><div><span>High intent</span><strong>{allEligible.filter(lead => scoreLead(lead).score >= 70).length}</strong><small>with clear interest signals</small></div><div><span>Active campaigns</span><strong>{active}</strong><small>{pending} follow-ups scheduled</small></div><div><span>Permission needed</span><strong>{blocked.length}</strong><small>excluded from the recovery queue</small></div></section>
    <div className="view-tabs">{["Recovery queue", "Campaigns"].map(label => <button key={label} className={tab === label ? "active" : ""} aria-pressed={tab === label} onClick={() => setTab(label)}>{label}<span>{label === "Campaigns" ? data.campaigns.length : allEligible.length}</span></button>)}</div>
    {tab === "Recovery queue" ? <section className="panel"><div className="table-toolbar"><div><h2>Worth another conversation</h2><p className="muted small-copy">Open enquiries · 7+ days without contact · opted in</p></div><label className="compact-select"><span className="sr-only">Recovery course filter</span><select value={course} onChange={event => { setCourse(event.target.value); setSelection(new Set()); }}><option>All courses</option>{data.courses.map(value => <option key={value}>{value}</option>)}</select></label></div>
      {eligible.length ? <><div className="recovery-table">{eligible.map((lead, index) => <div className={`recovery-row ${selection.has(lead.id) ? "selected" : ""}`} key={lead.id}><label className="check-cell"><input type="checkbox" checked={selection.has(lead.id)} disabled={!admin} onChange={() => toggle(lead.id)} aria-label={`Select ${lead.name} for recovery`} /></label><button className="person-cell" onClick={() => onOpen(lead.id)}><Avatar name={lead.name} index={index} /><span><strong>{lead.name}</strong><small>{lead.course}</small></span></button><div className="recovery-reason"><strong>{lead.nextAction || "Follow up with this enquiry"}</strong><small>{lead.lastContactAt ? `Last contacted ${relativeTime(lead.lastContactAt)}` : "No contact recorded"}</small></div><Score lead={lead} /><span className="contact-ready"><ShieldCheck size={14} />Opted in</span><button className="quiet-icon" aria-label={`View ${lead.name}`} onClick={() => onOpen(lead.id)}><ArrowUpRight size={17} /></button></div>)}</div><footer className="table-footer"><span>{selection.size ? `${chosen.length} selected` : `${eligible.length} eligible enquiries`}</span>{admin && <Button action={{ type: "campaign.create" }} variant="primary" disabled={!chosen.length || !data.sequence.enabled || busy} onClick={() => setShowCreate(true)}>Review audience<ArrowRight size={15} /></Button>}</footer></> : <EmptyState title="You’re up to date here" body="New recoverable enquiries appear after seven days without contact. Active campaign members are excluded." action={admin && <Button action={{ type: "lead.import" }} onClick={onImport}>Import older enquiries</Button>} />}
    </section> : <div className="campaign-list">{data.campaigns.length ? data.campaigns.map(campaign => {
      const jobs = data.jobs.filter(job => job.campaignId === campaign.id), processed = jobs.filter(job => ["accepted", "sent", "demo"].includes(job.status)).length;
      const delivered = jobs.filter(job => data.messages.some(message => message.id === job.messageId && ["delivered", "read"].includes(message.status))).length;
      const unresolved = jobs.filter(job => job.status === "reconcile").length;
      const revenue = data.revenue.filter(event => event.campaignId === campaign.id).reduce((sum, event) => sum + event.amount, 0);
      return <section className="panel campaign-panel" key={campaign.id}><header><span className="campaign-symbol"><RotateCcw size={20} /></span><div><h2>{campaign.name}</h2><p>{campaign.course} · Created {relativeTime(campaign.createdAt)}</p></div><Badge tone={campaign.status === "active" ? "green" : campaign.status === "paused" ? "amber" : "neutral"}>{campaign.status}</Badge></header><div className="campaign-stats"><div><span>Audience</span><strong>{campaign.leadIds.length}<small> enquiries</small></strong></div><div><span>{data.demo ? "Demo follow-ups" : "Provider accepted"}</span><strong>{processed}<small> of {jobs.length}</small></strong></div><div><span>Recorded revenue</span><strong>{currency(revenue)}</strong></div></div>
        <div className="campaign-progress" role="progressbar" aria-label={`${campaign.name} processed follow-ups`} aria-valuenow={processed} aria-valuemin={0} aria-valuemax={Math.max(1, jobs.length)}><span style={{ width: `${jobs.length ? processed / jobs.length * 100 : 0}%` }} /></div>
        <footer><span><Clock3 size={14} />{campaign.delays.map(delay => delay === 0 ? "Now" : `${delay}h`).join(" → ")}</span>{admin && campaign.status !== "completed" && <Button action={{ type: "campaign.toggle", id: campaign.id }} loading={busy} onClick={() => void act({ type: "campaign.toggle", id: campaign.id })}>{campaign.status === "active" ? <Pause size={14} /> : <Play size={14} />}{campaign.status === "active" ? "Pause campaign" : "Resume campaign"}</Button>}{campaign.status === "completed" && <span className="muted"><CheckCheck size={15} />Sequence processed</span>}</footer>
        <p className="field-note">{data.demo ? "Demo follow-ups are never delivered externally." : `${delivered} delivery/read confirmations. Provider acceptance alone does not confirm delivery.`}{campaign.templateName && ` Template: ${campaign.templateName} · ${campaign.templateLanguage || "en"}.`}</p>
        {unresolved > 0 && <p className="inline-error">{unresolved} follow-up{unresolved > 1 ? "s have" : " has"} unresolved delivery. Await signed provider status; these messages cannot be resent from a retry control.</p>}
        {jobs.some(job => job.status === "failed") && <p className="inline-error">Some operations failed. Review their details in AI & automations.</p>}
      </section>;
    }) : <EmptyState title="Your first recovery campaign starts here" body="Choose an audience from the recovery queue, then preview your follow-up sequence." />}</div>}
    <section className="recovery-rules"><div><ShieldCheck size={19} /><h3>A thoughtful follow-up, by design.</h3></div><p>Sequences stop when a student replies, opts out, books a session, or is handed to a counsellor. Unknown contact permissions and closed enquiries are excluded.</p>{blocked.length > 0 && <details><summary>{blocked.length} enquiries excluded from outreach<ChevronDown size={14} /></summary>{blocked.map(lead => <button key={lead.id} onClick={() => onOpen(lead.id)}><span>{lead.name}</span><small>{contactBlock(lead)}</small><ArrowUpRight size={14} /></button>)}</details>}<div className="run-jobs"><span>{data.demo ? "Demo mode: processing records sample follow-ups without contacting anyone." : "Scheduled follow-ups run through your institute’s background worker."}</span>{admin && <Button loading={busy} disabled={!due} onClick={async () => { const result = await act<{ processed: number }>({ type: "jobs.run" }); if (result) notify(`${result.processed} due jobs processed${data.demo ? " in demo mode" : ""}.`); }}><Play size={14} />Run due jobs</Button>}</div></section>
    {showCreate && admin && <CampaignDialog leadIds={chosen.map(lead => lead.id)} course={course} onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); setSelection(new Set()); setTab("Campaigns"); }} />}
  </>;
}

function CampaignDialog({ leadIds, course, onClose, onCreated }: { leadIds: string[]; course: string; onClose: () => void; onCreated: () => void }) {
  const { data, act, busy, notify } = useData();
  const options = useWhatsAppTemplates();
  const [demoMessage, setDemoMessage] = useState("Hi {name}, you enquired about {course} at {institute}. Are you still looking for a batch? I can help you book a counselling session. Reply STOP to opt out.");
  const [selected, setSelected] = useState("");
  const [step, setStep] = useState(0), [confirmed, setConfirmed] = useState(false);
  const [name, setName] = useState(`${course === "All courses" ? "Enquiry" : course} recovery`);
  const stageHeading = useRef<HTMLHeadingElement>(null);
  const submitting = useRef(false);
  useEffect(() => { if (step > 0) stageHeading.current?.focus(); }, [step]);
  const templateKey = (name: string, language: string) => `${name}:${language}`;
  useEffect(() => {
    if (!options.templates.length) return;
    setSelected(current => options.templates.some(template => templateKey(template.name, template.language) === current) ? current : (() => {
      const preferred = options.templates.find(template => template.name === options.connection?.metadata.templateName && template.language === options.connection?.metadata.templateLanguage);
      const first = preferred || options.templates.find(template => !templateIssue(template));
      return first ? templateKey(first.name, first.language) : "";
    })());
  }, [options.templates, options.connection?.metadata.templateName, options.connection?.metadata.templateLanguage]);
  const template = options.templates.find(item => templateKey(item.name, item.language) === selected);
  const message = data.demo ? demoMessage : templateBody(template), issue = data.demo ? null : templateIssue(template);
  const lead = data.leads.find(item => item.id === leadIds[0]);
  const values: Record<string, string> = { name: lead?.name.split(" ")[0] || "Student", course: lead?.course || "your course", institute: data.name, "1": lead?.name.split(" ")[0] || "Student", "2": lead?.course || "your course", "3": data.name };
  const preview = message.replace(/\{\{\s*(\w+)\s*\}\}|\{(name|course|institute)\}/g, (match, meta: string, demo: string) => values[meta || demo] || match);
  const audienceReady = leadIds.length > 0 && leadIds.length <= 1000 && data.sequence.enabled;
  const messageReady = !issue && Boolean(message.trim()) && (data.demo || options.enabled && !options.isFetching && !options.isError);
  const canContinue = audienceReady && Boolean(name.trim()) && (step === 0 || messageReady);
  return <Dialog title="Start a recovery conversation" onClose={onClose} wide><form onSubmit={async event => {
    event.preventDefault();
    if (busy || submitting.current) return;
    if (!canContinue) { notify(issue || "Check your campaign name, audience, message and recovery settings.", "error"); return; }
    if (step < 2) { setConfirmed(false); setStep(value => value + 1); return; }
    if (!confirmed) return;
    submitting.current = true;
    try {
      const result = await act({ type: "campaign.create", name: name.trim(), message, leadIds, course, templateName: data.demo ? "demo_recovery" : template!.name, templateLanguage: data.demo ? "en" : template!.language });
      if (result) { notify(data.demo ? "Demo campaign scheduled. No external messages will be delivered." : "Campaign scheduled with the selected Meta template."); onCreated(); }
    } finally { submitting.current = false; }
  }}>
    <ol className="campaign-steps" aria-label="Campaign setup progress">{["Audience", "Message", "Review"].map((label, index) => <li key={label} aria-current={step === index ? "step" : undefined}><b>{index + 1}</b>{label}</li>)}</ol>
    <h3 className="campaign-stage-title" tabIndex={-1} ref={stageHeading}>{["Choose who to reconnect with", "Shape the next conversation", "Review before scheduling"][step]}</h3>
    <fieldset hidden={step !== 0} disabled={step !== 0 || busy} style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className="sr-only">Campaign audience</legend>
      <Field label="Campaign name" name="name" required value={name} onChange={event => setName(event.target.value)} maxLength={100} />
      <div className="audience-chip"><Users size={16} /><strong>{leadIds.length} opted-in enquiries</strong><span>{course}</span></div>
      <p className="field-note">Only eligible enquiries from your selected recovery queue are included. Permissions and eligibility are checked again by the server.</p>
      <ul className="campaign-audience-list">{data.leads.filter(item => leadIds.includes(item.id)).map(item => <li key={item.id}><strong>{item.name}</strong><small>{item.course}</small></li>)}</ul>
      {!audienceReady && <p role="alert" className="inline-error">Choose 1–1,000 enquiries and enable recovery sequences before continuing.</p>}
    </fieldset>
    <div hidden={step === 0}><div className="campaign-builder"><div>
      {step === 2 && <div className="campaign-review"><strong>{name}</strong><p>{leadIds.length} opted-in enquiries · {course}</p><p>{data.demo ? "Simulation only. No students will be contacted." : "Live campaign. Scheduled jobs can send the approved template to these students."}</p></div>}
      <fieldset hidden={step !== 1} disabled={step !== 1 || busy} style={{ border: 0, padding: 0, margin: 0 }}><legend className="sr-only">Campaign message</legend>
      {data.demo ? <><TextareaField label="Message preview" name="message" value={demoMessage} onChange={event => setDemoMessage(event.target.value)} required maxLength={1500} rows={6} /><p className="field-note">Edit this demo freely. Use {"{name}"}, {"{course}"} and {"{institute}"} to personalise the preview. Demo campaigns never contact students.</p></> : <>
        <SelectField label="Approved Meta template" value={selected} disabled={options.isFetching || !options.enabled} required onChange={event => setSelected(event.target.value)}><option value="">{options.isFetching ? "Loading approved templates…" : "Choose an approved template"}</option>{options.templates.map(item => <option key={item.id} value={templateKey(item.name, item.language)} disabled={Boolean(templateIssue(item))}>{item.name} · {item.language}{templateIssue(item) ? " · unsupported variables" : ""}</option>)}</SelectField>
        {!options.enabled && <p className="field-note">Configure a verified WhatsApp account in <Link href="/integrations">Integrations</Link> to load approved Meta templates.</p>}
        {options.isError && <p className="inline-error" role="alert">{options.error.message}</p>}
        {options.enabled && <Button variant="ghost" loading={options.isFetching} onClick={() => void options.refetch()}><RefreshCw size={14} />Refresh templates</Button>}
        {options.enabled && !options.isPending && !options.isError && !options.templates.length && <p className="field-note">No approved templates were returned by Meta. Approve a template in WhatsApp Manager, then refresh.</p>}
        {template && <><TextareaField label="Approved template body" value={message} readOnly rows={6} /><p className="field-note">{template.category} · {template.language}. Meta-approved copy is used for live outreach. Body variables support name, course and institute.</p></>}
        {template && issue && <p className="inline-error">{issue}</p>}
      </>}</fieldset>
    </div><div className="campaign-preview"><span className="preview-label"><MessageSquare size={15} />Conversation preview</span><div className="preview-message">{preview || "Choose a template to preview the first conversation."}<small>{data.demo ? "Demo preview · no external message" : "Personalised Meta template preview · delivery requires provider confirmation"}</small></div><div className="sequence-mini">{data.sequence.delays.map((delay, index) => <div key={index}><i>{index + 1}</i><span>{index === 0 ? "First conversation" : `Follow-up ${index}`}<small>{delay === 0 ? "When the next job runs" : `After ${delay} hours, if no reply`}</small></span></div>)}</div></div></div>
    <p className="field-note"><ShieldCheck size={15} />Up to {leadIds.length * data.sequence.delays.length} {data.demo ? "simulated follow-ups" : "template messages"}. A reply, booking, opt-out or counsellor takeover stops further recovery sends.</p></div>
    {step === 2 && <label className="checkbox-line"><input type="checkbox" required checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />{data.demo ? "I reviewed this simulated campaign. No external messages will be sent." : "I reviewed the audience and approved message for this live campaign."}</label>}
    <div className="dialog-actions"><Button type="button" disabled={busy} onClick={onClose}>Cancel</Button>{step > 0 && <Button type="button" disabled={busy} onClick={() => { setConfirmed(false); setStep(value => value - 1); }}>Back</Button>}<Button action={{ type: "campaign.create" }} variant="primary" type="submit" loading={busy} disabled={!canContinue || step === 2 && !confirmed}>{step < 2 ? <>{step === 0 ? "Continue to message" : "Review campaign"}<ArrowRight size={16} /></> : <><RotateCcw size={16} />{data.demo ? "Schedule demo campaign" : "Schedule campaign"}</>}</Button></div>
  </form></Dialog>;
}
