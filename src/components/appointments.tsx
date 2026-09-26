"use client";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarDays, Check, ChevronLeft, ChevronRight, Clock3, Download, Plus, X, GraduationCap, RefreshCw, CalendarClock, UserRoundX, ArrowUpRight } from "lucide-react";
import { useData, assignableMembers, workspaceAccess, recordOwnerId, ownerLabel, memberLabel, canWorkRecord } from "./provider";
import { Avatar, Badge, Button, Dialog, EmptyState, Field, IconButton, PageHeading, SelectField, download } from "./ui";
import { type Appointment, dateLabel, calendarFile, DAY, HOUR } from "@/lib/domain";

const indiaDay = (time = Date.now()) => new Date(time + 5.5 * HOUR).toISOString().slice(0, 10);
const nextIndiaMidnight = (time: number) => Date.parse(`${indiaDay(time)}T00:00:00+05:30`) + DAY;
const indiaTime = (value: string) => new Date(Date.parse(value) + 5.5 * HOUR).toISOString().slice(11, 16);
type Availability = { connected: boolean; busy: { start: string; end: string }[]; checkedAt: string };

function busyAssessment(availability: Availability | undefined, start: string, duration: number, appointment?: Appointment) {
  if (!availability?.connected || !start) return { conflict: false, existingEvent: false };
  const from = Date.parse(start), to = from + duration * 60_000;
  const overlaps = availability.busy.filter(slot => from < Date.parse(slot.end) && to > Date.parse(slot.start));
  if (!overlaps.length) return { conflict: false, existingEvent: false };
  const oldFrom = appointment ? Date.parse(appointment.startsAt) : 0, oldTo = oldFrom + (appointment?.duration || 0) * 60_000;
  // Free/busy has no event IDs. Never claim that an overlapping existing event proves a slot is free.
  const existingEvent = Boolean(appointment?.externalId && overlaps.every(slot => Date.parse(slot.start) >= oldFrom && Date.parse(slot.end) <= oldTo));
  return { conflict: !existingEvent, existingEvent };
}

export function AppointmentsPage({ onBook, onOpen }: { onBook: (id?: string) => void; onOpen: (id: string) => void }) {
  const { data, act, busy, refresh, notify } = useData();
  const access = workspaceAccess(data);
  const [offset, setOffset] = useState(0), [selectedDay, setSelectedDay] = useState(""), [view, setView] = useState("Upcoming"), [rescheduling, setRescheduling] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    function updateTime() {
      const current = Date.now();
      setNow(current);
      const nextStart = data.appointments.reduce((next, appointment) => {
        const start = Date.parse(appointment.startsAt);
        return appointment.status === "scheduled" && start > current ? Math.min(next, start) : next;
      }, Infinity);
      timer = setTimeout(updateTime, Math.min(nextStart, nextIndiaMidnight(current)) - current);
    }
    updateTime();
    return () => clearTimeout(timer);
  }, [data.appointments]);
  const today = indiaDay(now);
  const week = Array.from({ length: 7 }, (_, index) => indiaDay(now + (offset * 7 + index) * DAY));
  const appointments = data.appointments.filter(appointment => (!selectedDay || indiaDay(Date.parse(appointment.startsAt)) === selectedDay)
    && (view === "All sessions" || view === "Needs outcome" && appointment.status === "scheduled" && Date.parse(appointment.startsAt) <= now
      || view === "Upcoming" && appointment.status === "scheduled" && Date.parse(appointment.startsAt) > now))
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const calendarConnected = !data.demo && Boolean(data.integrations?.calendar);
  const needsOutcome = data.appointments.filter(appointment => appointment.status === "scheduled" && Date.parse(appointment.startsAt) <= now).length;
  async function updateStatus(appointment: Appointment, status: "completed" | "cancelled" | "no_show") {
    if (await act({ type: "appointment.status", id: appointment.id, status })) notify(status === "no_show" ? "Session marked as a no-show. You can reschedule it when the student is ready." : status === "cancelled" ? "Session cancelled. Any connected calendar update is queued." : "Session marked complete.");
  }
  return <>
    <div className="page-eyebrow"><span>A TIME FOR THE NEXT STEP</span><span className="inline-subtle"><CalendarDays size={13} />{data.demo ? "Demo calendar" : calendarConnected ? "AdmitFlow → Google" : "Institute calendar"}</span></div>
    <PageHeading title="Make the next conversation count." description="Counselling sessions, campus visits and demo classes, all in India time."><IconButton label="Refresh counselling sessions" onClick={() => void refresh()}><RefreshCw size={16} /></IconButton>{access.canWork && <Button variant="primary" onClick={() => onBook()} disabled={!data.leads.some(lead => canWorkRecord(data, lead)) || !assignableMembers(data).some(member => access.admin || member.id === access.memberId)}><Plus size={16} />Book a session</Button>}</PageHeading>
    <section className="panel calendar-panel"><header className="calendar-header"><div><CalendarDays size={20} /><h2>{dateLabel(`${week[0]}T12:00:00+05:30`, { month: "long", year: "numeric" })}</h2><Badge>IST</Badge></div><div><Button variant="ghost" onClick={() => { setOffset(0); setSelectedDay(today); }}>Today</Button><IconButton label="Previous week" onClick={() => { setOffset(offset - 1); setSelectedDay(""); }}><ChevronLeft size={17} /></IconButton><IconButton label="Next week" onClick={() => { setOffset(offset + 1); setSelectedDay(""); }}><ChevronRight size={17} /></IconButton></div></header>
      <div className="week-strip">{week.map(day => { const count = data.appointments.filter(appointment => appointment.status === "scheduled" && indiaDay(Date.parse(appointment.startsAt)) === day).length; return <button key={day} aria-pressed={selectedDay === day} aria-label={`${dateLabel(`${day}T12:00:00+05:30`, { weekday: "long", day: "numeric", month: "long" })}, ${count} sessions`} className={`${selectedDay === day ? "selected" : ""} ${day === today ? "today" : ""}`} onClick={() => setSelectedDay(selectedDay === day ? "" : day)}><span>{dateLabel(`${day}T12:00:00+05:30`, { weekday: "short" })}</span><strong>{Number(day.slice(-2))}</strong><small>{count ? `${count} session${count > 1 ? "s" : ""}` : "—"}</small></button>; })}</div>
    </section>
    <div className="agenda-toolbar"><div className="view-tabs">{["Upcoming", "Needs outcome", "All sessions"].map(label => <button key={label} className={view === label ? "active" : ""} aria-pressed={view === label} onClick={() => setView(label)}>{label}{label === "Needs outcome" && needsOutcome > 0 && <span>{needsOutcome}</span>}</button>)}</div>{selectedDay && <Button variant="ghost" onClick={() => setSelectedDay("")}>Clear date filter<X size={14} /></Button>}</div>
    <section className="appointment-list">{appointments.length ? appointments.map(appointment => {
      const lead = data.leads.find(item => item.id === appointment.leadId), owner = ownerLabel(data, appointment);
      const writable = Boolean(lead && canWorkRecord(data, lead));
      const syncJobs = data.jobs.filter(job => job.kind === "calendar.sync" && job.payload?.appointmentId === appointment.id);
      const pendingSync = syncJobs.some(job => job.status === "pending" || job.status === "processing");
      const sync = data.demo ? "local" : pendingSync ? "pending" : appointment.syncStatus || "local";
      const syncLabel = data.demo ? "Demo · local session" : sync === "failed" ? "Calendar sync failed" : sync === "synced" ? appointment.status === "cancelled" ? "Removed from Google" : calendarConnected ? "Synced to Google" : "Previously synced to Google" : sync === "pending" ? appointment.status === "cancelled" ? "Cancellation sync pending" : "Calendar sync pending" : "Local session";
      const failedJob = syncJobs.slice().reverse().find(job => job.status === "failed");
      return <article key={appointment.id} className="panel appointment-card">
        <div className="appointment-date"><strong>{dateLabel(appointment.startsAt, { day: "numeric" })}</strong><span>{dateLabel(appointment.startsAt, { month: "short" })}</span></div>
        <div className="appointment-main"><span className="appointment-type">{appointment.kind}</span><button onClick={() => onOpen(appointment.leadId)}>{lead?.name || "Student enquiry"}<ChevronRight size={15} /></button><div><span><Clock3 size={14} />{dateLabel(appointment.startsAt, { hour: "numeric", minute: "2-digit" })} · {appointment.duration} min IST</span><span><Avatar name={owner} small />{owner}</span></div><p className="field-note appointment-sync"><CalendarDays size={12} /><span>{syncLabel}{sync === "failed" && failedJob?.error ? ` · ${failedJob.error}` : ""}</span></p></div>
        <Badge tone={appointment.status === "scheduled" ? "blue" : appointment.status === "completed" ? "green" : appointment.status === "no_show" ? "amber" : "neutral"}>{appointment.status === "no_show" ? "No-show" : appointment.status}</Badge>
        <div className="appointment-actions">
          {appointment.status !== "cancelled" && <IconButton label={`Download calendar invite for ${lead?.name || "student"}`} onClick={() => download(calendarFile(appointment, lead?.name || "Student", data.name), `counselling-${appointment.id}.ics`, "text/calendar;charset=utf-8")}><Download size={17} /></IconButton>}
          {appointment.meetingUrl?.startsWith("https://") && appointment.status === "scheduled" && <a className="button secondary" href={appointment.meetingUrl} target="_blank" rel="noreferrer">Join session<ArrowUpRight size={14} /></a>}
          {writable && ["scheduled", "no_show"].includes(appointment.status) && <Button disabled={busy} onClick={() => setRescheduling(appointment.id)}><CalendarClock size={14} />Reschedule</Button>}
          {writable && appointment.status === "scheduled" && <>
            <Button disabled={busy || Date.parse(appointment.startsAt) > now} onClick={() => void updateStatus(appointment, "completed")}><Check size={14} />Complete</Button>
            <IconButton label={`Mark no-show for ${lead?.name || "student"}`} disabled={busy || Date.parse(appointment.startsAt) > now} onClick={() => void updateStatus(appointment, "no_show")}><UserRoundX size={16} /></IconButton>
            <IconButton label={`Cancel appointment for ${lead?.name || "student"}`} disabled={busy} onClick={() => void updateStatus(appointment, "cancelled")}><X size={16} /></IconButton>
          </>}
        </div>
      </article>;
    }) : <EmptyState title={view === "Needs outcome" ? "No sessions need an outcome here" : "A clear calendar, for now"} body="Choose another date or book a session with an interested student." action={access.canWork && <Button variant="primary" onClick={() => onBook()} disabled={!data.leads.some(lead => canWorkRecord(data, lead)) || !assignableMembers(data).some(member => access.admin || member.id === access.memberId)}>Book a session</Button>} />}</section>
    <p className="field-note"><CalendarDays size={15} />{calendarConnected ? "Sessions sync from AdmitFlow to Google. Changes made in Google are not imported; availability checks are advisory." : data.demo ? "Demo sessions stay inside AdmitFlow. You can download an .ics calendar invite." : "Download an .ics invite for Google Calendar, Outlook or Apple Calendar. Connect Google in Integrations for one-way session updates."}</p>
    {rescheduling && <BookingDialog appointmentId={rescheduling} onClose={() => setRescheduling(null)} />}
  </>;
}

export function BookingDialog({ leadId, appointmentId, onClose }: { leadId?: string; appointmentId?: string; onClose: () => void }) {
  const { data, act, busy, notify } = useData();
  const access = workspaceAccess(data), members = assignableMembers(data).filter(member => access.admin || member.id === access.memberId);
  const appointment = data.appointments.find(item => item.id === appointmentId);
  const bookableLeads = data.leads.filter(lead => canWorkRecord(data, lead));
  const initialLead = bookableLeads.find(lead => lead.id === (appointment?.leadId || leadId)) || bookableLeads[0];
  const [selectedLead, setSelectedLead] = useState(initialLead?.id || "");
  const [ownerId, setOwnerId] = useState(() => {
    const assigned = appointment ? recordOwnerId(data, appointment) : initialLead ? recordOwnerId(data, initialLead) : null;
    return members.find(member => member.id === assigned)?.id || members[0]?.id || "";
  });
  const [day, setDay] = useState(appointment && Date.parse(appointment.startsAt) > Date.now() ? indiaDay(Date.parse(appointment.startsAt)) : indiaDay(Date.now() + DAY));
  const [time, setTime] = useState(appointment ? indiaTime(appointment.startsAt) : "10:00");
  const [duration, setDuration] = useState(appointment?.duration || 30), [kind, setKind] = useState<Appointment["kind"]>(appointment?.kind || "Counselling");
  const [saving, setSaving] = useState(false), submitting = useRef(false);
  const startTime = Date.parse(`${day}T${time}:00+05:30`), startsAt = Number.isFinite(startTime) ? new Date(startTime).toISOString() : "";
  const [now, setNow] = useState(0);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    function updateTime() {
      const current = Date.now();
      setNow(current);
      const nextStart = startTime > current ? startTime : Infinity;
      timer = setTimeout(updateTime, Math.min(nextStart, nextIndiaMidnight(current)) - current);
    }
    updateTime();
    return () => clearTimeout(timer);
  }, [startTime]);
  const connection = data.connections?.find(item => item.service === "google");
  const connected = !data.demo && Boolean(data.integrations?.calendar) && (!connection || connection.status === "connected");
  const availability = useQuery({
    queryKey: ["calendar-busy", data.id, connection?.updatedAt, startsAt, duration],
    enabled: connected && access.canWork && bookableLeads.some(lead => lead.id === selectedLead) && Boolean(startsAt) && startTime > now, staleTime: 0,
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({ from: startsAt, to: new Date(startTime + duration * 60_000).toISOString() });
      const response = await fetch(`/api/integrations/google/busy?${params}`, { cache: "no-store", signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Google availability could not be checked. Please retry.");
      return result as Availability;
    },
  });
  const localConflict = data.appointments.some(item => item.id !== appointmentId && item.status === "scheduled" && recordOwnerId(data, item) === ownerId && startTime < Date.parse(item.startsAt) + item.duration * 60_000 && startTime + duration * 60_000 > Date.parse(item.startsAt));
  const assessment = busyAssessment(availability.data, startsAt, duration, appointment);
  const validOwner = members.some(member => member.id === ownerId);
  if (!access.canWork || appointmentId && !appointment || (appointment?.leadId || leadId) && !bookableLeads.some(lead => lead.id === (appointment?.leadId || leadId))) return <Dialog title="Counselling session" onClose={onClose}><EmptyState title="This session isn’t available" body="An assigned counsellor or administrator can book and reschedule sessions." /></Dialog>;
  return <Dialog title={appointment ? "Find a better time to talk" : "Book a counselling moment"} onClose={onClose}>
    <p className="dialog-intro">{appointment ? "Keep the same session and update its time or counsellor." : "Give the student a time, a person and a clear next step."}</p>
    <form onSubmit={async event => {
      event.preventDefault();
      if (submitting.current || !startsAt || startTime <= Date.now() || !validOwner || !bookableLeads.some(lead => lead.id === selectedLead) || localConflict) return;
      submitting.current = true; setSaving(true);
      try {
        if (connected) {
          const checked = await availability.refetch();
          if (checked.error || !checked.data) { notify(checked.error?.message || "Availability could not be checked. Retry before booking.", "error"); return; }
          if (busyAssessment(checked.data, startsAt, duration, appointment).conflict) { notify("The connected Google calendar reports busy time. Choose another slot.", "error"); return; }
        }
        const result = await act(appointment ? { type: "appointment.reschedule", id: appointment.id, ownerId, startsAt } : { type: "appointment.create", leadId: selectedLead, ownerId, startsAt, duration, kind });
        if (result) { notify(appointment ? "Session rescheduled. Calendar status is shown in the agenda." : data.demo ? "Demo counselling session booked." : "Session booked. Calendar status is shown in the agenda."); onClose(); }
      } finally { submitting.current = false; setSaving(false); }
    }}>
      <SelectField label="Student" value={selectedLead} disabled={Boolean(appointment) || saving} onChange={event => { setSelectedLead(event.target.value); const lead = bookableLeads.find(item => item.id === event.target.value); const assigned = lead && recordOwnerId(data, lead); setOwnerId(members.find(member => member.id === assigned)?.id || members[0]?.id || ""); }} required>{!bookableLeads.length && <option value="">No assigned enquiries</option>}{bookableLeads.map(lead => <option value={lead.id} key={lead.id}>{lead.name} · {lead.course}</option>)}</SelectField>
      <div className="form-grid"><SelectField label="Session type" value={kind} disabled={Boolean(appointment) || saving} onChange={event => setKind(event.target.value as Appointment["kind"])}><option>Counselling</option><option>Demo class</option><option>Campus visit</option></SelectField><SelectField label="Counsellor" name="ownerId" value={ownerId} disabled={!access.admin || saving} required onChange={event => setOwnerId(event.target.value)}>{!members.length && <option value="">No active counsellor</option>}{members.map(member => <option key={member.id} value={member.id}>{memberLabel(member, members)}</option>)}</SelectField><Field label="Session date" type="date" name="date" required min={indiaDay(now)} value={day} disabled={saving} onChange={event => setDay(event.target.value)} /><Field label="Start time (IST)" type="time" name="time" required value={time} disabled={saving} onChange={event => setTime(event.target.value)} /><SelectField label="Duration" value={duration} disabled={Boolean(appointment) || saving} onChange={event => setDuration(Number(event.target.value))}>{[...new Set([30, 45, 60, ...(appointment ? [appointment.duration] : [])])].sort((a, b) => a - b).map(minutes => <option value={minutes} key={minutes}>{minutes} minutes</option>)}</SelectField></div>
      {localConflict && <p className="inline-error" role="alert">This counsellor already has an AdmitFlow session at that time. Choose another slot.</p>}
      {Boolean(startsAt) && startTime <= now && <p className="inline-error" role="alert">Choose a future start time in India time.</p>}
      {connected && <div className="calendar-availability" aria-live="polite">
        {availability.isFetching ? <p className="field-note"><RefreshCw size={14} className="spin" />Checking the connected Google calendar…</p> : availability.isError ? <div className="inline-error"><p>{availability.error.message}</p><Button variant="ghost" onClick={() => void availability.refetch()}><RefreshCw size={14} />Retry availability</Button></div> : availability.data && <p className={assessment.conflict ? "inline-error" : "field-note"}><CalendarDays size={15} /><span>{!availability.data.connected ? "Google did not provide availability. Only AdmitFlow appointment conflicts can be checked." : assessment.conflict ? "Google reports busy time in this slot. Choose another time." : assessment.existingEvent ? "Google reports busy time that may include this session’s existing event. Check the shared calendar before rescheduling; availability is not confirmed." : "No busy time was reported by Google at this check. This is advisory, not a reserved slot."}{availability.data.connected && ` Checked ${dateLabel(availability.data.checkedAt, { hour: "numeric", minute: "2-digit" })} IST.`}</span></p>}
      </div>}
      <div className="booking-note"><CalendarDays size={18} /><p>{appointment ? "Rescheduling updates this AdmitFlow session and queues any connected Google update." : "Booking checks the counsellor’s AdmitFlow sessions and stops this student’s automated recovery follow-ups."}{connected ? " Calendar updates flow from AdmitFlow to Google only." : " External calendar availability is not confirmed."}</p></div>
      <div className="dialog-actions"><Button type="button" onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" loading={saving || busy} disabled={!selectedLead || !validOwner || !startsAt || startTime <= now || localConflict || connected && (availability.isFetching || assessment.conflict || availability.isError)}><CalendarDays size={16} />{appointment ? "Reschedule session" : "Book session"}</Button></div>
    </form>
  </Dialog>;
}

export function RevenueDialog({ leadId, onClose }: { leadId: string; onClose: () => void }) {
  const { data, act, busy } = useData();
  const submitting = useRef(false);
  const lead = data.leads.find(item => item.id === leadId), campaigns = data.campaigns.filter(campaign => campaign.leadIds.includes(leadId));
  if (!workspaceAccess(data).admin) return <Dialog title="Record admission" onClose={onClose}><EmptyState title="Administrator access needed" body="An institute owner or administrator can record admission payments." /></Dialog>;
  if (!lead) return <Dialog title="Record admission" onClose={onClose}><EmptyState title="This enquiry isn’t available" body="Refresh your enquiry list and try again." /></Dialog>;
  return <Dialog title="An enquiry becomes an admission." onClose={onClose}><div className="admission-profile"><span><GraduationCap size={24} /></span><div><h3>{lead.name}</h3><p>{lead.course}</p></div></div><form onSubmit={async event => { event.preventDefault(); if (submitting.current || busy) return; submitting.current = true; try { const form = new FormData(event.currentTarget); const result = await act({ type: "revenue.record", leadId, amount: Number(form.get("amount")), reference: form.get("reference"), campaignId: form.get("campaignId") || null }); if (result) onClose(); } finally { submitting.current = false; } }}><Field label="Payment received (₹)" type="number" name="amount" defaultValue={lead.value || ""} required min={1} max={10000000} step={1} hint="Record the amount actually received, not the full course promise." /><Field label="Receipt or transaction reference" name="reference" required maxLength={100} placeholder="e.g. ADM-2026-0142" /><SelectField label="Recovery attribution" name="campaignId" defaultValue=""><option value="">Direct admission · no recovery campaign</option>{campaigns.map(campaign => <option key={campaign.id} value={campaign.id}>{campaign.name}</option>)}</SelectField><p className="field-note">This records a payment in your ledger. It does not charge the student or verify a bank transaction.</p><div className="dialog-actions"><Button type="button" onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" loading={busy}><Check size={16} />Record admission</Button></div></form></Dialog>;
}
