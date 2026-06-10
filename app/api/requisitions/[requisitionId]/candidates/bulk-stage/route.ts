// ─── Bulk drag/drop endpoint ─────────────────────────────────────────────────
//
// P1 #47 / EC-11.17 — recruiter selects N candidates and moves them all to
// the same target stage in one action. Each task is processed in its own
// transaction (via applyStageTransition) so partial failures don't block
// the rest. The response carries per-task outcomes so the UI can revert
// only the cards that failed.
//
// Body:
//   {
//     taskIds: string[],
//     stage: CandidateStage,
//     reason?: string,
//     expected?: { [taskId]: string }   // optional per-task If-Match (stageUpdatedAt)
//   }
//
// Response (always 200; per-task `ok` flag carries the actual outcome):
//   {
//     outcomes: Array<{
//       taskId: string,
//       ok: boolean,
//       task?: { stage, manualStage, stageUpdatedAt, jobId },
//       kind?: "not_found" | "concurrency_conflict" | "transition_refused" | "internal",
//       reason?: string,
//       currentStage?, currentStageUpdatedAt?,
//     }>
//   }

import { NextRequest, NextResponse } from "next/server";
import { CandidateStage } from "@prisma/client";
import { applyStageTransition } from "@/lib/channels/stage-transition";

export const dynamic = "force-dynamic";

const VALID_STAGES = new Set<string>(Object.values(CandidateStage));

const MAX_BULK_SIZE = 500; // hard cap; UI typically operates on ≤100

interface BulkStageBody {
  taskIds?: unknown;
  stage?: unknown;
  reason?: unknown;
  notify?: unknown;
  expected?: unknown;
}

export async function POST(
  req: NextRequest,
) {
  try {
    const body = (await req.json()) as BulkStageBody;
    const { taskIds, stage, reason, notify, expected } = body;

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
    if (typeof stage !== "string" || !VALID_STAGES.has(stage)) {
      return NextResponse.json({ error: "Invalid stage" }, { status: 400 });
    }
    if (reason !== undefined && reason !== null && typeof reason !== "string") {
      return NextResponse.json({ error: "reason must be a string" }, { status: 400 });
    }
    const expectedMap: Record<string, string> = {};
    if (expected && typeof expected === "object") {
      for (const [k, v] of Object.entries(expected as Record<string, unknown>)) {
        if (typeof v === "string") expectedMap[k] = v;
      }
    }

    const toStage = stage as CandidateStage;
    const reasonStr = (reason ?? null) as string | null;
    const notifyFlag = notify !== false; // default true; suppress candidate notification when explicitly false

    // Process sequentially so a single misbehaving candidate doesn't
    // exhaust the connection pool. With ≤500 cap this is fast enough
    // (each call is one tx; ~50ms each at typical Postgres latency).
    const outcomes: Array<Record<string, unknown>> = [];
    for (const taskId of taskIds as string[]) {
      const expectedTs = expectedMap[taskId] ?? null;
      const result = await applyStageTransition({
        taskId,
        toStage,
        reason: reasonStr,
        notify: notifyFlag,
        expectedStageUpdatedAt: expectedTs,
      });

      if (result.ok) {
        outcomes.push({
          taskId,
          ok: true,
          task: {
            stage: result.task.stage,
            manualStage: result.task.manualStage,
            stageUpdatedAt: result.task.stageUpdatedAt.toISOString(),
            jobId: result.task.jobId,
          },
        });
      } else {
        const base: Record<string, unknown> = { taskId, ok: false, kind: result.kind };
        if (result.kind === "concurrency_conflict") {
          base.currentStage = result.currentStage;
          base.currentStageUpdatedAt = result.currentStageUpdatedAt;
        }
        if (result.kind === "transition_refused") {
          base.reason = result.reason;
        }
        if (result.kind === "internal") {
          base.error = result.error;
        }
        outcomes.push(base);
      }
    }

    const okCount = outcomes.filter(o => o.ok).length;
    const failCount = outcomes.length - okCount;
    return NextResponse.json({ ok: okCount, failed: failCount, outcomes });
  } catch (err) {
    console.error("[bulk-stage] failed:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
