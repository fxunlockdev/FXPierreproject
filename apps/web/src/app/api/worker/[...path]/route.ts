import { NextResponse, type NextRequest } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";

/**
 * Authenticated proxy to the relay worker's admin API.
 * Every call runs inside one space: the caller must be an owner/admin of the
 * space named in x-space-id. The worker token never reaches the browser.
 */

const SPACE_HEADER = "x-space-id";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ALLOWED = [
  /^login\/start$/,
  /^login\/[0-9a-f-]{36}$/,
  /^login\/[0-9a-f-]{36}\/(code|password)$/,
  /^accounts\/(bot|check)$/,
  /^channels\/(resolve|join)$/,
  /^topics\/add$/,
  /^forwards\/retry$/,
  /^alerts\/test$/,
];

async function proxy(req: NextRequest, path: string[]): Promise<NextResponse> {
  const joined = path.join("/");
  if (!ALLOWED.some((re) => re.test(joined))) {
    return NextResponse.json({ error: "path not allowed" }, { status: 404 });
  }

  const spaceId = req.headers.get(SPACE_HEADER) ?? "";
  if (!UUID.test(spaceId)) {
    return NextResponse.json({ error: "missing space" }, { status: 400 });
  }

  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "not signed in" }, { status: 401 });
  }
  const { data: isAdmin, error } = await supabase.rpc("is_space_admin", { p_space: spaceId });
  if (error || isAdmin !== true) {
    return NextResponse.json({ error: "admin access to this space is required" }, { status: 403 });
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
        [SPACE_HEADER]: spaceId.toLowerCase(),
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
