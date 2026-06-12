import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// PATCH /api/requisitions/:requisitionId/candidates/:taskId/archive-note
//   Body: { note: string | null }
//   Updates Task.archiveNote without changing stage.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ requisitionId: string; taskId: string }> },
) {
  try {
    const { taskId } = await params;
    const { note } = await req.json() as { note?: string | null };

    const task = await prisma.task.findUnique({
      where: { id: taskId },
      select: { id: true, stage: true },
    });
    if (!task) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }
    if (task.stage !== "REJECTED" && task.stage !== "ARCHIVED") {
      return NextResponse.json({ error: "Only archived or rejected candidates can have an archive note" }, { status: 422 });
    }

    await prisma.task.update({
      where: { id: taskId },
      data: { archiveNote: note ?? null },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[archive-note] PATCH failed:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
