// ─── Bulk fan-out endpoint ───────────────────────────────────────────────────
//
// Recruiter selects N candidates and clicks "Fan out to channels". For each
// task we run fanOutToChannelsCore, which creates the missing ChannelThreads
// for every ACTIVE channel whose rules match the candidate's score — idempotent
// (safe to click repeatedly; existing threads are skipped via the
// @@unique([taskId, channelId]) constraint).
//
// This is the explicit recovery for the structural gap where a channel created
// AFTER a candidate was shortlisted never got a thread, so the worker never
// started outreach on it. Fan-out is only triggered on the *task* axis (task
// enters SHORTLISTED); this endpoint covers the *channel* axis (a channel
// added/activated later) on demand.
//
// Body:    { taskIds: string[] }
// Response (always 200; per-task `ok` carries the real outcome):
//   { created: number, ok: number, failed: number,
//     outcomes: Array<{ taskId, ok, created?, failed?, kind?, error? }> }

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveRequisitionId } from "@/lib/resolve-requisition";
import { fanOutToChannelsCore } from "@/lib/channels/fan-out";
import { triggerOutreach } from "@/lib/trigger";

export const dynamic = "force-dynamic";

const MAX_BULK_SIZE = 500; // hard cap; UI typically operates on ≤100

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ requisitionId: string }> },
) {
  try {
    const { requisitionId: rawId } = await params;
    const requisitionId = await resolveRequisitionId(rawId);

    const body = (await req.json()) as { taskIds?: unknown };
    const { taskIds } = body;

    if (!Array.isArray(taskIds) || taskIds.length === 0) {
      return NextResponse.json({ error: "taskIds must be a non-empty array" }, { status: 400 });
    }
    if (taskIds.length > MAX_BULK_SIZE) {
      return NextResponse.json(
        { error: `taskIds limit is ${MAX_BULK_SIZE}; got ${taskIds.length}` },
        { status: 400 },
      );
    }
    if (!taskIds.every(id => typeof id === "string" && id.length > 0)) {
      return NextResponse.json({ error: "taskIds must be an array of non-empty strings" }, { status: 400 });
    }

    // Scope to this requisition: refuse taskIds that belong elsewhere so the
    // endpoint can't fan out across requisitions. findMany applies the
    // soft-delete filter, so deleted tasks drop out here too and report
    // "not_found".
    const tasks = await prisma.task.findMany({
      where: { id: { in: taskIds as string[] }, job: { requisitionId } },
      select: { id: true, jobId: true },
    });
    const jobByTask = new Map(tasks.map(t => [t.id, t.jobId]));

    // Sequential so one slow task doesn't exhaust the connection pool (mirrors
    // bulk-stage). The outreach tick is triggered ONCE after the batch instead
    // of once per task — fanOutToChannelsCore deliberately does not trigger.
    let totalCreated = 0;
    const outcomes: Array<Record<string, unknown>> = [];
    for (const taskId of taskIds as string[]) {
      const jobId = jobByTask.get(taskId);
      if (!jobId) {
        outcomes.push({ taskId, ok: false, kind: "not_found" });
        continue;
      }
      try {
        const { created, failures } = await fanOutToChannelsCore(taskId, jobId);
        totalCreated += created;
        outcomes.push({ taskId, ok: failures.length === 0, created, failed: failures.length });
      } catch (err: any) {
        console.error(`[bulk-fan-out] Task ${taskId} failed:`, err);
        outcomes.push({ taskId, ok: false, kind: "internal", error: err?.message ?? String(err) });
      }
    }

    if (totalCreated > 0) triggerOutreach();

    const okCount = outcomes.filter(o => o.ok).length;
    return NextResponse.json({
      created: totalCreated,
      ok: okCount,
      failed: outcomes.length - okCount,
      outcomes,
    });
  } catch (err) {
    console.error("[bulk-fan-out] failed:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
