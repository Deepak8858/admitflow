import { createHash } from "node:crypto";
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, CopyObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { assert } from "./errors";
import { type Workspace, type WorkspaceFile, uid, isoNow } from "./domain";
import { loadWorkspace, mutateWorkspace } from "./store";
import { assertFileAccess, assertLeadAccess } from "./permissions";
import { readLimitedBytes } from "./http";

type Actor = NonNullable<Workspace["actor"]>;
export function storageConfigured() { return Boolean(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET); }
let storageClient: { fingerprint: string; client: S3Client } | undefined;
function storage() {
  if (!storageConfigured()) storageClient = undefined;
  assert(storageConfigured(), "Configure Cloudflare R2 to upload files.", 503);
  const fingerprint = createHash("sha256").update(JSON.stringify([process.env.R2_ACCOUNT_ID, process.env.R2_ACCESS_KEY_ID, process.env.R2_SECRET_ACCESS_KEY, process.env.R2_BUCKET])).digest("hex");
  if (storageClient?.fingerprint !== fingerprint) storageClient = { fingerprint, client: new S3Client({ region: "auto", endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID!, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY! } }) };
  return storageClient.client;
}
export const MAX_FILE_SIZE = 10_000_000;
export const FILE_TYPES = ["application/pdf", "text/plain", "text/csv", "image/jpeg", "image/png", "image/webp", "audio/mpeg", "audio/ogg", "audio/mp4", "audio/webm", "audio/wav", "audio/aac", "audio/amr"];
const filename = (name: string) => name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "file";
function validateInput(input: Pick<WorkspaceFile, "name" | "size" | "mime" | "purpose" | "leadId">) {
  assert(Number.isSafeInteger(input.size) && input.size > 0 && input.size <= MAX_FILE_SIZE && FILE_TYPES.includes(input.mime), "Choose a supported file smaller than 10 MB.");
  assert(input.name.trim().length > 0 && input.name.length <= 160, "Choose a valid filename.");
  if (input.purpose === "attachment") assert(input.leadId, "Choose the enquiry for this attachment.");
  if (input.purpose === "knowledge") assert(["application/pdf", "text/plain", "text/csv"].includes(input.mime) && !input.leadId, "Knowledge uploads must be institute-wide PDF or text documents.");
  if (input.purpose === "import") assert(["text/csv", "text/plain"].includes(input.mime), "Imports must be CSV or text files.");
}
function checkFile(workspace: Workspace, file: WorkspaceFile | undefined, actor?: Actor, upload = false): asserts file is WorkspaceFile & { objectKey: string } {
  assert(!workspace.demo, "Demo workspaces do not access live storage.", 409);
  assert(file?.objectKey && file.objectKey.startsWith(`${workspace.id}/`), "File not found.", 404);
  if (file.leadId) assert(workspace.leads.some(lead => lead.id === file.leadId), "Enquiry not found.", 404);
  if (actor) assertFileAccess(workspace, actor, file, upload);
}

/** Header matching alone is insufficient for documents subsequently parsed or sent. */
export function validateFileBytes(bytes: Uint8Array, mime: string, size: number) {
  assert(bytes.length === size && size > 0 && size <= MAX_FILE_SIZE, "The uploaded file does not match its declared size.");
  const prefix = Buffer.from(bytes.subarray(0, 16));
  const ascii = prefix.toString("latin1");
  let valid = false;
  if (mime === "application/pdf") valid = ascii.startsWith("%PDF-");
  else if (mime === "image/png") valid = prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  else if (mime === "image/jpeg") valid = prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff;
  else if (mime === "image/webp") valid = ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP";
  else if (mime === "audio/ogg") valid = ascii.startsWith("OggS");
  else if (mime === "audio/mpeg") valid = ascii.startsWith("ID3") || (prefix[0] === 0xff && (prefix[1] & 0xe0) === 0xe0);
  else if (mime === "audio/mp4") valid = ascii.slice(4, 8) === "ftyp";
  else if (mime === "audio/webm") valid = prefix.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  else if (mime === "audio/wav") valid = ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WAVE";
  else if (mime === "audio/aac") valid = prefix[0] === 0xff && (prefix[1] & 0xf6) === 0xf0;
  else if (mime === "audio/amr") valid = ascii.startsWith("#!AMR\n") || ascii.startsWith("#!AMR-WB\n");
  else if (["text/plain", "text/csv"].includes(mime)) {
    try { valid = !new TextDecoder("utf-8", { fatal: true }).decode(bytes).includes("\0"); } catch { valid = false; }
  }
  assert(valid, "The file contents do not match the declared type.");
}

export async function beginUpload(workspaceId: string, input: Pick<WorkspaceFile, "name" | "size" | "mime" | "purpose" | "leadId">, actor?: Actor) {
  validateInput(input);
  const workspace = await loadWorkspace(workspaceId);
  assert(!workspace.demo, "R2 uploads are available in a connected institute workspace.", 409);
  if (input.leadId) {
    if (actor) assertLeadAccess(workspace, actor, input.leadId);
    else assert(workspace.leads.some(lead => lead.id === input.leadId), "Enquiry not found.", 404);
  }
  const id = uid(), objectKey = `${workspaceId}/pending/${id}/${filename(input.name)}`;
  const file: WorkspaceFile = { ...input, id, objectKey, status: "pending", createdAt: isoNow(), uploadedBy: actor?.id };
  if (actor) assertFileAccess(workspace, actor, file, true);
  const metadata = { "admitflow-workspace": workspaceId, "admitflow-file": id };
  const url = await getSignedUrl(storage(), new PutObjectCommand({ Bucket: process.env.R2_BUCKET!, Key: objectKey, ContentType: input.mime, ContentLength: input.size, Metadata: metadata }), { expiresIn: 300, unhoistableHeaders: new Set(["x-amz-meta-admitflow-workspace", "x-amz-meta-admitflow-file"]), signableHeaders: new Set(["content-type"]) });
  await mutateWorkspace(workspaceId, current => { if (actor) assertFileAccess(current, actor, file, true); current.files!.push(file); });
  return { id, url, headers: { "Content-Type": input.mime, "x-amz-meta-admitflow-workspace": workspaceId, "x-amz-meta-admitflow-file": id }, expiresAt: new Date(Date.now() + 300_000).toISOString() };
}

async function objectBytes(file: WorkspaceFile & { objectKey: string }, etag = file.etag) {
  const response = await storage().send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET!, Key: file.objectKey, ...(etag ? { IfMatch: etag } : {}) }), { abortSignal: AbortSignal.timeout(30_000) });
  assert(response.ContentLength === file.size && response.ContentType === file.mime && response.Body, "The stored file does not match its metadata.");
  const bytes = await readLimitedBytes({ body: response.Body.transformToWebStream() as ReadableStream<Uint8Array>, headers: new Headers({ "content-length": String(response.ContentLength) }) }, Math.min(file.size, MAX_FILE_SIZE));
  validateFileBytes(bytes, file.mime, file.size);
  return bytes;
}
export async function finishUpload(workspaceId: string, id: string, actor?: Actor) {
  const workspace = await loadWorkspace(workspaceId), file = workspace.files!.find(item => item.id === id);
  checkFile(workspace, file, actor, true);
  if (file.status === "ready" && file.finalizedAt) return { workspace, result: { id } };
  assert(file.status === "pending", "This upload cannot be finalized again.", 409);
  const head = await storage().send(new HeadObjectCommand({ Bucket: process.env.R2_BUCKET!, Key: file.objectKey }), { abortSignal: AbortSignal.timeout(30_000) });
  assert(head.ContentLength === file.size && head.ContentType === file.mime && head.ETag && head.Metadata?.["admitflow-workspace"] === workspaceId && head.Metadata?.["admitflow-file"] === id, "The uploaded file does not match its declared size, type or workspace.");
  await objectBytes(file, head.ETag);
  // The upload URL remains valid for five minutes. Freeze a checked version at a
  // different key so replaying PUT can never replace a finalized attachment.
  const objectKey = `${workspaceId}/files/${id}/${uid()}/${filename(file.name)}`;
  const copied = await storage().send(new CopyObjectCommand({ Bucket: process.env.R2_BUCKET!, Key: objectKey, CopySource: `${process.env.R2_BUCKET!}/${file.objectKey.split("/").map(encodeURIComponent).join("/")}`, CopySourceIfMatch: head.ETag, ContentType: file.mime, MetadataDirective: "REPLACE", Metadata: { "admitflow-workspace": workspaceId, "admitflow-file": id } }), { abortSignal: AbortSignal.timeout(30_000) });
  assert(copied.CopyObjectResult?.ETag, "Storage did not confirm upload finalization.", 502);
  return mutateWorkspace(workspaceId, current => {
    const uploaded = current.files!.find(item => item.id === id);
    checkFile(current, uploaded, actor, true);
    if (uploaded.status === "ready" && uploaded.finalizedAt) return { id };
    assert(uploaded.status === "pending" && uploaded.objectKey === file.objectKey && uploaded.size === file.size && uploaded.mime === file.mime, "The upload changed during finalization.", 409);
    Object.assign(uploaded, { status: "ready", objectKey, etag: copied.CopyObjectResult!.ETag, finalizedAt: isoNow(), error: undefined });
    if (uploaded.purpose === "knowledge" && !current.jobs.some(job => job.kind === "file.ingest" && job.payload?.fileId === id)) current.jobs.push({ id: uid(), leadId: "", campaignId: "", kind: "file.ingest", step: 0, dueAt: isoNow(), status: "pending", payload: { fileId: id } });
    return { id };
  });
}
export async function downloadUrl(workspaceId: string, id: string, actor?: Actor) {
  const workspace = await loadWorkspace(workspaceId), file = workspace.files!.find(item => item.id === id && item.status === "ready");
  checkFile(workspace, file, actor);
  return getSignedUrl(storage(), new GetObjectCommand({ Bucket: process.env.R2_BUCKET!, Key: file.objectKey, ResponseContentDisposition: `attachment; filename="${filename(file.name)}"` }), { expiresIn: 180 });
}
export async function readFileBytes(workspaceId: string, id: string, actor?: Actor) {
  const workspace = await loadWorkspace(workspaceId), file = workspace.files!.find(item => item.id === id && item.status === "ready");
  checkFile(workspace, file, actor);
  assert(file.size <= MAX_FILE_SIZE, "File exceeds the upload limit.");
  return { file, bytes: Buffer.from(await objectBytes(file)) };
}
export async function saveGeneratedAudio(workspaceId: string, leadId: string, bytes: Uint8Array, id = uid()) {
  const workspace = await loadWorkspace(workspaceId);
  assert(!workspace.demo, "Demo workspaces do not generate live audio.", 409);
  assert(workspace.leads.some(lead => lead.id === leadId), "Enquiry not found.", 404);
  validateFileBytes(bytes, "audio/mpeg", bytes.length);
  const existing = workspace.files!.find(file => file.id === id);
  if (existing) { assert(existing.leadId === leadId && existing.purpose === "attachment", "Audio ID already in use.", 409); if (existing.status === "ready") return existing; }
  const objectKey = `${workspaceId}/files/${id}/${uid()}/assistant-reply.mp3`;
  const response = await storage().send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET!, Key: objectKey, Body: bytes, ContentType: "audio/mpeg", ContentLength: bytes.length, Metadata: { "admitflow-workspace": workspaceId, "admitflow-file": id, "admitflow-lead": leadId, "admitflow-source": "elevenlabs" } }), { abortSignal: AbortSignal.timeout(30_000) });
  assert(response.ETag, "Storage did not confirm generated audio.", 502);
  const file: WorkspaceFile = { id, leadId, objectKey, name: "assistant-reply.mp3", mime: "audio/mpeg", size: bytes.length, purpose: "attachment", status: "ready", createdAt: isoNow(), finalizedAt: isoNow(), etag: response.ETag };
  const saved = await mutateWorkspace(workspaceId, current => {
    assert(current.leads.some(lead => lead.id === leadId), "Enquiry not found.", 404);
    const previous = current.files!.find(item => item.id === id);
    if (previous) {
      assert(previous.leadId === leadId, "Audio ID already in use.", 409);
      if (previous.status === "ready") return previous;
      Object.assign(previous, file);
    } else current.files!.push(file);
    return file;
  });
  return saved.result;
}
export async function ingestDocument(workspaceId: string, id: string) {
  const { file, bytes } = await readFileBytes(workspaceId, id);
  assert(file.purpose === "knowledge" && !file.leadId, "Only institute knowledge documents can be indexed.");
  let text = "";
  if (file.mime === "application/pdf") {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: bytes });
    try { text = (await parser.getText()).text; } finally { await parser.destroy(); }
  } else if (["text/plain", "text/csv"].includes(file.mime)) text = bytes.toString("utf8");
  assert(text.trim(), "This document has no readable text. Upload a text PDF or a text file.");
  await mutateWorkspace(workspaceId, workspace => {
    if (workspace.articles.some(article => article.fileId === id)) return;
    const articleId = uid();
    workspace.articles.unshift({ id: articleId, fileId: id, title: file.name, category: "Documents", body: text.slice(0, 60000), updatedAt: isoNow(), version: 1 });
    workspace.jobs.push({ id: uid(), leadId: "", campaignId: "", kind: "knowledge.index", step: 0, dueAt: isoNow(), status: "pending", payload: { articleId } });
  });
}
