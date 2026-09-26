"use client";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useReactTable, getCoreRowModel, flexRender, type ColumnDef, type SortingState, type VisibilityState, type PaginationState } from "@tanstack/react-table";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { Search, Plus, Upload, Download, ChevronRight, ChevronLeft, SlidersHorizontal, Phone, Mail, CalendarDays, MessageSquare, ArrowUpRight, Check, FileSpreadsheet, ArrowLeft, ShieldCheck, Clock3, X, ListFilter, ArrowDownWideNarrow, LayoutList, Sparkles, RefreshCw } from "lucide-react";
import Papa from "papaparse";
import { useData, assignableMembers, workspaceAccess, recordOwnerId, ownerLabel, memberLabel, canWorkRecord, paidActionBlocked } from "./provider";
import { Avatar, Badge, Button, Dialog, EmptyState, Field, PageHeading, Score, SelectField, TextareaField, IconButton, download } from "./ui";
import { type Lead, type Consent, type SavedView, type LeadView, type LeadSort, STAGES, currency, dateLabel, relativeTime, scoreLead, isStale, normalizePhone, exportLeads, resolveSavedViewPreferences } from "@/lib/domain";

import { MAX_LEAD_PAGE, leadPageCount } from "@/lib/lead-pagination";

type LeadPage = { leads: Lead[]; total: number; page: number; pageSize: number; hasMore: boolean };
type Filters = { query: string; course: string; ownerId: string; stage: string; view: LeadView };
const builtInViews: { id: LeadView; label: string }[] = [
  { id: "all", label: "All enquiries" }, { id: "high-intent", label: "High intent" },
  { id: "needs-followup", label: "Needs follow-up" }, { id: "admitted", label: "Admitted" },
];
const sortingFor = (sort: LeadSort): SortingState => [{ id: sort === "newest" ? "createdAt" : sort, desc: sort !== "name" }];
const sortFor = (sorting: SortingState): LeadSort => sorting[0]?.id === "name" ? "name" : sorting[0]?.id === "createdAt" ? "newest" : "intent";

export function LeadsPage({ onOpen, onAdd, onImport }: { onOpen: (id: string) => void; onAdd: () => void; onImport: () => void }) {
  const { data, act, notify, busy } = useData();
  const access = workspaceAccess(data), members = assignableMembers(data);
  const [filters, setFilters] = useState<Filters>({ query: "", course: "", ownerId: "", stage: "", view: "all" });
  const [activeView, setActiveView] = useState("all"), [sorting, setSorting] = useState<SortingState>(sortingFor("intent"));
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 25 });
  const [selection, setSelection] = useState<Record<string, boolean>>({}), [visibility, setVisibility] = useState<VisibilityState>({ createdAt: false });
  const [saveView, setSaveView] = useState(false), [bulkOwner, setBulkOwner] = useState("");
  const sort = sortFor(sorting);
  const page = useQuery({
    queryKey: ["leads", data.id, data.actor?.id, access.role, access.memberId, filters, sort, pagination],
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({ page: String(pagination.pageIndex + 1), pageSize: String(pagination.pageSize), view: filters.view, sort });
      if (filters.query.trim()) params.set("q", filters.query.trim());
      if (filters.course) params.set("course", filters.course);
      if (filters.ownerId) params.set("ownerId", filters.ownerId);
      if (filters.stage) params.set("stage", filters.stage);
      const response = await fetch(`/api/leads?${params}`, { cache: "no-store", signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "These enquiries could not be loaded. Please retry.");
      return result as LeadPage;
    },
  });
  function updateFilters(changes: Partial<Filters>) {
    setFilters(current => ({ ...current, ...changes }));
    setPagination(current => ({ ...current, pageIndex: 0 }));
    setSelection({});
  }
  function chooseSort(value: LeadSort) {
    setSorting(sortingFor(value)); setPagination(current => ({ ...current, pageIndex: 0 })); setSelection({});
  }
  function openSavedView(saved: SavedView) {
    const extra = saved as SavedView & { ownerId?: string };
    let local: unknown;
    if (saved.view == null || saved.sort == null) {
      try { local = JSON.parse(localStorage.getItem(`admitflow:view:${data.id}:${saved.name}`) || "{}"); } catch { /* Older records may have browser-only preferences. */ }
    }
    const preference = resolveSavedViewPreferences(saved, local);
    let ownerId = extra.ownerId ?? saved.owner;
    if (ownerId && ownerId !== "unassigned" && !data.members?.some(member => member.id === ownerId)) {
      ownerId = recordOwnerId(data, { owner: ownerId }) || ownerId;
    }
    updateFilters({ query: saved.query, course: saved.course, stage: saved.stage, ownerId, view: preference.view });
    chooseSort(preference.sort);
    setActiveView(saved.id);
  }
  useEffect(() => {
    if (!page.data || page.isError) return;
    const lastPage = leadPageCount(page.data.total, pagination.pageSize) - 1;
    if (pagination.pageIndex > lastPage) setPagination(current => ({ ...current, pageIndex: lastPage }));
  }, [page.data, page.isError, pagination.pageIndex, pagination.pageSize]);

  const columns = useMemo<ColumnDef<Lead>[]>(() => [
    { id: "select", enableHiding: false, enableSorting: false, header: ({ table }) => <input type="checkbox" aria-label="Select all visible enquiries" checked={table.getIsAllPageRowsSelected()} onChange={table.getToggleAllPageRowsSelectedHandler()} />, cell: ({ row }) => <input type="checkbox" aria-label={`Select ${row.original.name}`} checked={row.getIsSelected()} onChange={row.getToggleSelectedHandler()} /> },
    { id: "name", accessorKey: "name", header: "Student", enableHiding: false, cell: ({ row }) => <button className="person-cell" onClick={() => onOpen(row.original.id)}><Avatar name={row.original.name} /><span><strong>{row.original.name}</strong><small>{row.original.phone.startsWith("meta:") ? "Meta form · phone needed" : row.original.phone.startsWith("wa:") ? "WhatsApp contact" : row.original.phone}</small></span></button> },
    { accessorKey: "course", header: "Course", enableSorting: false, cell: ({ row }) => <span className="course-tag">{row.original.course}</span> },
    { accessorKey: "stage", header: "Stage", enableSorting: false, cell: ({ row }) => <Badge tone={row.original.stage === "Admitted" ? "green" : row.original.stage === "Lost" ? "neutral" : row.original.stage === "Counselling" ? "violet" : "blue"}><i className="status-dot" />{row.original.stage}</Badge> },
    { id: "intent", accessorFn: lead => scoreLead(lead).score, header: "Intent", cell: ({ row }) => <Score lead={row.original} /> },
    { accessorKey: "owner", header: "Counsellor", enableSorting: false, cell: ({ row }) => { const name = ownerLabel(data, row.original); return <span className="owner-cell"><Avatar name={name} small /><span title={name}>{name.split(" ")[0]}</span></span>; } },
    { id: "lastContact", accessorFn: lead => lead.lastContactAt || "", header: "Last contact", enableSorting: false, cell: ({ row }) => <span className={isStale(row.original) ? "contact-age stale" : "contact-age"}><Clock3 size={12} />{row.original.lastContactAt ? relativeTime(row.original.lastContactAt) : "Not contacted"}</span> },
    { id: "createdAt", accessorKey: "createdAt", header: "Enquired", cell: ({ row }) => dateLabel(row.original.createdAt) },
    { id: "open", enableHiding: false, enableSorting: false, header: () => <span className="sr-only">Open enquiry</span>, cell: ({ row }) => <button className="quiet-icon row-open" aria-label={`Open ${row.original.name}`} onClick={() => onOpen(row.original.id)}><ArrowUpRight size={15} /></button> },
  ], [onOpen, data.members]);
  // List rows always come from this query, never from an unfiltered workspace fallback.
  const rows = page.isError ? [] : page.data?.leads || [];
  const table = useReactTable({
    data: rows, columns, state: { sorting, pagination, rowSelection: selection, columnVisibility: visibility },
    getRowId: row => row.id, onRowSelectionChange: setSelection, onColumnVisibilityChange: setVisibility,
    onPaginationChange: next => {
      const updated = typeof next === "function" ? next(pagination) : next;
      if (updated.pageIndex !== pagination.pageIndex || updated.pageSize !== pagination.pageSize) setSelection({});
      setPagination(updated);
    }, onSortingChange: next => {
      const value = typeof next === "function" ? next(sorting) : next;
      chooseSort(sortFor(value));
    },
    getCoreRowModel: getCoreRowModel(), manualPagination: true, manualSorting: true,
    rowCount: page.data?.total || 0, pageCount: leadPageCount(page.data?.total || 0, pagination.pageSize), enableSortingRemoval: false,
  });
  const selectedIds = rows.filter(lead => selection[lead.id]).map(lead => lead.id);
  const exportRows = selectedIds.length ? rows.filter(lead => selection[lead.id]) : rows;
  return <>
    <div className="page-eyebrow"><span>RELATIONSHIPS START HERE</span><span className="inline-subtle"><span className="live-dot" />{data.leads.length} enquiries, one shared workspace</span></div>
    <PageHeading title="Every enquiry. A possibility." description="A little context makes your next conversation a better one.">
      {access.admin && <Button action={{ type: "lead.import" }} onClick={onImport}><Upload size={15} />Import CSV</Button>}
      {access.canWork && <Button action={{ type: "lead.create" }} variant="primary" onClick={onAdd}><Plus size={16} />Add enquiry</Button>}
    </PageHeading>
    <div className="views-bar"><div className="view-tabs" aria-label="Enquiry views">
      {builtInViews.map(item => <button key={item.id} aria-pressed={activeView === item.id} className={activeView === item.id ? "active" : ""} onClick={() => { setActiveView(item.id); updateFilters({ view: item.id }); }}>{item.id === "all" && <LayoutList size={14} />}{item.label}{item.id === "all" && <span>{data.leads.length}</span>}</button>)}
      {(data.savedViews || []).map(saved => <button key={saved.id} aria-pressed={activeView === saved.id || activeView === `saved:${saved.name}`} className={activeView === saved.id || activeView === `saved:${saved.name}` ? "active" : ""} onClick={() => openSavedView(saved)}>{saved.name}</button>)}
    </div><button className="add-view" onClick={() => setSaveView(true)} disabled={(data.savedViews?.length || 0) >= 20}><Plus size={14} />Save view</button></div>
    <section className="panel leads-panel" aria-busy={page.isFetching}>
      <div className="table-toolbar"><label className="search-input"><Search size={16} /><span className="sr-only">Search enquiries</span><input aria-label="Search enquiries" placeholder="Search enquiries…" value={filters.query} maxLength={100} onChange={event => updateFilters({ query: event.target.value })} />{filters.query && <button aria-label="Clear enquiry search" onClick={() => updateFilters({ query: "" })}><X size={13} /></button>}</label>
        <div className="toolbar-controls">
          <label className="compact-select"><ListFilter size={14} /><span className="sr-only">Filter course</span><select value={filters.course} onChange={event => updateFilters({ course: event.target.value })}><option value="">All courses</option>{data.courses.map(item => <option key={item}>{item}</option>)}</select></label>
          <label className="compact-select"><span className="sr-only">Filter stage</span><select value={filters.stage} onChange={event => updateFilters({ stage: event.target.value })}><option value="">All stages</option>{STAGES.map(item => <option key={item}>{item}</option>)}</select></label>
          <label className="compact-select"><span className="sr-only">Filter counsellor</span><select value={filters.ownerId} onChange={event => updateFilters({ ownerId: event.target.value })}><option value="">{access.role === "counsellor" ? "My enquiries" : "All counsellors"}</option>{access.role !== "counsellor" && <option value="unassigned">Unassigned</option>}{members.filter(member => access.role !== "counsellor" || member.id === access.memberId).map(member => <option key={member.id} value={member.id}>{memberLabel(member, members)}</option>)}{filters.ownerId && filters.ownerId !== "unassigned" && !members.some(member => member.id === filters.ownerId) && <option value={filters.ownerId}>Saved counsellor filter</option>}</select></label>
          <label className="compact-select"><ArrowDownWideNarrow size={14} /><span className="sr-only">Sort enquiries</span><select value={sort} onChange={event => chooseSort(event.target.value as LeadSort)}><option value="intent">Highest intent</option><option value="newest">Newest enquiry</option><option value="name">Student name</option></select></label>
          <Dropdown.Root><Dropdown.Trigger asChild><button className="button secondary display-button"><SlidersHorizontal size={14} />Display</button></Dropdown.Trigger><Dropdown.Portal><Dropdown.Content className="dropdown-menu" align="end" sideOffset={6}><Dropdown.Label className="dropdown-label">VISIBLE COLUMNS</Dropdown.Label>{table.getAllLeafColumns().filter(column => column.getCanHide()).map(column => <Dropdown.CheckboxItem key={column.id} className="dropdown-item" checked={column.getIsVisible()} onCheckedChange={value => column.toggleVisibility(value)}><span className="menu-check">{column.getIsVisible() && <Check size={13} />}</span>{String(column.columnDef.header)}</Dropdown.CheckboxItem>)}</Dropdown.Content></Dropdown.Portal></Dropdown.Root>
          <IconButton label={selectedIds.length ? "Export selected enquiries on this page" : "Export current enquiry page"} disabled={page.isFetching || page.isError || !exportRows.length} onClick={() => download(exportLeads(exportRows), "admitflow-enquiries.csv")}><Download size={16} /></IconButton>
        </div>
      </div>
      {page.isError ? <EmptyState title="This view couldn’t load" body={page.error.message} action={<Button onClick={() => void page.refetch()} loading={page.isFetching}><RefreshCw size={15} />Retry enquiry search</Button>} /> : page.isPending ? <div className="empty-state" role="status"><RefreshCw size={21} className="spin" /><p>Loading this enquiry view…</p></div> : rows.length ? <>
        <div className="data-table-wrap"><table className="data-table enquiries-table"><caption className="sr-only">Enquiries</caption><thead>{table.getHeaderGroups().map(group => <tr key={group.id}>{group.headers.map(header => <th key={header.id} className={header.id === "select" ? "check-cell" : ""} aria-sort={header.column.getIsSorted() ? header.column.getIsSorted() === "asc" ? "ascending" : "descending" : undefined}>{header.column.getCanSort() ? <button className="column-sort" onClick={header.column.getToggleSortingHandler()}>{flexRender(header.column.columnDef.header, header.getContext())}{header.column.getIsSorted() && <ArrowDownWideNarrow size={12} />}</button> : flexRender(header.column.columnDef.header, header.getContext())}</th>)}</tr>)}</thead><tbody>{table.getRowModel().rows.map(row => <tr key={row.id} className={row.getIsSelected() ? "selected" : ""}>{row.getVisibleCells().map(cell => <td key={cell.id} className={cell.column.id === "select" ? "check-cell" : ""}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>)}</tr>)}</tbody></table></div>
        <footer className="table-footer"><span>Showing {pagination.pageIndex * pagination.pageSize + 1}–{pagination.pageIndex * pagination.pageSize + rows.length} of <strong>{page.data?.total}</strong> enquiries · export covers this page</span><div className="pagination"><label className="compact-select"><span className="sr-only">Enquiries per page</span><select value={pagination.pageSize} onChange={event => { setSelection({}); setPagination({ pageIndex: 0, pageSize: Number(event.target.value) }); }}>{[25, 50, 100].map(size => <option key={size} value={size}>{size} / page</option>)}</select></label><IconButton label="Previous enquiry page" disabled={!table.getCanPreviousPage() || page.isFetching} onClick={() => table.previousPage()}><ChevronLeft size={15} /></IconButton><span>{pagination.pageIndex + 1} / {Math.max(1, table.getPageCount())}</span><IconButton label="Next enquiry page" disabled={!page.data?.hasMore || pagination.pageIndex + 1 >= MAX_LEAD_PAGE || page.isFetching} onClick={() => table.nextPage()}><ChevronRight size={15} /></IconButton></div></footer>
        {(page.data?.total || 0) > MAX_LEAD_PAGE * pagination.pageSize && <p className="field-note" role="status">Showing at most {MAX_LEAD_PAGE.toLocaleString()} pages. Refine your filters to reach more enquiries.</p>}
      </> : <EmptyState title="No enquiries in this view" body="Try another search, adjust your filters, or add your first student enquiry." action={access.canWork && <Button action={{ type: "lead.create" }} onClick={onAdd}><Plus size={15} />Add enquiry</Button>} />}
    </section>
    {selectedIds.length > 0 && <div className="bulk-toolbar"><button aria-label="Clear selection" onClick={() => setSelection({})}><X size={15} /></button><strong>{selectedIds.length} selected</strong>{access.admin && <><span className="bulk-divider" /><select aria-label="Bulk assign counsellor" value={bulkOwner} onChange={event => setBulkOwner(event.target.value)}><option value="">Assign counsellor</option><option value="unassigned">Unassigned</option>{members.map(member => <option key={member.id} value={member.id}>{memberLabel(member, members)}</option>)}</select><Button variant="primary" disabled={!bulkOwner || busy || selectedIds.length > 1000} onClick={async () => { if (await act({ type: "lead.bulk", ids: selectedIds, ownerId: bulkOwner === "unassigned" ? null : bulkOwner })) { notify(`${selectedIds.length} enquiries assigned.`); setSelection({}); } }}>Assign<ChevronRight size={14} /></Button></>}</div>}
    <footer className="page-footer"><span><ShieldCheck size={13} />Your institute’s data. Your team’s next steps.</span><span>Intent is an explainable priority signal.</span></footer>
    {saveView && <Dialog title="Save your enquiry view" onClose={() => setSaveView(false)}><p className="dialog-intro">Keep this search and these filters one click away.</p><form onSubmit={async event => {
      event.preventDefault(); const name = String(new FormData(event.currentTarget).get("name") || "").trim();
      if (builtInViews.some(item => item.label.toLowerCase() === name.toLowerCase()) || data.savedViews?.some(item => item.name.toLowerCase() === name.toLowerCase())) { notify("Choose a unique name for this view.", "error"); return; }
      const saved = await act<{ viewId?: string; view?: LeadView; sort?: LeadSort }>({ type: "view.save", name, query: filters.query, course: filters.course, stage: filters.stage, owner: filters.ownerId, ownerId: filters.ownerId, view: filters.view, sort });
      if (saved) {
        try {
          const key = `admitflow:view:${data.id}:${name}`;
          if (saved.view === filters.view && saved.sort === sort) localStorage.removeItem(key);
          else localStorage.setItem(key, JSON.stringify({ view: filters.view, sort })); // Compatibility with an older server during rollout.
        } catch { /* Server-persisted preferences work even when browser storage is disabled. */ }
        setSaveView(false); setActiveView(saved.viewId || `saved:${name}`); notify("View saved.");
      }
    }}><Field label="View name" name="name" required maxLength={40} placeholder="e.g. Weekend NEET enquiries" /><div className="dialog-actions"><Button onClick={() => setSaveView(false)}>Cancel</Button><Button variant="primary" type="submit" loading={busy}>Save view</Button></div></form></Dialog>}
  </>;
}

export function AddLeadDialog({ onClose, onAdded }: { onClose: () => void; onAdded: (id: string) => void }) {
  const { data, act, busy } = useData();
  const [consent, setConsent] = useState<Consent>("unknown");
  const access = workspaceAccess(data), members = assignableMembers(data).filter(member => access.admin || member.id === access.memberId);
  if (!access.canWork) return <Dialog title="Add enquiry" onClose={onClose}><EmptyState title="Read-only workspace access" body="An owner, administrator or counsellor can add enquiries." /></Dialog>;
  return <Dialog title="A new enquiry. A new beginning." onClose={onClose}><p className="dialog-intro">Start with the essentials. The story grows from here.</p><form onSubmit={async event => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const result = await act<{ leadId: string }>({ type: "lead.create", lead: { name: form.get("name"), phone: form.get("phone"), email: form.get("email"), course: form.get("course"), source: form.get("source"), ownerId: access.admin ? form.get("ownerId") || null : access.memberId, value: Number(form.get("value")), notes: form.get("notes"), consent, consentSource: form.get("consentSource") || "", isMinor: form.get("isMinor") === "on", guardianConsent: form.get("guardianConsent") === "on" } });
    if (result) onAdded(result.leadId);
  }}>
    <div className="form-grid"><Field label="Student name" name="name" required maxLength={100} autoComplete="name" placeholder="Full name" /><Field label="Phone number" name="phone" type="tel" required maxLength={30} placeholder="+91 98765 43210" autoComplete="tel" /><Field label="Email address" name="email" type="email" placeholder="student@example.com" /><Field label="Course of interest" name="course" list="course-options" maxLength={100} placeholder="Select or type a course" /><datalist id="course-options">{data.courses.map(course => <option key={course}>{course}</option>)}</datalist><SelectField label="Lead source" name="source">{["Manual", "Meta Ads", "Google Ads", "Website", "Referral", "Walk-in", "WhatsApp"].map(value => <option key={value}>{value}</option>)}</SelectField><SelectField label="Assigned counsellor" name="ownerId" defaultValue={members.find(member => member.id === access.memberId)?.id || members[0]?.id || ""} disabled={!access.admin}>{access.admin && <option value="">Unassigned</option>}{members.map(member => <option key={member.id} value={member.id}>{memberLabel(member, members)}</option>)}</SelectField><Field label="Course value (₹)" name="value" type="number" min={0} max={10000000} step={1} defaultValue={0} hint="The potential course value." /><SelectField label="WhatsApp contact preference" value={consent} onChange={event => setConsent(event.target.value as Consent)}><option value="unknown">Not recorded</option><option value="opted_in">Opted in</option><option value="opted_out">Opted out</option></SelectField></div>
    {consent === "opted_in" && <Field label="Opt-in source" name="consentSource" required maxLength={200} placeholder="Enquiry form, date or other source" />}
    <div className="checkbox-row"><label><input type="checkbox" name="isMinor" />Student is under 18</label><label><input type="checkbox" name="guardianConsent" />Guardian consent recorded</label></div><TextareaField label="Counsellor notes" name="notes" rows={3} maxLength={5000} placeholder="A little context for a better conversation…" /><div className="dialog-actions"><Button onClick={onClose}>Cancel</Button><Button action={{ type: "lead.create" }} type="submit" variant="primary" loading={busy} disabled={!access.admin && !access.memberId}>Add enquiry<Plus size={15} /></Button></div>
  </form></Dialog>;
}

export function LeadDialog({ leadId, onClose, onBook, onRevenue, onInbox }: { leadId: string; onClose: () => void; onBook: (id: string) => void; onRevenue: (id: string) => void; onInbox: (id: string) => void }) {
  const { data, act, busy, notify } = useData();
  const [tab, setTab] = useState("Details"), [taskOpen, setTaskOpen] = useState(false);
  const lead = data.leads.find(item => item.id === leadId);
  const [consent, setConsent] = useState<Consent>(lead?.consent || "unknown");
  const access = workspaceAccess(data), members = assignableMembers(data);
  if (!lead) return <Dialog title="Enquiry details" onClose={onClose}><EmptyState title="This enquiry isn’t available" body="Your access may have changed. Return to the enquiry list." /></Dialog>;
  const writable = canWorkRecord(data, lead), ownerId = recordOwnerId(data, lead), owner = ownerLabel(data, lead);
  const score = scoreLead(lead), activities = data.activities.filter(activity => activity.leadId === leadId), tasks = data.tasks?.filter(task => task.leadId === leadId) || [];
  const taskMembers = members.filter(member => access.admin || member.id === access.memberId);
  return <Dialog title="Enquiry details" drawer onClose={onClose}>
    <div className="lead-profile"><Avatar name={lead.name} /><div><span className="record-eyebrow">STUDENT ENQUIRY</span><h3>{lead.name}</h3><p>{lead.course}<span> · </span>{lead.source}</p></div><Score lead={lead} /></div>
    <div className="contact-lines">{normalizePhone(lead.phone) ? <a href={`tel:${lead.phone}`}><Phone size={14} />{lead.phone}</a> : <span><Phone size={14} />Phone number needed</span>}{lead.email && <a href={`mailto:${lead.email}`}><Mail size={14} />{lead.email}</a>}</div>
    <div className="profile-actions"><Button variant="primary" onClick={() => onInbox(leadId)}><MessageSquare size={15} />Conversation</Button>{writable && <Button onClick={() => onBook(leadId)}><CalendarDays size={15} />Book session</Button>}</div>
    <div className="record-ownership"><Sparkles size={14} /><span>{lead.humanOwned ? `With ${owner}` : data.ai?.mode === "paused" ? "Assistant paused" : "AI-owned conversation"}</span>{writable && <button disabled={busy || paidActionBlocked(data, { type: "lead.update", changes: { humanOwned: !lead.humanOwned } })} onClick={() => void act({ type: "lead.update", id: leadId, changes: { humanOwned: !lead.humanOwned } })}>{lead.humanOwned ? "Enable AI" : "Take over"}</button>}</div>
    <div className="view-tabs">{["Details", "Activity"].map(value => <button key={value} className={tab === value ? "active" : ""} aria-pressed={tab === value} onClick={() => setTab(value)}>{value}{value === "Activity" && <span>{activities.length}</span>}</button>)}</div>
    {tab === "Details" ? <>
      <div className="form-grid"><SelectField label="Pipeline stage" value={lead.stage} disabled={!writable || busy} onChange={event => { if (event.target.value === "Admitted" && access.admin) onRevenue(leadId); else void act({ type: "lead.update", id: leadId, changes: { stage: event.target.value } }); }}>{STAGES.map(stage => <option key={stage}>{stage}</option>)}</SelectField><SelectField label="Counsellor" value={ownerId || ""} disabled={!access.admin || busy} onChange={event => void act({ type: "lead.update", id: leadId, changes: { ownerId: event.target.value || null } })}><option value="">Unassigned</option>{ownerId && !members.some(member => member.id === ownerId) && <option value={ownerId} disabled>{owner} · inactive</option>}{members.map(member => <option key={member.id} value={member.id}>{memberLabel(member, members)}</option>)}</SelectField></div>
      <div className="detail-facts"><div><span>Course value</span><strong>{currency(lead.value)}</strong></div><div><span>Enquired on</span><strong>{dateLabel(lead.createdAt)}</strong></div><div><span>Last contact</span><strong>{lead.lastContactAt ? relativeTime(lead.lastContactAt) : "Not yet"}</strong></div></div>
      <section className="score-breakdown"><div className="section-title"><h3>Behind the intent score</h3><Badge>Explainable</Badge></div>{score.reasons.map(reason => <div key={reason.label}><span>{reason.label}</span><strong>+{reason.points}</strong></div>)}</section>
      <form key={leadId} onSubmit={async event => {
        event.preventDefault(); if (!writable) return; const form = new FormData(event.currentTarget);
        if (await act({ type: "lead.update", id: leadId, changes: { notes: form.get("notes"), nextAction: form.get("nextAction"), consent, consentSource: form.get("consentSource"), isMinor: form.get("isMinor") === "on", guardianConsent: form.get("guardianConsent") === "on" } })) notify("Enquiry details saved.");
      }}><div className="section-title"><h3>The next step</h3>{writable && <button type="button" className="table-text-action" onClick={() => setTaskOpen(!taskOpen)}><Plus size={13} />Add task</button>}</div><Field label="Next action" name="nextAction" defaultValue={lead.nextAction} maxLength={500} readOnly={!writable} /><TextareaField label="Counsellor notes" name="notes" rows={3} defaultValue={lead.notes} maxLength={5000} readOnly={!writable} /><details className="consent-details"><summary><ShieldCheck size={14} />Contact preferences<Badge tone={lead.consent === "opted_in" ? "green" : "neutral"}>{lead.consent.replaceAll("_", " ")}</Badge></summary><SelectField label="WhatsApp permission" name="consent" value={consent} disabled={!writable} onChange={event => setConsent(event.target.value as Consent)}><option value="unknown">Not recorded</option><option value="opted_in">Opted in</option><option value="opted_out">Opted out</option></SelectField><Field label="Consent source" name="consentSource" defaultValue={lead.consentSource} required={consent === "opted_in"} maxLength={200} readOnly={!writable} /><div className="checkbox-row"><label><input type="checkbox" name="isMinor" defaultChecked={lead.isMinor} disabled={!writable} />Under 18</label><label><input type="checkbox" name="guardianConsent" defaultChecked={lead.guardianConsent} disabled={!writable} />Guardian consent</label></div></details><div className="dialog-actions">{access.admin && <Button onClick={() => onRevenue(leadId)}><ArrowUpRight size={15} />Record admission</Button>}{writable && <Button type="submit" variant="primary" loading={busy}>Save details</Button>}</div></form>
      {taskOpen && writable && <form className="inline-task-form" onSubmit={async event => {
        event.preventDefault(); const form = new FormData(event.currentTarget);
        if (await act({ type: "task.save", leadId, title: form.get("title"), ownerId: access.admin ? form.get("ownerId") : access.memberId, dueAt: new Date(`${form.get("date")}T10:00:00+05:30`).toISOString() })) { setTaskOpen(false); notify("Follow-up task added."); }
      }}><Field label="Task title" name="title" required maxLength={200} defaultValue={lead.nextAction} /><SelectField label="Task counsellor" name="ownerId" required defaultValue={taskMembers.some(member => member.id === ownerId) ? ownerId! : taskMembers[0]?.id || ""} disabled={!access.admin}>{taskMembers.map(member => <option key={member.id} value={member.id}>{memberLabel(member, members)}</option>)}</SelectField><Field label="Due date" type="date" name="date" required /><Button variant="primary" type="submit" loading={busy} disabled={!taskMembers.length}>Add follow-up task</Button></form>}
      {tasks.length > 0 && <section className="score-breakdown"><div className="section-title"><h3>Follow-up tasks</h3><Badge>{tasks.filter(task => task.status === "open").length} open</Badge></div>{tasks.map(task => <div key={task.id}><span><strong>{task.title}</strong><small className="field-note">{ownerLabel(data, task)} · {dateLabel(task.dueAt)}</small></span>{task.status === "completed" ? <Badge tone="green">Done</Badge> : writable && <button type="button" className="table-text-action" disabled={busy} onClick={() => void act({ type: "task.complete", id: task.id })}>Complete</button>}</div>)}</section>}
    </> : <div className="activity-timeline">{activities.length ? activities.map(activity => <div className="activity-item" key={activity.id}><span className="activity-point"><Clock3 size={12} /></span><div><p>{activity.text}</p><small>{dateLabel(activity.createdAt, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}</small></div></div>) : <EmptyState title="The story starts here" body="Conversations, notes and next steps will appear here." />}</div>}
  </Dialog>;
}

const importFields = [["name", "Student name", ["name", "studentname", "fullname"]], ["phone", "Phone number", ["phone", "phonenumber", "mobile", "contact"]], ["email", "Email address", ["email", "emailaddress"]], ["course", "Course", ["course", "exam", "program"]], ["source", "Lead source", ["source", "leadsource"]], ["value", "Course value (₹)", ["value", "fee", "fees", "amount"]], ["createdAt", "Enquiry date", ["createdat", "date", "enquirydate"]], ["notes", "Notes", ["notes", "remarks"]], ["consent", "WhatsApp opt-in", ["consent", "optin"]], ["consentSource", "Opt-in source", ["consentsource", "optinsource"]]] as const;
type ImportResult = { imported: number; duplicates: number; errors: { row: number; error: string }[] };

export function ImportDialog({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const { data, act, busy, notify } = useData();
  const members = assignableMembers(data), access = workspaceAccess(data);
  const [step, setStep] = useState(0), [filename, setFilename] = useState(""), [headers, setHeaders] = useState<string[]>([]), [rows, setRows] = useState<string[][]>([]), [mapping, setMapping] = useState<Record<string, string>>({});
  const [ownerId, setOwnerId] = useState(members[0]?.id || ""), [result, setResult] = useState<ImportResult | null>(null), [reading, setReading] = useState(false);
  const requiredMapped = ["name", "phone"].every(key => mapping[key] !== undefined && mapping[key] !== "");
  const mapped = rows.map(row => ({ ...Object.fromEntries(importFields.map(([key]) => {
    const value = mapping[key] !== undefined && mapping[key] !== "" ? row[Number(mapping[key])] || "" : "";
    if (key === "value") return [key, value ? Number(value.replace(/[₹,]/g, "")) : 0];
    if (key === "consent") return [key, ["yes", "true", "opted_in", "consented"].includes(value.toLowerCase().trim()) ? "opted_in" : ["opted_out", "stop", "unsubscribed"].includes(value.toLowerCase().trim()) ? "opted_out" : "unknown"];
    return [key, value.trim()];
  })), ownerId: ownerId || null }));
  const seen = new Set(data.leads.map(lead => lead.phone)); let duplicates = 0, invalid = 0;
  mapped.forEach(row => { const phone = normalizePhone(String(row.phone)); if (!row.name || !phone) invalid++; else if (seen.has(phone)) duplicates++; else seen.add(phone); });
  async function openFile(file?: File) {
    if (!file || reading) return;
    if (file.size > 2_000_000) { notify("Use a CSV smaller than 2 MB.", "error"); return; }
    setReading(true);
    try {
      const parsed = Papa.parse<string[]>(await file.text(), { skipEmptyLines: "greedy" });
      if (parsed.errors.length || parsed.data.length < 2) throw new Error("Include a header row and at least one enquiry in a valid CSV.");
      if (parsed.data.length > 1001) throw new Error("Import up to 1,000 enquiries at a time.");
      const head = parsed.data[0].map(value => value.replace(/^\uFEFF/, "").trim());
      setHeaders(head); setRows(parsed.data.slice(1)); setFilename(file.name); setResult(null);
      setMapping(Object.fromEntries(importFields.map(([key, , aliases]) => { const index = head.findIndex(value => (aliases as readonly string[]).includes(value.toLowerCase().replace(/[^a-z]/g, ""))); return [key, index < 0 ? "" : String(index)]; }))); setStep(1);
    } catch (error) { notify(error instanceof Error ? error.message : "This CSV could not be read.", "error"); }
    finally { setReading(false); }
  }
  if (!access.admin) return <Dialog title="Import enquiries" onClose={onClose}><EmptyState title="Administrator access needed" body="An institute owner or administrator can import a CSV." /></Dialog>;
  return <Dialog title="Bring your enquiries together" wide onClose={onClose}>
    <p className="dialog-intro">There’s opportunity in that spreadsheet. Let’s find it.</p><div className="import-steps">{["Upload file", "Map columns", "Review & import"].map((label, index) => <span key={label} className={step >= index ? "current" : ""}><b>{step > index ? <Check size={13} /> : index + 1}</b>{label}</span>)}</div>
    {result ? <div className="import-result"><span className="success-icon"><Check size={30} /></span><h3>{result.imported} enquiries imported</h3><p>{result.duplicates} duplicates skipped · {result.errors.length} rows need attention</p>{result.errors.length > 0 && <div className="import-errors">{result.errors.map(error => <p key={error.row}><strong>Row {error.row}:</strong> {error.error}</p>)}</div>}<Button variant="primary" onClick={onImported}>View enquiries<ArrowUpRight size={15} /></Button></div> : step === 0 ? <>
      <label className="upload-zone" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); void openFile(event.dataTransfer.files[0]); }}><span className="upload-illustration"><FileSpreadsheet size={34} strokeWidth={1.2} /></span><strong>{reading ? "Reading your CSV…" : "Drop a CSV. Start a new chapter."}</strong><span>or click to browse your files</span><small>CSV · up to 1,000 enquiries · 2 MB maximum</small><input type="file" accept=".csv,text/csv" aria-label="Upload enquiry CSV" disabled={reading} onChange={event => void openFile(event.target.files?.[0])} /></label>
      <div className="import-helper"><div><h3>A little head start</h3><p>Use our template with your enquiry data.</p></div><Button onClick={() => download("name,phone,email,course,source,value,createdAt,consent,consentSource,notes\r\nSample Student,+919000009999,student@example.com,NEET 2027,Website,65000,2026-08-01,unknown,,Asked about fees", "admitflow-import-template.csv")}><Download size={14} />Template</Button></div>
    </> : <>
      <div className="file-summary"><FileSpreadsheet size={18} /><strong>{filename}</strong><Badge>{rows.length} rows</Badge></div>
      {step === 1 ? <><p className="muted">Match your columns to AdmitFlow. Optional fields can be left out.</p><div className="mapping-grid">{importFields.map(([key, label]) => <SelectField key={key} label={`${label}${["name", "phone"].includes(key) ? " *" : ""}`} value={mapping[key] ?? ""} onChange={event => setMapping({ ...mapping, [key]: event.target.value })}><option value="">{["name", "phone"].includes(key) ? "Choose a column" : "Skip this field"}</option>{headers.map((header, index) => <option key={index} value={index}>{header || `Column ${index + 1}`}</option>)}</SelectField>)}</div><SelectField label="Assign imported enquiries" value={ownerId} onChange={event => setOwnerId(event.target.value)}><option value="">Unassigned</option>{members.map(member => <option key={member.id} value={member.id}>{memberLabel(member, members)}</option>)}</SelectField><div className="dialog-actions"><Button onClick={() => setStep(0)}><ArrowLeft size={14} />Back</Button><Button variant="primary" disabled={!requiredMapped} onClick={() => setStep(2)}>Review import<ChevronRight size={15} /></Button></div></> : <>
        <div className="import-review-stats"><div><strong>{Math.max(0, rows.length - duplicates - invalid)}</strong><span>ready for validation</span></div><div><strong>{duplicates}</strong><span>duplicates found</span></div><div><strong>{invalid}</strong><span>need attention</span></div></div>
        <div className="import-preview"><table className="data-table"><caption className="sr-only">CSV enquiry preview</caption><thead><tr><th>Name</th><th>Phone</th><th>Course</th><th>Permission</th></tr></thead><tbody>{mapped.slice(0, 5).map((row, index) => <tr key={index}><td>{String(row.name)}</td><td>{String(row.phone)}</td><td>{String(row.course) || "—"}</td><td>{String(row.consent).replaceAll("_", " ")}</td></tr>)}</tbody></table></div><p className="field-note"><ShieldCheck size={14} />Duplicates are skipped. Each row and its recorded contact permissions are validated before import.</p>
        <div className="dialog-actions"><Button disabled={busy} onClick={() => setStep(1)}><ArrowLeft size={14} />Back to mapping</Button><Button action={{ type: "lead.import" }} variant="primary" loading={busy} disabled={!requiredMapped} onClick={async () => { const imported = await act<ImportResult>({ type: "lead.import", rows: mapped }); if (imported) setResult(imported); }}>Import enquiries<Upload size={15} /></Button></div>
      </>}
    </>}
  </Dialog>;
}
