"use client";
import Link from "next/link";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { ActiveIndicator, ThemeSelect, spring } from "./appearance";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { LayoutDashboard, UsersRound, Columns3, Inbox, RotateCcw, CalendarDays, ChartNoAxesCombined, BookOpen, Workflow, Settings2, Search, Bell, CircleHelp, ChevronsUpDown, Plus, ArrowUpRight, X, Menu, ArrowRight, CheckCircle2, Info, Building2, Sparkles, PanelLeftClose, Keyboard, Plug, UserPlus } from "lucide-react";
import { useWorkspace, useData, workspaceAccess, canVisitPage, canWorkRecord, paidActionBlocked } from "./provider";
import { Avatar, Badge, Brand, Button, Dialog, EmptyState, IconButton, PageHeading } from "./ui";
import { SubscriptionStatus } from "./subscription";
import { relativeTime, recoverableLeads } from "@/lib/domain";
import { OverviewPage, AnalyticsPage } from "./overview";
import { LeadsPage, AddLeadDialog, ImportDialog, LeadDialog } from "./leads";
import { PipelinePage, RecoveryPage } from "./recovery";
import { InboxPage } from "./inbox";
import { AppointmentsPage, BookingDialog, RevenueDialog } from "./appointments";
import { KnowledgePage, AutomationsPage, SettingsPage, IntegrationsPage, TeamPage } from "./configuration";

export const navigation = [
  { path: "overview", label: "Overview", icon: LayoutDashboard, group: "WORKSPACE" },
  { path: "leads", label: "Enquiries", icon: UsersRound, group: "WORKSPACE" },
  { path: "pipeline", label: "Admissions pipeline", icon: Columns3, group: "WORKSPACE" },
  { path: "inbox", label: "Shared inbox", icon: Inbox, group: "WORKSPACE" },
  { path: "appointments", label: "Counselling", icon: CalendarDays, group: "WORKSPACE" },
  { path: "recovery", label: "Recovery campaigns", icon: RotateCcw, group: "GROWTH ENGINE" },
  { path: "automations", label: "AI & automations", icon: Workflow, group: "GROWTH ENGINE" },
  { path: "knowledge", label: "Knowledge base", icon: BookOpen, group: "GROWTH ENGINE" },
  { path: "analytics", label: "Revenue analytics", icon: ChartNoAxesCombined, group: "GROWTH ENGINE" },
  { path: "team", label: "Team & access", icon: UsersRound, group: "MANAGE" },
  { path: "integrations", label: "Integrations", icon: Plug, group: "MANAGE" },
  { path: "settings", label: "Settings", icon: Settings2, group: "MANAGE" },
];
const href = (path: string) => `/${path}`;

export function WorkspaceApp({ view }: { view: string }) {
  const { data, error, refresh } = useWorkspace();
  if (!data) return <div className="loading-workspace"><div className="loading-brand"><Brand /></div>{error ? <EmptyState title="Let’s get you into your workspace" body={error} action={<><Button onClick={() => void refresh()}>Try again</Button><Link href="/login" className="button primary">Sign in</Link></>} /> : <div className="loading-content" role="status"><div className="skeleton skeleton-heading" /><div className="skeleton-metrics">{[0, 1, 2, 3].map(i => <div className="skeleton" key={i} />)}</div><div className="skeleton skeleton-chart" /><span className="sr-only">Loading your admissions workspace</span></div>}</div>;
  return <LoadedWorkspace key={`${data.id}:${data.actor?.id}:${data.actor?.role}`} view={view} />;
}
function LoadedWorkspace({ view }: { view: string }) {
  const { data, notice, clearNotice, notify } = useData();
  const router = useRouter(), params = useSearchParams(), pathname = usePathname();
  const [commandOpen, setCommandOpen] = useState(false), [mobileNav, setMobileNav] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const reducedMotion = useReducedMotion();
  useEffect(() => { try { setCollapsed(localStorage.getItem("admitflow:sidebar") === "collapsed"); } catch { /* Optional preference. */ } }, []);
  function toggleSidebar() { setCollapsed(value => { try { localStorage.setItem("admitflow:sidebar", value ? "expanded" : "collapsed"); } catch { /* Collapse works without storage. */ } return !value; }); }
  const [modal, setModal] = useState<"add" | "import" | "book" | "revenue" | "activity" | "help" | null>(null);
  const [actionLead, setActionLead] = useState<string>();
  const leadId = params.get("lead"), current = navigation.find(item => item.path === view) || navigation[0];
  const unread = data.leads.filter(lead => lead.unread || data.messages.filter(message => message.leadId === lead.id && message.direction !== "internal").at(-1)?.direction === "inbound").length;
  const { admin, canWork, role } = workspaceAccess(data), allowed = canVisitPage(data, view);
  const userName = data.actor?.name || data.userName;
  const roleLabel = { owner: "Workspace owner", admin: "Workspace administrator", counsellor: "Admissions counsellor", analyst: "Read-only analyst" }[role];
  useEffect(() => {
    const handle = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setCommandOpen(value => !value); } };
    window.addEventListener("keydown", handle); return () => window.removeEventListener("keydown", handle);
  }, []);
  useEffect(() => { document.querySelector<HTMLElement>("#main-content")?.focus({ preventScroll: true }); }, [view]);
  function navigate(path: string) { if (!canVisitPage(data, path)) { notify("Your role does not have access to that page.", "error"); return; } setMobileNav(false); setCommandOpen(false); setModal(null); router.push(href(path)); }
  function openLead(id: string) { setModal(null); setCommandOpen(false); const next = new URLSearchParams(params); next.set("lead", id); router.push(`${pathname}?${next}`, { scroll: false }); }
  function closeLead() { const next = new URLSearchParams(params); next.delete("lead"); router.replace(`${pathname}${next.size ? `?${next}` : ""}`, { scroll: false }); }
  function book(id?: string) { if (!canWork || id && !data.leads.some(lead => lead.id === id && canWorkRecord(data, lead))) return; setActionLead(id); setModal("book"); }
  function record(id: string) { if (!admin) return; setActionLead(id); setModal("revenue"); }
  function importEnquiries() { if (paidActionBlocked(data, { type: "lead.import" })) { notify(data.capabilities!.message, "error"); return; } if (admin) setModal("import"); else notify("An institute owner or administrator can import enquiries.", "error"); }
  const navLinks = <nav aria-label="Main navigation">{["WORKSPACE", "GROWTH ENGINE", "MANAGE"].map(group => <div className="nav-group" key={group}><span className="nav-group-label">{group}</span>{navigation.filter(item => item.group === group && canVisitPage(data, item.path)).map(item => <Link key={item.path} href={href(item.path)} title={item.label} aria-label={item.path === "inbox" && unread > 0 ? `${item.label}, ${unread} unread` : item.label} className={`nav-item ${item.path === view ? "active" : ""}`} aria-current={item.path === view ? "page" : undefined} onClick={() => setMobileNav(false)}><item.icon size={17} strokeWidth={1.7} /><span className="nav-item-label">{item.label}</span>{item.path === view && !mobileNav && <ActiveIndicator id="workspace-navigation" />}{item.path === "inbox" && unread > 0 && <span className="nav-count blue-count" aria-hidden="true">{unread}</span>}{item.path === "leads" && <span className="nav-count" aria-hidden="true">{data.leads.length}</span>}</Link>)}</div>)}</nav>;
  return <div className={`app-shell ${collapsed ? "sidebar-is-collapsed" : ""}`}>
    <a href="#main-content" className="skip-link">Skip to main content</a>
    <aside className="sidebar">
      <div className="sidebar-brand"><Link href="/overview" aria-label="AdmitFlow overview"><Brand small={collapsed} /></Link><button className="sidebar-collapse-toggle" aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} aria-expanded={!collapsed} onClick={toggleSidebar}><PanelLeftClose size={16} /></button></div>
      <Dropdown.Root><Dropdown.Trigger asChild><button className="workspace-selector" aria-label={`Institute: ${data.name}`}><span className="academy-icon"><Building2 size={18} /></span><span><strong>{data.name}</strong><small>{data.demo ? "Demo workspace" : "Institute workspace"}</small></span><ChevronsUpDown size={13} /></button></Dropdown.Trigger><Dropdown.Portal><Dropdown.Content className="dropdown-menu" sideOffset={6} align="start"><Dropdown.Label className="dropdown-label">YOUR WORKSPACE</Dropdown.Label><Dropdown.Item className="dropdown-item" onSelect={() => navigate("settings")}><Building2 size={15} />{data.name}<CheckCircle2 size={14} /></Dropdown.Item>{data.actor?.backend === "workos" && <Dropdown.Item className="dropdown-item" onSelect={() => router.push("/onboarding")}><Plus size={15} />Switch or create institute</Dropdown.Item>}<Dropdown.Separator className="dropdown-separator" />{admin && <Dropdown.Item className="dropdown-item" onSelect={() => navigate("team")}><UserPlus size={15} />Invite your team</Dropdown.Item>}<Dropdown.Item className="dropdown-item" onSelect={() => navigate("settings")}><Settings2 size={15} />Workspace settings</Dropdown.Item></Dropdown.Content></Dropdown.Portal></Dropdown.Root>
      <button className="sidebar-search" aria-label="Quick search" title="Quick search" onClick={() => setCommandOpen(true)}><Search size={16} /><span>Quick search</span><kbd>Ctrl / ⌘ K</kbd></button>
      {navLinks}
      <div className="sidebar-bottom">
        <button className="sidebar-assistant" aria-label="Open assistant" title="Open assistant" onClick={() => navigate(admin ? "automations" : "inbox")}><span className="assistant-small-mark"><Sparkles size={17} /></span><span><strong>Your growth co-pilot</strong><small><i className="live-dot" />{data.ai?.mode === "autonomous" ? "Autonomous mode" : data.ai?.mode === "paused" ? "Assistant paused" : "Here to help"}</small></span><ArrowUpRight size={14} /></button>
        <button className="sidebar-help" aria-label="Help and getting started" title="Help and getting started" onClick={() => setModal("help")}><CircleHelp size={16} /><span>Help & getting started</span><ArrowUpRight size={13} /></button>
        <Dropdown.Root><Dropdown.Trigger asChild><button className="sidebar-profile" aria-label="Profile menu" title="Profile menu"><Avatar name={userName} /><span><strong>{userName}</strong><small>{roleLabel}</small></span><ChevronsUpDown size={13} /></button></Dropdown.Trigger><Dropdown.Portal><Dropdown.Content className="dropdown-menu" sideOffset={8} align="start"><Dropdown.Label className="dropdown-label">{userName} · {roleLabel}</Dropdown.Label><Dropdown.Item className="dropdown-item" onSelect={() => navigate("settings")}><Settings2 size={15} />Profile and workspace settings</Dropdown.Item>{admin && <Dropdown.Item className="dropdown-item" onSelect={() => navigate("team")}><UsersRound size={15} />Team and access</Dropdown.Item>}<Dropdown.Separator className="dropdown-separator" /><Dropdown.Item className="dropdown-item" onSelect={() => setModal("help")}><CircleHelp size={15} />Help and getting started</Dropdown.Item></Dropdown.Content></Dropdown.Portal></Dropdown.Root>
      </div>
    </aside>
    <div className="workspace-main">
      <header className="topbar"><div className="topbar-location"><IconButton label="Open navigation" className="mobile-menu" onClick={() => setMobileNav(true)}><Menu size={20} /></IconButton><span className="breadcrumb-parent">Workspace</span><span className="breadcrumb-slash">/</span><current.icon size={14} /><span>{current.label}</span></div><div className="topbar-tools"><ThemeSelect />{data.demo && <span className="demo-indicator"><span className="mini-dot blue" />Demo data</span>}<button className="header-search" aria-label="Search workspace" aria-keyshortcuts="Control+K Meta+K" onClick={() => setCommandOpen(true)}><Search size={17} /><kbd>Ctrl / ⌘ K</kbd></button><span className="topbar-divider" /><IconButton label="View recent activity" onClick={() => setModal("activity")}><Bell size={18} /></IconButton><button className="profile-button" aria-label="Open profile settings" onClick={() => navigate("settings")}><Avatar name={userName} small /></button></div></header>
      <motion.main key={view} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={reducedMotion ? { duration: 0 } : spring} id="main-content" tabIndex={-1} className={`page-content ${view === "inbox" ? "inbox-page" : ""} ${view === "pipeline" ? "pipeline-page" : ""}`}>
        <SubscriptionStatus />
        {!allowed ? <><PageHeading title={current.label} description="Your institute workspace" /><EmptyState title="This page is managed by your institute administrator" body="Use your assigned enquiries and shared inbox to continue your work." action={<Button onClick={() => navigate("leads")}>View enquiries<ArrowRight size={15} /></Button>} /></> : <>
        {view === "overview" && <OverviewPage onNavigate={navigate} onOpen={openLead} onImport={importEnquiries} />}
        {view === "leads" && <LeadsPage onOpen={openLead} onAdd={() => setModal("add")} onImport={() => setModal("import")} />}
        {view === "pipeline" && <PipelinePage onOpen={openLead} onAdd={() => setModal("add")} />}
        {view === "recovery" && <RecoveryPage onOpen={openLead} onImport={() => setModal("import")} />}
        {view === "inbox" && <InboxPage initialLead={params.get("conversation") || undefined} onOpen={openLead} onBook={book} />}
        {view === "appointments" && <AppointmentsPage onBook={book} onOpen={openLead} />}
        {view === "analytics" && <AnalyticsPage onOpen={openLead} />}
        {view === "knowledge" && <KnowledgePage />}
        {view === "automations" && <AutomationsPage />}
        {view === "settings" && <SettingsPage />}
        {view === "integrations" && <IntegrationsPage />}
        {view === "team" && <TeamPage />}
        </>}
      </motion.main>
    </div>
    {commandOpen && <CommandPalette onClose={() => setCommandOpen(false)} onNavigate={navigate} onLead={openLead} onAdd={() => { setCommandOpen(false); setModal("add"); }} />}
    {mobileNav && <Dialog title="Your workspace" onClose={() => setMobileNav(false)}><div className="mobile-nav-links">{navLinks}</div></Dialog>}
    {leadId && !modal && <LeadDialog key={leadId} leadId={leadId} onClose={closeLead} onBook={book} onRevenue={record} onInbox={id => { setModal(null); router.push(`/inbox?conversation=${id}`); }} />}
    {modal === "add" && canWork && <AddLeadDialog onClose={() => setModal(null)} onAdded={openLead} />}
    {modal === "import" && admin && <ImportDialog onClose={() => setModal(null)} onImported={() => navigate("leads")} />}
    {modal === "book" && canWork && <BookingDialog leadId={actionLead} onClose={() => setModal(null)} />}
    {modal === "revenue" && admin && actionLead && <RevenueDialog leadId={actionLead} onClose={() => setModal(null)} />}
    {modal === "activity" && <Dialog title="The latest in your workspace" onClose={() => setModal(null)}><div className="notification-list">{!data.activities.length && <EmptyState title="A fresh activity timeline" body="Enquiries, conversations and updates will appear here." />}{data.activities.slice(0, 20).map(activity => <button key={activity.id} onClick={() => activity.leadId ? openLead(activity.leadId) : navigate("recovery")}><span className={`notification-icon ${activity.kind}`}><CheckCircle2 size={17} /></span><span><strong>{activity.text}</strong><small>{relativeTime(activity.createdAt)}</small></span><ArrowUpRight size={14} /></button>)}</div></Dialog>}
    {modal === "help" && <Dialog title="A little follow-up. A big difference." onClose={() => setModal(null)}><div className="quick-guide"><p>Everything your team needs to turn an enquiry into a next step.</p>{[["Bring your enquiries together", "Import a CSV, check the preview, and assign your team."], ["Give your assistant context", "Add your courses, fee structure and approved policies."], ["Reconnect, thoughtfully", "Choose a recovery audience and an approved WhatsApp template."], ["Make the outcome count", "Book counselling and link every payment to its enquiry."]].map(([title, body], index) => <div key={title}><b>{index + 1}</b><span><strong>{title}</strong><p>{body}</p></span></div>)}<p className="field-note">{data.demo ? "This workspace uses fictional sample data. Demo messages are never delivered." : "Your institute's assistant and integrations are managed by an owner or administrator."}</p><div className="quick-guide-actions"><Link href="/help" className="button secondary" onClick={() => setModal(null)}>Full getting-started guide<ArrowUpRight size={15} /></Link>{admin && <Button action={{ type: "lead.import" }} variant="primary" onClick={importEnquiries}>Import your enquiries<ArrowRight size={16} /></Button>}</div></div></Dialog>}
    {notice && <div className={`toast ${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>{notice.tone === "error" ? <Info size={18} /> : <CheckCircle2 size={18} />}<p>{notice.message}</p><IconButton label="Dismiss notification" onClick={clearNotice}><X size={16} /></IconButton></div>}
  </div>;
}
function CommandPalette({ onClose, onNavigate, onLead, onAdd }: { onClose: () => void; onNavigate: (path: string) => void; onLead: (id: string) => void; onAdd: () => void }) {
  const { data } = useData(); const [query, setQuery] = useState(""), [index, setIndex] = useState(0);
  const actions = [...navigation.filter(item => canVisitPage(data, item.path) && item.label.toLowerCase().includes(query.toLowerCase())).map(item => ({ id: item.path, label: item.label, hint: "Navigate", icon: item.icon, run: () => onNavigate(item.path) })), ...data.leads.filter(lead => query && `${lead.name} ${lead.phone}`.toLowerCase().includes(query.toLowerCase())).slice(0, 6).map(lead => ({ id: lead.id, label: lead.name, hint: lead.course, icon: UsersRound, run: () => onLead(lead.id) })), ...(workspaceAccess(data).canWork && !paidActionBlocked(data, { type: "lead.create" }) && (!query || "add enquiry".includes(query.toLowerCase())) ? [{ id: "add", label: "Add an enquiry", hint: "Create", icon: Plus, run: onAdd }] : [])];
  return <Dialog title="Find your next step" onClose={onClose}><div className="command-search"><Search size={20} /><input autoFocus aria-label="Search pages and students" role="combobox" aria-expanded="true" aria-controls="command-results" aria-activedescendant={actions[index] ? `command-${actions[index].id}` : undefined} value={query} onChange={event => { setQuery(event.target.value); setIndex(0); }} placeholder="Where would you like to go?" onKeyDown={event => { if (event.key === "ArrowDown") { event.preventDefault(); setIndex(i => Math.max(0, Math.min(actions.length - 1, i + 1))); } if (event.key === "ArrowUp") { event.preventDefault(); setIndex(i => Math.max(0, i - 1)); } if (event.key === "Enter" && actions[index]) { event.preventDefault(); actions[index].run(); } }} /></div><div className="command-results" id="command-results" role="listbox" aria-label="Search results">{actions.map((action, i) => <button id={`command-${action.id}`} key={action.id} role="option" aria-selected={i === index} className={i === index ? "active" : ""} onMouseEnter={() => setIndex(i)} onClick={action.run}><action.icon size={17} /><strong>{action.label}</strong><small>{action.hint}</small><ArrowUpRight size={14} /></button>)}</div>{!actions.length && <p className="command-empty" role="status">No matches. Try a page name, student name or phone number.</p>}<footer className="command-footer"><Keyboard size={14} /><span>↑ ↓ to navigate</span><span>Enter to open</span><span>Esc to close</span></footer></Dialog>;
}
