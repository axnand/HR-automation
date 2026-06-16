import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { enqueueTaskBatch } from "@/lib/queue";

type Action = "pause" | "resume" | "cancel";

const TERMINAL_STATUSES = ["COMPLETED", "FAILED", "CANCELLED"];

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  try {
    const { jobId } = await params;
    const body = await req.json().catch(() => ({}));
    const action: Action = body.action || "cancel";

    const job = await prisma.job.findUnique({
      where: { id: jobId },
      select: { status: true },
    });

    if (!job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    if (action === "pause") {
      if (job.status !== "PROCESSING" && job.status !== "PENDING") {
        return NextResponse.json(
          { error: `Cannot pause a job that is ${job.status.toLowerCase()}` },
          { status: 400 }
        );
      }

      await prisma.job.update({
        where: { id: jobId },
        data: { status: "PAUSED" },
      });

      return NextResponse.json({
        message: "Job paused successfully",
        jobId,
        status: "PAUSED",
      });
    }

    if (action === "resume") {
      if (job.status !== "PAUSED") {
        return NextResponse.json(
          { error: `Cannot resume a job that is ${job.status.toLowerCase()}` },
          { status: 400 }
        );
      }

      await prisma.job.update({
        where: { id: jobId },
        data: { status: "PROCESSING" },
      });

      // Re-enqueue all PENDING tasks for this job (they were de-queued when pg-boss job completed during pause)
      const pendingTasks = await prisma.task.findMany({
        where: { jobId, status: "PENDING" },
        select: { id: true, source: true },
      });
      await enqueueTaskBatch(pendingTasks).catch((err) =>
        console.error("[Resume] Failed to enqueue tasks:", err)
      );

      return NextResponse.json({
        message: "Job resumed successfully",
        jobId,
        status: "PROCESSING",
      });
    }

    // Default: cancel
    if (TERMINAL_STATUSES.includes(job.status)) {
      return NextResponse.json(
        { error: `Job is already ${job.status.toLowerCase()}` },
        { status: 400 }
      );
    }

    await prisma.$transaction([
      prisma.job.update({
        where: { id: jobId },
        data: { status: "CANCELLED" },
      }),
      prisma.task.updateMany({
        where: { jobId, status: { in: ["PENDING", "PROCESSING"] } },
        data: { status: "FAILED", errorMessage: "Job was cancelled" },
      }),
    ]);

    return NextResponse.json({
      message: "Job cancelled successfully",
      jobId,
      status: "CANCELLED",
    });
  } catch (error) {
    console.error("Error updating job:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
