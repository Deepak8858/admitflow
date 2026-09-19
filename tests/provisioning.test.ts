import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { transform } from "esbuild";
import { NextRequest } from "next/server";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq, sql } from "drizzle-orm";
import { closeDatabase, useTestDatabase, type Database } from "../src/lib/db/client";
import * as schema from "../src/lib/db/schema";
import { beginProvisioning, markProvisioningReview, pendingProvisioning, provisioningTransaction, readProvisioning, transitionProvisioning } from "../src/lib/db/provisioning";
import * as provisioningDb from "../src/lib/db/provisioning";
import { acknowledgeProvisioning, continueProvisioning, pendingProvisioningStatus, readyProvisioning, startProvisioning, type ProvisioningProvider } from "../src/lib/provisioning";

async function isolatedModule<T>(file: string, overrides: Record<string, unknown>): Promise<T> {
  const filename = path.resolve(file), original = createRequire(filename);
  const { code } = await transform(await readFile(filename, "utf8"), { loader: "ts", format: "cjs", target: "node24" });
  const module = { exports: {} };
  new vm.Script(`(function(require,module,exports){${code}\n})`, { filename }).runInThisContext()((name: string) => Object.hasOwn(overrides, name) ? overrides[name] : original(name), module, module.exports);
  return module.exports as T;
}
function barrier() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
test("durable organization provisioning and route recovery", { timeout: 120_000 }, async t => {
  const oldClient = process.env.WORKOS_CLIENT_ID; process.env.WORKOS_CLIENT_ID = "client_test";
  t.after(() => { if (oldClient === undefined) delete process.env.WORKOS_CLIENT_ID; else process.env.WORKOS_CLIENT_ID = oldClient; });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Network forbidden in provisioning tests"); });
  const pg = new PGlite();
  t.after(async () => { await closeDatabase(); await pg.close(); });
  for (const file of (await readdir("drizzle")).filter(file => file.endsWith(".sql")).sort()) await pg.exec(await readFile(path.join("drizzle", file), "utf8"));
  await pg.exec("CREATE ROLE provisioning_runtime NOLOGIN NOBYPASSRLS; GRANT USAGE ON SCHEMA public TO provisioning_runtime; GRANT SELECT, INSERT, UPDATE, DELETE ON organization_provisioning TO provisioning_runtime; SET ROLE provisioning_runtime;");
  useTestDatabase(drizzle(pg, { schema }) as unknown as Database);
  let sequence = 0;
  function fixture() {
    const actor = { actorId: `user_${++sequence}`, clientId: "client_test" }, requestId = randomUUID();
    const state = { orgWrites: 0, memberWrites: 0, org: null as null | { id: string; externalId: string; metadata: Record<string, string> }, members: [] as { id: string; userId: string; organizationId: string; status: "active" | "inactive" | "pending"; role: { slug: string } }[], orgFailure: "" as "" | "before" | "after", memberFailure: "" as "" | "before" | "after", hideOrg: false, hideMembers: false, onOrg: undefined as undefined | (() => Promise<void>) };
    const provider: ProvisioningProvider = {
      organizations: {
        async createOrganization(input, options) {
          state.orgWrites++; assert.ok(options.idempotencyKey); await state.onOrg?.();
          if (state.orgFailure === "before") throw new Error("before org response");
          state.org = { id: `org_${sequence}`, externalId: input.externalId, metadata: input.metadata };
          if (state.orgFailure === "after") throw new Error("after org acceptance");
          return structuredClone(state.org);
        },
        async getOrganizationByExternalId(externalId) { if (!state.org || state.hideOrg) throw new Error("not found"); assert.equal(externalId, state.org.externalId); return structuredClone(state.org); },
        async getOrganization(id) { if (!state.org || state.hideOrg) throw new Error("unavailable"); assert.equal(id, state.org.id); return structuredClone(state.org); },
      },
      userManagement: {
        async listOrganizationMemberships(input) { assert.deepEqual(input.statuses, ["active", "inactive", "pending"]); return { autoPagination: async () => state.hideMembers ? [] : structuredClone(state.members) }; },
        async createOrganizationMembership(input) {
          state.memberWrites++;
          if (state.memberFailure === "before") throw new Error("before member response");
          const member = { id: `om_${sequence}`, userId: input.userId, organizationId: input.organizationId, status: "active" as const, role: { slug: input.roleSlug } };
          state.members.push(member);
          if (state.memberFailure === "after") throw new Error("after membership acceptance");
          return structuredClone(member);
        },
      },
    };
    return { actor, requestId, state, provider, start: () => startProvisioning(actor, requestId, "Test Institute", provider) };
  }
  await t.test("concurrent requests and immutable same-key payload yield one create", async () => {
    const f = fixture(), entered = barrier(), resume = barrier(); f.state.onOrg = async () => { entered.release(); await resume.promise; };
    const first = f.start();
    try {
      await entered.promise;
      assert.equal((await f.start()).state, "pending");
      await assert.rejects(startProvisioning(f.actor, randomUUID(), "Another Institute", f.provider), /already pending/);
      await assert.rejects(startProvisioning(f.actor, f.requestId, "Changed Name", f.provider), /different institute name/);
      assert.equal(f.state.orgWrites, 1);
    } finally { resume.release(); }
    assert.equal((await first).state, "ready"); assert.equal(f.state.memberWrites, 1);
  });
  for (const failure of ["before", "after"] as const) await t.test(`organization ${failure} acceptance ambiguity never replays`, async () => {
    const f = fixture(); f.state.orgFailure = failure;
    const initial = await f.start(); assert.equal(initial.state, "pending");
    f.state.hideOrg = true;
    for (let i = 0; i < 3; i++) assert.equal((await continueProvisioning(f.actor, initial.id, f.provider)).state, "pending");
    assert.equal(f.state.orgWrites, 1); assert.equal(f.state.memberWrites, 0);
    f.state.hideOrg = false;
    assert.equal((await f.start()).state, failure === "after" ? "ready" : "pending");
    assert.equal(f.state.orgWrites, 1); assert.equal(f.state.memberWrites, failure === "after" ? 1 : 0);
  });
  for (const failure of ["before", "after"] as const) await t.test(`membership ${failure} acceptance ambiguity never replays`, async () => {
    const f = fixture(); f.state.memberFailure = failure;
    const initial = await f.start(); assert.equal(initial.state, "pending");
    f.state.hideMembers = true;
    for (let i = 0; i < 3; i++) assert.equal((await continueProvisioning(f.actor, initial.id, f.provider)).state, "pending");
    f.state.hideMembers = false;
    assert.equal((await continueProvisioning(f.actor, initial.id, f.provider)).state, failure === "after" ? "ready" : "pending");
    assert.equal(f.state.orgWrites, 1); assert.equal(f.state.memberWrites, 1);
  });
  await t.test("crash after committed dispatch marker does not grant another dispatch", async () => {
    const f = fixture(); const initial = await beginProvisioning(f.actor, f.requestId, "Test Institute");
    assert.equal(initial.dispatch, true); assert.equal((await f.start()).state, "pending");
    assert.equal(f.state.orgWrites, 0); assert.equal(f.state.memberWrites, 0);
  });
  await t.test("crash after membership marker and before transmission remains pending", async () => {
    const f = fixture(); f.state.orgFailure = "after"; await f.start();
    const status = await pendingProvisioningStatus(f.actor, f.provider); assert.equal(status?.state, "continue");
    const row = await readProvisioning(f.actor, status!.id);
    await transitionProvisioning(f.actor, row, { phase: "membership_dispatched" });
    assert.equal((await continueProvisioning(f.actor, row.id, f.provider)).state, "pending");
    assert.equal(f.state.memberWrites, 0);
  });
  for (const field of ["externalId", "operation", "actor", "client"] as const) await t.test(`mismatched organization ${field} requires review`, async () => {
    const f = fixture(); f.state.orgFailure = "after"; const initial = await f.start();
    if (field === "externalId") { const external = f.state.org!.externalId; f.provider.organizations.getOrganizationByExternalId = async () => ({ ...f.state.org!, externalId: `${external}-wrong` }); }
    else f.state.org!.metadata[`admitflow_${field === "operation" ? "operation_id" : field === "actor" ? "actor_id" : "client_id"}`] = "wrong";
    assert.equal((await continueProvisioning(f.actor, initial.id, f.provider)).state, "review_required");
    assert.equal(f.state.orgWrites, 1); assert.equal(f.state.memberWrites, 0);
  });
  for (const mismatch of ["inactive", "wrong-user", "wrong-org", "wrong-role"] as const) await t.test(`${mismatch} membership is not adopted or reactivated`, async () => {
    const f = fixture(); f.state.memberFailure = "after"; const status = await f.start(), member = f.state.members[0];
    if (mismatch === "inactive") member.status = "inactive";
    if (mismatch === "wrong-user") member.userId = "user_wrong";
    if (mismatch === "wrong-org") member.organizationId = "org_wrong";
    if (mismatch === "wrong-role") member.role.slug = "admin";
    assert.equal((await continueProvisioning(f.actor, status.id, f.provider)).state, "review_required");
    assert.equal(f.state.memberWrites, 1);
  });
  for (const stage of ["organization", "membership"] as const) await t.test(`${stage} mismatch survives a concurrent positive phase advance`, async () => {
    const f = fixture(), entered = barrier(), resume = barrier();
    if (stage === "organization") f.state.orgFailure = "after"; else f.state.memberFailure = "after";
    const initial = await f.start(), before = await readProvisioning(f.actor, initial.id);
    const mismatching: ProvisioningProvider = { organizations: { ...f.provider.organizations }, userManagement: { ...f.provider.userManagement } };
    if (stage === "organization") mismatching.organizations.getOrganizationByExternalId = async () => {
      const wrong = { ...structuredClone(f.state.org!), externalId: "wrong-identity" };
      entered.release(); await resume.promise; return wrong;
    };
    else mismatching.userManagement.listOrganizationMemberships = async () => ({ autoPagination: async () => {
      const wrong = [{ ...structuredClone(f.state.members[0]), userId: "user_wrong" }];
      entered.release(); await resume.promise; return wrong;
    } });
    const negative = continueProvisioning(f.actor, initial.id, mismatching);
    let confirmed!: Awaited<ReturnType<typeof readProvisioning>>;
    try {
      await entered.promise;
      const positive = await pendingProvisioningStatus(f.actor, f.provider);
      assert.equal(positive?.state, stage === "organization" ? "continue" : "ready");
      confirmed = await readProvisioning(f.actor, initial.id);
      assert.ok(confirmed.revision > before.revision);
    } finally { resume.release(); }
    assert.equal((await negative).state, "review_required");
    const reviewed = await readProvisioning(f.actor, initial.id);
    assert.equal(reviewed.phase, confirmed.phase); assert.equal(reviewed.organizationId, confirmed.organizationId); assert.equal(reviewed.membershipId, confirmed.membershipId);
    assert.equal(reviewed.reviewCode, "identity_mismatch"); assert.equal(reviewed.revision, confirmed.revision + 1);
    assert.equal((await continueProvisioning(f.actor, initial.id, f.provider)).state, "review_required");
    await assert.rejects(readyProvisioning(f.actor, initial.id, f.provider), /not ready/);
    await assert.rejects(acknowledgeProvisioning(f.actor, initial.id, f.provider), /not ready/);
    await assert.rejects(startProvisioning(f.actor, randomUUID(), "Replacement Institute", f.provider), /already pending/);
    assert.equal(f.state.orgWrites, 1); assert.equal(f.state.memberWrites, stage === "organization" ? 0 : 1);
  });
  await t.test("concurrent duplicate review is idempotent, invalidates stale positive CAS and stays actor/client scoped", async () => {
    const f = fixture(), started = await beginProvisioning(f.actor, f.requestId, "Test Institute");
    for (const actor of [{ ...f.actor, actorId: "user_wrong" }, { ...f.actor, clientId: "client_wrong" }]) await assert.rejects(markProvisioningReview(actor, started.operation.id), /not found/);
    assert.equal((await readProvisioning(f.actor, started.operation.id)).reviewCode, null);
    const reviews = await Promise.all([markProvisioningReview(f.actor, started.operation.id), markProvisioningReview(f.actor, started.operation.id)]);
    assert.ok(reviews.every(row => row.reviewCode === "identity_mismatch" && row.revision === 1));
    assert.equal(await transitionProvisioning(f.actor, started.operation, { phase: "org_confirmed", organizationId: "org_positive" }), undefined);
    assert.equal((await continueProvisioning(f.actor, started.operation.id, f.provider)).state, "review_required");
    assert.equal(f.state.orgWrites, 0); assert.equal(f.state.memberWrites, 0);
  });
  for (const failedPhase of ["org_confirmed", "ready"] as const) await t.test(`local confirmation failure at ${failedPhase} recovers positive evidence without replay`, async () => {
    const f = fixture(); let fail = true;
    const service = await isolatedModule<typeof import("../src/lib/provisioning")>("src/lib/provisioning.ts", { "./db/provisioning": { ...provisioningDb, transitionProvisioning: async (...args: Parameters<typeof transitionProvisioning>) => {
      if (fail && args[2].phase === failedPhase) { fail = false; throw new Error("simulated database failure after provider acceptance"); }
      return transitionProvisioning(...args);
    } } });
    await assert.rejects(service.startProvisioning(f.actor, f.requestId, "Test Institute", f.provider), /database failure/);
    assert.equal((await f.start()).state, "ready"); assert.equal(f.state.orgWrites, 1); assert.equal(f.state.memberWrites, 1);
  });
  for (const status of ["active", "inactive", "pending"] as const) await t.test(`preexisting ${status} membership never dispatches create or reactivation`, async () => {
    const f = fixture(); f.state.orgFailure = "after"; const initial = await f.start();
    f.state.members.push({ id: "om_existing", userId: f.actor.actorId, organizationId: f.state.org!.id, status, role: { slug: "owner" } });
    assert.equal((await continueProvisioning(f.actor, initial.id, f.provider)).state, status === "active" ? "ready" : "review_required");
    assert.equal(f.state.orgWrites, 1); assert.equal(f.state.memberWrites, 0);
  });
  await t.test("competing membership dispatch CAS permits exactly one transition", async () => {
    const f = fixture(); f.state.orgFailure = "after"; await f.start(); const status = await pendingProvisioningStatus(f.actor, f.provider);
    const row = await readProvisioning(f.actor, status!.id);
    const winners = await Promise.all([transitionProvisioning(f.actor, row, { phase: "membership_dispatched" }), transitionProvisioning(f.actor, row, { phase: "membership_dispatched" })]);
    assert.equal(winners.filter(Boolean).length, 1);
    assert.equal((await continueProvisioning(f.actor, row.id, f.provider)).state, "pending"); assert.equal(f.state.memberWrites, 0);
  });
  await t.test("ready completion requires explicit acknowledgement and never rewrites history", async () => {
    const f = fixture(), ready = await f.start();
    await assert.rejects(startProvisioning(f.actor, randomUUID(), "New Institute", f.provider), /already pending/);
    assert.equal((await f.start()).id, ready.id); assert.equal(f.state.orgWrites, 1);
    f.state.members[0].status = "inactive";
    await assert.rejects(readyProvisioning(f.actor, ready.id, f.provider), /ownership changed/);
    await assert.rejects(acknowledgeProvisioning(f.actor, ready.id, f.provider), /ownership changed/);
    assert.ok(await pendingProvisioning(f.actor));
    f.state.members[0].status = "active";
    assert.equal((await acknowledgeProvisioning(f.actor, ready.id, f.provider)).acknowledged, true);
    assert.equal(await pendingProvisioning(f.actor), undefined);
    assert.equal((await f.start()).acknowledged, true); assert.equal(f.state.orgWrites, 1);
    const row = await readProvisioning(f.actor, ready.id);
    await assert.rejects(transitionProvisioning(f.actor, row, { acknowledgedAt: null }));
    await assert.rejects(transitionProvisioning(f.actor, row, { phase: "org_dispatched" }));
    await assert.rejects(provisioningTransaction(f.actor, tx => tx.delete(schema.organizationProvisioning).where(eq(schema.organizationProvisioning.id, row.id))));
    await assert.rejects(provisioningTransaction(f.actor, tx => tx.update(schema.organizationProvisioning).set({ name: "Changed", revision: row.revision + 1 }).where(eq(schema.organizationProvisioning.id, row.id))));
    assert.equal((await beginProvisioning(f.actor, randomUUID(), "Another Institute")).dispatch, true);
  });
  await t.test("forced RLS isolates actor and WorkOS client with missing context deny", async () => {
    const f = fixture(), row = await beginProvisioning(f.actor, f.requestId, "Test Institute");
    await assert.rejects(readProvisioning({ ...f.actor, actorId: "user_other" }, row.operation.id), /not found/);
    await assert.rejects(readProvisioning({ ...f.actor, clientId: "client_other" }, row.operation.id), /not found/);
    assert.equal((await pg.query("select * from organization_provisioning")).rows.length, 0);
    for (const actor of [{ ...f.actor, actorId: "user_other" }, { ...f.actor, clientId: "client_other" }]) {
      assert.equal((await provisioningTransaction(actor, tx => tx.select().from(schema.organizationProvisioning))).length, 0);
      await assert.rejects(provisioningTransaction(actor, tx => tx.insert(schema.organizationProvisioning).values({ ...row.operation, id: randomUUID(), requestId: randomUUID(), externalId: randomUUID() })));
      assert.equal((await provisioningTransaction(actor, tx => tx.update(schema.organizationProvisioning).set({ revision: 1 }).where(eq(schema.organizationProvisioning.id, row.operation.id)).returning())).length, 0);
    }
    const owner = await pg.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>("select relrowsecurity, relforcerowsecurity from pg_class where relname = 'organization_provisioning'");
    assert.equal(owner.rows[0].relrowsecurity, true); assert.equal(owner.rows[0].relforcerowsecurity, true);
    await provisioningTransaction(f.actor, async tx => { await assert.rejects(tx.execute(sql`update organization_provisioning set actor_id = 'user_other', revision = revision + 1 where id = ${row.operation.id}`)); });
  });
  await t.test("actual route fully paginates, retains ready receipt on refresh failure, then opens", async () => {
    const f = fixture(); let refreshCalls = 0, refreshFails = true, pagesRead = 0;
    const extra = Array.from({ length: 101 }, (_, index) => ({ id: `om_extra_${index}`, userId: f.actor.actorId, organizationId: `org_extra_${index}`, status: "active", role: { slug: "owner" } }));
    const provider = { ...f.provider, organizations: { ...f.provider.organizations, getOrganization: async (id: string) => id.startsWith("org_extra_") ? { id, name: id } : f.provider.organizations.getOrganization(id) }, userManagement: { ...f.provider.userManagement, listOrganizationMemberships: async (input: { organizationId?: string; userId: string; statuses: ("active" | "inactive" | "pending")[] }) => input.organizationId ? f.provider.userManagement.listOrganizationMemberships({ ...input, organizationId: input.organizationId }) : { data: extra.slice(0, 100), autoPagination: async () => { pagesRead++; return extra; } } } };
    const route = await isolatedModule<typeof import("../src/app/api/organizations/route")>("src/app/api/organizations/route.ts", { "@/lib/auth": { hostedSession: async () => ({ user: { id: f.actor.actorId, firstName: "Owner" } }), workos: () => provider }, "@workos-inc/authkit-nextjs": { refreshSession: async () => { refreshCalls++; if (refreshFails) throw new Error("sensitive refresh failure"); return { accessToken: "never-return-this" }; } } });
    const post = (action: Record<string, unknown>) => route.POST(new NextRequest("http://127.0.0.1:3000/api/organizations", { method: "POST", headers: { "Content-Type": "application/json", Host: "127.0.0.1:3000", Origin: "http://127.0.0.1:3000" }, body: JSON.stringify(action) }));
    const list = await route.GET(); assert.equal(list.status, 200); assert.equal((await list.json()).organizations.length, 101); assert.equal(pagesRead, 1); assert.match(list.headers.get("cache-control")!, /no-store/);
    assert.equal((await post({ type: "create", name: "No request ID" })).status, 400);
    const created = await post({ type: "create", requestId: f.requestId, name: "Test Institute" }); assert.equal(created.status, 200);
    const status = (await created.json()).provisioning; assert.equal(status.state, "ready"); assert.equal(refreshCalls, 0);
    const failed = await post({ type: "open", id: status.id }); assert.equal(failed.status, 503);
    const failedBody = await failed.json(); assert.equal(failedBody.provisioning.state, "ready"); assert.equal(failedBody.code, "PROVISIONING_SESSION_INCOMPLETE"); assert.doesNotMatch(JSON.stringify(failedBody), /sensitive|accessToken|never-return/);
    assert.equal((await post({ type: "create", requestId: f.requestId, name: "Test Institute" })).status, 200); assert.equal(f.state.orgWrites, 1); assert.equal(f.state.memberWrites, 1);
    refreshFails = false;
    const opened = await post({ type: "open", id: status.id }); assert.equal(opened.status, 200); assert.deepEqual(await opened.json(), { id: f.state.org!.id });
    f.state.members[0].status = "inactive"; assert.equal((await post({ type: "open", id: status.id })).status, 403); assert.equal(refreshCalls, 2);
    f.state.members[0].status = "active"; assert.equal((await post({ type: "acknowledge", id: status.id })).status, 200);
  });
});
