import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// GET /api/interview/sessions/[id] — resolve a session (used by the interview page).
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const session = await prisma.interviewSession.findUnique({
      where: { id },
      select: {
        id: true,
        roomId: true,
        status: true,
        startedAt: true,
        endedAt: true,
        task: { select: { candidateName: true } },
      },
    });
    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    return NextResponse.json({
      session: {
        id: session.id,
        roomId: session.roomId,
        status: session.status,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        candidateName: session.task.candidateName,
      },
    });
  } catch (err) {
    console.error("[interview/sessions/[id] GET]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// PATCH /api/interview/sessions/[id]  { ended?: true }
// Called when the candidate disconnects from the room. Stamps endedAt and keeps
// the session at IN_PROGRESS — the worker tick (runInterviewTranscriptTick) will
// advance it to COMPLETED once it fetches the transcript from SCAI. This means
// COMPLETED always implies "transcript fetched", which is a cleaner invariant
// for Phase 6 (result surfacing). See docs/interview-flow.md Phase 4.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const body = await req.json().catch(() => ({}));

    const current = await prisma.interviewSession.findUnique({
      where: { id },
      select: { status: true },
    });
    if (!current) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    if (body.ended) {
      // Only stamp endedAt; leave status at IN_PROGRESS for the transcript tick.
      // Guard: don't update a session already past IN_PROGRESS (e.g. if the
      // worker raced and marked it COMPLETED between the disconnect and this PATCH).
      if (current.status === "IN_PROGRESS" || current.status === "PENDING" || current.status === "SENT") {
        await prisma.interviewSession.update({
          where: { id },
          data: { endedAt: new Date() },
        });
      }
    }

    const session = await prisma.interviewSession.findUnique({
      where: { id },
      select: { id: true, status: true, endedAt: true },
    });
    return NextResponse.json({ session });
  } catch (err) {
    console.error("[interview/sessions/[id] PATCH]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
