import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// PATCH /api/tasks/:taskId/star
//   Body: { starred: boolean }
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
) {
  try {
    const { taskId } = await params;
    const { starred } = (await req.json()) as { starred: boolean };

    if (typeof starred !== "boolean") {
      return NextResponse.json({ error: "starred must be a boolean" }, { status: 400 });
    }

    const task = await prisma.task.update({
      where: { id: taskId },
      data: { starred },
      select: { id: true, starred: true },
    });

    return NextResponse.json(task);
  } catch (error: any) {
    if (error?.code === "P2025") {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }
    console.error("[Task Star] PATCH failed:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
