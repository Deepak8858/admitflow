import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { WorkOS } from "@workos-inc/node";
import * as schema from "../../src/lib/db/schema";
import { useTestDatabase, type Database } from "../../src/lib/db/client";
import { loadPostgresWorkspace, mutatePostgresWorkspace } from "../../src/lib/db/repository";
import type { Workspace } from "../../src/lib/domain";
import { migrationPlan, unpooledDatabaseUrl, verifyMigrationHistory } from "../migration-support";
import { importPreparedWorkspaces, mappingSchema, prepareWorkspace, rupeesToPaise, runSqliteMigration, verifyWorkosMappings, workspaceFingerprint } from "../../scripts/migrate-sqlite";

const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const time = "2026-09-01T09:30:00.000Z";
function fixture(): Workspace {
  return {
    id: id(1), name: "Migration fixture", demo: false, userName: "Original Owner", email: "owner@example.invalid", team: ["Original Owner"], courses: ["Course"],
    leads: [{ id: id(2), name: "Fixture student", phone: "+919000000001", email: "", course: "Course", source: "Manual", stage: "Qualified", owner: "Original Owner", value: 65000, notes: "Preserve history", nextAction: "Review", createdAt: time, lastContactAt: null, lastInboundAt: null, consent: "unknown", consentSource: "", consentAt: null, isMinor: false, guardianConsent: false, humanOwned: true }],
    messages: [{ id: id(3), leadId: id(2), body: "Queued before cutover", direction: "outbound", author: "Original Owner", status: "queued", createdAt: time }],
    campaigns: [{ id: id(4), name: "Historical campaign", course: "Course", status: "active", message: "Fixture", leadIds: [id(2)], createdAt: time, delays: [0, 24] }],
    jobs: [{ id: id(5), campaignId: id(4), leadId: id(2), step: 0, dueAt: time, status: "pending", messageId: id(3) }],
    appointments: [{ id: id(6), leadId: id(2), owner: "Original Owner", startsAt: time, duration: 30, kind: "Counselling", status: "scheduled" }],
    revenue: [{ id: id(7), leadId: id(2), campaignId: id(4), amount: 123.45, reference: "cash-01", recordedAt: time }],
    refunds: [{ id: id(8), revenueId: id(7), amount: 23.45, reference: "REFUND-01", recordedAt: time }],
    articles: [{ id: id(9), title: "Original article", category: "Course", body: "Preserved knowledge content.", updatedAt: time }],
    activities: [{ id: id(10), leadId: id(2), kind: "revenue", text: "Original receipt activity", createdAt: time }],
    tasks: [{ id: id(11), leadId: id(2), owner: "Original Owner", title: "Original task", dueAt: time, status: "open" }],
    sequence: { enabled: true, delays: [0, 24] },
  };
}
function mapping(workspaceId = id(1), suffix = "OWNER") {
  return mappingSchema.parse({ version: 1, workspaces: [{ workspaceId, workosOrganizationId: `org_${suffix}`, ownerWorkosUserId: `user_${suffix}`, members: [{ workosUserId: `user_${suffix}`, workosMembershipId: `om_${suffix}`, name: "Verified Owner", email: "owner@example.invalid", role: "owner", status: "active", ownerLabels: ["Original Owner"] }] }] }).workspaces[0];
}
async function temporaryDirectory() {
  const root = resolve("infra", ".test-output");
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, "migration-"));
}

test("money conversion is exact and rejects fractional paise and PostgreSQL overflow", () => {
  assert.equal(rupeesToPaise(65000), 6500000);
  assert.equal(rupeesToPaise(123.45), 12345);
  assert.equal(rupeesToPaise(0.29), 29);
  assert.equal(rupeesToPaise(21474836.47), 2147483647);
  for (const value of [0, -1, 0.001, 21474836.48, Number.MAX_SAFE_INTEGER, Infinity, "123.45"]) assert.throws(() => rupeesToPaise(value));
  assert.throws(() => unpooledDatabaseUrl({ DATABASE_URL: "postgres://runtime" }), /DATABASE_URL_UNPOOLED/);
  assert.throws(() => unpooledDatabaseUrl({ DATABASE_URL_UNPOOLED: "postgres://role:password@ep-example-pooler.ap-southeast-1.aws.neon.tech/db" }), /pooler/);
});

test("journal validation rejects unjournaled SQL and changed or newer applied history", async () => {
  const folder = await temporaryDirectory();
  try {
    await mkdir(join(folder, "meta"));
    await writeFile(join(folder, "meta/_journal.json"), JSON.stringify({ dialect: "postgresql", entries: [{ idx: 0, tag: "0000_fixture", when: 1, breakpoints: true }] }));
    await writeFile(join(folder, "0000_fixture.sql"), "CREATE TABLE fixture (id integer PRIMARY KEY);");
    const plan = await migrationPlan(folder);
    verifyMigrationHistory(plan, [{ hash: plan[0].sha256, created_at: "1" }]);
    assert.throws(() => verifyMigrationHistory(plan, [{ hash: "changed", created_at: "1" }]), /differs/);
    assert.throws(() => verifyMigrationHistory([], [{ hash: plan[0].sha256, created_at: "1" }]), /newer/);
    await writeFile(join(folder, "0001_unjournaled.sql"), "SELECT 1;");
    await assert.rejects(() => migrationPlan(folder), /journal entry/);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("explicit identity mappings preserve legacy member IDs and report unresolved/invalid data", () => {
  const original = fixture();
  original.members = [{ id: "legacy-member-row", name: "Original Owner", email: "", role: "counsellor", status: "active" }];
  const map = mapping(); map.members[0].legacyMemberId = "legacy-member-row";
  const result = prepareWorkspace(original, map, [original.email]);
  assert.deepEqual(result.report.issues, []);
  assert(result.prepared);
  assert.equal(result.prepared.workspace.members![0].id, "legacy-member-row");
  assert.equal(result.prepared.workspace.leads[0].ownerId, "legacy-member-row");
  assert.equal(result.prepared.workspace.jobs[0].status, "reconcile");
  assert.equal(result.prepared.workspace.messages[0].status, "reconcile");
  assert.equal(result.prepared.workspace.campaigns[0].status, "paused");
  assert.equal(result.prepared.workspace.revenue[0].id, original.revenue[0].id);
  assert.equal(result.prepared.workspace.revenue[0].amount, 123.45);
  assert.equal(result.prepared.workspace.appointments[0].startsAt, time);
  assert.equal(original.sequence.enabled, true, "preparation must not mutate the source aggregate");
  assert.equal(original.jobs[0].status, "pending");
  assert.equal(prepareWorkspace(fixture(), undefined).report.action, "blocked");
  const duplicate = fixture(); duplicate.leads.push({ ...duplicate.leads[0], id: id(12) });
  assert(prepareWorkspace(duplicate, mapping()).report.issues.some(issue => issue.includes("duplicate normalized phone")));
  const missing = fixture(); missing.revenue[0].leadId = id(999);
  assert(prepareWorkspace(missing, mapping()).report.issues.some(issue => issue.includes("missing reference")));
});

test("SQLite defaults to a WAL-consistent backup and offline report, excluding sessions and demo data", async () => {
  const folder = await temporaryDirectory(), source = join(folder, "legacy.sqlite"), db = new DatabaseSync(source);
  try {
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE workspaces(id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE users(email TEXT, password_hash TEXT, workspace_id TEXT); CREATE TABLE sessions(token_hash TEXT, workspace_id TEXT);");
    const raw = JSON.stringify(fixture());
    db.prepare("INSERT INTO workspaces VALUES (?, ?)").run(id(1), raw);
    db.prepare("INSERT INTO workspaces VALUES (?, ?)").run(id(100), JSON.stringify({ ...fixture(), id: id(100), demo: true }));
    db.prepare("INSERT INTO users VALUES (?, ?, ?)").run("owner@example.invalid", "test-hash-not-for-export", id(1));
    db.prepare("INSERT INTO sessions VALUES (?, ?)").run("test-session-not-for-export", id(1));
    const mappingFile = join(folder, "mapping.json");
    await writeFile(mappingFile, JSON.stringify({ version: 1, workspaces: [mapping()] }));
    const result = await runSqliteMigration({ source, mappingFile, backupDir: join(folder, "backups") });
    assert.equal(result.report.mode, "dry-run");
    assert.equal(result.report.identitiesVerified, false);
    assert.equal(result.report.localSessionsExcluded, 1);
    assert.equal(result.report.workspaces.filter(workspace => workspace.action === "excluded").length, 1);
    assert.equal(result.report.workspaces.find(workspace => workspace.workspaceId === id(1))!.money!.netPaise, "10000");
    const snapshot = new DatabaseSync(result.report.backup, { readOnly: true });
    try { assert.equal(snapshot.prepare("SELECT data FROM workspaces WHERE id=?").get(id(1))!.data, raw); } finally { snapshot.close(); }
    assert.equal(db.prepare("SELECT data FROM workspaces WHERE id=?").get(id(1))!.data, raw);
    const reportText = await readFile(result.reportFile, "utf8");
    assert(!reportText.includes("test-hash-not-for-export"));
    assert(!reportText.includes("test-session-not-for-export"));
  } finally { db.close(); await rm(folder, { recursive: true, force: true }); }
});

test("apply verification only accepts the real mapped WorkOS identity and organization membership", async () => {
  const prepared = prepareWorkspace(fixture(), mapping()).prepared!;
  const membership = { id: "om_OWNER", userId: "user_OWNER", organizationId: "org_OWNER", status: "active", role: { slug: "owner" } };
  const sdk = { organizations: { getOrganization: async () => ({ id: "org_OWNER" }) }, userManagement: { getOrganizationMembership: async () => membership, getUser: async () => ({ id: "user_OWNER", firstName: "Verified", lastName: "Owner", email: "owner@example.invalid", emailVerified: true }) } } as unknown as Pick<WorkOS, "organizations" | "userManagement">;
  await verifyWorkosMappings([prepared], sdk);
  membership.organizationId = "org_DIFFERENT";
  await assert.rejects(() => verifyWorkosMappings([prepared], sdk), /differs/);
});

test("repository import preserves IDs, exact money and history; resume never overwrites changed tenants", async () => {
  const pg = new PGlite();
  try {
    for (const migration of readMigrationFiles({ migrationsFolder: resolve("drizzle") })) for (const statement of migration.sql) if (statement.trim()) await pg.exec(statement);
    const db = drizzle(pg, { schema }); useTestDatabase(db as unknown as Database);
    const first = prepareWorkspace(fixture(), mapping()).prepared!;
    await importPreparedWorkspaces([first]);
    const saved = await loadPostgresWorkspace(first.workspace.id);
    assert.equal(workspaceFingerprint(saved), first.report.fingerprint);
    assert.equal((await db.select().from(schema.payments))[0].amountPaise, 12345);
    assert.equal((await db.select().from(schema.refunds))[0].amountPaise, 2345);
    assert.equal(saved.leads[0].id, id(2));
    assert.equal(saved.leads[0].value, 65000, "pipeline values remain integer rupees in the current schema");
    assert.equal(saved.appointments[0].startsAt, time);
    const resume = prepareWorkspace(fixture(), mapping()).prepared!;
    await importPreparedWorkspaces([resume], true);
    assert.equal(resume.report.action, "skipped-identical");
    const collisionSource = { ...fixture(), id: id(101) };
    const collision = prepareWorkspace(collisionSource, mapping(id(101), "SECOND")).prepared!;
    await assert.rejects(() => importPreparedWorkspaces([collision]), /source ID/);
    assert.equal((await db.select().from(schema.organizations)).length, 1, "preflight must reject cross-tenant collisions before writing the new organization");
    await mutatePostgresWorkspace(id(1), workspace => { workspace.leads[0].notes = "Post-cutover change"; });
    await assert.rejects(() => importPreparedWorkspaces([prepareWorkspace(fixture(), mapping()).prepared!], true), /differs/);
  } finally { await pg.close(); }
});
