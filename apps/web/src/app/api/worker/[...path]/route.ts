import { NextResponse, type NextRequest } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";

/**
 * Authenticated proxy to the relay worker's admin API.
 * Only dashboard admins may pass; the worker token never reaches the browser.
 */

const ALLOWED = [
  /^health$/,
  /^login\/start$/,
  /^login\/[0-9a-f-]{36}$/,
  /^login\/[0-9a-f-]{36}\/(code|password)$/,
  /^accounts\/bot$/,
  /^channels\/(resolve|join)$/,
  /^forwards\/retry$/,
  /^alerts\/test$/,
  /^sim\/(post|edit|delete|fail)$/,
];

async function proxy(req: NextRequest, path: string[]): Promise<NextResponse> {
  const joined = path.join("/");
  if (!ALLOWED.some((re) => re.test(joined))) {
    return NextResponse.json({ error: "path not allowed" }, { status: 404 });
  }

  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) {
    return NextResponse.json({ error: "not signed in" }, { status: 401 });
  }
  const { data: member } = await supabase
    .from("app_members")
    .select("role")
    .eq("email", user.email.toLowerCase())
    .maybeSingle();
  if (member?.role !== "admin") {
    return NextResponse.json({ error: "admin access required" }, { status: 403 });
  }

  const workerUrl = process.env.WORKER_URL;
  const workerToken = process.env.WORKER_API_TOKEN;
  if (!workerUrl || !workerToken) {
    return NextResponse.json(
      { error: "worker is not configured (WORKER_URL / WORKER_API_TOKEN)" },
      { status: 503 },
    );
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${workerUrl}/${joined}`, {
      method: req.method,
      headers: {
        authorization: `Bearer ${workerToken}`,
        "content-type": "application/json",
      },
      body: req.method === "POST" ? await req.text() : undefined,
      signal: AbortSignal.timeout(30_000),
      cache: "no-store",
    });
  } catch {
    return NextResponse.json(
      { error: "relay worker is unreachable — is it running?" },
      { status: 502 },
    );
  }

  const body = await upstream.text();
  return new NextResponse(body, {
    status: upstream.status,
    headers: { "content-type": "application/json" },
  });
}

export async function GET(req: NextRequest, ctx: RouteContext<"/api/worker/[...path]">) {
  const { path } = await ctx.params;
  return proxy(req, path);
}

export async function POST(req: NextRequest, ctx: RouteContext<"/api/worker/[...path]">) {
  const { path } = await ctx.params;
  return proxy(req, path);
}
