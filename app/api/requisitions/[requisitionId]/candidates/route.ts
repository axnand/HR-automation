import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveRequisitionId } from "@/lib/resolve-requisition";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ requisitionId: string }> }
) {
  try {
    const { requisitionId: rawId } = await params;
    const requisitionId = await resolveRequisitionId(rawId);

    // Fetch all jobs for this requisition ordered oldest→newest so runIndex is stable
    const jobs = await prisma.job.findMany({
      where: { requisitionId },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });

    const jobIds = jobs.map(j => j.id);
    const runIndexById: Record<string, number> = {};
    jobs.forEach((j, i) => { runIndexById[j.id] = i + 1; });

    if (jobIds.length === 0) {
      return NextResponse.json({ tasks: [] });
    }

    // P1 #37 — `?needsReview=true` filters down to Tasks where the AI
    // analysis sub-step failed (analysisStatus = 'FAILED'). Recruiter UI
    // surfaces this as a "needs manual review" bucket.
    const url = new URL(_req.url);
    const needsReview = url.searchParams.get("needsReview") === "true";

    const tasks = await prisma.task.findMany({
      where: {
        jobId: { in: jobIds },
        ...(needsReview ? { analysisStatus: "FAILED" } : {}),
      },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        jobId: true,
        url: true,
        source: true,
        sourceFileName: true,
        sourceFileUrl: true,
        status: true,
        analysisStatus: true,
        result: true,
        analysisResult: true,
        errorMessage: true,
        retryCount: true,
        createdAt: true,
        starred: true,
        overrides: {
          select: {
            ruleKey: true,
            paramKey: true,
            original: true,
            override: true,
            reason: true,
            author: true,
            createdAt: true,
          },
        },
      },
    });

    return NextResponse.json({
      tasks: tasks.map(t => ({
        id: t.id,
        url: t.url,
        source: t.source,
        sourceFileName: t.sourceFileName ?? null,
        hasResume: !!t.sourceFileUrl,
        status: t.status,
        analysisStatus: t.analysisStatus,
        result: t.result ? JSON.parse(t.result) : null,
        analysisResult: t.analysisResult ? JSON.parse(t.analysisResult) : null,
        errorMessage: t.errorMessage ?? null,
        retryCount: t.retryCount,
        runId: t.jobId,
        runIndex: runIndexById[t.jobId] ?? 1,
        addedAt: t.createdAt,
        starred: t.starred,
        overrides: t.overrides,
      })),
    });
  } catch (error) {
    console.error("[Candidates] GET failed:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
