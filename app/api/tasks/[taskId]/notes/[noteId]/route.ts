import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ taskId: string; noteId: string }> },
) {
  try {
    const { taskId, noteId } = await params;
    const { body } = await req.json() as { body: string };

    if (!body?.trim()) {
      return NextResponse.json({ error: "body is required" }, { status: 400 });
    }

    const note = await prisma.note.update({
      where: { id: noteId, taskId },
      data: { body: body.trim() },
    });

    return NextResponse.json({ note });
  } catch (error) {
    console.error("[Notes] PATCH failed:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ taskId: string; noteId: string }> },
) {
  try {
    const { taskId, noteId } = await params;

    await prisma.note.delete({
      where: { id: noteId, taskId },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[Notes] DELETE failed:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
