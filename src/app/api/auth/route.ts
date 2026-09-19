import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { register, login, endSession, createDemo, checkAuthRate } from "@/lib/store";
import { publicWorkspace } from "@/lib/integrations";
import { cookieOptions, sameOrigin } from "@/lib/http";

export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Origin not allowed." }, { status: 403 });
  try {
    const input = await request.json();
    if (input.type === "logout") {
      const old = request.cookies.get("admitflow_session")?.value;
      if (old) endSession(old);
      const result = createDemo();
      const response = NextResponse.json(publicWorkspace(result.workspace));
      response.cookies.set("admitflow_session", result.token, cookieOptions(request));
      return response;
    }
    const fields = z.object({ type: z.enum(["register", "login"]), email: z.email().max(200).transform(value => value.toLowerCase()), password: z.string().min(10).max(200), name: z.string().trim().min(1).max(100).optional(), institute: z.string().trim().min(1).max(100).optional() }).parse(input);
    checkAuthRate(fields.email);
    const result = fields.type === "register" ? register(fields.email, fields.password, fields.name || "Owner", fields.institute || "My institute") : login(fields.email, fields.password);
    const old = request.cookies.get("admitflow_session")?.value;
    if (old) endSession(old);
    const response = NextResponse.json(publicWorkspace(result.workspace));
    response.cookies.set("admitflow_session", result.token, cookieOptions(request));
    return response;
  } catch (error) {
    return NextResponse.json({ error: error instanceof z.ZodError ? error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ") : (error as Error).message }, { status: 400 });
  }
}
