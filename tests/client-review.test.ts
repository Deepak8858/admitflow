import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { readJsonBody, readJsonResponse } from "../src/lib/client-response";
import { indexInboxMessages } from "../src/lib/inbox-index";
import type { Message } from "../src/lib/domain";
import { verificationEnvironment } from "../scripts/verify.mjs";

const fallback = "The operation could not be completed.";
test("non-JSON gateway failures retain the HTTP status and stable client fallback", async () => {
  for (const status of [401, 502, 504]) for (const text of ["", "<html>Gateway failure</html>", "null", "[]", "42"]) {
    const response = new Response(text, { status });
    assert.deepEqual(await readJsonBody(response.clone(), fallback), {});
    assert.equal(response.status, status);
    await assert.rejects(readJsonResponse(response, fallback), { message: fallback });
  }
});
test("JSON errors are used only when strings; malformed success bodies fail instead of mutating state", async () => {
  await assert.rejects(readJsonResponse(Response.json({ error: "Access denied" }, { status: 403 }), fallback), { message: "Access denied" });
  for (const error of [null, {}, 10, "", "  "]) await assert.rejects(readJsonResponse(Response.json({ error }, { status: 500 }), fallback), { message: fallback });
  for (const text of ["", "<html>OK</html>", "null", "[]"]) await assert.rejects(readJsonResponse(new Response(text), fallback), { message: fallback });
  assert.deepEqual(await readJsonResponse(Response.json({ id: "confirmed" }), fallback), { id: "confirmed" });
  assert.deepEqual(await readJsonBody(Response.json({ code: "PROVISIONING_PENDING" }, { status: 409 }), fallback), { code: "PROVISIONING_PENDING" });
});

test("inbox indexes preserve draft-only/internal threads and deterministic latest external messages", () => {
  const message = (id: string, leadId: string, direction: Message["direction"], status: Message["status"] = "sent", createdAt = "2026-09-20T00:00:00.000Z"): Message => ({ id, leadId, direction, status, createdAt, body: id, author: "Fixture" });
  const messages = [message("z", "one", "outbound"), message("a", "one", "inbound"), message("internal", "one", "internal", "sent", "2026-09-21T00:00:00.000Z"), message("draft", "draft-only", "outbound", "draft"), message("note", "note-only", "internal")];
  const original = messages.map(item => item.id);
  const index = indexInboxMessages(messages);
  assert.deepEqual(messages.map(item => item.id), original);
  assert.deepEqual(index.byLead.get("one")?.map(item => item.id), ["a", "z", "internal"]);
  assert.equal(index.latest.get("one")?.id, "z");
  assert.equal(index.leadIds.has("draft-only"), true);
  assert.equal(index.byLead.has("draft-only"), false);
  assert.equal(index.leadIds.has("note-only"), true);
  assert.equal(index.latest.has("note-only"), false);
  assert.equal(indexInboxMessages([message("new", "one", "inbound", "sent", "2026-09-22T00:00:00.000Z")]).latest.get("one")?.id, "new");
});

test("browser commands use the sanitizer and direct unsanitized config loading fails closed", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts["test:e2e"], "node scripts/verify.mjs --browser");
  const env = verificationEnvironment({ ...process.env, DATABASE_URL: "postgres://synthetic.invalid/test", OPENAI_API_KEY: "synthetic-test-only" }, readFileSync(new URL("../.env.example", import.meta.url), "utf8"), "fixture-directory");
  assert.equal(env.DATABASE_URL, ""); assert.equal(env.OPENAI_API_KEY, "");
  assert.equal(env.ADMITFLOW_BROWSER_ISOLATED, "1");
  const load = (overrides: Record<string, string | undefined>) => spawnSync(process.execPath, ["--import", "tsx", "-e", "import('./playwright.config.ts')"], { env: { ...env, ...overrides, NODE_ENV: "test" }, encoding: "utf8", timeout: 30000 });
  assert.equal(load({}).status, 0);
  for (const overrides of [{ ADMITFLOW_BROWSER_ISOLATED: "" }, { DATABASE_URL: "postgres://synthetic.invalid/test" }, { ADMITFLOW_BROWSER_DB: "" }]) {
    const result = load(overrides);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Run browser tests through/);
    assert.doesNotMatch(result.stderr, /synthetic\.invalid/);
  }
});
