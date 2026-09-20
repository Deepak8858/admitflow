import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getTableColumns, getTableName, eq } from "drizzle-orm";
import * as schema from "../src/lib/db/schema";
import { canonicalInstant, driverInstant, normalizeWorkspaceInstants } from "../src/lib/instants";
import { createWorkspace } from "../src/lib/seed";
import { latestInbound, sortLeads, uid } from "../src/lib/domain";
import { createPostgresWorkspace, loadPostgresWorkspace, mutatePostgresWorkspace } from "../src/lib/db/repository";
import { useTestDatabase, type Database } from "../src/lib/db/client";
import { prepareWorkspace } from "../scripts/migrate-sqlite";

const invalid = ["", " ", "infinity", "-infinity", "not-a-date", "2026-02-30T12:00:00Z", "2025-02-29T12:00:00Z", "2026-04-31T12:00:00Z", "2026-00-01T12:00:00Z", "2026-01-00T12:00:00Z", "2026-01-01T24:00:00Z", "2026-01-01T12:60:00Z", "2026-01-01T12:00:60Z", "2026-01-01T12:00:00", "2026-01-01", "2026-01-01T12:00:00+16:00", "2026-01-01T12:00:00+05:60", "2026-01-01T12:00:00.0001Z", "2026-01-01T12:00:00.1230001Z", "0000-01-01T00:00:00Z", "0001-01-01T00:00:00+01:00", "9999-12-31T23:59:59-01:00"];
const instant = "2026-09-01T09:30:00.123Z", offset = "2026-09-01T15:00:00.123000+05:30";

test("strict instants reject calendar rollover, missing offsets, nonfinite and lossy precision", () => {
  assert.equal(canonicalInstant(offset), instant);
  assert.equal(canonicalInstant("2024-02-29T09:30:00Z"), "2024-02-29T09:30:00.000Z");
  assert.equal(driverInstant(new Date(instant)), instant);
  assert.equal(driverInstant("2026-09-01 09:30:00.123+00"), instant);
  assert.equal(driverInstant("2026-09-01 15:00:00.123+0530"), instant);
  for (const value of [...invalid, null, undefined, new Date(instant)]) assert.throws(() => canonicalInstant(value), RangeError);
  assert.throws(() => driverInstant(new Date(NaN)), RangeError);
});

test("aggregate normalization is explicit, atomic, preserves nulls and never rewrites metadata", () => {
  const workspace = createWorkspace();
  workspace.leads[0].createdAt = offset; workspace.leads[0].lastContactAt = null;
  workspace.leads[0].customFields = { createdAt: "customer label" };
  workspace.subscription = { status: "trial", plan: "Pilot", renewsAt: offset, verifiedAt: offset, currentPeriodEnd: offset };
  workspace.messages[0].createdAt = "invalid-private-date";
  assert.throws(() => normalizeWorkspaceInstants(workspace), { message: "Invalid instant counts: messages.createdAt=1." });
  assert.equal(workspace.leads[0].createdAt, offset, "failed normalization must not partly mutate the aggregate");
  workspace.messages[0].createdAt = offset;
  normalizeWorkspaceInstants(workspace);
  assert.equal(workspace.leads[0].createdAt, instant); assert.equal(workspace.leads[0].lastContactAt, null);
  assert.equal(workspace.subscription.currentPeriodEnd, instant); assert.equal(workspace.messages[0].createdAt, instant);
  assert.equal(workspace.leads[0].customFields.createdAt, "customer label");
});

test("mixed-offset domain ordering chooses the newest actual instant", () => {
  const workspace = createWorkspace(), lead = workspace.leads[0]; delete lead.lastInboundMessageId;
  const older = "2026-09-01T15:00:00+05:30", newer = "2026-09-01T10:00:00Z";
  workspace.messages = [{ id: uid(), leadId: lead.id, body: "older", direction: "inbound", author: "Student", status: "received", createdAt: older }, { id: uid(), leadId: lead.id, body: "newer", direction: "inbound", author: "Student", status: "received", createdAt: newer }];
  assert.equal(latestInbound(workspace, lead)?.body, "newer");
  assert.equal(sortLeads([{ ...lead, id: "older", createdAt: older }, { ...lead, id: "newer", createdAt: newer }])[0].id, "newer");
});

async function oldDatabase() {
  const pg = new PGlite();
  for (const file of (await readdir("drizzle")).filter(file => file.endsWith(".sql") && file < "0010").sort()) await pg.exec(await readFile(`drizzle/${file}`, "utf8"));
  return pg;
}
const migration = () => readFile("drizzle/0010_native_instants.sql", "utf8");

test("old-schema preflight rejects invalid legacy dates with safe counts and atomic rollback", async () => {
  const pg = await oldDatabase();
  try {
    const upgrade = await migration();
    await pg.query("insert into event_receipts(id, provider, received_at, payload) values ('receipt', 'test', $1, '{}')", [instant]);
    for (const value of invalid) {
      await pg.query("update event_receipts set received_at = $1", [value]);
      await assert.rejects(() => pg.transaction(tx => tx.exec(upgrade)), { message: "Invalid legacy instant counts: event_receipts.received_at=1" });
      assert.equal((await pg.query<{ received_at: string }>("select received_at from event_receipts")).rows[0].received_at, value);
      assert.equal((await pg.query<{ data_type: string }>("select data_type from information_schema.columns where table_name='event_receipts' and column_name='received_at'")).rows[0].data_type, "text");
      assert.equal((await pg.query<{ count: number }>("select count(*)::int as count from pg_constraint where conname='trial_dates'")).rows[0].count, 1);
    }
  } finally { await pg.close(); }
});

test("all 31 native columns preserve history, nullable fields, indexes, RLS and immutable triggers", async () => {
  const pg = await oldDatabase();
  try {
    await pg.query("insert into event_receipts(id, provider, received_at, payload) values ('older', 'test', $1, '{}'), ('newer', 'test', '2026-09-01T10:00:00Z', '{}')", [offset]);
    await pg.exec("insert into institute_trials values ('org_legacy', '2026-09-01T15:00:00+05:30', '2026-09-08T15:00:00+05:30', false, 'test')");
    const provisionId = uid(), requestId = uid();
    await pg.query("insert into organization_provisioning(id, actor_id, client_id, request_id, name, external_id, phase, created_at, updated_at) values ($1, 'actor', 'client', $2, 'Test', 'test-external', 'org_dispatched', $3, $3)", [provisionId, requestId, offset]);
    const indexes = (await pg.query("select tablename,indexname from pg_indexes where schemaname='public' order by tablename,indexname")).rows;
    const guards = (await pg.query("select tgname, pg_get_triggerdef(oid) as definition from pg_trigger where not tgisinternal order by tgname")).rows;
    const policies = (await pg.query("select * from pg_policies order by tablename,policyname")).rows;
    const security = (await pg.query("select relname,relrowsecurity,relforcerowsecurity from pg_class where relnamespace='public'::regnamespace and relkind='r' order by relname")).rows;
    const nullable = (await pg.query("select table_name,column_name,is_nullable from information_schema.columns where table_schema='public' order by table_name,column_name")).rows;
    const upgrade = await migration();
    await pg.transaction(tx => tx.exec(upgrade));
    const actual = (await pg.query<{ table_name: string; column_name: string; datetime_precision: number }>("select table_name,column_name,datetime_precision from information_schema.columns where table_schema='public' and data_type='timestamp with time zone' order by table_name,column_name")).rows;
    const snapshot = JSON.parse(await readFile("drizzle/meta/0010_snapshot.json", "utf8")) as { tables: Record<string, { name: string; columns: Record<string, { name: string; type: string }> }> };
    const expected = Object.values(snapshot.tables).flatMap(table => Object.values(table.columns).filter(column => column.type === "timestamptz(3)").map(column => `${table.name}.${column.name}`)).sort();
    assert.equal(expected.length, 31); assert.deepEqual(actual.map(row => `${row.table_name}.${row.column_name}`).sort(), expected);
    assert.ok(actual.every(row => row.datetime_precision === 3));
    assert.deepEqual((await pg.query("select tablename,indexname from pg_indexes where schemaname='public' order by tablename,indexname")).rows, indexes);
    assert.deepEqual((await pg.query("select tgname, pg_get_triggerdef(oid) as definition from pg_trigger where not tgisinternal order by tgname")).rows, guards);
    assert.deepEqual((await pg.query("select * from pg_policies order by tablename,policyname")).rows, policies);
    assert.deepEqual((await pg.query("select relname,relrowsecurity,relforcerowsecurity from pg_class where relnamespace='public'::regnamespace and relkind='r' order by relname")).rows, security);
    assert.deepEqual((await pg.query("select table_name,column_name,is_nullable from information_schema.columns where table_schema='public' order by table_name,column_name")).rows, nullable);
    assert.equal((await pg.query<{ count: number }>("select count(*)::int as count from pg_constraint where pg_get_constraintdef(oid) like '%isfinite(%'")).rows[0].count, 31);
    const db = drizzle(pg, { schema }); useTestDatabase(db as unknown as Database);
    const receipts = await db.select().from(schema.eventReceipts).orderBy(schema.eventReceipts.receivedAt);
    assert.deepEqual(receipts.map(row => row.id), ["older", "newer"]); assert.equal(receipts[0].receivedAt, instant); assert.equal(receipts[0].processedAt, null);
    const [trial] = await db.select().from(schema.instituteTrials); assert.equal(trial.startedAt, "2026-09-01T09:30:00.000Z");
    assert.equal(Date.parse(trial.endsAt!) - Date.parse(trial.startedAt!), 168 * 3600000);
    await assert.rejects(() => pg.exec("update institute_trials set ends_at = ends_at + interval '1 hour'"), /cannot be reset/);
    await assert.rejects(() => pg.exec("delete from institute_trials"), /must be retained/);
    await assert.rejects(() => pg.exec("insert into institute_trials values ('org_bad', '2026-01-01Z', '2026-01-09Z', false, 'test')"));
    await assert.rejects(() => pg.exec("update organization_provisioning set created_at = created_at + interval '1 hour', revision=revision+1"), /cannot be rewritten/);
    await assert.rejects(() => pg.exec("delete from organization_provisioning"), /cannot be deleted/);
    for (const value of ["infinity", "-infinity", "10000-01-01T00:00:00Z"]) await assert.rejects(() => pg.query("update event_receipts set received_at = $1::timestamptz", [value]), /received_at_finite/);
    const [provision] = await db.select().from(schema.organizationProvisioning); assert.equal(provision.createdAt, instant); assert.equal(provision.acknowledgedAt, null);
    // Historical invariants above belong to 0010; current repository reads require the full migration chain.
    for (const file of (await readdir("drizzle")).filter(file => file.endsWith(".sql") && file > "0010_native_instants.sql").sort()) await pg.exec(await readFile(`drizzle/${file}`, "utf8"));
    const currentColumns = (await pg.query<{ table_name: string; column_name: string }>("select table_name,column_name from information_schema.columns where table_schema='public' and data_type='timestamp with time zone'")).rows;
    const modeledColumns = Object.values(schema).flatMap(table => Object.values(getTableColumns(table)).filter(column => column.getSQLType() === "timestamptz(3)").map(column => `${getTableName(table)}.${column.name}`)).sort();
    assert.deepEqual(currentColumns.map(row => `${row.table_name}.${row.column_name}`).sort(), modeledColumns);
    const workspace = createWorkspace(); workspace.leads[0].createdAt = offset;
    workspace.subscription!.renewsAt = offset;
    await createPostgresWorkspace(workspace);
    assert.equal(workspace.leads[0].createdAt, instant); assert.equal(workspace.subscription!.renewsAt, instant);
    const changed = await mutatePostgresWorkspace(workspace.id, current => { current.leads[0].nextActionAt = offset; return current.leads[0]; });
    assert.equal(changed.result.nextActionAt, instant); assert.equal(changed.workspace.leads[0].nextActionAt, instant);
    assert.equal((await loadPostgresWorkspace(workspace.id)).leads[0].nextActionAt, instant);
    await assert.rejects(() => mutatePostgresWorkspace(workspace.id, current => { current.leads[0].createdAt = ""; }), /Invalid instant counts/);
    assert.ok((await loadPostgresWorkspace(workspace.id)).leads[0].createdAt);
    await pg.exec("create role instant_runtime; grant usage on schema public to instant_runtime; grant select on all tables in schema public to instant_runtime; set role instant_runtime");
    assert.equal((await db.select().from(schema.leads)).length, 0); assert.equal((await db.select().from(schema.organizationProvisioning)).length, 0);
    await pg.exec("reset role");
    assert.equal((await db.select().from(schema.organizationProvisioning).where(eq(schema.organizationProvisioning.id, provisionId))).length, 1);
  } finally { await pg.close(); }
});

test("SQLite preparation blocks invalid instant fields with counts, not source contents", () => {
  for (const value of invalid) {
    const workspace = createWorkspace(false);
    const example = createWorkspace().leads[0];
    workspace.leads = [{ ...example, createdAt: value }];
    const result = prepareWorkspace(workspace, undefined);
    assert.equal(result.report.action, "blocked");
    assert.ok(result.report.issues.includes("Invalid instant counts: leads.createdAt=1."));
    assert.equal(result.prepared, undefined);
  }
});
