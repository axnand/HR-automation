import { NextRequest, NextResponse } from "next/server";
import { reevaluateTask } from "@/lib/reevaluate";

export const dynamic = "force-dynamic";

// Re-run the AI scorer against this task's cached profile using the current
// scoring rules. Does NOT re-scrape LinkedIn and does NOT change the pipeline
// stage — it only refreshes the score. See lib/reevaluate.ts.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ taskId: string }> }
) {
  try {
    const { taskId } = await params;
    const result = await reevaluateTask(taskId);

    if (!result.ok) {
      const status = result.error === "Task not found" ? 404 : 400;
      return NextResponse.json({ ok: false, error: result.error }, { status });
    }

    return NextResponse.json(result);
  } catch (error: any) {
    console.error("[Reevaluate] POST failed:", error);
    return NextResponse.json(
      { ok: false, error: error?.message || "Internal server error" },
      { status: 500 }
    );
  }
}
