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

    const requisition = await prisma.requisition.findUnique({
      where: { id: requisitionId },
      include: {
        jobs: {
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            status: true,
            totalTasks: true,
            processedCount: true,
            successCount: true,
            failedCount: true,
            createdAt: true,
          },
        },
      },
    });

    if (!requisition) {
      return NextResponse.json({ error: "Requisition not found" }, { status: 404 });
    }

    const config = requisition.config ? JSON.parse(requisition.config) : {};

    return NextResponse.json({
      id: requisition.id,
      title: requisition.title,
      department: requisition.department,
      recruiterName: requisition.recruiterName,
      archived: requisition.archived,
      createdAt: requisition.createdAt,
      updatedAt: requisition.updatedAt,
      config,
      runs: requisition.jobs,
    });
  } catch (error) {
    console.error("[Requisitions] GET [id] failed:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ requisitionId: string }> }
) {
  try {
    const { requisitionId: rawId } = await params;
    const requisitionId = await resolveRequisitionId(rawId);
    const body = await req.json();

    const existing = await prisma.requisition.findUnique({ where: { id: requisitionId } });
    if (!existing) {
      return NextResponse.json({ error: "Requisition not found" }, { status: 404 });
    }

    const patch: Record<string, any> = {};
    if (typeof body.title === "string") patch.title = body.title;
    if (typeof body.department === "string") patch.department = body.department;
    if (typeof body.recruiterName === "string") patch.recruiterName = body.recruiterName;
    if ("startDate" in body) patch.startDate = body.startDate ? new Date(body.startDate) : null;
    if (typeof body.archived === "boolean") patch.archived = body.archived;
    if (typeof body.isActive === "boolean") patch.isActive = body.isActive;

    // Config merge — only specified keys overwrite
    const CONFIG_KEYS = [
      "jobDescription", "jdTitle", "scoringRules", "customScoringRules",
      "aiModel", "aiProviderId", "sheetWebAppUrl", "minScoreThreshold",
      "autoShortlistThreshold",
      "promptRole", "promptGuidelines", "criticalInstructions",
      "builtInRuleDescriptions", "ruleDefinitions", "promptEnvelope",
      "interview", // Phase 2/3 — interview trigger + question list + messageTemplate
    ];
    const currentConfig = existing.config ? JSON.parse(existing.config) : {};
    let configChanged = false;
    for (const k of CONFIG_KEYS) {
      if (k in body) {
        if (k === "interview" && body[k] && typeof body[k] === "object") {
          // Deep-merge the interview sub-object. It holds independently-edited
          // keys — `questions`/`trigger` (InterviewTab) and `messageTemplate`
          // (the per-role delivery template, Phase 3). A wholesale overwrite
          // would let one editor silently wipe the other's keys.
          currentConfig.interview = { ...(currentConfig.interview || {}), ...body[k] };
        } else {
          currentConfig[k] = body[k];
        }
        configChanged = true;
      }
    }
    if (configChanged) patch.config = JSON.stringify(currentConfig);

    const updated = await prisma.requisition.update({
      where: { id: requisitionId },
      data: patch,
    });

    const rulesChanged = configChanged && (
      "scoringRules" in body || "customScoringRules" in body ||
      "builtInRuleDescriptions" in body || "ruleDefinitions" in body
    );
    if (rulesChanged) {
      const { recalculateScoresForRequisition } = await import("@/lib/recalculate-scores");
      await recalculateScoresForRequisition(requisitionId, currentConfig);
    }

    return NextResponse.json({ ...updated, recalculated: rulesChanged });
  } catch (error) {
    console.error("[Requisitions] PUT failed:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ requisitionId: string }> }
) {
  try {
    const { requisitionId: rawId } = await params;
    const requisitionId = await resolveRequisitionId(rawId);
    await prisma.requisition.delete({ where: { id: requisitionId } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[Requisitions] DELETE failed:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
