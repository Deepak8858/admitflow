import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import { transform } from "esbuild";
import { NextRequest } from "next/server";
import { AppError } from "../src/lib/errors";
import { apiError, readAction } from "../src/lib/api";
import { assertPermission } from "../src/lib/permissions";
import type { SessionContext } from "../src/lib/auth";

test("intake uses only the authenticated tenant and rejects unauthenticated or lower-role requests", async t => {
  const previousBaseUrl = process.env.APP_BASE_URL;
  delete process.env.APP_BASE_URL;
  t.after(() => { if (previousBaseUrl === undefined) delete process.env.APP_BASE_URL; else process.env.APP_BASE_URL = previousBaseUrl; });
  const filename = path.resolve("src/app/api/intake/route.ts");
  const original = createRequire(filename);
  const { code } = await transform(await readFile(filename, "utf8"), { loader: "ts", format: "cjs", target: "node22" });
  let session: SessionContext | undefined;
  const calls: string[] = [];
  const summaries = async (id: string) => { calls.push(`summary:${id}`); return { count: 0 }; };
  const module = { exports: {} };
  const overrides: Record<string, unknown> = {
    "@/lib/auth": { resolveWorkspace: async () => {
      if (!session) throw new AppError("Sign in to continue.", 401);
      return session;
    } },
    "@/lib/api": { apiError, readAction },
    "@/lib/permissions": { assertPermission },
    "@/lib/config": { productionDatabase: () => true },
    "@/lib/db/intake": {
      intakeSummary: summaries,
      importIntake: async (id: string) => { calls.push(`import:${id}`); return { result: { imported: 0 } }; },
    },
    "@/lib/store": { loadWorkspace: async (id: string) => { calls.push(`load:${id}`); return { id }; } },
    "@/lib/integrations": { publicWorkspace: (workspace: { id: string }) => ({ id: workspace.id }) },
  };
  new vm.Script(`(function(require,module,exports){${code}\n})`, { filename }).runInThisContext()(
    (name: string) => Object.hasOwn(overrides, name) ? overrides[name] : original(name), module, module.exports,
  );
  const route = module.exports as typeof import("../src/app/api/intake/route");
  const get = (query = "") => route.GET(new NextRequest(`http://127.0.0.1:3000/api/intake${query}`));
  const post = (body: object) => route.POST(new NextRequest("http://127.0.0.1:3000/api/intake", {
    method: "POST",
    headers: { Host: "127.0.0.1:3000", Origin: "http://127.0.0.1:3000", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));

  assert.equal((await get()).status, 401);
  assert.equal((await post({ type: "import" })).status, 401);
  assert.deepEqual(calls, []);

  session = { workspaceId: "tenant-a", actor: { id: "counsellor-a", name: "Counsellor", email: "c@example.test", role: "counsellor", backend: "workos" } };
  assert.equal((await get()).status, 403);
  assert.equal((await post({ type: "import" })).status, 403);
  assert.deepEqual(calls, []);

  session = { ...session, actor: { ...session.actor, id: "admin-a", role: "admin" } };
  const summary = await get("?workspaceId=tenant-b");
  assert.equal(summary.status, 200);
  assert.equal(summary.headers.get("cache-control"), "no-store");
  assert.deepEqual(calls, ["summary:tenant-a"]);
  assert.equal((await post({ type: "import", workspaceId: "tenant-b" })).status, 400);
  assert.deepEqual(calls, ["summary:tenant-a"]);

  const imported = await post({ type: "import", after: "a".repeat(64) });
  assert.equal(imported.status, 200);
  assert.equal(imported.headers.get("cache-control"), "no-store");
  assert.deepEqual(calls, ["summary:tenant-a", "import:tenant-a", "summary:tenant-a", "load:tenant-a"]);
  assert.equal((await imported.json()).workspace.id, "tenant-a");
});
