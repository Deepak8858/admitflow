import test from "node:test";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { transform } from "esbuild";
import { NextRequest } from "next/server";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { and, eq, sql } from "drizzle-orm";
import { useTestDatabase, type Database } from "../src/lib/db/client";
import { createPostgresWorkspace, loadPostgresWorkspace, mutatePostgresWorkspace, tenantTransaction } from "../src/lib/db/repository";
import * as billing from "../src/lib/providers/billing";
import { ACCESS_LEASE_MS, claimAccess, confirmAccess, dispatchAccess, mutateAccessWorkspace, projectAccessIdentity, readAccessFence, releaseAccess } from "../src/lib/db/team-access";
import * as schema from "../src/lib/db/schema";
import { createWorkspace } from "../src/lib/seed";
import { AppError } from "../src/lib/errors";
import { projectMembers, type MemberSnapshot } from "../src/app/api/team/members";
import type { Actor } from "../src/lib/auth";
import { WorkOS } from "@workos-inc/node";

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
/** Compile unchanged source; substitute only WorkOS/AuthKit, not authorization or persistence. */
async function isolatedModule<T>(file: string, overrides: Record<string, unknown>): Promise<T> {
  const filename = path.resolve(file), original = createRequire(filename);
  const { code } = await transform(await readFile(filename, "utf8"), { loader: "ts", format: "cjs", target: "node24", supported: { "dynamic-import": false } });
  const module = { exports: {} };
  new vm.Script(`(function(require,module,exports){${code}\n})`, { filename }).runInThisContext()((name: string) => Object.hasOwn(overrides, name) ? overrides[name] : original(name), module, module.exports);
  return module.exports as T;
}

test("application WorkOS transport never retries uncertain access writes", async t => {
  const env = { WORKOS_API_KEY: "test-only", WORKOS_CLIENT_ID: "test-only", WORKOS_COOKIE_PASSWORD: "test-only" };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  let calls = 0;
  let failure: number | "network" | "abort" = 503;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    if (failure === "network") throw new TypeError("Mock connection lost");
    if (failure === "abort") throw Object.assign(new Error("Mock timeout"), { name: "AbortError" });
    return Response.json({ message: "Mock uncertain response" }, { status: failure });
  });
  const auth = await isolatedModule<typeof import("../src/lib/auth")>("src/lib/auth.ts", {
    "@workos-inc/node": { WorkOS: class extends WorkOS {
      constructor(key: string, options: ConstructorParameters<typeof WorkOS>[1]) {
        assert.equal(options?.maxRetries, 0);
        assert.equal(options?.timeout, 15_000);
        super(key, options);
      }
    } },
  });
  const management = auth.workos().userManagement;
  const operations = [
    () => management.updateOrganizationMembership("om_test", { roleSlug: "admin" }),
    () => management.deactivateOrganizationMembership("om_test"),
    () => management.reactivateOrganizationMembership("om_test"),
    () => management.revokeInvitation("inv_test"),
    () => management.sendInvitation({ organizationId: "org_test", email: "test@example.com", roleSlug: "counsellor" }),
  ];
  for (const outcome of [408, 429, 500, 502, 503, 504, "network", "abort"] as const) {
    failure = outcome;
    for (const operation of operations) {
      const before = calls;
      await assert.rejects(operation);
      assert.equal(calls - before, 1, `No retry after ${outcome}`);
    }
  }
});

test("hosted access operations serialize provider writes and fence actual auth/team projections", { timeout: 120_000 }, async t => {
  const env = { DATABASE_URL: "postgresql://test.invalid/team-access", ADMITFLOW_DB: ":memory:", APP_BASE_URL: "", WORKOS_API_KEY: "test-only", WORKOS_CLIENT_ID: "test-only", WORKOS_COOKIE_PASSWORD: "test-only-not-a-real-cookie-password", BILLING_PLANS_JSON: "" };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Network is forbidden in access tests."); });
  const pg = new PGlite();
  t.after(() => pg.close());
  for (const file of (await readdir("drizzle")).filter(file => file.endsWith(".sql")).sort()) await pg.exec(await readFile(path.join("drizzle", file), "utf8"));
  const db = drizzle(pg, { schema }); useTestDatabase(db as unknown as Database);
  const sessions = new AsyncLocalStorage<{ userId: string; organizationId: string }>();
  const states = new Map<string, MemberSnapshot>();
  let writes = 0;
  let onWrite: (() => Promise<void>) | undefined;
  let afterWrite: (() => Promise<void>) | undefined;
  let onAuthRead: (() => Promise<void>) | undefined;
  let onUserRead: (() => Promise<void>) | undefined;
  let hideInvitations = false;
  const membership = (id: string) => [...states.values()].flatMap(state => state.memberships).find(item => item.id === id)!;
  const write = async (apply: () => void) => { writes++; await onWrite?.(); apply(); await afterWrite?.(); };
  const management = {
    async listOrganizationMemberships(input: { organizationId: string; userId?: string; statuses: string[] }) {
      const data = structuredClone(states.get(input.organizationId)!.memberships.filter(item => (!input.userId || input.userId === item.userId) && input.statuses.includes(item.status)));
      if (input.userId) await onAuthRead?.();
      return { data, autoPagination: async () => data };
    },
    async listInvitations(input: { organizationId: string; email?: string }) {
      if (hideInvitations) throw new AppError("Mock invitation read outage", 503);
      const data = structuredClone(states.get(input.organizationId)!.invitations.filter(item => !input.email || item.email === input.email));
      return { data, autoPagination: async () => data };
    },
    async getUser(id: string) { const user = structuredClone([...states.values()].flatMap(state => state.users).find(item => item.id === id)!); await onUserRead?.(); return user; },
    async updateOrganizationMembership(id: string, input: { roleSlug: string }) { await write(() => { membership(id).role.slug = input.roleSlug; }); return structuredClone(membership(id)); },
    async deactivateOrganizationMembership(id: string) { await write(() => { membership(id).status = "inactive"; }); return structuredClone(membership(id)); },
    async reactivateOrganizationMembership(id: string) { await write(() => { membership(id).status = "active"; }); return structuredClone(membership(id)); },
    async sendInvitation(input: { organizationId: string; email: string; roleSlug: string }) {
      const invitation = { id: `inv_${writes + 1}`, email: input.email, organizationId: input.organizationId, state: "pending" as const, roleSlug: input.roleSlug, acceptedUserId: null, expiresAt: new Date(Date.now() + 86400_000).toISOString() };
      await write(() => { states.get(input.organizationId)!.invitations.push(invitation); });
      return invitation;
    },
    async revokeInvitation(id: string) { await write(() => { [...states.values()].flatMap(state => state.invitations).find(item => item.id === id)!.state = "revoked"; }); },
  };
  const auth = await isolatedModule<typeof import("../src/lib/auth")>("src/lib/auth.ts", {
    "@workos-inc/node": { WorkOS: class { userManagement = management; } },
    "@workos-inc/authkit-nextjs": { withAuth: async () => { const session = sessions.getStore()!; return { organizationId: session.organizationId, user: states.get(session.organizationId)!.users.find(user => user.id === session.userId) }; } },
  });
  const route = await isolatedModule<typeof import("../src/app/api/team/route")>("src/app/api/team/route.ts", { "@/lib/auth": auth });
  let sequence = 0;
  async function fixture() {
    onWrite = afterWrite = onAuthRead = onUserRead = undefined; hideInvitations = false;
    const workspace = createWorkspace(false), organizationId = `org_access_${++sequence}`;
    const state: MemberSnapshot = {
      memberships: ["a", "b"].map(id => ({ id: `om_${sequence}_${id}`, userId: `user_${sequence}_${id}`, organizationId, status: "active", role: { slug: "owner" } })),
      users: ["a", "b"].map(id => ({ id: `user_${sequence}_${id}`, email: `${sequence}-${id}@example.com`, firstName: "Owner", lastName: id.toUpperCase() })), invitations: [],
    };
    workspace.members = projectMembers([], state, organizationId); workspace.team = workspace.members.map(member => member.name);
    states.set(organizationId, state); await createPostgresWorkspace(workspace, organizationId);
    const request = (actor: number, action?: Record<string, unknown>, handler = route) => sessions.run({ organizationId, userId: state.users[actor].id }, () => {
      const req = new NextRequest("http://127.0.0.1:3000/api/team", { method: action ? "POST" : "GET", headers: { "Content-Type": "application/json", Host: "127.0.0.1:3000", Origin: "http://127.0.0.1:3000" }, ...(action ? { body: JSON.stringify(action) } : {}) });
      return action ? handler.POST(req) : handler.GET(req);
    });
    const session = (actor: number) => sessions.run({ organizationId, userId: state.users[actor].id }, () => auth.resolveWorkspace(new NextRequest("http://127.0.0.1:3000/api/team")));
    const age = async () => {
      await tenantTransaction(workspace.id, async tx => {
        const [receipt] = await tx.select().from(schema.eventReceipts).where(eq(schema.eventReceipts.id, `team:access:${workspace.id}`));
        await tx.update(schema.eventReceipts).set({ payload: { ...receipt.payload, startedAt: Date.now() - ACCESS_LEASE_MS - 1000 } }).where(eq(schema.eventReceipts.id, receipt.id));
      });
    };
    return { workspace, organizationId, state, request, session, age };
  }
  for (const scenario of ["demotions", "cross-deactivations", "mixed"] as const) await t.test(`actual POST ${scenario}: competitor is rejected before dispatch and retry retains an owner`, async () => {
    const f = await fixture(), entered = barrier(), resume = barrier(), before = writes;
    onWrite = async () => { entered.release(); await resume.promise; };
    const [a, b] = f.state.memberships;
    const firstAction = scenario === "cross-deactivations" ? { type: "deactivate", id: b.id } : { type: "role", id: scenario === "mixed" ? b.id : a.id, role: "admin" };
    const secondAction = scenario === "demotions" ? { type: "role", id: b.id, role: "admin" } : { type: "deactivate", id: a.id };
    const first = f.request(0, firstAction);
    try {
      await entered.promise;
      assert.equal((await f.request(1, secondAction)).status, 409);
      assert.equal(writes - before, 1);
      await assert.rejects(f.session(scenario === "demotions" ? 0 : 1), /awaiting WorkOS confirmation/);
    } finally { resume.release(); }
    assert.equal((await first).status, 200);
    onWrite = undefined;
    assert.ok([403, 409].includes((await f.request(1, secondAction)).status));
    assert.equal(writes - before, 1);
    assert.equal(f.state.memberships.filter(item => item.status === "active" && item.role.slug === "owner").length, 1);
    assert.equal((await loadPostgresWorkspace(f.workspace.id)).members!.filter(item => item.status === "active" && item.role === "owner").length, 1);
  });

  for (const type of ["invite", "reactivate"] as const) for (const beforeDispatch of [true, false]) await t.test(`${type}: cancellation ${beforeDispatch ? "before final guard prevents write" : "after dispatch preserves confirmation"}`, async () => {
    const f = await fixture(), before = writes;
    if (type === "reactivate") f.state.memberships[1].status = "inactive";
    const restrict = () => mutatePostgresWorkspace(f.workspace.id, current => { current.subscription = { status: "cancelled", plan: "Ended" }; });
    let reservations = 0;
    const guardedRoute = await isolatedModule<typeof import("../src/app/api/team/route")>("src/app/api/team/route.ts", {
      "@/lib/auth": auth,
      "@/lib/providers/billing": { ...billing, reserveBillingSeat: async (...args: Parameters<typeof billing.reserveBillingSeat>) => {
        const seat = await billing.reserveBillingSeat(...args); reservations++;
        if (beforeDispatch) await restrict();
        return seat;
      } },
    });
    if (!beforeDispatch) afterWrite = async () => { await restrict(); };
    const action = type === "invite" ? { type, name: "New teammate", email: "new@example.com", role: "counsellor" } : { type, id: f.state.memberships[1].id };
    const response = await f.request(0, action, guardedRoute);
    assert.equal(response.status, beforeDispatch ? 402 : 200);
    if (beforeDispatch) assert.equal((await response.json()).code, "SUBSCRIPTION_RESTRICTED");
    assert.equal(reservations, 1); assert.equal(writes - before, beforeDispatch ? 0 : 1);
    assert.equal((await readAccessFence(f.workspace.id, f.organizationId)).phase, "idle");
    if (type === "reactivate") assert.equal(f.state.memberships[1].status, beforeDispatch ? "inactive" : "active");
    else assert.equal(f.state.invitations.length, beforeDispatch ? 0 : 1);
    // An already-active membership is a no-op confirmation, not a new reactivation.
    assert.equal((await f.request(0, action)).status, type === "reactivate" && !beforeDispatch ? 200 : 402);
    assert.equal(writes - before, beforeDispatch ? 0 : 1);
    assert.equal((await f.request(0)).status, 200);
    afterWrite = undefined;
    if (!beforeDispatch) {
      const removal = type === "invite" ? { type: "revoke", id: f.state.invitations[0].id } : { type: "deactivate", id: f.state.memberships[1].id };
      assert.equal((await f.request(0, removal)).status, 200);
    }
  });

  await t.test("actual auth response fetched before demotion cannot restore an owner", async () => {
    const f = await fixture(), entered = barrier(), resume = barrier();
    onAuthRead = async () => { onAuthRead = undefined; entered.release(); await resume.promise; };
    const delayed = f.session(0);
    await entered.promise;
    assert.equal((await f.request(1, { type: "role", id: f.state.memberships[0].id, role: "admin" })).status, 200);
    const rejected = assert.rejects(delayed, /access changed/); resume.release(); await rejected;
    assert.equal((await loadPostgresWorkspace(f.workspace.id)).members!.find(item => item.workosId === f.state.users[0].id)!.role, "admin");
  });

  await t.test("expired team GET cannot overwrite a subsequent deactivation", async () => {
    const f = await fixture(), entered = barrier(), resume = barrier();
    onUserRead = async () => { onUserRead = undefined; entered.release(); await resume.promise; };
    const delayed = f.request(0);
    await entered.promise; await f.age();
    assert.equal((await f.request(1, { type: "deactivate", id: f.state.memberships[0].id })).status, 200);
    resume.release(); assert.equal((await delayed).status, 409);
    assert.equal((await loadPostgresWorkspace(f.workspace.id)).members!.find(item => item.workosId === f.state.users[0].id)!.status, "inactive");
  });

  await t.test("lost provider response stays durable, recovers via GET evidence, and never repeats a write", async () => {
    const f = await fixture(), before = writes;
    afterWrite = async () => { throw new AppError("Mock lost response", 503); };
    assert.equal((await f.request(0, { type: "role", id: f.state.memberships[0].id, role: "admin" })).status, 503);
    const pending = await readAccessFence(f.workspace.id, f.organizationId);
    assert.equal(pending.phase, "dispatched");
    await releaseAccess(pending);
    await assert.rejects(claimAccess(f.workspace.id, f.organizationId), /awaiting WorkOS/);
    assert.equal((await f.request(1)).status, 409);
    await f.age(); afterWrite = undefined;
    assert.equal((await f.request(1)).status, 200);
    assert.equal((await readAccessFence(f.workspace.id, f.organizationId)).phase, "idle");
    assert.equal(writes - before, 1);
    await assert.rejects(mutateAccessWorkspace(pending, current => { current.members![0].role = "owner"; }), /access changed/);
  });

  await t.test("missing or wrong-tenant postconditions cannot release dispatched claims even after expiry", async () => {
    const f = await fixture(), before = writes;
    onWrite = async () => { throw new AppError("Mock uncertain transport failure", 503); };
    assert.equal((await f.request(0, { type: "role", id: f.state.memberships[0].id, role: "admin" })).status, 503);
    await f.age(); onWrite = undefined;
    assert.equal((await f.request(1)).status, 409);
    const pending = await readAccessFence(f.workspace.id, f.organizationId);
    const wrong = structuredClone(f.state); wrong.memberships[0].role.slug = "admin"; wrong.memberships[0].organizationId = "org_foreign";
    await assert.rejects(confirmAccess(pending, wrong), /awaiting WorkOS/);
    await assert.rejects(claimAccess(f.workspace.id, f.organizationId), /awaiting WorkOS/);
    assert.equal(writes - before, 1);
  });

  await t.test("claims are tenant scoped; expired undispatched writers and idle auth fences cannot commit", async () => {
    const f = await fixture(), other = await fixture();
    const idle = await readAccessFence(f.workspace.id, f.organizationId);
    const old = await claimAccess(f.workspace.id, f.organizationId);
    const otherClaim = await claimAccess(other.workspace.id, other.organizationId);
    await f.age();
    const next = await claimAccess(f.workspace.id, f.organizationId);
    await assert.rejects(dispatchAccess(old, { kind: "revoke", id: "inv_stale" }), /access changed/);
    await releaseAccess(old);
    assert.equal((await readAccessFence(f.workspace.id, f.organizationId)).token, next.token);
    const user = f.state.users[0];
    const actor: Actor = { id: user.id, name: "Owner A", email: user.email, role: "owner", backend: "workos" };
    await assert.rejects(projectAccessIdentity(idle, actor, f.state.memberships[0].id), /access changed/);
    await assert.rejects(readAccessFence(f.workspace.id, other.organizationId), /another institute/);
    await releaseAccess(next); await releaseAccess(otherClaim);
  });

  await t.test("restricted role cannot read or change another tenant's members", async () => {
    const a = await fixture(), b = await fixture();
    await pg.exec("CREATE ROLE team_rls_test NOLOGIN NOSUPERUSER NOBYPASSRLS; GRANT SELECT, INSERT, UPDATE ON members TO team_rls_test;");
    const restricted = <T,>(operation: Parameters<typeof tenantTransaction<T>>[1]) => tenantTransaction(b.workspace.id, async tx => { await tx.execute(sql`set local role team_rls_test`); return operation(tx); });
    const people = await restricted(tx => tx.select().from(schema.members));
    assert.equal(people.length, b.workspace.members!.length);
    assert.ok(people.every(row => row.organizationId === b.workspace.id));
    assert.equal((await restricted(tx => tx.update(schema.members).set({ role: "analyst" }).where(eq(schema.members.id, a.workspace.members![0].id)).returning())).length, 0);
    await assert.rejects(() => restricted(tx => tx.insert(schema.members).values({ id: "om_foreign_insert", organizationId: a.workspace.id, name: "Foreign", email: "foreign@example.com", role: "owner", status: "active" })));
    await assert.rejects(() => restricted(tx => tx.update(schema.members).set({ organizationId: a.workspace.id }).where(eq(schema.members.id, b.workspace.members![0].id))));
    assert.equal((await loadPostgresWorkspace(a.workspace.id)).members![0].role, "owner");
  });

  await t.test("reactivation lost-response recovery confirms its seat; deactivation then frees it", async () => {
    const f = await fixture(), target = f.state.memberships[1]; target.status = "inactive"; target.role.slug = "counsellor";
    assert.equal((await f.request(0)).status, 200);
    afterWrite = async () => { throw new AppError("Mock lost reactivation response", 503); };
    assert.equal((await f.request(0, { type: "reactivate", id: target.id })).status, 503);
    const seats = () => db.select().from(schema.eventReceipts).where(and(eq(schema.eventReceipts.organizationId, f.workspace.id), eq(schema.eventReceipts.provider, "billing_seat")));
    assert.equal((await seats())[0].payload.phase, "uncertain");
    afterWrite = undefined; await f.age();
    assert.equal((await f.request(0)).status, 200);
    assert.equal((await seats())[0].payload.phase, "confirmed");
    assert.equal((await f.request(0, { type: "deactivate", id: target.id })).status, 200);
    assert.equal((await seats())[0].payload.phase, "released");
  });

  await t.test("lost invitation acknowledgement recovers its receipt and seat without another email", async () => {
    const f = await fixture(), before = writes, action = { type: "invite", name: "Invitee", email: "lost@example.com", role: "counsellor" };
    afterWrite = async () => { hideInvitations = true; throw new AppError("Mock lost invitation acknowledgement", 503); };
    assert.equal((await f.request(0, action)).status, 503);
    assert.equal((await readAccessFence(f.workspace.id, f.organizationId)).phase, "dispatched");
    afterWrite = undefined; hideInvitations = false; await f.age();
    assert.equal((await f.request(0)).status, 200);
    const rows = await db.select().from(schema.eventReceipts).where(eq(schema.eventReceipts.organizationId, f.workspace.id));
    assert.equal(rows.find(row => row.provider === "workos_invitation")!.payload.phase, "ready");
    assert.equal(rows.find(row => row.provider === "billing_seat")!.payload.phase, "confirmed");
    assert.equal((await f.request(0, action)).status, 200);
    assert.equal(writes - before, 1);
  });

  await t.test("unchanged auth and team reads do not churn revisions; recreated memberships retain stable IDs", async () => {
    const f = await fixture();
    const revision = (await loadPostgresWorkspace(f.workspace.id)).revision;
    await Promise.all([f.session(0), f.session(1), f.session(0)]);
    assert.equal((await f.request(0)).status, 200);
    assert.equal((await loadPostgresWorkspace(f.workspace.id)).revision, revision);
    const stableId = f.state.memberships[0].id;
    f.state.memberships[0].id += "_recreated";
    f.state.users[0].firstName = "Renamed";
    const context = await f.session(0);
    assert.equal(context.actor.memberId, stableId);
    assert.equal(context.actor.name, "Renamed A");
    assert.equal((await f.request(0, { type: "role", id: stableId, role: "admin" })).status, 200);
    const current = await loadPostgresWorkspace(f.workspace.id);
    assert.equal(current.members!.find(member => member.workosId === context.actor.id)!.id, stableId);
    assert.equal(current.members!.find(member => member.id === stableId)!.role, "admin");
  });

  await t.test("invitation retries deduplicate and revoked invitation can be replaced without losing seat accounting", async () => {
    const f = await fixture(), before = writes, action = { type: "invite", name: "Invitee", email: "new@example.com", role: "counsellor" };
    assert.equal((await f.request(0, action)).status, 200);
    assert.equal((await f.request(0, action)).status, 200);
    assert.equal(writes - before, 1);
    assert.equal((await f.request(0, { type: "revoke", id: f.state.invitations[0].id })).status, 200);
    assert.equal((await f.request(0, action)).status, 200);
    assert.equal(writes - before, 3);
  });
});
