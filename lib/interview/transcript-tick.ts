// ─── Interview transcript tick ─────────────────────────────────────────────
//
// Polled from worker.ts (in-process setInterval) and from the cron route
// app/api/cron/interview-transcript/route.ts — mirroring runOutreachTick.
//
// Cross-process safety (worker + cron may run concurrently): this tick is fully
// IDEMPOTENT, and the final write is a guarded `updateMany` (only advances a row
// still in {SENT,IN_PROGRESS} with callId IS NULL). If both processes fetch the
// same transcript at once, exactly one update wins and the other no-ops — no
// double-advance, no clobber. We deliberately do NOT hold a Postgres advisory
// lock across the tick: CLAUDE.md forbids holding a transaction across network
// calls, and a session-scoped lock taken/released through separate Prisma calls
// is unsafe under connection pooling (acquire and release can land on different
// pooled connections, leaking the lock). The guarded write gives the same
// cross-process correctness without that fragility. The worker also guards
// against in-process overlap with a reentrancy flag.
//
// Flow:
//   1. Load pending sessions (status IN ('SENT','IN_PROGRESS'), callId IS NULL),
//      newest first, capped at BATCH_SIZE.
//   2. ONE SCAI search (§3.2) per tick — fetch recent RECRUITMENT_LIVE_TRANSCRIPT
//      calls and index by roomName. (Avoids one search per session.)
//   3. For each pending session whose call is present AND COMPLETED in its
//      statusTimeline: GET /v1/calls/{callId} (§3.3 — use callId "RM_xxx", NOT
//      the uuid `id`), store transcript JSON, advance to COMPLETED via guarded
//      updateMany.

import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";

const BATCH_SIZE = 50;
// The search page size. We pull more than BATCH_SIZE recent calls so a session
// near the back of the batch can still be matched. Pagination remains a known
// limitation: a session older than this many recent completed calls won't be
// found until newer ones age out — acceptable while interview volume is low.
const SEARCH_PAGE_SIZE = 100;
const SCAI_LOB = "hccbckinddemo";

type ScaiCallSearchResult = {
  id: string;           // uuid — NOT what we use for GET
  callId: string;       // "RM_xxx" — use this for GET /v1/calls/{callId}
  roomName: string;     // "interview_<uuid>" — matches session.roomId
  status: string;
  statusTimeline?: { statusTimelines?: Array<{ status: string; timeStamp: string }> };
};

function scaiHeaders(apiKey: string, orgId: string) {
  return {
    "Content-Type": "application/json",
    "accept": "application/json",
    "api-key": apiKey,
    "organizationId": orgId,
    "lob": SCAI_LOB,
  };
}

function isCallCompleted(call: ScaiCallSearchResult): boolean {
  const timelines = call.statusTimeline?.statusTimelines ?? [];
  // The timeline is the reliable "finished" signal — `status` may have moved on
  // to a sales-domain leftover (NOT_ORDERED/ORDERED) after COMPLETED (§3.2).
  return timelines.some(t => t.status === "COMPLETED") || call.status === "COMPLETED";
}

async function searchRecentCalls(
  baseUrl: string,
  apiKey: string,
  orgId: string,
): Promise<Map<string, ScaiCallSearchResult>> {
  const res = await fetch(`${baseUrl}/v1/calls/search`, {
    method: "POST",
    headers: scaiHeaders(apiKey, orgId),
    body: JSON.stringify({
      page: 0,
      size: SEARCH_PAGE_SIZE,
      orderBy: "created_at",
      orderDirection: "DESC",
      source: "RECRUITMENT_LIVE_TRANSCRIPT",
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`SCAI search failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const calls: ScaiCallSearchResult[] = data.content ?? [];
  const byRoom = new Map<string, ScaiCallSearchResult>();
  for (const c of calls) {
    if (c.roomName) byRoom.set(c.roomName, c);
  }
  return byRoom;
}

async function fetchCallTranscript(
  baseUrl: string,
  apiKey: string,
  orgId: string,
  callId: string,
): Promise<unknown> {
  // ⚠️ Use callId ("RM_xxx"), NOT the uuid id — GET /v1/calls/{uuid} returns 404.
  const res = await fetch(`${baseUrl}/v1/calls/${callId}`, {
    headers: scaiHeaders(apiKey, orgId),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`SCAI transcript fetch failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return res.json();
}

export async function runInterviewTranscriptTick(): Promise<{
  checked: number;
  completed: number;
  errors: number;
}> {
  const apimgmtUrl = process.env.SCAI_APIMGMT_URL;
  const apiKey = process.env.SCAI_API_KEY;
  const orgId = process.env.SCAI_ORG_ID;

  if (!apimgmtUrl || !apiKey || !orgId) {
    // Not configured — skip silently (worker may run before env vars are set).
    return { checked: 0, completed: 0, errors: 0 };
  }

  // Pending sessions awaiting their transcript. IN_PROGRESS includes sessions
  // whose candidate disconnected (PATCH stamps endedAt but leaves IN_PROGRESS).
  const sessions = await prisma.interviewSession.findMany({
    where: {
      status: { in: ["SENT", "IN_PROGRESS"] },
      callId: null,
    },
    select: { id: true, roomId: true },
    orderBy: { createdAt: "desc" },
    take: BATCH_SIZE,
  });

  if (sessions.length === 0) {
    return { checked: 0, completed: 0, errors: 0 };
  }

  let completed = 0;
  let errors = 0;

  let callsByRoom: Map<string, ScaiCallSearchResult>;
  try {
    callsByRoom = await searchRecentCalls(apimgmtUrl, apiKey, orgId);
  } catch (err: any) {
    console.error("[InterviewTranscriptTick] search failed:", err.message);
    return { checked: sessions.length, completed: 0, errors: 1 };
  }

  for (const session of sessions) {
    const call = callsByRoom.get(session.roomId);
    if (!call || !isCallCompleted(call)) continue; // not on SCAI yet / still live

    try {
      const transcript = await fetchCallTranscript(apimgmtUrl, apiKey, orgId, call.callId);

      // Guarded write: only advance a row still pending with no callId. If a
      // concurrent runner (cron vs worker) already advanced it, count=0 and we
      // skip — no double-advance, no clobber of a later status.
      const result = await prisma.interviewSession.updateMany({
        where: { id: session.id, callId: null, status: { in: ["SENT", "IN_PROGRESS"] } },
        data: {
          callId: call.callId,
          transcript: transcript as Prisma.InputJsonValue,
          status: "COMPLETED",
        },
      });
      if (result.count > 0) completed++;
    } catch (err: any) {
      errors++;
      console.error(`[InterviewTranscriptTick] session ${session.id} error:`, err.message);
    }
  }

  return { checked: sessions.length, completed, errors };
}
