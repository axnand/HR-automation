import { auth } from "@/auth";
import { NextResponse } from "next/server";

// Routes that must remain public — no session required.
//
// /interview/*       — candidate-facing interview room (token-gated by accessToken)
// /api/interview/*   — LiveKit token mint + session status updates (called from the room)
// /api/webhooks/*    — Unipile push webhooks (bearer-token authenticated by provider)
// /api/cron/*        — Railway / Vercel cron triggers (bearer-token authenticated)
// /api/health        — uptime probe
// /api/auth/*        — Auth.js sign-in / sign-out / session endpoints
// /login             — the sign-in page itself
const PUBLIC_PREFIXES = [
  "/interview/",
  "/api/interview/",
  "/api/webhooks/",
  "/api/cron/",
  "/api/health",
  "/api/auth/",
  "/login",
];

export default auth((req) => {
  const { pathname } = req.nextUrl;

  const isPublic = PUBLIC_PREFIXES.some(prefix => pathname.startsWith(prefix));
  if (isPublic) return NextResponse.next();

  // Unauthenticated — redirect to login, preserving the intended destination.
  if (!req.auth) {
    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set("callbackUrl", req.url);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
});

export const config = {
  // Run on every route except Next.js internals and static assets.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
