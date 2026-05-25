import { NextRequest, NextResponse } from "next/server";
import { pollJobInviteAcceptances, pollChatReplies } from "@/lib/channels/outreach-tick";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

// ─── Acceptance-poll cron ─────────────────────────────────────────────────────
//
// Runs 3× per day via Vercel cron (see vercel.json). Polls Unipile's
// "sent invitations" list for every account with INVITE_PENDING threads and
// advances any accepted threads to CONNECTED so the next outreach tick can
// send the first DM.
//
// Why not in the per-30-second outreach tick?
// The LinkedIn API (via Unipile) rate-limits list-invitations calls. Running it
// every 30 s produces ~2 800 calls/account/day and triggers automation flags.
// Unipile's own docs recommend "a few times per day with random delay."
// A 10–30 s random jitter is injected here to prevent all cron invocations
// from hitting LinkedIn at exactly the same wall-clock second across accounts.

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (
    process.env.NODE_ENV === "production" &&
    process.env.CRON_SECRET &&
    authHeader !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Random 10–30 s jitter so this cron and the worker timer never synchronise
  // on the same second across multiple accounts.
  const jitterMs = 10_000 + Math.random() * 20_000;
  await new Promise(r => setTimeout(r, jitterMs));

  const [accepted, replied] = await Promise.all([
    pollJobInviteAcceptances(),
    pollChatReplies(),
  ]);
  return NextResponse.json({ ok: true, accepted, replied });
}
