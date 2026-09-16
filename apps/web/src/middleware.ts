import { NextResponse, type NextRequest } from "next/server";

/**
 * Per-request nonce CSP. Next.js picks the nonce up from the request's CSP
 * header for its own inline scripts; our theme script reads it via x-nonce.
 */
export function middleware(request: NextRequest) {
  // one canonical host: auth cookies are per-host, so www and the bare domain
  // would otherwise be two separate sign-ins
  const host = request.headers.get("host") ?? "";
  if (host.startsWith("www.")) {
    const { pathname, search } = request.nextUrl;
    return NextResponse.redirect(new URL(`${pathname}${search}`, `https://${host.slice(4)}`), 308);
  }

  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const isDev = process.env.NODE_ENV !== "production";

  const csp = [
    "default-src 'self'",
    // strict-dynamic: every script needs the nonce, loaded scripts inherit trust
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'", // next/font + Radix runtime styles
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' https://*.supabase.co wss://*.supabase.co${
      isDev ? " http://127.0.0.1:* ws://127.0.0.1:* http://localhost:* ws://localhost:*" : ""
    }`,
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("content-security-policy", csp);
  return response;
}

export const config = {
  matcher: [
    // Everything except static assets — API routes stay covered.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
