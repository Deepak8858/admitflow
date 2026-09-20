import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { transform } from "esbuild";
import { NextRequest } from "next/server";
import config from "../next.config";
import { createWorkspace } from "../src/lib/seed";
import { MAX_LEAD_PAGE, MAX_LEAD_PAGE_SIZE, leadPageCount, hasMoreLeadPages } from "../src/lib/lead-pagination";

async function moduleWith<T>(file: string, overrides: Record<string, unknown>): Promise<T> {
  const filename = path.resolve(file), original = createRequire(filename);
  const { code } = await transform(await readFile(filename, "utf8"), { loader: "ts", format: "cjs", target: "node24" });
  const module = { exports: {} };
  new vm.Script(`(function(require,module,exports){${code}\n})`, { filename }).runInThisContext()(
    (name: string) => Object.hasOwn(overrides, name) ? overrides[name] : original(name), module, module.exports,
  );
  return module.exports as T;
}

test("HSTS is host-only and production-only without losing existing security headers", async () => {
  const previous = process.env.NODE_ENV;
  try {
    for (const environment of ["production", "development", "test"]) {
      Object.assign(process.env, { NODE_ENV: environment });
      const result = await config.headers!();
      const headers = Object.fromEntries(result[0].headers.map(item => [item.key, item.value]));
      assert.equal(headers["Strict-Transport-Security"], environment === "production" ? "max-age=86400" : undefined);
      assert.equal(headers["X-Content-Type-Options"], "nosniff");
      assert.equal(headers["X-Frame-Options"], "DENY");
      assert.equal(headers["Referrer-Policy"], "strict-origin-when-cross-origin");
    }
  } finally { if (previous === undefined) Reflect.deleteProperty(process.env, "NODE_ENV"); else Object.assign(process.env, { NODE_ENV: previous }); }
});

test("lead pagination retains true totals while bounding API and UI traversal", async () => {
  const workspace = createWorkspace();
  const route = await moduleWith<typeof import("../src/app/api/leads/route")>("src/app/api/leads/route.ts", {
    "@/lib/auth": { resolveWorkspace: async () => ({ workspaceId: workspace.id, actor: {} }) },
    "@/lib/config": { productionDatabase: () => false },
    "@/lib/store": { loadWorkspace: async () => workspace },
    "@/lib/permissions": { scopeWorkspace: () => workspace },
    "@/lib/db/repository": { queryPostgresLeads: () => assert.fail("local route must not query PostgreSQL") },
  });
  const get = (query = "") => route.GET(new NextRequest(`http://localhost/api/leads?${query}`));
  const defaults = await (await get()).json();
  assert.equal(defaults.page, 1); assert.equal(defaults.pageSize, 50); assert.equal(defaults.total, workspace.leads.length);
  assert.equal((await get(`page=${MAX_LEAD_PAGE}&pageSize=${MAX_LEAD_PAGE_SIZE}`)).status, 200);
  for (const query of ["page=1001", "page=0", "page=-1", "page=1.5", "page=no", "pageSize=101", "pageSize=0"]) assert.equal((await get(query)).status, 400, query);
  assert.equal(leadPageCount(100001, 100), 1000);
  assert.equal(leadPageCount(0, 25), 1);
  assert.equal(hasMoreLeadPages(100001, 999, 100), true);
  assert.equal(hasMoreLeadPages(100001, 1000, 100), false);
});
