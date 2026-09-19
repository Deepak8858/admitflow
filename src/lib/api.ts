import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { AppError } from "./errors";
import { sameOrigin, readLimitedText } from "./http";

export function apiError(error: unknown) {
  if (error instanceof AppError) return NextResponse.json({ error: error.message, ...(error.code ? { code: error.code } : {}) }, { status: error.status });
  if (error instanceof z.ZodError) return NextResponse.json({ error: error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ") }, { status: 400 });
  if (error instanceof SyntaxError) return NextResponse.json({ error: "The request could not be read." }, { status: 400 });
  console.error("AdmitFlow request failed", error instanceof Error ? error.name : "Unknown error");
  return NextResponse.json({ error: "The request could not be completed. Check the service configuration and retry." }, { status: 500 });
}
export async function readAction(request: NextRequest, maxBytes = 4_000_000) {
  if (!sameOrigin(request)) throw new AppError("Origin not allowed.", 403);
  const contentType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (contentType && contentType !== "application/json") throw new AppError("Use an application/json request body.", 415);
  const text = await readLimitedText(request, maxBytes);
  return z.record(z.string(), z.unknown()).parse(JSON.parse(text));
}
