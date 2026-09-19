import { createHash } from "node:crypto";
import type { Article } from "../domain";

export const CHUNK_SIZE = 1800;
export function articleChunks(article: Article) {
  const body = article.body.replace(/\r\n/g, "\n").trim();
  const chunks: { ordinal: number; title: string; body: string; version: number; contentHash: string }[] = [];
  for (let start = 0; start < body.length; ) {
    const end = Math.min(start + CHUNK_SIZE, body.length);
    const boundary = end < body.length ? Math.max(body.lastIndexOf("\n", end), body.lastIndexOf(". ", end)) : end;
    const stop = boundary > start + CHUNK_SIZE / 2 ? boundary + (body[boundary] === "." ? 1 : 0) : end;
    const text = body.slice(start, stop).trim();
    if (text) chunks.push({ ordinal: chunks.length, title: article.title, body: text, version: article.version || 1, contentHash: createHash("sha256").update(`${article.title}\n${text}`).digest("hex") });
    if (stop === body.length) break;
    start = Math.max(start + 1, stop - 180);
  }
  return chunks;
}

export function lexicalSources(articles: Article[], query: string, limit = 6) {
  const words = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || [])].slice(0, 32);
  return articles.flatMap(article => articleChunks(article).map(chunk => ({ id: article.id, title: chunk.title, body: chunk.body,
    rank: words.reduce((rank, word) => rank + (chunk.title.toLowerCase().includes(word) ? 3 : 0) + (chunk.body.toLowerCase().includes(word) ? 1 : 0), 0), ordinal: chunk.ordinal })))
    .filter(chunk => chunk.rank > 0 || words.length === 0).sort((a, b) => b.rank - a.rank || a.id.localeCompare(b.id) || a.ordinal - b.ordinal).slice(0, limit)
    .map(({ id, title, body }) => ({ id, title, body }));
}
