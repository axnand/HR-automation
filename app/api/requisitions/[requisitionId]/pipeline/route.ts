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

    const runs = await prisma.job.findMany({
      where: { requisitionId },
      select: { id: true },
    });

    if (runs.length === 0) {
      return NextResponse.json({ stages: {}, total: 0 });
    }

    const tasks = await prisma.task.findMany({
      where: {
        jobId: { in: runs.map(r => r.id) },
        status: "DONE",
      },
      select: {
        id: true,
        url: true,
        stage: true,
        stageUpdatedAt: true,
        result: true,
        analysisResult: true,
        source: true,
        sourceFileName: true,
        archiveNote: true,
        starred: true,
        createdAt: true,
        outreachMessages: { select: { channel: true, status: true } },
        channelThreads: {
          select: {
            channelType: true,
            status: true,
            providerState: true,
            lastMessageAt: true,
            archivedReason: true,
          },
        },
      },
      orderBy: { stageUpdatedAt: "desc" },
    });

    const grouped: Record<string, any[]> = {};

    for (const t of tasks) {
      const analysis = t.analysisResult ? JSON.parse(t.analysisResult) : null;
      const profile = t.result ? JSON.parse(t.result) : null;
      const stage = t.stage;

      const scrapedName = profile
        ? [profile.first_name, profile.last_name].filter(Boolean).join(" ")
        : "";
      const extracted = profile?.extractedInfo || {};

      const shaped = {
        id: t.id,
        url: t.url,
        stage,
        stageUpdatedAt: t.stageUpdatedAt,
        source: t.source,
        sourceFileName: t.sourceFileName,
        addedAt: t.createdAt,
        name:
          scrapedName ||
          extracted.name ||
          analysis?.candidateInfo?.name ||
          "Unknown",
        headline:
          profile?.headline ||
          profile?.occupation ||
          extracted.currentDesignation ||
          analysis?.candidateInfo?.currentDesignation ||
          "",
        currentOrg:
          analysis?.candidateInfo?.currentOrg ||
          extracted.currentOrg ||
          "",
        currentDesignation:
          analysis?.candidateInfo?.currentDesignation ||
          extracted.currentDesignation ||
          "",
        totalExperienceYears:
          analysis?.candidateInfo?.totalExperienceYears ?? null,
        location:
          analysis?.candidateInfo?.currentLocation ||
          profile?.location ||
          extracted.currentLocation ||
          "",
        scorePercent: analysis?.scorePercent ?? null,
        recommendation: analysis?.recommendation ?? null,
        remarks: analysis?.remarks ?? null,
        archiveNote: t.archiveNote ?? null,
        starred: t.starred,
        profilePictureUrl: profile?.profile_picture_url || null,
        publicId: profile?.public_identifier || null,
        outreachMessages: t.outreachMessages ?? [],
        channelThreads: (t.channelThreads ?? []).map(ct => ({
          channelType: ct.channelType,
          status: ct.status,
          providerState: ct.providerState as Record<string, unknown> | null,
          lastMessageAt: ct.lastMessageAt?.toISOString() ?? null,
          archivedReason: ct.archivedReason ?? null,
        })),
      };

      if (!grouped[stage]) grouped[stage] = [];
      grouped[stage].push(shaped);
    }

    return NextResponse.json({
      stages: grouped,
      total: tasks.length,
    });
  } catch (error) {
    console.error("[Pipeline] GET failed:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
