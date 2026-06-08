import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { reevaluateTask, type ReevaluateResult } from "@/lib/reevaluate";

export const dynamic = "force-dynamic";

// Re-evaluate the SELECTED candidates against the current scoring rules.
// Each re-evaluation is one LLM call on the cached profile (no re-scrape), so
// we cap concurrency to stay friendly to the AI provider's rate limits.
const CONCURRENCY = 4;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ requisitionId: string }> },
) {
  const { requisitionId } = await params;
  const body = await req.json().catch(() => ({}));
  const { taskIds } = body as { taskIds?: string[] };

  if (!taskIds?.length) {
    return NextResponse.json({ error: "taskIds array is required" }, { status: 400 });
  }

  // Scope to tasks that actually belong to this requisition (prevents
  // re-evaluating arbitrary tasks via a crafted id list).
  const owned = await prisma.task.findMany({
    where: { id: { in: taskIds }, job: { requisitionId } },
    select: { id: true },
  });
  if (owned.length === 0) {
    return NextResponse.json({ error: "No valid tasks found" }, { status: 404 });
  }

  const ids = owned.map(t => t.id);
  const results: ReevaluateResult[] = [];

  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    const chunk = ids.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(chunk.map(id => reevaluateTask(id)));
    for (let j = 0; j < settled.length; j++) {
      const r = settled[j];
      if (r.status === "fulfilled") {
        results.push(r.value);
      } else {
        results.push({ taskId: chunk[j], ok: false, error: r.reason?.message ?? "Re-evaluation failed" });
      }
    }
  }

  const reevaluated = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  return NextResponse.json({ reevaluated, failed, total: ids.length, results });
}
