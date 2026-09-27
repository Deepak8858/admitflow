import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { register, login, endSession, createDemo, checkAuthRate } from "@/lib/store";
import { publicWorkspace } from "@/lib/integrations";
import { cookieOptions, sameOrigin } from "@/lib/http";
import { apiError, readAction } from "@/lib/api";
import { productionDatabase } from "@/lib/config";
import { AppError } from "@/lib/errors";

export const runtime = "nodejs";
const authFields = z.object({ type: z.enum(["register", "login"]), email: z.email().max(200).transform(value => value.toLowerCase()), password: z.string().min(10).max(200), name: z.string().trim().min(1).max(100).optional(), institute: z.string().trim().min(1).max(100).optional() });
export async function POST(request: NextRequest) {
  if (!request.headers.get("origin") || !sameOrigin(request)) return NextResponse.json({ error: "Origin not allowed." }, { status: 403 });
  if (productionDatabase()) return apiError(new AppError("Local authentication is unavailable. Use WorkOS to sign in or out.", 403));
  let fields: z.infer<typeof authFields> | { type: "logout" };
  try {
    const input = await readAction(request);
    fields = input.type === "logout" ? { type: "logout" } : authFields.parse(input);
  } catch (error) { return apiError(error); }
  try {
    if (fields.type === "logout") {
      const old = request.cookies.get("admitflow_session")?.value;
      if (old) endSession(old);
      const result = createDemo();
      const response = NextResponse.json(publicWorkspace(result.workspace));
      response.cookies.set("admitflow_session", result.token, cookieOptions(request));
      return response;
    }
    checkAuthRate(fields.email);
    const result = fields.type === "register" ? register(fields.email, fields.password, fields.name || "Owner", fields.institute || "My institute") : login(fields.email, fields.password);
    const old = request.cookies.get("admitflow_session")?.value;
    if (old) endSession(old);
    const response = NextResponse.json(publicWorkspace(result.workspace));
    response.cookies.set("admitflow_session", result.token, cookieOptions(request));
    return response;
  } catch (error) {
    // Syntax/Zod errors here describe internal state, not the already-validated request.
    return apiError(error instanceof AppError ? error : new Error("Local authentication failed."));
  }
}
