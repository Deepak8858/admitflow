import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { transform } from "esbuild";
import { NextRequest } from "next/server";
import { readAction, apiError } from "../src/lib/api";
import { sameOrigin, cookieOptions } from "../src/lib/http";
import { createWorkspace } from "../src/lib/seed";
import { isoNow, uid, type WorkspaceFile } from "../src/lib/domain";
import { assertFileAccess, scopeWorkspace } from "../src/lib/permissions";
import { AppError } from "../src/lib/errors";

async function isolatedAuthRoute(store: Record<string, unknown>) {
  const filename = path.resolve("src/app/api/auth/route.ts");
  const { code } = await transform(await readFile(filename, "utf8"), { loader: "ts", format: "cjs", target: "node24" });
  const module = { exports: {} };
  const original = createRequire(filename);
  new vm.Script(`(function(require,module,exports){${code}\n})`, { filename }).runInThisContext()(
    (name: string) => ({
      "@/lib/store": store,
      "@/lib/integrations": { publicWorkspace: () => ({ id: "workspace" }) },
      "@/lib/http": { sameOrigin, cookieOptions },
      "@/lib/api": { readAction, apiError },
      "@/lib/config": { productionDatabase: () => false },
      "@/lib/errors": { AppError },
    })[name as "@/lib/store"] ?? original(name), module, module.exports,
  );
  return module.exports as typeof import("../src/app/api/auth/route");
}

test("JSON mutation parser rejects missing Origin and missing JSON content type", async () => {
  const url = "http://127.0.0.1:3000/api/workspace";
  const body = JSON.stringify({ type: "view.save", name: "x" });
  const request = (headers: Record<string, string>, payload: BodyInit = body) => new NextRequest(url, { method: "POST", headers: { host: "127.0.0.1:3000", ...headers }, body: payload });
  const noOrigin = request({ "content-type": "application/json" });
  await assert.rejects(() => readAction(noOrigin), (error: unknown) => (error as AppError).status === 403);
  assert.equal(noOrigin.bodyUsed, false, "untrusted bodies must be rejected before reading");
  const foreignOrigin = request({ origin: "http://attacker.invalid", "content-type": "application/json" });
  await assert.rejects(() => readAction(foreignOrigin), (error: unknown) => (error as AppError).status === 403);
  assert.equal(foreignOrigin.bodyUsed, false, "cross-origin bodies must be rejected before reading");
  const noType = request({ origin: "http://127.0.0.1:3000" }, new Blob([body]));
  await assert.rejects(() => readAction(noType), (error: unknown) => (error as AppError).status === 415);
  assert.deepEqual(await readAction(request({ origin: "http://127.0.0.1:3000", "content-type": "application/json; charset=UTF-8" })), { type: "view.save", name: "x" });
});

test("local auth does not create or rotate sessions for unverified mutation requests", async () => {
  let changed = 0;
  const store = {
    register: () => { changed++; throw new Error("unexpected registration"); },
    login: () => { changed++; throw new Error("unexpected login"); },
    endSession: () => { changed++; },
    createDemo: () => { changed++; throw new Error("unexpected demo"); },
    checkAuthRate: () => { changed++; },
  };
  const route = await isolatedAuthRoute(store);
  const url = "http://127.0.0.1:3000/api/auth";
  const login = JSON.stringify({ type: "login", email: "staff@example.com", password: "password-long" });
  for (const [headers, body, status] of [
    [{ "content-type": "application/json" }, login, 403],
    [{ origin: "http://127.0.0.1:3000" }, new Blob([login]), 415],
    [{ origin: "http://attacker.invalid", "content-type": "application/json" }, login, 403],
  ] as const) {
    const response = await route.POST(new NextRequest(url, { method: "POST", headers: { host: "127.0.0.1:3000", ...headers }, body }));
    assert.equal(response.status, status);
    assert.equal(response.headers.get("set-cookie"), null);
  }
  assert.equal(changed, 0);
});

test("analyst cannot project or download applicant files by ID", () => {
  const workspace = createWorkspace(false);
  workspace.workosOrganizationId = "org_security";
  const analyst = { id: "user_analyst", memberId: "om_analyst", name: "Analyst", email: "analyst@example.com", role: "analyst" as const, backend: "workos" as const };
  workspace.members = [{ id: analyst.memberId, workosId: analyst.id, name: analyst.name, email: analyst.email, role: analyst.role, status: "active" }];
  const leadId = uid();
  workspace.leads.push({ id: leadId, name: "Applicant", phone: "+919999999999", email: "applicant@example.com", course: "Course", source: "Manual", stage: "New", owner: "Unassigned", ownerId: null, value: 0, notes: "", nextAction: "", createdAt: isoNow(), lastContactAt: null, lastInboundAt: null, consent: "unknown", consentSource: "", consentAt: null, isMinor: false, guardianConsent: false, humanOwned: false });
  const file = (purpose: WorkspaceFile["purpose"], attached = false): WorkspaceFile => {
    const id = uid();
    return { id, name: `${purpose}.pdf`, mime: "application/pdf", size: 100, purpose, leadId: attached ? leadId : undefined, status: "ready", createdAt: isoNow(), objectKey: `${workspace.id}/files/${id}/private.pdf` };
  };
  const attachment = file("attachment", true), receipt = file("receipt", true), imported = file("import"), knowledge = file("knowledge");
  workspace.files = [attachment, receipt, imported, knowledge];
  workspace.messages.push({ id: uid(), leadId, body: "Document received", direction: "internal", author: "Owner", status: "received", createdAt: isoNow(), fileId: attachment.id });
  workspace.articles.push({ id: uid(), title: "Private document", category: "Import", body: "private", updatedAt: isoNow(), fileId: imported.id });
  const projection = scopeWorkspace(workspace, analyst);
  assert.deepEqual(projection.files?.map(item => item.id), [knowledge.id]);
  assert.equal(projection.messages[0].fileId, undefined);
  assert.equal(projection.articles.length, 0);
  for (const privateFile of [attachment, receipt, imported]) {
    assert.throws(() => assertFileAccess(workspace, analyst, privateFile), (error: unknown) => (error as AppError).status === 403);
  }
  assert.doesNotThrow(() => assertFileAccess(workspace, analyst, knowledge));
  assert.equal(workspace.files.length, 4, "response scoping must not mutate the stored workspace");
});
