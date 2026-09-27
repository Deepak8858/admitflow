import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { createHmac } from "node:crypto";
import { S3Client, HeadObjectCommand, GetObjectCommand, CopyObjectCommand } from "@aws-sdk/client-s3";
import { KMSClient } from "@aws-sdk/client-kms";
import { createWorkspace } from "../src/lib/seed";
import { applyAction } from "../src/lib/actions";
import { uid, isoNow, DAY, LEAD_VIEWS, LEAD_SORTS, leadMatchesView, sortLeads, resolveSavedViewPreferences, type Workspace, type WorkspaceFile } from "../src/lib/domain";
import { scopeWorkspace, authorizeRecordAction, assertFileAccess, can } from "../src/lib/permissions";
import { roleFrom } from "../src/lib/auth";
import { publicWorkspace, processJobs, suggestReply, bookAppointment } from "../src/lib/integrations";
import { credentials, saveConnection, validProviderKey, verifyProviderCredentials } from "../src/lib/connections";
import { beginUpload, finishUpload, downloadUrl } from "../src/lib/files";
import { transcribe, synthesize } from "../src/lib/providers/speech";
import { templates, validSignature } from "../src/lib/providers/meta";
import { sealSecret, openSecret } from "../src/lib/secrets";
import { readAction } from "../src/lib/api";
import { sameOrigin, readLimitedText, constantTimeEqual } from "../src/lib/http";
import { createSession, saveNewWorkspace, loadWorkspace, mutateWorkspace } from "../src/lib/store";
import { enqueueWorkspaceJobs } from "../src/lib/db/outbox";
import { POST as jobsPost } from "../src/app/api/jobs/route";
import { POST as whatsappPost } from "../src/app/api/webhooks/whatsapp/route";
import { POST as workspacePost } from "../src/app/api/workspace/route";
import { GET as leadsGet } from "../src/app/api/leads/route";
import { calendarEventId } from "../src/lib/providers/calendar";

function environment(t: TestContext, values: Record<string, string | undefined>) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
async function calendarFixture(t: TestContext, demo = false) {
  environment(t, { DATABASE_URL: undefined, ADMITFLOW_DB: ":memory:", APP_BASE_URL: undefined, KMS_KEY_ID: undefined, INTEGRATION_ENCRYPTION_KEY: Buffer.alloc(32, 13).toString("base64"), GOOGLE_CLIENT_ID: "test-client", GOOGLE_CLIENT_SECRET: "test-client-secret" });
  const workspace = createWorkspace(false); workspace.demo = demo;
  applyAction(workspace, { type: "lead.create", lead: { name: "Calendar student", phone: "9876543210", course: "NEET" } });
  workspace.connections = [{ id: uid(), service: "google", status: "connected", externalId: "google-account", label: "Calendar", updatedAt: isoNow(), metadata: { calendarId: "primary" }, ...(demo ? {} : { secret: await sealSecret({ refreshToken: "test-refresh-token" }, workspace.id) }) }];
  saveNewWorkspace(workspace);
  const token = createSession(workspace.id);
  const request = (action: Record<string, unknown>) => new NextRequest("http://127.0.0.1/api/workspace", { method: "POST", headers: { cookie: `admitflow_session=${token}`, "content-type": "application/json", host: "127.0.0.1", origin: "http://127.0.0.1" }, body: JSON.stringify(action) });
  const startsAt = new Date(Date.now() + 2 * DAY).toISOString();
  const action = { type: "appointment.create", leadId: workspace.leads[0].id, ownerId: workspace.members![0].id, startsAt, duration: 30, kind: "Counselling" };
  return { workspace, request, startsAt, action };
}
function identityWorkspace() {
  const workspace = createWorkspace(false);
  workspace.workosOrganizationId = "org_security_test";
  workspace.team = ["Same Name"];
  workspace.members = [
    { id: "membership_a", workosId: "user_a", name: "Same Name", email: "a@example.com", role: "counsellor", status: "active" },
    { id: "membership_b", workosId: "user_b", name: "Same Name", email: "b@example.com", role: "counsellor", status: "active" },
  ];
  for (const [index, member] of workspace.members.entries()) applyAction(workspace, { type: "lead.create", lead: { name: `Student ${index}`, phone: `987654321${index}`, ownerId: member.id } });
  const actor = { id: "user_a", memberId: "membership_a", name: "Same Name", email: "a@example.com", role: "counsellor" as const, backend: "workos" as const };
  return { workspace, actor, mine: workspace.leads.find(lead => lead.ownerId === actor.memberId)!, other: workspace.leads.find(lead => lead.ownerId !== actor.memberId)! };
}
function file(workspace: Workspace, leadId?: string, purpose: WorkspaceFile["purpose"] = "attachment"): WorkspaceFile {
  const id = uid(); return { id, leadId, name: "notes.txt", mime: "text/plain", size: 5, purpose, status: "ready", createdAt: isoNow(), objectKey: `${workspace.id}/files/${id}/notes.txt` };
}

test("same-name counsellors cannot project, suggest, reparent tasks, or attach files from another owner", async () => {
  const { workspace, actor, mine, other } = identityWorkspace();
  const mineFile = file(workspace, mine.id), otherFile = file(workspace, other.id), knowledge = file(workspace, undefined, "knowledge");
  workspace.files = [mineFile, otherFile, knowledge];
  const taskId = uid(); workspace.tasks = [{ id: taskId, leadId: other.id, owner: other.owner, ownerId: other.ownerId, title: "Private follow-up", dueAt: isoNow(), status: "open" }];
  workspace.messages.push({ id: uid(), leadId: mine.id, body: "Invalid legacy reference", direction: "internal", status: "received", createdAt: isoNow(), author: "Same Name", fileId: otherFile.id });
  const scoped = scopeWorkspace(workspace, actor);
  assert.deepEqual(scoped.leads.map(lead => lead.id), [mine.id]);
  assert.equal(scoped.tasks?.length, 0);
  assert.deepEqual(scoped.files?.map(item => item.id).sort(), [mineFile.id, knowledge.id].sort());
  assert.equal(scoped.messages[0].fileId, undefined);
  assert.throws(() => authorizeRecordAction(workspace, actor, { type: "lead.update", id: other.id, changes: { notes: "stolen" } }), /not assigned/);
  assert.throws(() => authorizeRecordAction(workspace, actor, { type: "task.save", id: taskId, leadId: mine.id, ownerId: actor.memberId }), /not assigned/);
  assert.throws(() => authorizeRecordAction(workspace, actor, { type: "message.send", leadId: mine.id, fileId: otherFile.id }), /does not belong/);
  assert.throws(() => authorizeRecordAction(workspace, actor, { type: "task.complete", id: uid() }), /not found/);
  assert.throws(() => authorizeRecordAction(workspace, actor, { type: "lead.update", id: mine.id, changes: { ownerId: "membership_b" } }), /administrator/);
  await assert.rejects(() => suggestReply(workspace, other, "private question", actor), /not assigned/);
  assert.doesNotThrow(() => assertFileAccess(workspace, actor, mineFile, true));
  assert.throws(() => assertFileAccess(workspace, actor, otherFile, true), /not assigned/);
  assert.throws(() => assertFileAccess(workspace, actor, knowledge, true), /Counsellor files/);
  const action = { type: "lead.create", lead: { name: "New student", phone: "9876543299", ownerId: "membership_b" } };
  authorizeRecordAction(workspace, actor, action); applyAction(workspace, action);
  assert.equal(workspace.leads[0].ownerId, actor.memberId);
});

test("role and actor claims fail closed, including identity collisions, revocation and local-backend spoofing", () => {
  const { workspace, actor, mine } = identityWorkspace();
  assert.equal(can("__proto__" as never, "lead.update"), false);
  assert.throws(() => roleFrom("unexpected"), /not configured/);
  for (const forged of [{ ...actor, role: "owner" as const }, { ...actor, memberId: "membership_b" }, { ...actor, email: "b@example.com" }, { ...actor, backend: "local" as const, role: "owner" as const, id: workspace.id }]) assert.throws(() => scopeWorkspace(workspace, forged));
  workspace.members![0].status = "inactive";
  assert.throws(() => authorizeRecordAction(workspace, actor, { type: "message.read", id: mine.id }), /membership has changed/);
});

test("public workspace allowlists connection metadata and never returns secrets or storage credentials", () => {
  const workspace = createWorkspace();
  workspace.connections = [{ id: uid(), service: "whatsapp", status: "connected", externalId: "123", label: "WhatsApp", updatedAt: isoNow(), secret: "ENCRYPTED_SECRET", metadata: { wabaId: "456", coexistence: "requested", accessToken: "ACCESS_TOKEN", refresh_token: "REFRESH_TOKEN", objectKey: "PRIVATE_KEY", signedUrl: "SIGNED_URL", nested: '{"secret":"HIDDEN"}' } }];
  workspace.files = [file(workspace, workspace.leads[0].id)];
  const result = publicWorkspace(workspace), text = JSON.stringify(result);
  for (const secret of ["ENCRYPTED_SECRET", "ACCESS_TOKEN", "REFRESH_TOKEN", "PRIVATE_KEY", "SIGNED_URL", "HIDDEN", workspace.files[0].objectKey!]) assert.ok(!text.includes(secret));
  assert.equal(result.connections![0].metadata.wabaId, "456");
  assert.equal(workspace.connections[0].secret, "ENCRYPTED_SECRET", "scrubbing must not mutate durable credentials");
});

test("body limits count streamed bytes, cancel oversized chunked bodies, and enforce origin protocol", async t => {
  environment(t, { APP_BASE_URL: undefined });
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("₹₹")); }, cancel() { cancelled = true; } });
  await assert.rejects(() => readLimitedText({ body: stream, headers: new Headers({ "content-length": "1" }) }, 5), (error: unknown) => (error as { status: number }).status === 413);
  assert.equal(cancelled, true);
  const oversized = new NextRequest("http://127.0.0.1/api/workspace", { method: "POST", headers: { "content-type": "application/json", "content-length": "999999999" }, body: "{}" });
  await assert.rejects(() => readAction(oversized), (error: unknown) => (error as { status: number }).status === 413);
  assert.equal(sameOrigin(new NextRequest("https://app.example.com/api/workspace", { headers: { origin: "http://app.example.com" } })), false);
  assert.equal(sameOrigin(new NextRequest("https://app.example.com/api/workspace", { headers: { origin: "https://app.example.com" } })), true);
  assert.equal(sameOrigin(new NextRequest("https://app.example.com/api/workspace", { headers: { "sec-fetch-site": "cross-site" } })), false);
  assert.equal(constantTimeEqual("aaa", "₹₹₹"), false, "equal JS lengths must not crash byte comparisons");
});

test("signatures and tenant-bound encryption reject tampering without exposing credentials", async t => {
  environment(t, { KMS_KEY_ID: undefined, INTEGRATION_ENCRYPTION_KEY: Buffer.alloc(32, 11).toString("base64") });
  const workspaceId = uid(), raw = '{"text":"नमस्ते"}', key = "signature-secret";
  const signature = `sha256=${createHmac("sha256", key).update(raw).digest("hex")}`;
  assert.equal(validSignature(raw, signature, key), true);
  assert.equal(validSignature(`${raw} `, signature, key), false);
  assert.equal(validSignature(raw, "₹".repeat(signature.length), key), false);
  const first = await sealSecret({ token: "secret" }, workspaceId), second = await sealSecret({ token: "secret" }, workspaceId);
  assert.notEqual(first, second);
  assert.equal((await openSecret(first, workspaceId)).token, "secret");
  await assert.rejects(() => openSecret(first, uid()));
  const parts = first.split(":"); const tag = Buffer.from(parts[2], "base64"); tag[0] ^= 1; parts[2] = tag.toString("base64");
  await assert.rejects(() => openSecret(parts.join(":"), workspaceId));
  await assert.rejects(() => openSecret(first.replace("v1:", "v99:"), workspaceId));
});

test("demo AI, jobs, uploads and connection setup are credential- and network-free even when keys exist", async t => {
  environment(t, { DATABASE_URL: undefined, ADMITFLOW_DB: ":memory:", APP_BASE_URL: undefined, KMS_KEY_ID: "test-kms-key", OPENAI_API_KEY: `sk-${"a".repeat(40)}`, ELEVENLABS_API_KEY: `sk_${"b".repeat(40)}`, R2_ACCOUNT_ID: "test", R2_ACCESS_KEY_ID: "test", R2_SECRET_ACCESS_KEY: "test", R2_BUCKET: "test" });
  const fetchMock = t.mock.method(globalThis, "fetch", async () => { throw new Error("No live fetch allowed in demo"); });
  const s3 = t.mock.method(S3Client.prototype, "send", async () => { throw new Error("No live R2 allowed in demo"); });
  const kms = t.mock.method(KMSClient.prototype, "send", async () => { throw new Error("No KMS allowed in demo"); });
  const workspace = createWorkspace(); saveNewWorkspace(workspace);
  const draft = await suggestReply(workspace, workspace.leads[1], "course fees");
  assert.equal(draft.retrievalMode, "keyword");
  await assert.rejects(() => credentials(workspace, "openai"), /Demo/);
  await assert.rejects(() => transcribe(workspace, new Uint8Array([1])), /Demo/);
  await assert.rejects(() => synthesize(workspace, "Hello"), /Demo/);
  await assert.rejects(() => templates(workspace), /Demo/);
  await assert.rejects(() => saveConnection(workspace.id, "openai", { apiKey: process.env.OPENAI_API_KEY! }, workspace.id, "Test"), /production institute/);
  await assert.rejects(() => beginUpload(workspace.id, { name: "notes.txt", mime: "text/plain", size: 5, purpose: "attachment", leadId: workspace.leads[0].id }), /connected institute/);
  await mutateWorkspace(workspace.id, current => { for (const kind of ["file.ingest", "knowledge.index", "calendar.sync"] as const) current.jobs.push({ id: uid(), leadId: "", campaignId: "", step: 0, kind, dueAt: isoNow(), status: "pending", payload: {} }); });
  assert.equal((await processJobs(workspace.id)).processed, 3);
  const token = createSession(workspace.id), leadId = workspace.leads[1].id;
  const simulate = (body: string, echo = false) => workspacePost(new NextRequest("http://127.0.0.1/api/workspace", { method: "POST", headers: { cookie: `admitflow_session=${token}`, "content-type": "application/json", host: "127.0.0.1", origin: "http://127.0.0.1" }, body: JSON.stringify({ type: "message.simulate", leadId, body, echo }) }));
  assert.equal((await simulate("What are the course fees?")).status, 200);
  const beforeEcho = await loadWorkspace(workspace.id);
  const replies = beforeEcho.messages.filter(message => message.leadId === leadId && message.author === "AdmitFlow AI");
  assert.equal(replies.length, 1); assert.equal(replies[0].status, "demo");
  assert.equal((await simulate("I'll handle this personally", true)).status, 200);
  assert.equal((await simulate("Another student question")).status, 200);
  assert.equal((await loadWorkspace(workspace.id)).messages.filter(message => message.leadId === leadId && message.author === "AdmitFlow AI").length, 1);
  assert.equal(fetchMock.mock.callCount(), 0); assert.equal(s3.mock.callCount(), 0); assert.equal(kms.mock.callCount(), 0);
});

test("attachment finalization checks assignment, size/type and freezes an immutable object before downloads", async t => {
  environment(t, { DATABASE_URL: undefined, ADMITFLOW_DB: ":memory:", R2_ACCOUNT_ID: "a".repeat(32), R2_ACCESS_KEY_ID: "test-key", R2_SECRET_ACCESS_KEY: "test-secret", R2_BUCKET: "test-bucket" });
  const { workspace, actor, mine, other } = identityWorkspace(); saveNewWorkspace(workspace);
  const bytes = new TextEncoder().encode("hello"); let size = bytes.length, copies = 0;
  const upload = await beginUpload(workspace.id, { name: "notes.txt", mime: "text/plain", size, purpose: "attachment", leadId: mine.id }, actor);
  assert.equal(upload.headers["x-amz-meta-admitflow-workspace"], workspace.id);
  const s3 = t.mock.method(S3Client.prototype, "send", async (command: unknown) => {
    if (command instanceof HeadObjectCommand) return { ContentLength: size, ContentType: "text/plain", ETag: '"pending-etag"', Metadata: { "admitflow-workspace": workspace.id, "admitflow-file": upload.id } };
    if (command instanceof GetObjectCommand) return { ContentLength: bytes.length, ContentType: "text/plain", Body: { transformToWebStream: () => new Response(bytes).body! } };
    if (command instanceof CopyObjectCommand) { copies++; assert.equal(command.input.CopySourceIfMatch, '"pending-etag"'); return { CopyObjectResult: { ETag: '"final-etag"' } }; }
    throw new Error("Unexpected storage operation");
  });
  size++;
  await assert.rejects(() => finishUpload(workspace.id, upload.id, actor), /declared size/);
  assert.equal((await loadWorkspace(workspace.id)).files![0].status, "pending");
  size--;
  await finishUpload(workspace.id, upload.id, actor);
  const stored = (await loadWorkspace(workspace.id)).files![0];
  assert.equal(stored.status, "ready"); assert.ok(stored.finalizedAt); assert.equal(stored.etag, '"final-etag"'); assert.ok(stored.objectKey!.includes("/files/"));
  await finishUpload(workspace.id, upload.id, actor); assert.equal(copies, 1, "finish is idempotent");
  assert.match(await downloadUrl(workspace.id, upload.id, actor), /^https:/);
  await assert.rejects(() => beginUpload(workspace.id, { name: "notes.txt", mime: "text/plain", size, purpose: "attachment", leadId: other.id }, actor), /not assigned/);
  await mutateWorkspace(workspace.id, current => { current.leads.find(lead => lead.id === mine.id)!.ownerId = "membership_b"; });
  const calls = s3.mock.callCount();
  await assert.rejects(() => finishUpload(workspace.id, upload.id, actor), /not assigned/);
  await assert.rejects(() => downloadUrl(workspace.id, upload.id, actor), /not assigned/);
  assert.equal(s3.mock.callCount(), calls, "revoked access is rejected before storage access");
});

test("provider key format/readiness checks do not report an unverified credential as connected", async t => {
  environment(t, { DATABASE_URL: undefined, ADMITFLOW_DB: ":memory:", KMS_KEY_ID: undefined });
  assert.equal(validProviderKey("openai", "not-a-key"), false);
  assert.equal(validProviderKey("elevenlabs", "short"), false);
  const workspace = createWorkspace(false), apiKey = `sk-${"a".repeat(40)}`;
  const fetchMock = t.mock.method(globalThis, "fetch", async () => new Response('{"error":{"message":"invalid"}}', { status: 401 }));
  await assert.rejects(() => verifyProviderCredentials(workspace, "openai", { apiKey }), /could not verify/);
  assert.equal(workspace.connections!.length, 0); assert.equal(fetchMock.mock.callCount(), 1);
});

test("HTTP endpoints reject unauthenticated jobs, forged/oversized callbacks and foreign enquiry IDs", async t => {
  environment(t, { DATABASE_URL: undefined, REDIS_URL: undefined, ADMITFLOW_DB: ":memory:", APP_BASE_URL: undefined, CRON_SECRET: "cron-secret", META_APP_SECRET: "meta-secret", INTEGRATION_WORKSPACE_ID: uid() });
  const network = t.mock.method(globalThis, "fetch", async () => { throw new Error("No network expected"); });
  assert.equal((await jobsPost(new NextRequest("http://127.0.0.1/api/jobs", { method: "POST" }))).status, 401);
  assert.equal((await jobsPost(new NextRequest("http://127.0.0.1/api/jobs", { method: "POST", headers: { authorization: "Bearer cron-secret" } }))).status, 503, "the obsolete workspace env cannot authorize dispatch");
  assert.equal((await whatsappPost(new NextRequest("http://127.0.0.1/api/webhooks/whatsapp", { method: "POST", body: "{}" }))).status, 403);
  assert.equal((await whatsappPost(new NextRequest("http://127.0.0.1/api/webhooks/whatsapp", { method: "POST", headers: { "content-length": "3000000" }, body: "{}" }))).status, 413);
  const workspace = createWorkspace(), foreign = createWorkspace(); saveNewWorkspace(workspace); saveNewWorkspace(foreign);
  const token = createSession(workspace.id);
  const request = (action: unknown) => new NextRequest("http://127.0.0.1/api/workspace", { method: "POST", headers: { cookie: `admitflow_session=${token}`, "content-type": "application/json", host: "127.0.0.1", origin: "http://127.0.0.1" }, body: JSON.stringify(action) });
  assert.equal((await workspacePost(request({ type: "message.suggest", leadId: foreign.leads[0].id }))).status, 404);
  assert.equal((await workspacePost(request({ type: "message.note", leadId: workspace.leads[0].id, body: "Internal note", author: "Forged actor", role: "admin" }))).status, 200);
  const saved = await loadWorkspace(workspace.id);
  assert.equal(saved.messages.at(-1)!.author, workspace.userName);
  assert.equal(saved.userName, workspace.userName); assert.equal(saved.actor, undefined);
  const first = await leadsGet(new NextRequest("http://127.0.0.1/api/leads?page=1&pageSize=3", { headers: { cookie: `admitflow_session=${token}` } }));
  const second = await leadsGet(new NextRequest("http://127.0.0.1/api/leads?page=2&pageSize=3", { headers: { cookie: `admitflow_session=${token}` } }));
  const a = await first.json(), b = await second.json();
  assert.equal(a.total, 40); assert.equal(a.leads.length, 3); assert.equal(a.hasMore, true); assert.ok(a.leads.every((lead: { id: string }) => !b.leads.some((item: { id: string }) => item.id === lead.id)));
  assert.equal(network.mock.callCount(), 0);
});

test("failed BullMQ entries are re-enqueued from durable pending jobs rather than silently reusing a failed ID", async () => {
  const workspace = createWorkspace(false);
  workspace.jobs = [{ id: uid(), leadId: "", campaignId: "", kind: "file.ingest", status: "failed", step: 0, dueAt: isoNow(), attempts: 3 }];
  applyAction(workspace, { type: "job.retry", id: workspace.jobs[0].id });
  const calls: string[] = [];
  const queue = { getJob: async () => ({ getState: async () => "failed", remove: async () => { calls.push("remove"); } }), add: async (_name: string, data: unknown, options: { jobId: string }) => { calls.push("add"); assert.deepEqual(data, { workspaceId: workspace.id, jobId: workspace.jobs[0].id }); assert.ok(options.jobId.endsWith("-1-3")); } };
  assert.equal(await enqueueWorkspaceJobs(queue as unknown as Parameters<typeof enqueueWorkspaceJobs>[0], workspace), 1);
  assert.deepEqual(calls, ["remove", "add"]);
});

test("HTTP lead views and sort filters are applied before local pagination and invalid selectors fail closed", async t => {
  environment(t, { DATABASE_URL: undefined, ADMITFLOW_DB: ":memory:" });
  const workspace = createWorkspace();
  // The seed puts this reply exactly 14 days ago; a millisecond between expected and HTTP clocks changes its intent score.
  workspace.leads[6].lastInboundAt = new Date(Date.parse(workspace.leads[6].lastInboundAt!) - DAY).toISOString();
  saveNewWorkspace(workspace);
  const token = createSession(workspace.id), now = Date.now();
  for (const view of LEAD_VIEWS) for (const sort of LEAD_SORTS) {
    const response = await leadsGet(new NextRequest(`http://127.0.0.1/api/leads?view=${view}&sort=${sort}&page=2&pageSize=3`, { headers: { cookie: `admitflow_session=${token}`, host: "127.0.0.1" } }));
    const body = await response.json();
    const expected = sortLeads(workspace.leads.filter(lead => leadMatchesView(lead, view, now)), sort, now);
    assert.equal(response.status, 200); assert.equal(body.total, expected.length);
    assert.deepEqual(body.leads.map((lead: { id: string }) => lead.id), expected.slice(3, 6).map(lead => lead.id));
  }
  for (const query of ["view=not-a-view", "sort=not-a-sort"]) {
    const response = await leadsGet(new NextRequest(`http://127.0.0.1/api/leads?${query}`, { headers: { cookie: `admitflow_session=${token}`, host: "127.0.0.1" } }));
    assert.equal(response.status, 400); assert.equal((await response.json()).leads, undefined);
  }
});

test("saved-view HTTP responses persist validated preferences and restore them without browser storage", async t => {
  environment(t, { DATABASE_URL: undefined, ADMITFLOW_DB: ":memory:", APP_BASE_URL: undefined });
  const workspace = createWorkspace(); saveNewWorkspace(workspace);
  const token = createSession(workspace.id), owner = workspace.members![0].id;
  const request = (changes: Record<string, unknown>) => new NextRequest("http://127.0.0.1/api/workspace", { method: "POST", headers: { cookie: `admitflow_session=${token}`, host: "127.0.0.1", origin: "http://127.0.0.1", "content-type": "application/json" }, body: JSON.stringify({ type: "view.save", name: "Server-saved view", owner, ...changes }) });
  const response = await workspacePost(request({ view: "high-intent", sort: "name", course: "NEET 2027" }));
  const body = await response.json();
  assert.equal(response.status, 200); assert.equal(body.result.view, "high-intent"); assert.equal(body.result.sort, "name");
  const saved = (await loadWorkspace(workspace.id)).savedViews!.find(view => view.id === body.result.viewId)!;
  assert.equal(saved.owner, owner); assert.equal(saved.course, "NEET 2027");
  assert.deepEqual(resolveSavedViewPreferences(saved), { view: "high-intent", sort: "name" });
  const page = await leadsGet(new NextRequest(`http://127.0.0.1/api/leads?view=${saved.view}&sort=${saved.sort}&ownerId=${encodeURIComponent(saved.owner)}&course=${encodeURIComponent(saved.course)}&pageSize=100`, { headers: { cookie: `admitflow_session=${token}`, host: "127.0.0.1" } }));
  const data = await page.json();
  const expected = sortLeads(workspace.leads.filter(lead => lead.ownerId === owner && lead.course === saved.course && leadMatchesView(lead, "high-intent")), "name");
  assert.equal(page.status, 200); assert.equal(data.total, expected.length); assert.deepEqual(data.leads.map((lead: { id: string }) => lead.id), expected.map(lead => lead.id));
  assert.equal((await workspacePost(request({ name: "Bad sort", sort: "unsupported" }))).status, 400);
  assert.equal((await workspacePost(request({ name: "Bad view", view: "unsupported" }))).status, 400);
  assert.equal((await loadWorkspace(workspace.id)).savedViews!.length, 1);
});

test("live booking rejects Google conflicts and outages before accepting a slot, then exposes pending sync", async t => {
  const { workspace, request, startsAt, action } = await calendarFixture(t);
  let state: "busy" | "outage" | "free" = "busy";
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = String(input); calls.push(url);
    if (url.endsWith("/token")) return Response.json({ access_token: "test-google-access" });
    assert.ok(url.endsWith("/freeBusy"), "booking preflight must not create an external event");
    if (state === "outage") return new Response("unavailable", { status: 503 });
    return Response.json({ calendars: { primary: { busy: state === "busy" ? [{ start: startsAt, end: new Date(Date.parse(startsAt) + 30 * 60000).toISOString() }] : [] } } });
  });
  assert.equal((await workspacePost(request(action))).status, 409);
  assert.equal((await loadWorkspace(workspace.id)).appointments.length, 0);
  state = "outage";
  assert.equal((await workspacePost(request(action))).status, 502);
  assert.equal((await loadWorkspace(workspace.id)).appointments.length, 0, "an outage is not an empty calendar");
  state = "free";
  const response = await workspacePost(request(action)), result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.result.syncStatus, "pending"); assert.equal(result.result.availability.source, "google");
  const current = await loadWorkspace(workspace.id);
  assert.equal(current.appointments.length, 1); assert.equal(current.appointments[0].status, "scheduled"); assert.equal(current.appointments[0].syncStatus, "pending");
  assert.equal(current.jobs.filter(job => job.kind === "calendar.sync" && job.status === "pending").length, 1);
  assert.equal(calls.length, 6);
});

test("rescheduling excludes only a verified existing event and still detects overlapping or paginated conflicts", async t => {
  for (const variant of ["own-event", "other-overlap", "wrong-binding", "later-page", "incomplete-own-event"] as const) await t.test(variant, async t => {
    const { workspace, request, startsAt, action } = await calendarFixture(t);
    const created = await mutateWorkspace(workspace.id, current => {
      const result = applyAction(current, action) as { appointmentId: string };
      const appointment = current.appointments[0]; appointment.externalId = calendarEventId(appointment.id); appointment.syncStatus = "synced";
      current.jobs.forEach(job => { job.status = "sent"; });
      return result;
    });
    const id = created.result.appointmentId, oldEnd = new Date(Date.parse(startsAt) + 30 * 60000).toISOString(), next = new Date(Date.parse(startsAt) + 15 * 60000).toISOString();
    const own = { id: calendarEventId(id), status: "confirmed", start: { dateTime: startsAt }, end: { dateTime: oldEnd }, extendedProperties: { private: { admitflowWorkspaceId: variant === "wrong-binding" ? uid() : workspace.id, admitflowAppointmentId: id } } };
    const other = { id: "another-private-event", status: "confirmed", start: { dateTime: startsAt }, end: { dateTime: oldEnd } };
    let pages = 0;
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/token")) return Response.json({ access_token: "test-google-access" });
      if (url.endsWith("/freeBusy")) return Response.json({ calendars: { primary: { busy: [{ start: startsAt, end: oldEnd }] } } });
      assert.ok(url.includes("/calendars/primary/events?")); pages++;
      if (variant === "incomplete-own-event") return Response.json({ items: [{ ...own, start: undefined, end: undefined }] });
      if (variant === "later-page") return new URL(url).searchParams.has("pageToken") ? Response.json({ items: [other] }) : Response.json({ items: [own], nextPageToken: "next-page" });
      return Response.json({ items: variant === "other-overlap" ? [own, other] : [own] });
    });
    const response = await workspacePost(request({ type: "appointment.reschedule", id, startsAt: next }));
    const body = await response.json(), current = await loadWorkspace(workspace.id);
    assert.equal(response.status, variant === "own-event" ? 200 : variant === "incomplete-own-event" ? 502 : 409);
    assert.equal(current.appointments.length, 1);
    assert.equal(current.appointments[0].startsAt, variant === "own-event" ? next : startsAt);
    assert.equal(current.appointments[0].syncStatus, variant === "own-event" ? "pending" : "synced");
    if (variant === "own-event") assert.equal(body.result.availability.excludedExistingEvent, true);
    assert.equal(pages, variant === "later-page" ? 2 : 1);
    assert.ok(!JSON.stringify(body).includes("another-private-event"), "availability errors must not reveal other event IDs");
  });
});

test("booking preflight checks permissions before providers and rechecks assignment and connection identity before commit", async t => {
  for (const change of ["assignment", "connection"] as const) await t.test(change, async t => {
    environment(t, { DATABASE_URL: undefined, ADMITFLOW_DB: ":memory:", KMS_KEY_ID: undefined, INTEGRATION_ENCRYPTION_KEY: Buffer.alloc(32, 17).toString("base64"), GOOGLE_CLIENT_ID: "test-client", GOOGLE_CLIENT_SECRET: "test-client-secret" });
    const { workspace, actor, mine, other } = identityWorkspace();
    workspace.connections = [{ id: uid(), service: "google", status: "connected", externalId: "google-account", label: "Calendar", updatedAt: isoNow(), metadata: { calendarId: "primary" }, secret: await sealSecret({ refreshToken: "test-refresh-token" }, workspace.id) }];
    saveNewWorkspace(workspace);
    const action = { type: "appointment.create", leadId: mine.id, ownerId: actor.memberId, startsAt: new Date(Date.now() + DAY).toISOString(), duration: 30, kind: "Counselling" };
    let calls = 0;
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
      calls++;
      if (String(input).endsWith("/token")) return Response.json({ access_token: "test-google-access" });
      await mutateWorkspace(workspace.id, current => {
        if (change === "assignment") current.leads.find(lead => lead.id === mine.id)!.ownerId = "membership_b";
        else current.connections![0].metadata.calendarId = "different-calendar";
      });
      return Response.json({ calendars: { primary: { busy: [] } } });
    });
    await assert.rejects(() => bookAppointment(workspace.id, { ...action, leadId: other.id }, { actor }), /not assigned/);
    assert.equal(calls, 0);
    await assert.rejects(() => bookAppointment(workspace.id, action, { actor }), change === "assignment" ? /not assigned/ : /connection changed/);
    assert.equal((await loadWorkspace(workspace.id)).appointments.length, 0);
  });
});

test("local conflict checks run again after Google preflight and demo bookings never access Google", async t => {
  await t.test("a concurrent local booking wins safely", async t => {
    const { workspace, request, action } = await calendarFixture(t);
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/token")) return Response.json({ access_token: "test-google-access" });
      await mutateWorkspace(workspace.id, current => applyAction(current, action));
      return Response.json({ calendars: { primary: { busy: [] } } });
    });
    const response = await workspacePost(request(action));
    assert.equal(response.status, 400); assert.match((await response.json()).error, /already has an appointment/);
    assert.equal((await loadWorkspace(workspace.id)).appointments.length, 1);
  });
  await t.test("demo is provider-free", async t => {
    const { workspace, request, action } = await calendarFixture(t, true);
    const network = t.mock.method(globalThis, "fetch", async () => { throw new Error("Demo must not call Google"); });
    const response = await workspacePost(request(action));
    assert.equal(response.status, 200); assert.equal((await response.json()).result.syncStatus, "local");
    await processJobs(workspace.id);
    assert.equal((await loadWorkspace(workspace.id)).appointments[0].syncStatus, "local");
    assert.equal(network.mock.callCount(), 0);
  });
});
