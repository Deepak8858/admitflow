import { timingSafeEqual } from "node:crypto";
import { NextRequest } from "next/server";
import { AppError } from "./errors";

export function cookieOptions(request: NextRequest) {
  return { httpOnly: true, secure: request.nextUrl.protocol === "https:", sameSite: "lax" as const, path: "/", maxAge: 14 * 86400 };
}
export function sameOrigin(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (!origin) return request.headers.get("sec-fetch-site") !== "cross-site";
  try {
    // nextUrl can normalise a loopback host; HTTP Host retains the browser's address.
    const source = new URL(origin);
    if (!["http:", "https:"].includes(source.protocol) || source.username || source.password || source.pathname !== "/" || source.search || source.hash) return false;
    if (process.env.APP_BASE_URL) return source.origin === new URL(process.env.APP_BASE_URL).origin;
    return source.protocol === request.nextUrl.protocol && source.host === (request.headers.get("host") || request.nextUrl.host);
  } catch { return false; }
}

export function constantTimeEqual(first: string, second: string) {
  const left = Buffer.from(first), right = Buffer.from(second);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Enforce the limit while streaming, including chunked bodies and false length headers. */
interface LimitedBody { body: ReadableStream<Uint8Array> | null; headers: Headers }
export async function readLimitedBytes(source: LimitedBody, maxBytes: number): Promise<Uint8Array> {
  const declared = source.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > maxBytes)) {
    await source.body?.cancel().catch(() => undefined);
    throw new AppError("This request is too large or has an invalid length.", 413);
  }
  if (!source.body) return new Uint8Array();
  const reader = source.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel().catch(() => undefined); throw new AppError("This request is too large.", 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
export async function readLimitedText(source: LimitedBody, maxBytes: number) {
  const bytes = await readLimitedBytes(source, maxBytes);
  // Preserve a leading BOM so signature checks cannot authenticate altered bytes.
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new AppError("The request is not valid UTF-8.", 400); }
}
