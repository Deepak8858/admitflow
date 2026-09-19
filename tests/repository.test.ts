import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq, and, sql } from "drizzle-orm";
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import * as schema from "../src/lib/db/schema";
import { useTestDatabase, type Database } from "../src/lib/db/client";
import { createPostgresWorkspace, loadPostgresWorkspace, mutatePostgresWorkspace, tenantTransaction, queryPostgresLeads } from "../src/lib/db/repository";
import { createWorkspace } from "../src/lib/seed";
import { applyAction } from "../src/lib/actions";
import { uid, isoNow, DAY, LEAD_VIEWS, LEAD_SORTS, leadMatchesView, sortLeads, scoreLead, isStale, revenueReport, resolveSavedViewPreferences, type Lead } from "../src/lib/domain";
import { retrieveKnowledge, vectorAvailable } from "../src/lib/db/knowledge";
import { POST as whatsappPost } from "../src/app/api/webhooks/whatsapp/route";

test("PostgreSQL migrations, round-trip persistence, tenant RLS and transaction rollback", async t => {
  const pg = new PGlite();
  const previousUrl = process.env.DATABASE_URL, previousVector = process.env.KNOWLEDGE_VECTOR_ENABLED, previousMeta = process.env.META_APP_SECRET;
  try {
    const migrations = (await readdir(path.join(process.cwd(), "drizzle"))).filter(name => name.endsWith(".sql")).sort();
    for (const name of migrations.filter(name => name !== "0005_saved_view_preferences.sql")) await pg.exec(await readFile(path.join(process.cwd(), "drizzle", name), "utf8"));
    const db = drizzle(pg, { schema });
    useTestDatabase(db as unknown as Database);
    process.env.DATABASE_URL = "postgresql://injected-pglite-only";
    const first = createWorkspace(), second = createWorkspace();
    await createPostgresWorkspace(first, "org_test_a");
    await createPostgresWorkspace(second, "org_test_b");
    const legacyViewId = uid();
    await tenantTransaction(first.id, tx => tx.execute(sql`insert into saved_views (id, organization_id, name, query, course, stage, owner) values (${legacyViewId}, ${first.id}, 'Legacy view', 'Student', 'NEET 2027', 'Qualified', 'Priya Sharma')`));
    await pg.exec(await readFile(path.join(process.cwd(), "drizzle", "0005_saved_view_preferences.sql"), "utf8"));
    const loaded = await loadPostgresWorkspace(first.id);
    assert.equal(loaded.leads.length, first.leads.length);
    assert.deepEqual(loaded.revenue.map(item => item.amount).sort(), first.revenue.map(item => item.amount).sort());
    assert.equal(loaded.campaigns[0].leadIds.length, first.campaigns[0].leadIds.length);
    const legacyView = loaded.savedViews!.find(view => view.id === legacyViewId)!;
    assert.equal(legacyView.query, "Student"); assert.equal(legacyView.owner, "Priya Sharma");
    assert.equal(legacyView.view, undefined); assert.equal(legacyView.sort, undefined);
    assert.deepEqual(resolveSavedViewPreferences(legacyView, { view: "high-intent", sort: "name" }), { view: "high-intent", sort: "name" });
    await mutatePostgresWorkspace(first.id, workspace => applyAction(workspace, { type: "lead.update", id: first.leads[0].id, changes: { stage: "Lost" } }));
    assert.equal((await loadPostgresWorkspace(first.id)).leads.find(lead => lead.id === first.leads[0].id)?.stage, "Lost");
    await assert.rejects(() => mutatePostgresWorkspace(first.id, workspace => { workspace.name = "Should roll back"; throw new Error("abort"); }), /abort/);
    assert.equal((await loadPostgresWorkspace(first.id)).name, first.name);

    await t.test("composite foreign keys reject cross-tenant owners, files, tasks, messages and job sources", async () => {
      await assert.rejects(() => mutatePostgresWorkspace(first.id, workspace => { workspace.name = "Must roll back with FK failure"; workspace.leads[0].ownerId = second.members![0].id; }));
      assert.equal((await loadPostgresWorkspace(first.id)).name, first.name);
      await assert.rejects(() => tenantTransaction(first.id, tx => tx.insert(schema.messages).values({ id: uid(), organizationId: first.id, leadId: second.leads[0].id, body: "Foreign", direction: "inbound", author: "Student", status: "received", createdAt: isoNow() })));
      await assert.rejects(() => tenantTransaction(first.id, tx => tx.insert(schema.tasks).values({ id: uid(), organizationId: first.id, leadId: first.leads[0].id, title: "Foreign owner", owner: second.members![0].name, ownerId: second.members![0].id, dueAt: isoNow(), status: "open" })));
      await assert.rejects(() => tenantTransaction(first.id, tx => tx.insert(schema.files).values({ id: uid(), organizationId: first.id, leadId: second.leads[0].id, name: "foreign.txt", mime: "text/plain", size: 5, purpose: "attachment", status: "ready", createdAt: isoNow(), objectKey: `${first.id}/foreign.txt` })));
      const otherThread = first.messages.find(message => message.leadId !== first.leads[0].id)!;
      await assert.rejects(() => tenantTransaction(first.id, tx => tx.insert(schema.jobs).values({ id: uid(), organizationId: first.id, leadId: first.leads[0].id, sourceMessageId: otherThread.id, kind: "ai.reply", status: "pending", step: 0, dueAt: isoNow() })));
      const fileId = uid();
      await tenantTransaction(first.id, tx => tx.insert(schema.files).values({ id: fileId, organizationId: first.id, leadId: first.leads[1].id, name: "private.txt", mime: "text/plain", size: 5, purpose: "attachment", status: "ready", createdAt: isoNow(), objectKey: `${first.id}/files/${fileId}/private.txt` }));
      await assert.rejects(() => tenantTransaction(first.id, tx => tx.insert(schema.messages).values({ id: uid(), organizationId: first.id, leadId: first.leads[0].id, fileId, body: "Wrong thread attachment", direction: "outbound", author: "Counsellor", status: "queued", createdAt: isoNow() })));
      await assert.rejects(() => mutatePostgresWorkspace(first.id, workspace => { workspace.leads[0].lastInboundMessageId = otherThread.id; }));
    });

    await t.test("integer paise, refund ceilings, duplicate references and database-error rollback", async () => {
      const paymentId = uid();
      await mutatePostgresWorkspace(first.id, workspace => { workspace.revenue.push({ id: paymentId, leadId: first.leads[0].id, amount: 1250.5, reference: "DECIMAL-RECEIPT", campaignId: null, recordedAt: isoNow() }); });
      const [payment] = await tenantTransaction(first.id, tx => tx.select().from(schema.payments).where(eq(schema.payments.id, paymentId)));
      assert.equal(payment.amountPaise, 125050);
      await mutatePostgresWorkspace(first.id, workspace => applyAction(workspace, { type: "revenue.refund", revenueId: paymentId, amount: 1200.25, reference: "PARTIAL-REFUND" }));
      await assert.rejects(() => tenantTransaction(first.id, tx => tx.insert(schema.refunds).values({ id: uid(), organizationId: first.id, revenueId: paymentId, amountPaise: 5026, reference: "OVER-REFUND", recordedAt: isoNow() })));
      await assert.rejects(() => tenantTransaction(first.id, tx => tx.update(schema.payments).set({ amountPaise: 120000 }).where(eq(schema.payments.id, paymentId))));
      await assert.rejects(() => tenantTransaction(first.id, tx => tx.insert(schema.refunds).values({ id: uid(), organizationId: first.id, revenueId: second.revenue[0].id, amountPaise: 1, reference: "FOREIGN-REFUND", recordedAt: isoNow() })));
      await assert.rejects(() => mutatePostgresWorkspace(first.id, workspace => { workspace.name = "Rollback negative receipt"; workspace.revenue.push({ id: uid(), leadId: first.leads[0].id, amount: -1, reference: "INVALID", campaignId: null, recordedAt: isoNow() }); }));
      assert.equal((await loadPostgresWorkspace(first.id)).name, first.name);
      await assert.rejects(() => tenantTransaction(first.id, tx => tx.insert(schema.payments).values({ id: uid(), organizationId: first.id, leadId: first.leads[0].id, amountPaise: 100, reference: "decimal-receipt", recordedAt: isoNow() })));
      await tenantTransaction(first.id, tx => tx.insert(schema.refunds).values({ id: uid(), organizationId: first.id, revenueId: paymentId, amountPaise: 5025, reference: "BALANCE-REFUND", recordedAt: isoNow() }));
      const balance = await loadPostgresWorkspace(first.id);
      assert.equal(balance.refunds!.filter(refund => refund.revenueId === paymentId).reduce((sum, refund) => sum + Math.round(refund.amount * 100), 0), 125050);
      assert.equal(balance.revenue.find(item => item.id === paymentId)!.amount, 1250.5);
      const report = revenueReport({ revenue: balance.revenue.filter(item => item.id === paymentId), refunds: balance.refunds!.filter(item => item.revenueId === paymentId) }, 1);
      assert.equal(report.money.grossPaise, 125050); assert.equal(report.money.refundsPaise, 125050); assert.equal(report.money.netPaise, 0);
      assert.equal(report.totals.grossRevenue, 1250.5); assert.equal(report.totals.admissions, 1);
    });

    await t.test("saved-view preferences survive a database round trip, preserve legacy rows, and reject invalid enums", async () => {
      const created = await mutatePostgresWorkspace(first.id, workspace => applyAction(workspace, { type: "view.save", name: "Server preferences", query: "Student", course: "NEET 2027", stage: "Qualified", owner: first.members![0].id, view: "needs-followup", sort: "newest" }));
      const id = (created.result as { viewId: string }).viewId;
      const saved = (await loadPostgresWorkspace(first.id)).savedViews!.find(view => view.id === id)!;
      assert.equal(saved.view, "needs-followup"); assert.equal(saved.sort, "newest"); assert.equal(saved.owner, first.members![0].id);
      assert.deepEqual(resolveSavedViewPreferences(saved), { view: "needs-followup", sort: "newest" }, "restoration must not need browser-local data");
      assert.deepEqual(resolveSavedViewPreferences(saved, { view: "all", sort: "name" }), { view: "needs-followup", sort: "newest" });
      await assert.rejects(() => tenantTransaction(first.id, tx => tx.update(schema.savedViews).set({ view: "unknown" as never }).where(eq(schema.savedViews.id, id))));
      await assert.rejects(() => tenantTransaction(first.id, tx => tx.update(schema.savedViews).set({ sort: "unknown" as never }).where(eq(schema.savedViews.id, id))));
      assert.equal((await loadPostgresWorkspace(first.id)).savedViews!.find(view => view.id === id)!.view, "needs-followup");
      const other = await mutatePostgresWorkspace(second.id, workspace => applyAction(workspace, { type: "view.save", name: "Server preferences", view: "admitted", sort: "name" }));
      assert.ok(!(await loadPostgresWorkspace(first.id)).savedViews!.some(view => view.id === (other.result as { viewId: string }).viewId));
      assert.equal((await loadPostgresWorkspace(first.id)).savedViews!.find(view => view.id === legacyViewId)!.sort, undefined);
    });

    await t.test("paginated SQL queries filter same-name owners before count/limit and escape wildcard searches", async () => {
      await mutatePostgresWorkspace(first.id, workspace => {
        workspace.members![0].name = "Same Name"; workspace.members![0].workosId = "user_a"; workspace.members![0].email = "a@example.com";
        workspace.members![1].name = "Same Name"; workspace.members![1].workosId = "user_b"; workspace.members![1].email = "b@example.com";
        for (const lead of workspace.leads) if ([workspace.members![0].id, workspace.members![1].id].includes(lead.ownerId || "")) lead.owner = "Same Name";
      });
      const actor = { id: "user_a", memberId: first.members![0].id, name: "Same Name", email: "a@example.com", role: "counsellor" as const, backend: "workos" as const };
      const page1 = await queryPostgresLeads(first.id, actor, { page: 1, pageSize: 3 }), page2 = await queryPostgresLeads(first.id, actor, { page: 2, pageSize: 3 });
      assert.equal(page1.total, first.leads.filter(lead => lead.ownerId === actor.memberId).length);
      assert.equal(page1.leads.length, 3); assert.equal(page1.hasMore, true);
      assert.ok(page1.leads.every(lead => lead.ownerId === actor.memberId && !page2.leads.some(other => other.id === lead.id)));
      assert.equal((await queryPostgresLeads(first.id, actor, { page: 1, pageSize: 3, ownerId: "user_b" })).total, 0);
      assert.equal((await queryPostgresLeads(first.id, actor, { page: 1, pageSize: 3, q: "%" })).total, 0);
      await assert.rejects(() => queryPostgresLeads(second.id, actor, { page: 1, pageSize: 3 }), /membership has changed/);
    });

    await t.test("chunk indexing and knowledge retrieval are tenant-filtered, versioned, and honestly fall back without pgvector", async () => {
      await pg.exec(await readFile(path.join(process.cwd(), "drizzle", "optional", "pgvector.sql"), "utf8"));
      await mutatePostgresWorkspace(first.id, workspace => { workspace.demo = false; });
      const workspace = await loadPostgresWorkspace(first.id);
      const before = await tenantTransaction(first.id, tx => tx.select().from(schema.knowledgeChunks).where(eq(schema.knowledgeChunks.articleId, first.articles[0].id)));
      assert.ok(before.length > 0);
      process.env.KNOWLEDGE_VECTOR_ENABLED = "true";
      const retrieval = await retrieveKnowledge(workspace, "What are the course fees?");
      assert.equal(retrieval.retrievalMode, "full-text"); assert.ok(retrieval.sources.length > 0); assert.match(retrieval.retrievalNote!, /full-text/);
      assert.ok(retrieval.sources.every(source => first.articles.some(article => article.id === source.id) && !second.articles.some(article => article.id === source.id)));
      const available = await vectorAvailable(first.id);
      if (!available) assert.match(retrieval.retrievalNote!, /pgvector is unavailable/);
      await mutatePostgresWorkspace(first.id, current => applyAction(current, { type: "article.save", id: first.articles[0].id, title: "Updated fees", category: "Courses", body: "Verified updated fees for this institute only." }));
      const after = await tenantTransaction(first.id, tx => tx.select().from(schema.knowledgeChunks).where(eq(schema.knowledgeChunks.articleId, first.articles[0].id)));
      assert.ok(after.every(chunk => chunk.version === 2 && !before.some(old => old.id === chunk.id)));
      await assert.rejects(() => tenantTransaction(first.id, tx => tx.insert(schema.knowledgeChunks).values({ id: uid(), organizationId: first.id, articleId: second.articles[0].id, ordinal: 0, title: "Foreign", body: "Foreign source", version: 1, contentHash: "hash" })));
    });

    await t.test("SQL view, score, order and page counts match domain rules across time boundaries and owner scopes", async () => {
      const now = Date.parse("2026-09-12T12:00:00.000Z"), date = (offset: number) => new Date(now + offset).toISOString();
      const workspace = createWorkspace(false);
      workspace.members = [
        { id: `member_${uid()}`, workosId: "user_views_a", name: "Same Name", email: "a@views.test", role: "counsellor", status: "active" },
        { id: `member_${uid()}`, workosId: "user_views_b", name: "Same Name", email: "b@views.test", role: "counsellor", status: "active" },
      ];
      const patches: Partial<Lead>[] = [
        { name: "ananya", notes: "FEES and weekend BATCH", stage: "Qualified", source: "Referral", lastInboundAt: date(-14 * DAY), lastContactAt: date(-7 * DAY) },
        { name: "Ananya", notes: "price and campus visit", stage: "Counselling", source: "Website", lastInboundAt: date(-14 * DAY - 1), lastContactAt: date(-7 * DAY + 1) },
        { name: "Zoya", notes: "scholarship, classroom", stage: "Demo", lastInboundAt: date(DAY), lastContactAt: null },
        { name: "Student low", course: "Undecided", source: "Walk-in", lastInboundAt: null, lastContactAt: date(-8 * DAY) },
        { name: "Closed admission", notes: "budget, schedule", stage: "Admitted", source: "Referral", lastInboundAt: date(-DAY), lastContactAt: date(-9 * DAY) },
        { name: "Closed lost", notes: "fees and demo", stage: "Lost", source: "Website", lastInboundAt: date(-DAY), lastContactAt: date(-9 * DAY) },
        { name: "Old invalid date", notes: "fees", lastInboundAt: "invalid", lastContactAt: "invalid" },
        { name: "Empty dates", course: "", lastInboundAt: "", lastContactAt: "" },
        { name: "राहुल", notes: "budget", stage: "Negotiation", lastInboundAt: "2026-08-29T17:30:00.000+05:30", lastContactAt: "2026-09-05T17:30:00.000+05:30", consent: "opted_out" },
        { name: "Recent", notes: "fees", stage: "Qualified", lastInboundAt: date(-DAY), lastContactAt: date(-DAY) },
        { name: "Same tie", notes: "fee", stage: "Qualified", lastInboundAt: date(-DAY) },
        { name: "Same tie", notes: "fee", stage: "Qualified", lastInboundAt: date(-DAY) },
        { name: "İpek", notes: "", lastInboundAt: null },
        { name: "ipek", notes: "", lastInboundAt: null },
      ];
      patches.forEach((patch, index) => {
        applyAction(workspace, { type: "lead.create", lead: { name: `Student ${index}`, phone: `+91988888${String(index).padStart(4, "0")}`, ownerId: workspace.members![0].id, course: "NEET" } });
        Object.assign(workspace.leads[0], { createdAt: date(-10 * DAY), lastContactAt: null, ...patch });
      });
      const hidden = { ...workspace.leads.find(lead => lead.name === "ananya")!, id: uid(), phone: "+919999999998", name: "Hidden same-name counsellor", ownerId: workspace.members[1].id };
      workspace.leads.push(hidden);
      await createPostgresWorkspace(workspace, "org_views");
      const actor = { id: "user_views_a", memberId: workspace.members[0].id, name: "Same Name", email: "a@views.test", role: "counsellor" as const, backend: "workos" as const };
      const visible = workspace.leads.filter(lead => lead.ownerId === actor.memberId);
      assert.equal(scoreLead(visible.find(lead => lead.name === "ananya")!, now).score, 100);
      assert.equal(isStale(visible.find(lead => lead.name === "राहुल")!, now), true, "staleness is not a campaign-consent filter");
      for (const view of LEAD_VIEWS) for (const sort of LEAD_SORTS) {
        const expected = sortLeads(visible.filter(lead => leadMatchesView(lead, view, now)), sort, now);
        const ids: string[] = [];
        for (let page = 1; page <= Math.ceil(expected.length / 3) + 1; page++) {
          const actual = await queryPostgresLeads(workspace.id, actor, { view, sort, page, pageSize: 3 }, now);
          assert.equal(actual.total, expected.length, `${view}/${sort} total`);
          assert.equal(actual.hasMore, page * 3 < expected.length);
          assert.deepEqual(actual.leads.map(lead => lead.id), expected.slice((page - 1) * 3, page * 3).map(lead => lead.id), `${view}/${sort} page ${page}`);
          ids.push(...actual.leads.map(lead => lead.id));
        }
        assert.equal(new Set(ids).size, ids.length, "sort ties must not repeat rows across pages");
        assert.ok(!ids.includes(hidden.id));
      }
      assert.equal((await queryPostgresLeads(workspace.id, actor, { view: "admitted", stage: "Qualified", sort: "intent", page: 1, pageSize: 5 }, now)).total, 0);
      assert.equal((await queryPostgresLeads(workspace.id, actor, { view: "high-intent", ownerId: workspace.members[1].id, page: 1, pageSize: 5 }, now)).total, 0);
      const filtered = await queryPostgresLeads(workspace.id, actor, { view: "high-intent", q: "ananya", course: "NEET", sort: "name", page: 1, pageSize: 5 }, now);
      assert.equal(filtered.total, 2);
      await assert.rejects(() => queryPostgresLeads(workspace.id, actor, { view: "unknown" as never, page: 1, pageSize: 5 }, now), /Unsupported/);
      const defaults = await queryPostgresLeads(workspace.id, actor, { page: 1, pageSize: 5 }, now);
      assert.deepEqual(defaults.leads.map(lead => lead.id), sortLeads(visible).slice(0, 5).map(lead => lead.id));
    });

    await t.test("signed WhatsApp routes deduplicate inbound, bind status IDs to the institute, and verify coexistence from echoes", async () => {
      process.env.META_APP_SECRET = "test-meta-app-secret";
      // Converting a demo flag does not grant a hosted trial. This live callback
      // fixture uses explicit verified paid coverage instead.
      await mutatePostgresWorkspace(first.id, workspace => { workspace.subscription = { status: "active", plan: "Test", providerId: "sub_Repository", providerStatus: "active", verifiedAt: isoNow(), currentPeriodEnd: new Date(Date.now() + DAY).toISOString() }; });
      await mutatePostgresWorkspace(first.id, workspace => { workspace.connections!.push({ id: uid(), service: "whatsapp", status: "connected", externalId: "111111", label: "First institute", updatedAt: isoNow(), metadata: { wabaId: "111", coexistence: "requested" } }); workspace.leads.find(lead => lead.id === first.leads[1].id)!.humanOwned = false; });
      await mutatePostgresWorkspace(second.id, workspace => { workspace.demo = false; workspace.connections!.push({ id: uid(), service: "whatsapp", status: "connected", externalId: "222222", label: "Second institute", updatedAt: isoNow(), metadata: { wabaId: "222" } }); });
      const deliver = async (field: string, value: unknown) => {
        const raw = JSON.stringify({ entry: [{ changes: [{ field, value }] }] });
        const signature = `sha256=${createHmac("sha256", process.env.META_APP_SECRET!).update(raw).digest("hex")}`;
        return whatsappPost(new NextRequest("http://127.0.0.1/api/webhooks/whatsapp", { method: "POST", headers: { "x-hub-signature-256": signature }, body: raw }));
      };
      const inbound = { metadata: { phone_number_id: "111111" }, messages: [{ id: "wamid.signed-inbound", from: first.leads[1].phone.slice(1), type: "text", text: { body: "Course fees?" }, timestamp: String(Math.floor(Date.now() / 1000)) }] };
      assert.equal((await deliver("messages", inbound)).status, 200); assert.equal((await deliver("messages", inbound)).status, 200);
      let current = await loadPostgresWorkspace(first.id);
      const incoming = current.messages.find(message => message.providerId === "wamid.signed-inbound")!;
      assert.equal(current.messages.filter(message => message.providerId === "wamid.signed-inbound").length, 1);
      assert.equal(current.jobs.filter(job => job.sourceMessageId === incoming.id).length, 1);
      assert.equal(current.leads.find(lead => lead.id === incoming.leadId)!.lastInboundMessageId, incoming.id);
      const outgoingId = uid();
      await mutatePostgresWorkspace(first.id, workspace => { workspace.messages.push({ id: outgoingId, leadId: incoming.leadId, body: "Hello", author: "Counsellor", direction: "outbound", status: "queued", dispatchedAt: isoNow(), createdAt: isoNow(), dispatchState: "dispatching" }); });
      assert.equal((await deliver("messages", { metadata: { phone_number_id: "222222" }, statuses: [{ id: "wamid.cross-tenant", status: "read", biz_opaque_callback_data: outgoingId }] })).status, 200);
      assert.equal((await loadPostgresWorkspace(first.id)).messages.find(message => message.id === outgoingId)!.status, "queued");
      assert.equal((await deliver("messages", { metadata: { phone_number_id: "111111" }, statuses: [{ id: "wamid.signed-delivery", status: "delivered", recipient_id: first.leads[1].phone.slice(1), biz_opaque_callback_data: outgoingId }] })).status, 200);
      assert.equal((await deliver("smb_message_echoes", { metadata: { phone_number_id: "111111" }, message_echoes: [{ id: "wamid.phone-echo", to: first.leads[1].phone.slice(1), type: "text", text: { body: "I'll take over from the phone" } }] })).status, 200);
      current = await loadPostgresWorkspace(first.id);
      assert.equal(current.messages.find(message => message.id === outgoingId)!.status, "delivered");
      assert.equal(current.connections![0].metadata.coexistence, "verified");
      assert.equal(current.leads.find(lead => lead.id === incoming.leadId)!.humanOwned, true);
    });
    await pg.exec("CREATE ROLE app_runtime; GRANT USAGE ON SCHEMA public TO app_runtime; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime; SET ROLE app_runtime;");
    assert.equal((await db.select().from(schema.leads)).length, 0, "queries without tenant context must return no CRM records");
    await db.transaction(async tx => {
      await tx.execute(`select set_config('app.organization_id', '${first.id}', true)`);
      assert.equal((await tx.select().from(schema.leads)).length, first.leads.length);
      assert.equal((await tx.select().from(schema.leads).where(eq(schema.leads.id, second.leads[0].id))).length, 0);
      assert.equal((await tx.select().from(schema.files).where(eq(schema.files.organizationId, second.id))).length, 0);
      assert.equal((await tx.select().from(schema.knowledgeChunks).where(eq(schema.knowledgeChunks.organizationId, second.id))).length, 0);
      assert.equal((await tx.select().from(schema.savedViews).where(eq(schema.savedViews.organizationId, second.id))).length, 0);
      assert.ok((await tx.select().from(schema.savedViews)).every(view => view.organizationId === first.id));
      assert.ok((await tx.select().from(schema.knowledgeChunks)).every(chunk => chunk.organizationId === first.id));
    });
    assert.equal((await db.select().from(schema.leads)).length, 0, "transaction-local tenant context must not leak to the pooled connection");
    await assert.rejects(() => db.insert(schema.leads).values({ ...second.leads[0], organizationId: second.id }), /row-level security|Failed query/);
  } finally {
    if (previousUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousUrl;
    if (previousVector === undefined) delete process.env.KNOWLEDGE_VECTOR_ENABLED; else process.env.KNOWLEDGE_VECTOR_ENABLED = previousVector;
    if (previousMeta === undefined) delete process.env.META_APP_SECRET; else process.env.META_APP_SECRET = previousMeta;
    await pg.close();
  }
});
