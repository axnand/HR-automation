import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ taskId: string }> }
) {
  try {
    const { taskId } = await params;
    const body = await req.json();
    const { name, headline, location, currentOrg, currentDesignation } = body;

    if (!name || !headline) {
      return NextResponse.json({ error: "Name and Headline are required" }, { status: 400 });
    }

    const task = await prisma.task.findUnique({
      where: { id: taskId },
      include: { job: true },
    });

    if (!task) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }

    if (task.status !== "FAILED") {
      return NextResponse.json({ error: "Only failed tasks can be manually entered" }, { status: 400 });
    }

    // Split name into first and last
    const nameParts = name.trim().split(" ");
    const firstName = nameParts[0];
    const lastName = nameParts.length > 1 ? nameParts.slice(1).join(" ") : "";

    // Build manual Unipile-like profile
    const manualProfile = {
      first_name: firstName,
      last_name: lastName,
      headline: headline,
      location: location || "",
      summary: "Manually entered profile.",
      work_experience: [],
      education: [],
      extractedInfo: {
        name,
        currentOrg: currentOrg || "",
        currentDesignation: currentDesignation || headline,
        currentLocation: location || "",
      }
    };

    await prisma.$transaction([
      prisma.task.update({
        where: { id: taskId },
        data: {
          status: "DONE",
          errorMessage: null,
          result: JSON.stringify(manualProfile),
          candidateName: name.trim() || null,
          // We clear analysisResult so the background evaluator runs if we enqueue it?
          // Actually, if we set status = DONE, the evaluator will NOT run unless it's sent to process-task?
          // No, if status is DONE, the evaluator script (poll-tasks) picks it up if analysisResult is null!
        },
      }),
      prisma.job.update({
        where: { id: task.job.id },
        data: {
          successCount: { increment: 1 },
          failedCount: Math.max(0, task.job.failedCount - 1),
        },
      }),
    ]);

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[Task Manual Entry] POST failed:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
