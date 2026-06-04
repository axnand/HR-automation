import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getOrCreateOpenInterviewSession } from "@/lib/interview/session";

export const dynamic = "force-dynamic";

// POST /api/interview/sessions  { taskId }
// Reuses the candidate's open interview session, or creates one. The merged
// question list is snapshotted onto questionsSnapshot inside
// getOrCreateOpenInterviewSession (the chokepoint shared by every entry point —
// this route, the "Start Interview" button, and all delivery triggers), so it
// happens regardless of how the session is born. See docs/interview-flow.md §5.2.
export async function POST(req: NextRequest) {
  try {
    const { taskId } = await req.json();
    if (!taskId || typeof taskId !== "string") {
      return NextResponse.json({ error: "taskId is required" }, { status: 400 });
    }

    // findUnique is intentionally unfiltered by deletedAt (CLAUDE.md) — a PK
    // lookup is deliberate. We still refuse to create a session for a
    // soft-deleted candidate.
    const task = await prisma.task.findUnique({
      where: { id: taskId },
      select: { id: true, deletedAt: true, candidateName: true },
    });
    if (!task || task.deletedAt) {
      return NextResponse.json({ error: "Candidate not found" }, { status: 404 });
    }

    const { session, created } = await getOrCreateOpenInterviewSession(taskId);

    return NextResponse.json({
      session: { id: session.id, roomId: session.roomId, accessToken: session.accessToken, status: session.status },
      candidateName: task.candidateName,
      reused: !created,
    });
  } catch (err) {
    console.error("[interview/sessions POST]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// GET /api/interview/sessions?taskId=...
// Lists sessions for a candidate, most recent first. For COMPLETED sessions,
// transcript and questionsSnapshot are included for Phase 6 result surfacing.
export async function GET(req: NextRequest) {
  try {
    const taskId = new URL(req.url).searchParams.get("taskId");
    if (!taskId) {
      return NextResponse.json({ error: "taskId query param is required" }, { status: 400 });
    }

    const sessions = await prisma.interviewSession.findMany({
      where: { taskId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        accessToken: true, // candidate URL segment for Copy Link / Open
        status: true,
        sentVia: true,
        sentAt: true,
        score: true,
        recommendation: true,
        questionsSnapshot: true,
        transcript: true,
        startedAt: true,
        endedAt: true,
        createdAt: true,
      },
    });

    return NextResponse.json({ sessions });
  } catch (err) {
    console.error("[interview/sessions GET]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
