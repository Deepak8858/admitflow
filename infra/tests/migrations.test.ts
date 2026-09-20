import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { DrizzleQueryError } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { WorkOS } from "@workos-inc/node";
import type { Client } from "pg";
import * as schema from "../../src/lib/db/schema";
import { useTestDatabase, type Database } from "../../src/lib/db/client";
import { loadPostgresWorkspace, mutatePostgresWorkspace } from "../../src/lib/db/repository";
import type { Workspace } from "../../src/lib/domain";
import { MigrationError, migrationPlan, safeMigrationError, unpooledDatabaseUrl, verifyMigrationHistory } from "../migration-support";
import { importPreparedWorkspaces, mappingSchema, prepareWorkspace, rupeesToPaise, runSqliteMigration, verifyImportMigrationHistory, verifyWorkosMappings, workspaceFingerprint } from "../../scripts/migrate-sqlite";

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

const diagnosticPrefix = "Invalid legacy instant counts: ";
const genericMigrationFailure = "Migration failed. Check the database connection, permissions and reviewed migration files.";
const legacyError = (counts = "event_receipts.received_at=1") => Object.assign(new Error(diagnosticPrefix + counts), { code: "22007" });
const wrappedError = (cause: unknown) => new DrizzleQueryError("SELECT 'private-query-marker'", ["private-parameter-marker"], cause as Error);

function assertGenericMigrationFailure(error: unknown) {
  assert.match(safeMigrationError(error), /^Migration failed(?: \([A-Z0-9_]{2,32}\))?\. Check the database connection, permissions and reviewed migration files\.$/);
}

test("safe migration diagnostics accept exactly the 31 historical preflight pairs and safe counts", async () => {
  const sql = await readFile(resolve("drizzle/0010_native_instants.sql"), "utf8");
  const pairs = [...sql.matchAll(/\('([a-z_]+)', '([a-z_]+)'\)/g)].map(match => `${match[1]}.${match[2]}`);
  assert.equal(pairs.length, 31);
  assert.equal(new Set(pairs).size, 31);
  for (const pair of pairs) {
    const error = legacyError(`${pair}=1`);
    assert.equal(safeMigrationError(error), error.message);
    assert.equal(safeMigrationError(wrappedError(wrappedError(error))), error.message);
  }
  const all = legacyError(pairs.map(pair => `${pair}=${Number.MAX_SAFE_INTEGER}`).join(", "));
  assert.equal(safeMigrationError(all), all.message);
  // Whitelisting table and column names separately would incorrectly accept these combinations.
  for (const table of new Set(pairs.map(pair => pair.split(".")[0]))) {
    for (const column of new Set(pairs.map(pair => pair.split(".")[1]))) {
      const pair = `${table}.${column}`;
      if (!pairs.includes(pair)) assertGenericMigrationFailure(legacyError(`${pair}=1`));
    }
  }
});

test("safe migration diagnostics reject malformed counts, identifiers, extra text and excessive input", () => {
  const invalid = ["", "0", "-1", "+1", "01", "1.0", "1.5", "1e2", "NaN", "Infinity", "9007199254740992", "9999999999999999", "9223372036854775807", "１", " 1", "1 "];
  const messages = [
    ...invalid.map(count => diagnosticPrefix + `event_receipts.received_at=${count}`),
    diagnosticPrefix, diagnosticPrefix + "private_table.received_at=1", diagnosticPrefix + "event_receipts.private_column=1",
    diagnosticPrefix + "public.event_receipts.received_at=1", diagnosticPrefix + '"event_receipts".received_at=1',
    diagnosticPrefix + "event_receipts.received_at=1, event_receipts.received_at=2",
    diagnosticPrefix + "event_receipts.received_at=1,event_receipts.processed_at=2",
    diagnosticPrefix + "event_receipts.received_at=1, ", diagnosticPrefix + "event_receipts.received_at=1; SELECT private_marker",
    diagnosticPrefix + "event_receipts.received_at=1\n", diagnosticPrefix + "event_receipts.received_at=1\r\n",
    diagnosticPrefix + "event_receipts.received_at=1\0", diagnosticPrefix + "event_receipts.received_at=1\u001b[31m",
    "private-marker " + diagnosticPrefix + "event_receipts.received_at=1",
    diagnosticPrefix + "event_receipts.received_at=1 private-marker",
    diagnosticPrefix + Array(32).fill("event_receipts.received_at=1").join(", "),
    diagnosticPrefix + "event_receipts.received_at=" + "1".repeat(3000),
  ];
  for (const message of messages) {
    const error = Object.assign(new Error(message), { code: "22007" });
    assertGenericMigrationFailure(error);
    assertGenericMigrationFailure(wrappedError(error));
  }
  for (const code of [undefined, "23505", 22007, "22007\n", "private-marker"]) {
    assertGenericMigrationFailure(Object.assign(legacyError(), { code }));
  }
  assertGenericMigrationFailure({ code: "22007", cause: { message: legacyError().message } });
  assertGenericMigrationFailure({ message: legacyError().message, cause: { code: "22007" } });
});

test("safe migration diagnostics bound cause traversal and reject cycles, accessors and malformed wrappers", () => {
  const valid = legacyError();
  let chain: unknown = valid;
  for (let index = 0; index < 7; index++) chain = wrappedError(chain);
  assert.equal(safeMigrationError(chain), valid.message, "eight total cause objects are accepted");
  assertGenericMigrationFailure(wrappedError(chain));
  for (let index = 0; index < 100; index++) chain = wrappedError(chain);
  assertGenericMigrationFailure(chain);
  const cycle = wrappedError(valid); cycle.cause = cycle;
  assertGenericMigrationFailure(cycle);
  const twoNodeCycle = wrappedError(cycle); cycle.cause = twoNodeCycle;
  assertGenericMigrationFailure(twoNodeCycle);
  assertGenericMigrationFailure(Object.assign(valid, { cause: valid }));
  for (const malformed of [null, undefined, 1, "private-marker", [], { cause: legacyError() }, { message: 1, cause: legacyError() }, { message: "wrapper", cause: "private-marker" }, Object.create({ message: "wrapper", cause: legacyError() })]) assertGenericMigrationFailure(malformed);
  let accessorCalls = 0;
  for (const key of ["message", "code", "cause"]) {
    const error = wrappedError(legacyError());
    Object.defineProperty(error, key, { get() { accessorCalls++; throw new Error("private-accessor-marker"); } });
    assertGenericMigrationFailure(error);
  }
  assert.equal(safeMigrationError({ code: { toString() { accessorCalls++; return "PRIVATE_MARKER"; } } }), genericMigrationFailure);
  assert.equal(accessorCalls, 0, "error accessors and coercion hooks must never run");
  const inheritedCause = Object.assign(Object.create({ cause: legacyError() }), { message: legacyError().message, code: "22007" });
  assertGenericMigrationFailure(inheritedCause);
  for (const code of ["22007\n", "22007\r", "22007\u2028", "22007\u2029", "A".repeat(33)]) assert.equal(safeMigrationError({ code }), genericMigrationFailure);
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  assert.equal(safeMigrationError(revoked.proxy), genericMigrationFailure);
  assert.equal(safeMigrationError(new MigrationError("Reviewed migration guidance.")), "Reviewed migration guidance.");
  assert.equal(safeMigrationError(new Error("postgres://private-marker")), genericMigrationFailure);
  assert.equal(safeMigrationError(Object.assign(new Error("private-marker"), { code: "23505" })), genericMigrationFailure.replace("failed.", "failed (23505)."));
});

test("real historical preflight errors survive Drizzle wrapping without leaking invalid source values", async () => {
  const pg = new PGlite();
  try {
    const plan = await migrationPlan(), migrations = readMigrationFiles({ migrationsFolder: resolve("drizzle") });
    const index = plan.findIndex(entry => entry.tag === "0010_native_instants");
    assert.ok(index > 0);
    for (const migration of migrations.slice(0, index)) for (const statement of migration.sql) if (statement.trim()) await pg.exec(statement);
    await pg.query("INSERT INTO event_receipts(id, provider, received_at, payload) VALUES ('invalid-instant', 'test', $1, '{}')", ["private-invalid-instant-marker"]);
    await assert.rejects(() => pg.exec(migrations[index].sql.join("\n")), (error: unknown) => {
      assert.equal(safeMigrationError(error), diagnosticPrefix + "event_receipts.received_at=1");
      assert.equal(safeMigrationError(wrappedError(error)), diagnosticPrefix + "event_receipts.received_at=1");
      return true;
    });
  } finally { await pg.close(); }
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

test("SQLite import requires a complete matching journal, including a missing migration table", async () => {
  const pg = new PGlite();
  const client = { query: (query: string) => pg.query(query) } as unknown as Pick<Client, "query">;
  const plan = [{ tag: "0000_fixture", when: 1, sha256: "fixture-hash", statements: 1 }];
  const missingJournal = (error: unknown) => {
    assert(error instanceof MigrationError);
    assert.equal(safeMigrationError(error), "Apply the full Drizzle journal before importing SQLite workspaces.");
    return true;
  };
  try {
    await assert.rejects(() => verifyImportMigrationHistory(client, plan), missingJournal);
    await pg.exec("CREATE SCHEMA drizzle; CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint);");
    await assert.rejects(() => verifyImportMigrationHistory(client, plan), missingJournal);
    await pg.exec("INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('fixture-hash', 1)");
    await verifyImportMigrationHistory(client, plan);
    await pg.exec("UPDATE drizzle.__drizzle_migrations SET hash = 'changed'");
    await assert.rejects(() => verifyImportMigrationHistory(client, plan), /differs/);
    await pg.exec("INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('newer', 2)");
    await assert.rejects(() => verifyImportMigrationHistory(client, plan), /newer/);
  } finally { await pg.close(); }
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
    const offsetSource = fixture();
    offsetSource.leads[0].createdAt = "2026-09-01T15:00:00.000000+05:30";
    offsetSource.appointments[0].startsAt = "2026-09-01T05:30:00-04:00";
    offsetSource.subscription = { status: "trial", plan: "Pilot", renewsAt: "2026-09-01T15:00:00+05:30" };
    const first = prepareWorkspace(offsetSource, mapping()).prepared!;
    assert.equal(first.workspace.leads[0].createdAt, time);
    assert.equal(first.workspace.subscription!.renewsAt, time);
    await importPreparedWorkspaces([first]);
    const saved = await loadPostgresWorkspace(first.workspace.id);
    assert.equal(workspaceFingerprint(saved), first.report.fingerprint);
    assert.equal((await db.select().from(schema.payments))[0].amountPaise, 12345);
    assert.equal((await db.select().from(schema.refunds))[0].amountPaise, 2345);
    assert.equal(saved.leads[0].id, id(2));
    assert.equal(saved.leads[0].value, 65000, "pipeline values remain integer rupees in the current schema");
    assert.equal(saved.appointments[0].startsAt, time);
    const canonicalSource = fixture();
    canonicalSource.subscription = { status: "trial", plan: "Pilot", renewsAt: time };
    const resume = prepareWorkspace(canonicalSource, mapping()).prepared!;
    assert.equal(resume.report.fingerprint, first.report.fingerprint, "source and target fingerprints compare instants, not offset spelling");
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
