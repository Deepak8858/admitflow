import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createWorkspace } from "../src/lib/seed";
import { receiveMessage, receiveStatus, applyDelivery, validSignature } from "../src/lib/providers/meta";
import { applyPaymentEvent } from "../src/lib/providers/payments";
import { replyBlock, contactBlock, uid, isoNow, DAY, latestInbound, type Workspace, type Message } from "../src/lib/domain";
import { sealSecret, openSecret } from "../src/lib/secrets";
import { applyAction } from "../src/lib/actions";
import { loadWorkspace, mutateWorkspace, saveNewWorkspace } from "../src/lib/store";
import { processJob, sendReply, recoverWorkspaceJobs, transcribeMessage } from "../src/lib/integrations";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { availableSlots } from "../src/lib/providers/ai";

test("inbound messages schedule autonomous replies once; Business-app echoes and opt-outs pause them", () => {
  const workspace = createWorkspace(), lead = workspace.leads[1]; lead.humanOwned = false;
  const event = { id: "wamid.1", from: lead.phone.slice(1), body: "What are your fees?" };
  receiveMessage(workspace, event); receiveMessage(workspace, event);
  assert.equal(workspace.messages.filter(message => message.providerId === event.id).length, 1);
  assert.equal(workspace.jobs.filter(job => job.kind === "ai.reply" && job.status === "pending").length, 1);
  receiveMessage(workspace, { ...event, id: "wamid.echo", echo: true, body: "Let me help you personally." });
  assert.equal(lead.humanOwned, true);
  assert.equal(workspace.jobs.filter(job => job.status === "pending").length, 0);
  receiveMessage(workspace, { ...event, id: "wamid.stop", body: "STOP" });
  assert.equal(lead.consent, "opted_out");
});
test("service replies do not invent marketing consent, and status events cannot regress delivery", () => {
  const workspace = createWorkspace(), lead = workspace.leads[0];
  lead.consent = "unknown"; lead.isMinor = false; lead.lastInboundAt = new Date().toISOString();
  assert.equal(replyBlock(lead), null); assert.ok(contactBlock(lead));
  const message = workspace.messages[0]; message.status = "delivered";
  applyDelivery(message, "sent"); applyDelivery(message, "failed"); assert.equal(message.status, "delivered");
  applyDelivery(message, "read"); assert.equal(message.status, "read");
});
test("provider signatures and tenant-bound encrypted credentials reject forgery and cross-tenant use", async () => {
  const raw = '{"event":"test"}', key = "test-secret";
  const signature = `sha256=${createHmac("sha256", key).update(raw).digest("hex")}`;
  assert.ok(validSignature(raw, signature, key)); assert.ok(!validSignature(`${raw} `, signature, key));
  process.env.INTEGRATION_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  const org = uid(), sealed = await sealSecret({ token: "private" }, org);
  assert.equal((await openSecret(sealed, org)).token, "private");
  await assert.rejects(() => openSecret(sealed, uid()));
});
test("captured payment events are idempotent and verified refunds affect the correct receipt", () => {
  const workspace = createWorkspace(), lead = workspace.leads[0];
  const event = { event: "payment.captured", payload: { payment: { entity: { id: "pay_test", status: "captured", amount: 125050, currency: "INR", notes: { admitflow_workspace_id: workspace.id, admitflow_lead_id: lead.id } } } } };
  applyPaymentEvent(workspace, event); applyPaymentEvent(workspace, event);
  assert.equal(workspace.revenue.filter(item => item.providerId === "pay_test").length, 1);
  assert.equal(workspace.revenue.find(item => item.providerId === "pay_test")?.amount, 1250.5);
  applyPaymentEvent(workspace, { event: "refund.processed", payload: { refund: { entity: { id: "rfnd_test", payment_id: "pay_test", amount: 25050, status: "processed", currency: "INR" } } } });
  assert.equal(workspace.refunds![0].amount, 250.5);
});

function environment(t: TestContext, values: Record<string, string | undefined>) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
async function liveFixture(t: TestContext, kind: "reply" | "followup" | "voice" = "reply") {
  environment(t, { DATABASE_URL: undefined, ADMITFLOW_DB: ":memory:", KMS_KEY_ID: undefined, INTEGRATION_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"), OPENAI_API_KEY: `sk-${"a".repeat(40)}`, ELEVENLABS_API_KEY: `sk_${"b".repeat(40)}`, R2_ACCOUNT_ID: "a".repeat(32), R2_ACCESS_KEY_ID: "test-access", R2_SECRET_ACCESS_KEY: "test-secret", R2_BUCKET: "test-bucket" });
  const workspace = createWorkspace(false);
  workspace.ai!.voiceReplies = kind === "voice"; workspace.ai!.voiceId = "voice_test_12345";
  workspace.articles = [{ id: uid(), title: "Course fees", category: "Courses", body: "The NEET course fee is ₹65,000. Weekday batches run at 4 pm.", updatedAt: isoNow(), version: 1 }];
  applyAction(workspace, { type: "lead.create", lead: { name: "Student", phone: "9876543210", course: "NEET", consent: "opted_in", consentSource: "Test enquiry form" } });
  const lead = workspace.leads[0];
  workspace.connections = [{ id: uid(), service: "whatsapp", status: "connected", externalId: "111111", label: "Test number", updatedAt: isoNow(), secret: await sealSecret({ accessToken: `EAA${"a".repeat(40)}` }, workspace.id), metadata: { wabaId: "222222", templateName: "recovery", templateLanguage: "en", coexistence: "requested" } }];
  if (kind === "followup") {
    lead.createdAt = new Date(Date.now() - 10 * DAY).toISOString();
    workspace.sequence.delays = [0];
    applyAction(workspace, { type: "campaign.create", name: "Recovery", course: "NEET", message: "Hi {name}", leadIds: [lead.id] });
  } else receiveMessage(workspace, { id: `wamid.incoming.${uid()}`, from: lead.phone.slice(1), body: kind === "voice" ? "[audio message]" : "What are the course fees?", ...(kind === "voice" ? { mediaType: "audio", mediaId: "333333" } : {}) });
  workspace.jobs.forEach(job => { job.dueAt = isoNow(); });
  saveNewWorkspace(workspace);
  return { workspace, lead, job: workspace.jobs[0] };
}
const approved = () => Response.json({ data: [{ id: "template_1", name: "recovery", language: "en", status: "APPROVED", category: "MARKETING", components: [{ type: "BODY", text: "Hi {{1}}, interested in {{2}} at {{3}}?" }] }] });
function modelReply(workspace: Workspace, booking: ReturnType<typeof availableSlots>[number] | null = null) {
  return Response.json({ id: "chatcmpl_test", object: "chat.completion", created: 1, model: "gpt-4.1-mini", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", refusal: null, content: JSON.stringify({ body: booking ? "I've requested that counselling slot; calendar confirmation is pending." : "The NEET course fee is ₹65,000. Would you like a counselling session?", sourceIds: [workspace.articles[0].id], handoff: false, nextAction: "Confirm a counselling time", qualified: true, booking }) } }] });
}

test("provider acceptance stays accepted until signed status, request IDs prevent replay, and callbacks never regress", async t => {
  const { workspace, lead } = await liveFixture(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({ messages: [{ id: "wamid.accepted" }] }); });
  const id = uid();
  await sendReply(workspace.id, lead.id, "Hello student", id);
  let current = await loadWorkspace(workspace.id), message = current.messages.find(item => item.id === id)!;
  assert.equal(message.status, "accepted"); assert.equal(message.dispatchState, "accepted"); assert.ok(message.dispatchedAt);
  assert.equal(current.leads[0].lastContactAt, null, "API acceptance must not invent a sent contact timestamp");
  await sendReply(workspace.id, lead.id, "Hello student", id); assert.equal(calls, 1);
  await assert.rejects(() => sendReply(workspace.id, lead.id, "Different body", id), /different message/);
  await mutateWorkspace(workspace.id, value => {
    receiveStatus(value, { id: "wamid.accepted", status: "sent", timestamp: String(Math.floor(Date.now() / 1000) - 2) });
    receiveStatus(value, { id: "wamid.accepted", status: "read", timestamp: String(Math.floor(Date.now() / 1000)) });
    receiveStatus(value, { id: "wamid.accepted", status: "failed", timestamp: String(Math.floor(Date.now() / 1000) - 1) });
    receiveStatus(value, { id: "wamid.accepted", status: "sent", timestamp: String(Math.floor(Date.now() / 1000) - 2) });
  });
  current = await loadWorkspace(workspace.id); message = current.messages.find(item => item.id === id)!;
  assert.equal(message.status, "read"); assert.ok(current.leads[0].lastContactAt);
});

test("a callback that arrives before the send response wins, while ambiguous timeouts never resend", async t => {
  await t.test("delivery callback races the API response", async t => {
    const { workspace, lead } = await liveFixture(t);
    const id = uid();
    t.mock.method(globalThis, "fetch", async () => {
      await mutateWorkspace(workspace.id, value => receiveStatus(value, { id: "wamid.race", status: "delivered", biz_opaque_callback_data: id, recipient_id: lead.phone.slice(1) }));
      return Response.json({ messages: [{ id: "wamid.race" }] });
    });
    await sendReply(workspace.id, lead.id, "A reply", id);
    assert.equal((await loadWorkspace(workspace.id)).messages.find(item => item.id === id)!.status, "delivered");
  });
  await t.test("timeout after the message POST is ambiguous", async t => {
    const { workspace, lead } = await liveFixture(t);
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => { calls++; throw new DOMException("Provider timed out", "TimeoutError"); });
    const id = uid();
    await assert.rejects(() => sendReply(workspace.id, lead.id, "A reply", id), /timed out/);
    const result = await sendReply(workspace.id, lead.id, "A reply", id);
    assert.equal(calls, 1); assert.equal(result.messages.find(item => item.id === id)!.status, "reconcile");
    await mutateWorkspace(workspace.id, value => receiveStatus(value, { id: "wamid.late", status: "sent", biz_opaque_callback_data: id }));
    assert.equal((await loadWorkspace(workspace.id)).messages.find(item => item.id === id)!.status, "sent");
  });
});

test("recovery revalidates consent, ownership, latest inbound and campaign pause after template lookup", async t => {
  const cases: { name: string; mutate: (workspace: Workspace) => void; status: string }[] = [
    { name: "paused campaign", mutate: workspace => { workspace.campaigns[0].status = "paused"; }, status: "pending" },
    { name: "opt-out", mutate: workspace => { receiveMessage(workspace, { id: `stop-${uid()}`, from: workspace.leads[0].phone.slice(1), body: "STOP" }); }, status: "cancelled" },
    { name: "human takeover", mutate: workspace => { applyAction(workspace, { type: "lead.update", id: workspace.leads[0].id, changes: { humanOwned: true } }); }, status: "cancelled" },
    { name: "new incoming message", mutate: workspace => { receiveMessage(workspace, { id: `reply-${uid()}`, from: workspace.leads[0].phone.slice(1), body: "Tell me more about the fees" }); }, status: "cancelled" },
    { name: "guardian permission revoked", mutate: workspace => { workspace.leads[0].isMinor = true; workspace.leads[0].guardianConsent = false; }, status: "cancelled" },
  ];
  for (const item of cases) await t.test(item.name, async t => {
    const { workspace, job } = await liveFixture(t, "followup");
    let sends = 0;
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
      if (String(input).includes("message_templates")) { await mutateWorkspace(workspace.id, item.mutate); return approved(); }
      sends++; throw new Error("The message POST must not happen");
    });
    assert.equal(await processJob(workspace.id, job.id), false);
    const current = await loadWorkspace(workspace.id);
    assert.equal(sends, 0); assert.equal(current.jobs.find(value => value.id === job.id)!.status, item.status);
    assert.ok(current.messages.every(message => !message.dispatchedAt));
  });
});

test("transient template lookup failures have bounded safe retries, while accepted follow-ups wait for sent callbacks", async t => {
  const { workspace, job } = await liveFixture(t, "followup");
  let lookups = 0, sends = 0, fail = true;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    if (String(input).includes("message_templates")) { lookups++; if (fail) throw new TypeError("fetch failed"); return approved(); }
    sends++; return Response.json({ messages: [{ id: "wamid.followup" }] });
  });
  for (let attempt = 1; attempt <= 3; attempt++) {
    await mutateWorkspace(workspace.id, current => { current.jobs[0].dueAt = isoNow(); });
    assert.equal(await processJob(workspace.id, job.id), false);
    assert.equal((await loadWorkspace(workspace.id)).jobs[0].status, attempt < 3 ? "pending" : "failed");
  }
  assert.equal(lookups, 3); assert.equal(sends, 0);
  fail = false;
  await mutateWorkspace(workspace.id, current => applyAction(current, { type: "job.retry", id: job.id }));
  assert.equal(await processJob(workspace.id, job.id), true);
  let current = await loadWorkspace(workspace.id);
  assert.equal(current.jobs[0].status, "accepted"); assert.equal(current.campaigns[0].status, "active"); assert.equal(sends, 1);
  await mutateWorkspace(workspace.id, value => receiveStatus(value, { id: "wamid.followup", status: "sent" }));
  current = await loadWorkspace(workspace.id);
  assert.equal(current.jobs[0].status, "sent"); assert.equal(current.campaigns[0].status, "completed");
});

test("explicit rate-limit rejection can retry, but a subsequent undispatched lookup failure is not mistaken for acceptance", async t => {
  const { workspace, job } = await liveFixture(t, "followup");
  let sends = 0, phase = 0;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    if (String(input).includes("message_templates")) { if (phase === 1) throw new TypeError("lookup network failure"); return approved(); }
    sends++;
    return phase === 0 ? Response.json({ error: { code: 4, is_transient: true } }, { status: 429 }) : Response.json({ messages: [{ id: "wamid.after-rejection" }] });
  });
  await processJob(workspace.id, job.id);
  assert.equal((await loadWorkspace(workspace.id)).jobs[0].status, "pending");
  phase = 1;
  await mutateWorkspace(workspace.id, current => { current.jobs[0].dueAt = isoNow(); });
  await processJob(workspace.id, job.id);
  let current = await loadWorkspace(workspace.id);
  assert.equal(current.jobs[0].status, "pending"); assert.equal(current.messages[0].dispatchedAt, undefined);
  phase = 2;
  await mutateWorkspace(workspace.id, current => { current.jobs[0].dueAt = isoNow(); });
  await processJob(workspace.id, job.id);
  current = await loadWorkspace(workspace.id);
  assert.equal(current.jobs[0].status, "accepted"); assert.equal(sends, 2);
});

test("concurrent workers claim an AI reply once, and a handoff during generation blocks dispatch", async t => {
  await t.test("one durable claim", async t => {
    const { workspace, job } = await liveFixture(t);
    let sends = 0;
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
      if (String(input).includes("openai.com")) return modelReply(workspace);
      sends++; return Response.json({ messages: [{ id: "wamid.one-worker" }] });
    });
    const results = await Promise.all([processJob(workspace.id, job.id), processJob(workspace.id, job.id)]);
    assert.equal(results.filter(Boolean).length, 1); assert.equal(sends, 1);
    assert.equal((await loadWorkspace(workspace.id)).jobs[0].attempts, 1);
  });
  await t.test("handoff while the model is running", async t => {
    const { workspace, lead, job } = await liveFixture(t);
    let sends = 0;
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
      if (String(input).includes("openai.com")) { await mutateWorkspace(workspace.id, current => applyAction(current, { type: "lead.update", id: lead.id, changes: { humanOwned: true } })); return modelReply(workspace); }
      sends++; throw new Error("Dispatch must be blocked");
    });
    assert.equal(await processJob(workspace.id, job.id), false); assert.equal(sends, 0);
    assert.equal((await loadWorkspace(workspace.id)).jobs[0].status, "cancelled");
  });
});

test("manual attachment replies recheck the latest inbound turn after media upload", async t => {
  const { workspace, lead } = await liveFixture(t);
  const fileId = uid(), bytes = new TextEncoder().encode("hello"); let sends = 0;
  await mutateWorkspace(workspace.id, current => { current.files!.push({ id: fileId, leadId: lead.id, name: "notes.txt", mime: "text/plain", size: bytes.length, purpose: "attachment", status: "ready", createdAt: isoNow(), objectKey: `${workspace.id}/files/${fileId}/notes.txt` }); });
  t.mock.method(S3Client.prototype, "send", async () => ({ ContentLength: bytes.length, ContentType: "text/plain", Body: { transformToWebStream: () => new Response(bytes).body! } }));
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/media")) { await mutateWorkspace(workspace.id, current => receiveMessage(current, { id: "wamid.new-during-upload", from: lead.phone.slice(1), body: "Actually, another question" })); return Response.json({ id: "444444" }); }
    sends++; throw new Error("Stale manual reply must not be sent");
  });
  const id = uid();
  await assert.rejects(() => sendReply(workspace.id, lead.id, "Here is the document", id, { fileId }), /newer incoming/);
  assert.equal(sends, 0); assert.equal((await loadWorkspace(workspace.id)).messages.find(message => message.id === id)!.status, "failed");
});

test("concurrent enquiries reserve the daily AI budget before generating or dispatching replies", async t => {
  const { workspace } = await liveFixture(t);
  await mutateWorkspace(workspace.id, current => {
    current.ai!.dailyLimit = 1;
    applyAction(current, { type: "lead.create", lead: { name: "Second student", phone: "9876543211" } });
    receiveMessage(current, { id: "wamid.second-budget", from: "919876543211", body: "Course fees?" });
    current.jobs.forEach(job => { job.dueAt = isoNow(); });
  });
  let generations = 0, sends = 0;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    if (String(input).includes("openai.com")) { generations++; return modelReply(workspace); }
    sends++; return Response.json({ messages: [{ id: "wamid.within-budget" }] });
  });
  const jobs = (await loadWorkspace(workspace.id)).jobs;
  await Promise.all(jobs.map(job => processJob(workspace.id, job.id)));
  assert.equal(generations, 1); assert.equal(sends, 1);
  const current = await loadWorkspace(workspace.id);
  assert.equal(current.jobs.filter(job => job.status === "accepted").length, 1);
  assert.equal(current.jobs.filter(job => job.status === "failed" && job.error?.includes("daily AI")).length, 1);
});

test("worker restart recovery only re-enqueues undispatched/idempotent work; manual confirmation cannot bypass ambiguity", () => {
  const workspace = createWorkspace(false);
  applyAction(workspace, { type: "lead.create", lead: { name: "Student", phone: "9876543210" } });
  const leadId = workspace.leads[0].id, old = new Date(Date.now() - 600_000).toISOString();
  const uncertain: Message = { id: uid(), leadId, direction: "outbound", body: "Uncertain", author: "AI", status: "queued", createdAt: old, dispatchedAt: old, dispatchState: "dispatching" };
  const accepted: Message = { ...uncertain, id: uid(), providerId: "wamid.known", status: "accepted", dispatchState: "accepted" };
  workspace.messages = [uncertain, accepted];
  workspace.jobs = [
    { id: uid(), leadId: "", campaignId: "", kind: "file.ingest", step: 0, status: "processing", dueAt: old, lockedAt: old, attempts: 1 },
    { id: uid(), leadId, campaignId: "", kind: "ai.reply", step: 0, status: "processing", dueAt: old, lockedAt: old, attempts: 1, messageId: uncertain.id, dispatchedAt: old },
    { id: uid(), leadId, campaignId: "", kind: "ai.reply", step: 0, status: "processing", dueAt: old, lockedAt: old, attempts: 1, messageId: accepted.id, dispatchedAt: old },
  ];
  assert.equal(recoverWorkspaceJobs(workspace), 3);
  assert.deepEqual(workspace.jobs.map(job => job.status), ["pending", "reconcile", "accepted"]);
  assert.equal(uncertain.status, "reconcile");
  assert.throws(() => applyAction(workspace, { type: "job.retry", id: workspace.jobs[1].id, confirmedNotSent: true }), /manual confirmation/);
});

test("duplicate and out-of-order inbound events preserve the latest turn; signed Business-app echo verifies coexistence", () => {
  const workspace = createWorkspace(false);
  workspace.connections = [{ id: uid(), service: "whatsapp", status: "connected", externalId: "123", label: "Business app", updatedAt: isoNow(), metadata: { coexistence: "requested" } }];
  const now = Math.floor(Date.now() / 1000);
  const event = { id: "wamid.latest", from: "919876543210", body: "Latest question", timestamp: String(now - 10) };
  receiveMessage(workspace, event);
  const lead = workspace.leads[0], latest = lead.lastInboundMessageId, pending = workspace.jobs[0].id;
  lead.unread = false;
  assert.equal(receiveMessage(workspace, event), false);
  receiveMessage(workspace, { ...event, id: "wamid.older", body: "Historical question", timestamp: String(now - 1000) });
  assert.equal(lead.lastInboundMessageId, latest); assert.equal(latestInbound(workspace, lead)!.id, latest); assert.equal(lead.unread, false);
  assert.equal(workspace.jobs.find(job => job.id === pending)!.status, "pending"); assert.equal(workspace.jobs.length, 1);
  receiveMessage(workspace, { ...event, id: "wamid.old-stop", body: "STOP", timestamp: String(now - 2000) });
  assert.equal(lead.consent, "opted_out"); assert.equal(lead.lastInboundMessageId, latest); assert.equal(workspace.jobs[0].status, "cancelled");
  lead.lastContactAt = new Date((now - 5) * 1000).toISOString();
  receiveMessage(workspace, { ...event, id: "wamid.echo", body: "Manual reply", echo: true });
  assert.equal(workspace.connections[0].metadata.coexistence, "requested");
  receiveMessage(workspace, { ...event, id: "wamid.signed-echo", body: "Manual reply", echo: true, verified: true });
  assert.equal(workspace.connections[0].metadata.coexistence, "verified"); assert.ok(workspace.connections[0].metadata.coexistenceVerifiedAt);
  assert.equal(lead.lastContactAt, new Date((now - 5) * 1000).toISOString());
});

test("voice replies transcribe bounded media, ground text, store R2 MP3 metadata and send one Meta audio message", async t => {
  const { workspace, lead, job } = await liveFixture(t, "voice");
  const incoming = new TextEncoder().encode("OggS-test-voice"), outgoing = new TextEncoder().encode("ID3-test-generated-mp3");
  const stored = new Map<string, Uint8Array>(); let outgoingPayload: Record<string, unknown> | undefined;
  t.mock.method(S3Client.prototype, "send", async (command: unknown) => {
    if (command instanceof PutObjectCommand) { assert.equal(command.input.ContentType, "audio/mpeg"); assert.equal(command.input.Metadata?.["admitflow-lead"], lead.id); stored.set(command.input.Key!, new Uint8Array(command.input.Body as Uint8Array)); return { ETag: '"audio-etag"' }; }
    if (command instanceof GetObjectCommand) { const bytes = stored.get(command.input.Key!)!; return { ContentLength: bytes.length, ContentType: "audio/mpeg", Body: { transformToWebStream: () => new Response(new Uint8Array(bytes)).body! } }; }
    throw new Error("Unexpected storage operation");
  });
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); calls.push(url);
    if (url.endsWith("/333333")) return Response.json({ url: "https://lookaside.fbsbx.com/test-audio", mime_type: "audio/ogg; codecs=opus", file_size: incoming.length });
    if (url === "https://lookaside.fbsbx.com/test-audio") return new Response(incoming);
    if (url.endsWith("/speech-to-text")) return Response.json({ text: "What are the course fees?" });
    if (url.includes("openai.com")) return modelReply(workspace);
    if (url.includes("/text-to-speech/")) return new Response(outgoing, { headers: { "content-type": "audio/mpeg" } });
    if (url.endsWith("/111111/media")) return Response.json({ id: "444444" });
    if (url.endsWith("/111111/messages")) { outgoingPayload = JSON.parse(String(init?.body)); return Response.json({ messages: [{ id: "wamid.voice" }] }); }
    throw new Error(`Unexpected provider URL: ${url}`);
  });
  assert.equal(await processJob(workspace.id, job.id), true);
  const current = await loadWorkspace(workspace.id), message = current.messages.find(item => item.direction === "outbound")!, audio = current.files!.find(item => item.id === message.fileId)!;
  assert.equal(message.status, "accepted"); assert.equal(message.mediaType, "audio"); assert.equal(audio.mime, "audio/mpeg"); assert.equal(audio.size, outgoing.length); assert.equal(audio.leadId, lead.id); assert.ok(audio.finalizedAt);
  assert.match(current.messages.find(item => item.direction === "inbound")!.body, /course fees/);
  assert.equal(outgoingPayload!.type, "audio"); assert.deepEqual(outgoingPayload!.audio, { id: "444444" }); assert.equal(outgoingPayload!.biz_opaque_callback_data, job.id);
  assert.equal(calls.filter(url => url.endsWith("/messages")).length, 1); assert.equal(current.jobs[0].status, "accepted");
});

test("voice failures prepare an observable text fallback, but a message POST timeout cannot trigger fallback delivery", async t => {
  for (const failure of ["transcription", "synthesis", "media-upload", "message-timeout"] as const) await t.test(failure, async t => {
    const { workspace, job } = await liveFixture(t, "voice");
    const audio = new TextEncoder().encode("OggS-incoming"), mp3 = new TextEncoder().encode("ID3-generated"); let sends = 0, sentType = "";
    t.mock.method(S3Client.prototype, "send", async (command: unknown) => {
      if (command instanceof PutObjectCommand) return { ETag: '"audio"' };
      if (command instanceof GetObjectCommand) return { ContentLength: mp3.length, ContentType: "audio/mpeg", Body: { transformToWebStream: () => new Response(mp3).body! } };
      throw new Error("Unexpected storage call");
    });
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/333333")) return Response.json({ url: "https://lookaside.fbsbx.com/test-audio", mime_type: "audio/ogg", file_size: audio.length });
      if (url === "https://lookaside.fbsbx.com/test-audio") return new Response(audio);
      if (url.endsWith("/speech-to-text")) return failure === "transcription" ? new Response("unavailable", { status: 503 }) : Response.json({ text: "Course fees?" });
      if (url.includes("openai.com")) return modelReply(workspace);
      if (url.includes("/text-to-speech/")) return failure === "synthesis" ? new Response("unavailable", { status: 503 }) : new Response(mp3);
      if (url.endsWith("/media")) return failure === "media-upload" ? Response.json({ error: { code: 1 } }, { status: 503 }) : Response.json({ id: "444444" });
      if (url.endsWith("/messages")) { sends++; sentType = JSON.parse(String(init?.body)).type; if (failure === "message-timeout") throw new DOMException("timed out", "TimeoutError"); return Response.json({ messages: [{ id: "wamid.fallback" }] }); }
      throw new Error("Unexpected provider request");
    });
    await processJob(workspace.id, job.id);
    const current = await loadWorkspace(workspace.id), message = current.messages.find(item => item.direction === "outbound")!;
    assert.equal(sends, 1);
    if (failure === "message-timeout") { assert.equal(message.status, "reconcile"); assert.equal(sentType, "audio"); assert.equal(current.jobs[0].status, "reconcile"); assert.equal(await processJob(workspace.id, job.id), false); assert.equal(sends, 1); }
    else { assert.equal(message.status, "accepted"); assert.equal(sentType, "text"); assert.match(message.voiceFallback!, /fallback prepared/); assert.equal(message.fileId, undefined); }
  });
});

test("audio download rejects untrusted hosts and enforces actual streaming size instead of trusting headers", async t => {
  for (const mode of ["host", "size"] as const) await t.test(mode, async t => {
    const { workspace } = await liveFixture(t, "voice");
    let downloads = 0;
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/333333")) return Response.json({ url: mode === "host" ? "https://lookaside.fbsbx.com.evil.example/audio" : "https://lookaside.fbsbx.com/audio", mime_type: "audio/ogg", file_size: 5 });
      downloads++; return new Response("OggS-more-than-five-bytes", { headers: { "content-length": "1" } });
    });
    await assert.rejects(() => transcribeMessage(workspace, workspace.messages[0]));
    assert.equal(downloads, mode === "host" ? 0 : 1);
  });
});

test("AI booking proposals wait for Google availability and keep acceptance separate from calendar synchronization", async t => {
  for (const scenario of ["free", "busy", "restart", "temporary-outage", "human-handoff"] as const) await t.test(scenario, async t => {
    const { workspace, lead, job } = await liveFixture(t);
    environment(t, { GOOGLE_CLIENT_ID: "test-client", GOOGLE_CLIENT_SECRET: "test-secret" });
    const secret = await sealSecret({ refreshToken: "test-refresh-token" }, workspace.id);
    await mutateWorkspace(workspace.id, current => { current.connections!.push({ id: uid(), service: "google", status: "connected", externalId: "google-account", label: "Calendar", updatedAt: isoNow(), secret, metadata: { calendarId: "primary" } }); });
    const slot = availableSlots(workspace)[0];
    let sends = 0, availabilityCalls = 0;
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("openai.com")) return modelReply(workspace, slot);
      if (url.endsWith("/messages")) { sends++; return Response.json({ messages: [{ id: "wamid.booking-proposal" }] }); }
      if (url.endsWith("/token")) return Response.json({ access_token: "test-google-access" });
      if (url.endsWith("/freeBusy")) {
        availabilityCalls++;
        if (scenario === "temporary-outage" && availabilityCalls === 1) return new Response("unavailable", { status: 503 });
        return Response.json({ calendars: { primary: { busy: scenario === "busy" ? [{ start: slot.startsAt, end: new Date(Date.parse(slot.startsAt) + 30 * 60000).toISOString() }] : [] } } });
      }
      throw new Error(`Unexpected provider operation: ${url}`);
    });
    assert.equal(await processJob(workspace.id, job.id), true);
    let current = await loadWorkspace(workspace.id);
    const booking = current.jobs.find(item => item.kind === "appointment.book")!;
    assert.ok(booking); assert.equal(current.appointments.length, 0);
    assert.equal(current.jobs.find(item => item.id === job.id)!.payload!.bookingState, "pending");
    assert.match(current.leads[0].nextAction, /Checking/);
    assert.equal(availabilityCalls, 0, "the synchronous reply-plan mutation cannot accept an unchecked slot");
    if (scenario === "human-handoff") {
      await mutateWorkspace(workspace.id, value => receiveMessage(value, { id: "wamid.booking-handoff", from: lead.phone.slice(1), echo: true, body: "I'll take over" }));
      assert.equal(await processJob(workspace.id, booking.id), false);
      current = await loadWorkspace(workspace.id);
      assert.equal(current.appointments.length, 0); assert.equal(availabilityCalls, 0);
      assert.equal(current.jobs.find(item => item.id === job.id)!.payload!.bookingState, "cancelled");
      return;
    }
    if (scenario === "restart") await mutateWorkspace(workspace.id, value => {
      const item = value.jobs.find(item => item.id === booking.id)!;
      Object.assign(item, { status: "processing", lockedAt: new Date(Date.now() - 600_000).toISOString(), attempts: 1 });
      recoverWorkspaceJobs(value);
      assert.equal(item.status, "pending");
    });
    await processJob(workspace.id, booking.id);
    if (scenario === "temporary-outage") {
      current = await loadWorkspace(workspace.id);
      assert.equal(current.appointments.length, 0); assert.equal(current.jobs.find(item => item.id === booking.id)!.status, "pending");
      await mutateWorkspace(workspace.id, value => { value.jobs.find(item => item.id === booking.id)!.dueAt = isoNow(); });
      await processJob(workspace.id, booking.id);
    }
    current = await loadWorkspace(workspace.id);
    const parent = current.jobs.find(item => item.id === job.id)!;
    if (scenario === "busy") {
      assert.equal(current.appointments.length, 0); assert.equal(parent.payload!.bookingState, "conflict");
      assert.equal(current.jobs.find(item => item.id === booking.id)!.status, "failed");
      assert.match(current.leads[0].nextAction, /slot is busy/);
    } else {
      assert.equal(current.appointments.length, 1); assert.equal(current.appointments[0].syncStatus, "pending");
      assert.equal(parent.payload!.bookingState, "booked"); assert.equal(parent.payload!.bookingAppointmentId, current.appointments[0].id);
      assert.equal(current.jobs.filter(item => item.kind === "calendar.sync" && item.status === "pending").length, 1);
      assert.equal(await processJob(workspace.id, booking.id), false, "a duplicate queue delivery cannot create another appointment");
    }
    assert.equal(sends, 1, "calendar checks and retries must never resend the accepted WhatsApp reply");
  });
});
