import { NextRequest, NextResponse } from "next/server";
import { CandidateStage } from "@prisma/client";
import { applyStageTransition } from "@/lib/channels/stage-transition";

export const dynamic = "force-dynamic";

const VALID_STAGES = new Set<string>(Object.values(CandidateStage));

// PATCH /api/requisitions/:requisitionId/candidates/:taskId
//   Body: { stage: CandidateStage, reason?: string }
//   Headers: If-Match: <stageUpdatedAt-iso>  (optional optimistic concurrency)
//   Responses:
//     200 {task}                     — applied
//     400                             — invalid stage
//     404                             — task not found
//     409 {currentStage, currentStageUpdatedAt}  — If-Match mismatch
//     422 {reason}                    — transition refused (rare; current
//                                       policy allows all drags)
//     500                             — internal
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ requisitionId: string; taskId: string }> },
) {
  try {
    const { taskId } = await params;
    const body = await req.json();
    const { stage, reason, notify } = body as { stage?: string; reason?: string; notify?: boolean };

    if (!stage || !VALID_STAGES.has(stage)) {
      return NextResponse.json({ error: "Invalid stage" }, { status: 400 });
    }

    const ifMatch = req.headers.get("if-match");
    const expectedStageUpdatedAt = ifMatch ? ifMatch.replace(/^"+|"+$/g, "") : null;

    const result = await applyStageTransition({
      taskId,
      toStage: stage as CandidateStage,
      reason: reason ?? null,
      notify: notify !== false,
      expectedStageUpdatedAt,
    });

    if (result.ok) {
      return NextResponse.json(result.task, {
        headers: { ETag: `"${result.task.stageUpdatedAt.toISOString()}"` },
      });
    }

    switch (result.kind) {
      case "not_found":
        return NextResponse.json({ error: "Task not found" }, { status: 404 });
      case "concurrency_conflict":
        return NextResponse.json(
          {
            error: "stage_concurrency_conflict",
            currentStage: result.currentStage,
            currentStageUpdatedAt: result.currentStageUpdatedAt,
          },
          {
            status: 409,
            headers: { ETag: `"${result.currentStageUpdatedAt}"` },
          },
        );
      case "transition_refused":
        return NextResponse.json(
          { error: "stage_transition_refused", reason: result.reason },
          { status: 422 },
        );
      case "internal":
      default:
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
  } catch (error) {
    console.error("[Candidate Stage] PATCH failed:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
