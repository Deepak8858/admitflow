import { eq, and, sql, getTableColumns, desc, or, ilike, count, isNull, inArray, notInArray } from "drizzle-orm";
import type { PgTable, AnyPgColumn, PgTransactionConfig } from "drizzle-orm/pg-core";
import { database, type Database } from "./client";
import * as s from "./schema";
import { hydrateWorkspace, uid, DAY, LEAD_RULES, LEAD_VIEWS, LEAD_SORTS, type Workspace, type Lead, type Stage, type LeadView, type LeadSort } from "../domain";
import { AppError, assert } from "../errors";
import { isDeepStrictEqual } from "node:util";
import { articleChunks } from "./chunks";
import { assertActor } from "../permissions";
import { TRIAL_MS } from "../subscription-policy";
import { normalizeWorkspaceInstants } from "../instants";
import { intakeHeldPhones } from "../intake-retention-policy";
import { MAX_LEAD_PAGE, MAX_LEAD_PAGE_SIZE, hasMoreLeadPages } from "../lead-pagination";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Db = Database | Transaction;

export async function tenantTransaction<T>(id: string, action: (tx: Transaction) => Promise<T>, config?: PgTransactionConfig) {
  return database().transaction(async tx => {
    await tx.execute(sql`select set_config('app.organization_id', ${id}, true)`);
    return action(tx);
  }, config);
}

function clean<T>(rows: unknown[]): T[] {
  return rows.map(row => Object.fromEntries(Object.entries(row as Record<string, unknown>).filter(([key, value]) => key !== "organizationId" && value !== null))) as T[];
}

async function readWorkspaceIdentity(id: string, db: Db): Promise<Pick<Workspace, "id" | "workosOrganizationId" | "members">> {
  const [org] = await db.select({ id: s.organizations.id, workosId: s.organizations.workosId }).from(s.organizations).where(eq(s.organizations.id, id));
  assert(org, "Workspace not found.", 404);
  const members = clean<NonNullable<Workspace["members"]>[number]>(await db.select().from(s.members).where(eq(s.members.organizationId, id)));
  return { id, workosOrganizationId: org.workosId || undefined, members };
}
export function loadWorkspaceIdentity(id: string) { return tenantTransaction(id, tx => readWorkspaceIdentity(id, tx), { isolationLevel: "repeatable read" }); }

export async function readWorkspace(id: string, db: Db): Promise<Workspace> {
  const [org] = await db.select().from(s.organizations).where(eq(s.organizations.id, id));
  if (!org) throw new AppError("Workspace not found.", 404);
  const select = (table: PgTable & { organizationId: AnyPgColumn }) => db.select().from(table as unknown as typeof s.leads).where(eq(table.organizationId, id));
  const [leadRows, messageRows, campaignRows, recipientRows, jobRows, appointmentRows, paymentRows, refundRows, articleRows, activityRows, taskRows, memberRows, fileRows, connectionRows, views] = await Promise.all([
    select(s.leads), select(s.messages), select(s.campaigns), db.select().from(s.campaignRecipients).where(eq(s.campaignRecipients.organizationId, id)), select(s.jobs), select(s.appointments), select(s.payments), select(s.refunds), select(s.articles), select(s.activities), select(s.tasks), select(s.members), select(s.files), select(s.connections), select(s.savedViews),
  ]);
  const workspace = {
    id, workosOrganizationId: org.workosId || undefined, name: org.name, userName: org.ownerName, email: org.email, demo: org.demo, team: org.team, courses: org.courses, sequence: org.sequence, ai: org.ai, subscription: org.subscription, timezone: org.timezone, revision: org.revision,
    leads: clean<Workspace["leads"][number]>(leadRows).map(lead => ({ ...lead, lastContactAt: lead.lastContactAt || null, lastInboundAt: lead.lastInboundAt || null, consentAt: lead.consentAt || null })),
    messages: clean<Workspace["messages"][number]>(messageRows),
    campaigns: clean<Workspace["campaigns"][number]>(campaignRows).map(campaign => ({ ...campaign, leadIds: recipientRows.filter(row => row.campaignId === campaign.id).map(row => row.leadId) })),
    jobs: clean<Workspace["jobs"][number]>(jobRows).map(job => ({ ...job, campaignId: job.campaignId || "", leadId: job.leadId || "" })),
    appointments: clean<Workspace["appointments"][number]>(appointmentRows),
    revenue: clean<Record<string, unknown>>(paymentRows).map(({ amountPaise, ...row }) => ({ ...row, amount: Number(amountPaise) / 100, campaignId: row.campaignId || null })),
    refunds: clean<Record<string, unknown>>(refundRows).map(({ amountPaise, ...row }) => ({ ...row, amount: Number(amountPaise) / 100 })),
    articles: clean(articleRows), activities: clean(activityRows), tasks: clean(taskRows), members: clean(memberRows), files: clean(fileRows), connections: clean(connectionRows), savedViews: clean(views),
  } as Workspace;
  if (org.workosId && !org.demo) {
    const [trial] = await db.select({ startedAt: s.instituteTrials.startedAt, endsAt: s.instituteTrials.endsAt, consumed: s.instituteTrials.consumed }).from(s.instituteTrials).where(eq(s.instituteTrials.workosId, org.workosId));
    workspace.trial = trial;
  }
  const pending = await db.select({ contactKey: s.intakeInbox.contactKey, contactKeyVersion: s.intakeInbox.contactKeyVersion }).from(s.intakeInbox).where(and(eq(s.intakeInbox.organizationId, id), sql`${s.intakeInbox.state} <> 'imported'`));
  const pendingPhones = intakeHeldPhones(id, workspace.leads.map(lead => lead.phone), pending);
  for (const lead of workspace.leads) lead.intakePending = pendingPhones.has(lead.phone);
  workspace.leads.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  workspace.activities.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return normalizeWorkspaceInstants(hydrateWorkspace(workspace));
}

function orgValues(workspace: Workspace, workosId?: string) {
  normalizeWorkspaceInstants(hydrateWorkspace(workspace));
  return { id: workspace.id, ...(workosId ? { workosId } : {}), name: workspace.name, ownerName: workspace.userName, email: workspace.email, demo: workspace.demo, team: workspace.team, courses: workspace.courses, sequence: workspace.sequence, ai: workspace.ai!, subscription: workspace.subscription!, timezone: workspace.timezone!, revision: workspace.revision! };
}

/** Persist only changed records. The organization lock serializes conflicting domain transitions. */
async function persist(db: Transaction, before: Workspace, after: Workspace) {
  type Entity = { id: string };
  async function sync(table: PgTable, previous: Entity[], next: Entity[], transform: (row: Entity) => Record<string, unknown> = row => ({ ...row })) {
    const typed = table as typeof s.leads;
    const old = new Map(previous.map(row => [row.id, JSON.stringify(row)]));
    for (const row of next) {
      if (old.get(row.id) === JSON.stringify(row)) continue;
      const values: Record<string, unknown> = { ...transform(row), organizationId: after.id };
      for (const [key, column] of Object.entries(getTableColumns(table))) if (!column.notNull && !column.generated && values[key] === undefined) values[key] = null;
      // Each mapping is checked against the table schema by Drizzle at the SQL boundary.
      const changed = await db.insert(typed).values(values as typeof s.leads.$inferInsert).onConflictDoUpdate({ target: typed.id, set: values, setWhere: eq(typed.organizationId, after.id) }).returning({ id: typed.id });
      assert(changed.length === 1, "A record ID is already in use outside this workspace.", 409);
    }
    const ids = new Set(next.map(row => row.id));
    for (const row of previous) if (!ids.has(row.id)) await db.delete(typed).where(and(eq(typed.organizationId, after.id), eq(typed.id, row.id)));
  }
  await db.update(s.organizations).set(orgValues(after)).where(eq(s.organizations.id, after.id));
  await sync(s.members, before.members || [], after.members || []);
  await sync(s.leads, before.leads, after.leads);
  await sync(s.files, before.files || [], after.files || []);
  await sync(s.campaigns, before.campaigns, after.campaigns, entity => { const { leadIds: _ids, ...row } = entity as Workspace["campaigns"][number]; return row; });
  for (const campaign of after.campaigns) {
    if (JSON.stringify(before.campaigns.find(item => item.id === campaign.id)?.leadIds) === JSON.stringify(campaign.leadIds)) continue;
    await db.delete(s.campaignRecipients).where(and(eq(s.campaignRecipients.organizationId, after.id), eq(s.campaignRecipients.campaignId, campaign.id)));
    if (campaign.leadIds.length) await db.insert(s.campaignRecipients).values(campaign.leadIds.map(leadId => ({ organizationId: after.id, campaignId: campaign.id, leadId })));
  }
  await sync(s.messages, before.messages, after.messages);
  await sync(s.jobs, before.jobs, after.jobs, entity => { const row = entity as Workspace["jobs"][number]; return { ...row, campaignId: row.campaignId || null, leadId: row.leadId || null, kind: row.kind || "followup", lockedAt: row.lockedAt || null, error: row.error || null, messageId: row.messageId || null }; });
  await sync(s.appointments, before.appointments, after.appointments);
  await sync(s.payments, before.revenue, after.revenue, entity => { const { amount, ...row } = entity as Workspace["revenue"][number]; return { ...row, amountPaise: Math.round(amount * 100), reference: row.reference.toUpperCase() }; });
  await sync(s.refunds, before.refunds || [], after.refunds || [], entity => { const { amount, ...row } = entity as NonNullable<Workspace["refunds"]>[number]; return { ...row, amountPaise: Math.round(amount * 100) }; });
  await sync(s.articles, before.articles, after.articles);
  for (const article of after.articles) {
    const previous = before.articles.find(item => item.id === article.id);
    if (previous && previous.body === article.body && previous.title === article.title && previous.version === article.version) continue;
    await db.delete(s.knowledgeChunks).where(and(eq(s.knowledgeChunks.organizationId, after.id), eq(s.knowledgeChunks.articleId, article.id)));
    const chunks = articleChunks(article);
    if (chunks.length) await db.insert(s.knowledgeChunks).values(chunks.map(chunk => ({ ...chunk, id: uid(), organizationId: after.id, articleId: article.id })));
  }
  await sync(s.activities, before.activities, after.activities);
  await sync(s.tasks, before.tasks || [], after.tasks || []);
  await sync(s.connections, before.connections || [], after.connections || []);
  for (const connection of after.connections || []) {
    if (!connection.externalId || !(connection.status === "connected" || (connection.service === "whatsapp" && connection.metadata.subscriptionPending === "true"))) continue;
    const [route] = await db.insert(s.connectionRoutes).values({ service: connection.service, externalId: connection.externalId, organizationId: after.id }).onConflictDoUpdate({ target: [s.connectionRoutes.service, s.connectionRoutes.externalId], set: { organizationId: after.id }, setWhere: eq(s.connectionRoutes.organizationId, after.id) }).returning();
    assert(route, "This provider account is already connected to another institute.", 409);
  }
  for (const connection of before.connections || []) if (!after.connections?.some(current => current.id === connection.id && current.externalId === connection.externalId && (current.status === "connected" || (current.service === "whatsapp" && current.metadata.subscriptionPending === "true")))) await db.delete(s.connectionRoutes).where(and(eq(s.connectionRoutes.organizationId, after.id), eq(s.connectionRoutes.service, connection.service), eq(s.connectionRoutes.externalId, connection.externalId)));
  await sync(s.savedViews, before.savedViews || [], after.savedViews || []);
}

export async function createPostgresWorkspace(workspace: Workspace, workosId?: string) {
  return tenantTransaction(workspace.id, async tx => {
    await tx.insert(s.organizations).values(orgValues(workspace, workosId));
    await tx.insert(s.organizationRoutes).values({ organizationId: workspace.id, workosId });
    if (workosId && !workspace.demo) {
      const consumed = Boolean(workspace.subscription?.providerId || workspace.subscription?.status !== "trial");
      const now = Date.now();
      await tx.insert(s.instituteTrials).values({ workosId, startedAt: consumed ? null : new Date(now).toISOString(), endsAt: consumed ? null : new Date(now + TRIAL_MS).toISOString(), consumed, provenance: "provisioning" }).onConflictDoNothing();
    }
    const empty = { ...workspace, leads: [], messages: [], campaigns: [], jobs: [], appointments: [], revenue: [], refunds: [], articles: [], activities: [], tasks: [], members: [], files: [], connections: [], savedViews: [] };
    await persist(tx, empty, workspace);
    return workspace;
  });
}
export async function loadPostgresWorkspace(id: string) { return tenantTransaction(id, tx => readWorkspace(id, tx), { isolationLevel: "repeatable read" }); }
export async function mutatePostgresWorkspace<T>(id: string, action: (workspace: Workspace) => T, guard?: (tx: Transaction) => Promise<void>, commit?: (tx: Transaction) => Promise<void>) {
  return tenantTransaction(id, async tx => {
    await tx.select({ id: s.organizations.id }).from(s.organizations).where(eq(s.organizations.id, id)).for("update");
    if (guard) await guard(tx);
    const workspace = await readWorkspace(id, tx);
    const before = structuredClone(workspace);
    const result = action(workspace);
    assert(!(result instanceof Promise), "Workspace mutations must be synchronous.", 500);
    assert(workspace.id === id, "A workspace ID cannot be changed.", 403);
    normalizeWorkspaceInstants(workspace);
    // Guarded identity/team reads must not emit a revision event when nothing changed.
    if (guard && isDeepStrictEqual(before, workspace)) { await commit?.(tx); return { workspace, result }; }
    workspace.revision = (workspace.revision || 0) + 1;
    await persist(tx, before, workspace);
    await commit?.(tx);
    return { workspace, result };
  });
}

export interface LeadQuery { q?: string; course?: string; stage?: Stage; ownerId?: string; view?: LeadView; sort?: LeadSort; page: number; pageSize: number }
export interface LeadPage { leads: Lead[]; page: number; pageSize: number; total: number; hasMore: boolean }
/** Mirrors scoreLead using shared rules; recency is anchored once per request. */
function leadIntentSql(now: number) {
  const points = LEAD_RULES.points;
  return sql<number>`least(100, ${points.base}
    + case when ${s.leads.course} <> '' and ${s.leads.course} <> 'Undecided' then ${points.course} else 0 end
    + case when ${inArray(s.leads.stage, [...LEAD_RULES.qualifiedStages])} then ${points.qualified} else 0 end
    + case when (${s.leads.notes} collate "C") ~* ${LEAD_RULES.budgetPattern} then ${points.budget} else 0 end
    + case when (${s.leads.notes} collate "C") ~* ${LEAD_RULES.visitPattern} then ${points.visit} else 0 end
    + case when ${s.leads.lastInboundAt} is not null then
        case when ${s.leads.lastInboundAt} >= ${new Date(now - LEAD_RULES.recentInboundDays * DAY).toISOString()}::timestamptz then ${points.recentInbound}::integer else ${points.pastInbound}::integer end
      else 0 end
    + case when ${inArray(s.leads.source, [...LEAD_RULES.directSources])} then ${points.directSource} else 0 end)`;
}
export async function queryPostgresLeads(id: string, actor: NonNullable<Workspace["actor"]>, query: LeadQuery, now = Date.now()): Promise<LeadPage> {
  assert(LEAD_VIEWS.includes(query.view || "all") && LEAD_SORTS.includes(query.sort || "newest"), "Unsupported enquiry view or sort.");
  assert(Number.isInteger(query.page) && query.page >= 1 && query.page <= MAX_LEAD_PAGE && Number.isInteger(query.pageSize) && query.pageSize >= 1 && query.pageSize <= MAX_LEAD_PAGE_SIZE, "Invalid enquiry pagination.", 400);
  return tenantTransaction(id, async tx => {
    const identity = await readWorkspaceIdentity(id, tx), members = identity.members!;
    const member = assertActor(identity, actor);
    const requestedOwner = query.ownerId ? members.find(item => item.id === query.ownerId || item.workosId === query.ownerId)?.id || query.ownerId : undefined;
    const ownerId = actor.role === "counsellor" ? member!.id : requestedOwner;
    const filters = [eq(s.leads.organizationId, id)];
    if (ownerId) filters.push(ownerId === "unassigned" ? isNull(s.leads.ownerId) : eq(s.leads.ownerId, ownerId));
    if (requestedOwner && requestedOwner !== ownerId) filters.push(sql`false`);
    if (query.course) filters.push(eq(s.leads.course, query.course));
    if (query.stage) filters.push(eq(s.leads.stage, query.stage));
    const intent = leadIntentSql(now);
    if (query.view === "high-intent") filters.push(sql`${intent} >= ${LEAD_RULES.highIntent}`);
    if (query.view === "needs-followup") filters.push(and(notInArray(s.leads.stage, [...LEAD_RULES.closedStages]), sql`coalesce(${s.leads.lastContactAt}, ${s.leads.createdAt}) <= ${new Date(now - LEAD_RULES.staleDays * DAY).toISOString()}::timestamptz`)!);
    if (query.view === "admitted") filters.push(eq(s.leads.stage, "Admitted"));
    if (query.q) {
      const search = `%${query.q.replace(/[\\%_]/g, character => `\\${character}`)}%`;
      filters.push(or(ilike(s.leads.name, search), ilike(s.leads.phone, search), ilike(s.leads.email, search))!);
    }
    const where = and(...filters);
    const [total] = await tx.select({ value: count() }).from(s.leads).where(where);
    const primaryOrder = query.sort === "intent" ? [desc(intent)] : query.sort === "name" ? [sql`translate(${s.leads.name}, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') collate "C" asc`] : [];
    const rows = await tx.select().from(s.leads).where(where).orderBy(...primaryOrder, desc(s.leads.createdAt), desc(s.leads.id)).limit(query.pageSize).offset((query.page - 1) * query.pageSize);
    return { leads: clean<Lead>(rows).map(lead => ({ ...lead, ownerId: lead.ownerId || null, lastContactAt: lead.lastContactAt || null, lastInboundAt: lead.lastInboundAt || null, consentAt: lead.consentAt || null })), page: query.page, pageSize: query.pageSize, total: total.value, hasMore: hasMoreLeadPages(total.value, query.page, query.pageSize) };
  }, { isolationLevel: "repeatable read" });
}
