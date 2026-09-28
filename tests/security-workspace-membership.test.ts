import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { transform } from "esbuild";
import { NextRequest } from "next/server";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import * as errors from "../src/lib/errors";
import { organizationRoutes } from "../src/lib/db/schema";

type Membership = {
  id: string;
  userId: string;
  organizationId: string;
  status: string;
  role: { slug: string };
};

/** Load the real resolver while replacing its external identity and database edges. */
async function isolatedAuth(mocks: Record<string, unknown>) {
  const filename = path.resolve("src/lib/auth.ts");
  const { code } = await transform(await readFile(filename, "utf8"), {
    loader: "ts", format: "cjs", target: "node24", supported: { "dynamic-import": false },
  });
  const module = { exports: {} }, original = createRequire(filename);
  new vm.Script(`(function(require,module,exports){${code}\n})`, { filename }).runInThisContext()(
    (name: string) => Object.hasOwn(mocks, name) ? mocks[name] : original(name),
    module,
    module.exports,
  );
  return module.exports as typeof import("../src/lib/auth");
}

test("production workspace resolution requires a matching active membership and ignores tenant claims", async () => {
  const routes = new Map([
    ["org_alpha", "workspace_alpha"],
    ["org_bravo", "workspace_bravo"],
  ]);
  const users = {
    alpha: { id: "user_alpha", email: "alpha@example.test", firstName: "Alpha", lastName: "User" },
    bravo: { id: "user_bravo", email: "bravo@example.test", firstName: "Bravo", lastName: "User" },
  };
  const alphaMembership: Membership = {
    id: "membership_alpha", userId: users.alpha.id, organizationId: "org_alpha",
    status: "active", role: { slug: "analyst" },
  };
  const bravoMembership: Membership = {
    id: "membership_bravo", userId: users.bravo.id, organizationId: "org_bravo",
    status: "active", role: { slug: "owner" },
  };
  let session: Record<string, unknown> = {};
  let returnedMemberships: Membership[] = [];
  const lookups: string[] = [], membershipReads: string[] = [], fences: string[] = [];
  const projections: string[] = [], rateCharges: string[] = [];
  const dialect = new PgDialect();
  const auth = await isolatedAuth({
    "@workos-inc/authkit-nextjs": { withAuth: async () => session },
    "@workos-inc/node": { WorkOS: class {
      userManagement = {
        listOrganizationMemberships: async (input: { userId: string; organizationId: string; statuses: string[] }) => {
          membershipReads.push(`${input.userId}:${input.organizationId}`);
          assert.deepEqual(input.statuses, ["active"]);
          return { data: returnedMemberships };
        },
      };
      organizations = { getOrganization: async () => { throw new Error("Unexpected organization lookup"); } };
    } },
    "./config": { productionDatabase: () => true, workosConfigured: () => true },
    "./errors": errors,
    "./store": {},
    "./seed": { createWorkspace: () => { throw new Error("Unexpected workspace creation"); } },
    "./db/client": { database: () => ({
      select: () => ({
        from: (table: unknown) => {
          assert.equal(table, organizationRoutes);
          return {
            where: async (condition: SQL) => {
              const query = dialect.sqlToQuery(condition);
              assert.match(query.sql, /"workos_id"\s*=\s*\$1/);
              assert.equal(query.params.length, 1);
              const organizationId = query.params[0] as string;
              lookups.push(organizationId);
              const workspaceId = routes.get(organizationId);
              return workspaceId ? [{ organizationId: workspaceId }] : [];
            },
          };
        },
      }),
    }) },
    "./db/schema": { organizationRoutes },
    "./db/repository": { createPostgresWorkspace: async () => { throw new Error("Unexpected provisioning"); } },
    "./db/team-access": {
      readAccessFence: async (workspaceId: string, organizationId: string) => {
        fences.push(`${workspaceId}:${organizationId}`);
        assert.equal(routes.get(organizationId), workspaceId);
        return { workspaceId, organizationId };
      },
      projectAccessIdentity: async (fence: { workspaceId: string; organizationId: string }, actor: { id: string }, membershipId: string) => {
        projections.push(`${fence.workspaceId}:${fence.organizationId}:${actor.id}:${membershipId}`);
      },
    },
    "./mutation-rate-limit": {
      enforceMutationRateLimit: async (_request: NextRequest, input: { tenantId: string; actorId: string }) => {
        rateCharges.push(`${input.tenantId}:${input.actorId}`);
      },
    },
  });
  const request = () => new NextRequest(
    "https://app.example.test/api/workspace?workspaceId=workspace_bravo&organizationId=org_bravo&tenantId=workspace_bravo&role=owner",
    { headers: { cookie: "admitflow_session=workspace_bravo; organizationId=org_bravo" } },
  );
  const denied = async (expected: number) => {
    const prior = { projections: projections.length, rateCharges: rateCharges.length };
    await assert.rejects(
      auth.resolveWorkspace(request()),
      (error: unknown) => error instanceof errors.AppError && error.status === expected,
    );
    assert.equal(projections.length, prior.projections, "denied identity must not project into a workspace");
    assert.equal(rateCharges.length, prior.rateCharges, "denied identity must not reach tenant rate limiting");
  };

  session = {
    user: users.alpha, organizationId: "org_alpha",
    workspaceId: "workspace_bravo", tenantId: "workspace_bravo", role: "owner",
  };
  returnedMemberships = [alphaMembership];
  const own = await auth.resolveWorkspace(request());
  assert.equal(own.workspaceId, "workspace_alpha");
  assert.equal(own.workosOrganizationId, "org_alpha");
  assert.deepEqual(
    { id: own.actor.id, memberId: own.actor.memberId, role: own.actor.role },
    { id: users.alpha.id, memberId: alphaMembership.id, role: "analyst" },
  );
  assert.deepEqual(lookups, ["org_alpha"]);
  assert.deepEqual(membershipReads, ["user_alpha:org_alpha"]);
  assert.deepEqual(fences, ["workspace_alpha:org_alpha"]);
  assert.deepEqual(projections, ["workspace_alpha:org_alpha:user_alpha:membership_alpha"]);
  assert.deepEqual(rateCharges, ["org_alpha:user_alpha"]);

  session = { user: users.alpha, organizationId: "org_bravo", workspaceId: "workspace_bravo", role: "owner" };
  returnedMemberships = [];
  await denied(403);
  returnedMemberships = [alphaMembership];
  await denied(403);
  returnedMemberships = [{ ...bravoMembership, id: "membership_other_user" }];
  await denied(403);
  returnedMemberships = [{ ...bravoMembership, userId: users.alpha.id, status: "inactive" }];
  await denied(403);
  assert.deepEqual(lookups.slice(1), Array(4).fill("org_bravo"));
  assert.deepEqual(membershipReads.slice(1), Array(4).fill("user_alpha:org_bravo"));

  session = { user: users.alpha, workspaceId: "workspace_bravo", tenantId: "workspace_bravo", role: "owner" };
  await denied(409);
  session = { user: null, organizationId: "org_bravo", workspaceId: "workspace_bravo", role: "owner" };
  await denied(401);

  session = { user: users.bravo, organizationId: "org_bravo" };
  returnedMemberships = [bravoMembership];
  const other = await auth.resolveWorkspace(request());
  assert.equal(other.workspaceId, "workspace_bravo", "a real member can select their own mapped workspace");
  assert.equal(other.actor.id, users.bravo.id);
  assert.deepEqual(projections.slice(1), ["workspace_bravo:org_bravo:user_bravo:membership_bravo"]);
});
