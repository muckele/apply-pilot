import { NextRequest, NextResponse } from "next/server";

// The companion sign-in page and its code exchange must work without a session: they are
// how the companion's automated window, which Google refuses, gets one.
const publicPagePaths = new Set(["/", "/login", "/signup", "/companion-sign-in"]);

const publicApiPrefixes = [
  "/api/auth",
  "/api/companion-sign-in",
  "/api/health",
  "/api/gmail/callback",
  "/api/cron/job-discovery"
];

function hasSessionCookie(request: NextRequest) {
  return [
    "authjs.session-token",
    "__Secure-authjs.session-token",
    "next-auth.session-token",
    "__Secure-next-auth.session-token"
  ].some((name) => Boolean(request.cookies.get(name)?.value));
}

function isPublicPath(pathname: string) {
  return (
    publicPagePaths.has(pathname) ||
    publicApiPrefixes.some((prefix) =>
      pathname === prefix || pathname.startsWith(`${prefix}/`)
    ) ||
    (pathname.startsWith("/api/interviews/") && pathname.endsWith("/audio/upload"))
  );
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (
    isPublicPath(pathname) ||
    pathname.startsWith("/_next") ||
    pathname === "/favicon.ico" ||
    pathname === "/robots.txt"
  ) {
    return NextResponse.next();
  }

  if (process.env.NODE_ENV !== "production" && process.env.ALLOW_DEMO_USER === "true") {
    return NextResponse.next();
  }

  if (hasSessionCookie(request)) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: 401, headers: { "Cache-Control": "private, no-store" } }
    );
  }

  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("callbackUrl", request.nextUrl.pathname + request.nextUrl.search);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"]
};
