import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ taskId: string }> }
) {
  try {
    const { taskId } = await params;

    const task = await prisma.task.findUnique({
      where: { id: taskId },
      include: {
        job: {
          include: { requisition: true },
        },
        stageEvents: {
          orderBy: { createdAt: "asc" },
        },
        outreachMessages: {
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            channel: true,
            status: true,
            direction: true,
            renderedBody: true,
            inboundBody: true,
            sentAt: true,
            createdAt: true,
          },
        },
        contact: true,
        overrides: true,
      },
    });

    if (!task) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }

    return NextResponse.json({
      id: task.id,
      url: task.url,
      source: task.source,
      sourceFileName: task.sourceFileName,
      hasResume: !!task.sourceFileUrl,
      status: task.status,
      stage: task.stage,
      createdAt: task.createdAt,
      result: task.result ? JSON.parse(task.result) : null,
      analysisResult: task.analysisResult ? JSON.parse(task.analysisResult) : null,
      errorMessage: task.errorMessage,
      job: {
        id: task.job.id,
        title: task.job.title,
        requisitionId: task.job.requisitionId,
        requisitionTitle: task.job.requisition?.title ?? task.job.title,
        config: task.job.config ? JSON.parse(task.job.config) : null,
      },
      stageEvents: task.stageEvents,
      outreachMessages: task.outreachMessages,
      contact: task.contact,
      overrides: task.overrides,
    });
  } catch (error) {
    console.error("[Task] GET failed:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ taskId: string }> }
) {
  try {
    const { taskId } = await params;
    const body = await req.json();
    const { candidateInfo } = body as { candidateInfo?: Record<string, string | number> };

    if (!candidateInfo || Object.keys(candidateInfo).length === 0) {
      return NextResponse.json({ error: "candidateInfo is required" }, { status: 400 });
    }

    const task = await prisma.task.findUnique({
      where: { id: taskId },
      select: { analysisResult: true, result: true },
    });

    if (!task) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }

    const analysis = task.analysisResult ? JSON.parse(task.analysisResult) : {};
    analysis.candidateInfo = { ...(analysis.candidateInfo || {}), ...candidateInfo };

    const updateData: Parameters<typeof prisma.task.update>[0]["data"] = {
      analysisResult: JSON.stringify(analysis),
    };

    // Keep candidateName + profile JSON in sync when name is explicitly edited
    if (typeof candidateInfo.name === "string" && candidateInfo.name.trim()) {
      const fullName = candidateInfo.name.trim();
      const parts = fullName.split(/\s+/);
      updateData.candidateName = fullName;
      if (task.result) {
        const profile = JSON.parse(task.result);
        profile.first_name = parts[0] ?? "";
        profile.last_name = parts.slice(1).join(" ");
        if (profile.extractedInfo) profile.extractedInfo.name = fullName;
        updateData.result = JSON.stringify(profile);
      }
    }

    await prisma.task.update({ where: { id: taskId }, data: updateData });

    return NextResponse.json({ ok: true, candidateInfo: analysis.candidateInfo });
  } catch (error) {
    console.error("[Task] PATCH failed:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
