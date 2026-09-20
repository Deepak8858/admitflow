import OpenAI from "openai";
import { and, eq, inArray, sql, desc } from "drizzle-orm";
import { tenantTransaction } from "./repository";
import { knowledgeChunks, articles, organizations } from "./schema";
import { articleChunks, lexicalSources } from "./chunks";
import { type Workspace, uid } from "../domain";
import { productionDatabase } from "../config";
import { credentials } from "../connections";
import { loadWorkspace } from "../store";
import { assert } from "../errors";
import { requirePaidCapability } from "../subscription-access";
import { SubscriptionRestricted } from "../subscription-policy";

export interface KnowledgeResult { sources: { id: string; title: string; body: string }[]; retrievalMode: "keyword" | "full-text" | "vector"; retrievalNote?: string }
const EMBEDDING_MODEL = "text-embedding-3-small";
const DIMENSIONS = 1536;
export async function vectorAvailable(workspaceId: string) {
  return tenantTransaction(workspaceId, async tx => {
    const result = await tx.execute(sql`select exists(select 1 from pg_extension where extname = 'vector') and exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'knowledge_chunks' and column_name = 'embedding') as available`);
    return result.rows[0]?.available === true;
  });
}
async function ensureChunks(workspaceId: string, articleIds: string[]) {
  const ids = [...new Set(articleIds)].sort();
  if (!ids.length) return;
  return tenantTransaction(workspaceId, async tx => {
    const indexed = await tx.selectDistinct({ id: knowledgeChunks.articleId }).from(knowledgeChunks).where(and(eq(knowledgeChunks.organizationId, workspaceId), inArray(knowledgeChunks.articleId, ids)));
    const existingIds = new Set(indexed.map(article => article.id));
    const missing = ids.filter(id => !existingIds.has(id));
    if (!missing.length) return;
    // Match aggregate writers' tenant-first lock order before locking article rows.
    await tx.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, workspaceId)).for("update");
    const locked = await tx.select().from(articles).where(and(eq(articles.organizationId, workspaceId), inArray(articles.id, missing))).orderBy(articles.id).for("update");
    // Another backfill/edit may have won while locks were pending. Never replace its chunks.
    const indexedAfterLock = await tx.selectDistinct({ id: knowledgeChunks.articleId }).from(knowledgeChunks).where(and(eq(knowledgeChunks.organizationId, workspaceId), inArray(knowledgeChunks.articleId, missing)));
    const present = new Set(indexedAfterLock.map(article => article.id));
    const batch: (typeof knowledgeChunks.$inferInsert)[] = [];
    for (const article of locked) {
      if (present.has(article.id)) continue;
      for (const chunk of articleChunks({ ...article, fileId: article.fileId || undefined })) {
        batch.push({ ...chunk, id: uid(), organizationId: workspaceId, articleId: article.id });
        if (batch.length === 100) { await tx.insert(knowledgeChunks).values(batch); batch.length = 0; }
      }
    }
    if (batch.length) await tx.insert(knowledgeChunks).values(batch);
  });
}
function vectorLiteral(vector: number[]) {
  assert(vector.length === DIMENSIONS && vector.every(Number.isFinite), "The embedding provider returned an invalid vector.", 502);
  return `[${vector.join(",")}]`;
}
export async function indexKnowledgeEmbeddings(workspaceId: string, articleId: string) {
  const workspace = await loadWorkspace(workspaceId);
  if (workspace.demo || !productionDatabase()) return { retrievalMode: "keyword", retrievalNote: "Local keyword retrieval; no provider calls." };
  await ensureChunks(workspaceId, [articleId]);
  if (process.env.KNOWLEDGE_VECTOR_ENABLED !== "true") return { retrievalMode: "full-text", retrievalNote: "Vector indexing is not enabled." };
  if (!(await vectorAvailable(workspaceId))) return { retrievalMode: "full-text", retrievalNote: "The optional pgvector migration is not installed; full-text retrieval is active." };
  const chunks = await tenantTransaction(workspaceId, tx => tx.select({ id: knowledgeChunks.id, title: knowledgeChunks.title, body: knowledgeChunks.body, contentHash: knowledgeChunks.contentHash }).from(knowledgeChunks).where(and(eq(knowledgeChunks.organizationId, workspaceId), eq(knowledgeChunks.articleId, articleId), sql`embedding is null`)));
  if (!chunks.length) return { retrievalMode: "vector" };
  const { apiKey } = await credentials(workspace, "openai");
  const client = new OpenAI({ apiKey, timeout: 30000, maxRetries: 0 });
  // A bounded batch also limits provider response memory and retry cost.
  for (let offset = 0; offset < chunks.length; offset += 32) {
    const batch = chunks.slice(offset, offset + 32);
    await requirePaidCapability(workspaceId);
    const result = await client.embeddings.create({ model: EMBEDDING_MODEL, dimensions: DIMENSIONS, input: batch.map(chunk => `${chunk.title}\n${chunk.body}`) });
    assert(result.data.length === batch.length && new Set(result.data.map(item => item.index)).size === batch.length, "The embedding provider returned an incomplete batch.", 502);
    await tenantTransaction(workspaceId, async tx => {
      for (const item of result.data) {
        const chunk = batch[item.index]; assert(chunk, "The embedding provider returned an invalid index.", 502);
        const vector = vectorLiteral(item.embedding);
        // An edit/delete during the provider call invalidates the old chunk ID or
        // hash. Never attach stale vectors to a new document version.
        await tx.execute(sql`update knowledge_chunks set embedding = ${vector}::vector, embedding_model = ${EMBEDDING_MODEL} where organization_id = ${workspaceId} and id = ${chunk.id} and content_hash = ${chunk.contentHash}`);
      }
    });
  }
  return { retrievalMode: "vector" };
}
export async function retrieveKnowledge(workspace: Workspace, query: string): Promise<KnowledgeResult> {
  const allowed = workspace.articles.filter(article => !article.fileId || workspace.files?.some(file => file.id === article.fileId && file.purpose === "knowledge" && !file.leadId && file.status === "ready"));
  if (workspace.demo || !productionDatabase()) return { sources: lexicalSources(allowed, query), retrievalMode: "keyword" };
  const ids = allowed.map(article => article.id);
  if (!ids.length) return { sources: [], retrievalMode: "full-text" };
  await ensureChunks(workspace.id, ids);
  const search = (query.match(/[\p{L}\p{N}]{2,}/gu) || []).slice(0, 32).join(" OR ");
  const fallback = await tenantTransaction(workspace.id, async tx => {
    const rank = sql<number>`ts_rank_cd(${knowledgeChunks.search}, websearch_to_tsquery('english', ${search}))`;
    const rows = await tx.select({ id: knowledgeChunks.articleId, title: knowledgeChunks.title, body: knowledgeChunks.body }).from(knowledgeChunks).where(and(eq(knowledgeChunks.organizationId, workspace.id), inArray(knowledgeChunks.articleId, ids), sql`${knowledgeChunks.search} @@ websearch_to_tsquery('english', ${search})`)).orderBy(desc(rank), knowledgeChunks.articleId, knowledgeChunks.ordinal).limit(6);
    return { sources: rows, retrievalMode: "full-text" as const };
  });
  if (process.env.KNOWLEDGE_VECTOR_ENABLED !== "true") return fallback;
  if (!(await vectorAvailable(workspace.id))) return { ...fallback, retrievalNote: "pgvector is unavailable; full-text retrieval was used." };
  const indexed = await tenantTransaction(workspace.id, tx => tx.select({ id: knowledgeChunks.id }).from(knowledgeChunks).where(and(eq(knowledgeChunks.organizationId, workspace.id), inArray(knowledgeChunks.articleId, ids), eq(knowledgeChunks.embeddingModel, EMBEDDING_MODEL), sql`embedding is not null`)).limit(1));
  if (!indexed.length) return { ...fallback, retrievalNote: "Embeddings are not indexed yet; full-text retrieval was used." };
  try {
    const { apiKey } = await credentials(workspace, "openai");
    await requirePaidCapability(workspace.id);
    const embedding = await new OpenAI({ apiKey, timeout: 15000, maxRetries: 0 }).embeddings.create({ model: EMBEDDING_MODEL, dimensions: DIMENSIONS, input: query.slice(0, 4000) || "Admissions course information" });
    const vector = vectorLiteral(embedding.data[0]?.embedding || []);
    const rows = await tenantTransaction(workspace.id, tx => tx.select({ id: knowledgeChunks.articleId, title: knowledgeChunks.title, body: knowledgeChunks.body }).from(knowledgeChunks).where(and(eq(knowledgeChunks.organizationId, workspace.id), inArray(knowledgeChunks.articleId, ids), eq(knowledgeChunks.embeddingModel, EMBEDDING_MODEL), sql`embedding is not null`)).orderBy(sql`embedding <=> ${vector}::vector`, knowledgeChunks.id).limit(6));
    return { sources: rows, retrievalMode: "vector" };
  } catch (error) { if (error instanceof SubscriptionRestricted) throw error; return { ...fallback, retrievalNote: "Vector lookup was unavailable; full-text retrieval was used." }; }
}
