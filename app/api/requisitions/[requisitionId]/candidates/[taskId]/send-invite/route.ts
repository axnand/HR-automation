import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { sendInvitation, extractIdentifier } from "@/lib/services/unipile.service";
import { buildVars, renderTemplate } from "@/lib/outreach/render-template";
import { resolveRequisitionId } from "@/lib/resolve-requisition";
import { stageEventExplicit } from "@/lib/channels/stage-event-context";

export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ requisitionId: string; taskId: string }> },
) {
  try {
    const { requisitionId: rawReqId, taskId } = await params;
    const requisitionId = await resolveRequisitionId(rawReqId);

    const task = await prisma.task.findUnique({
      where: { id: taskId },
      select: { id: true, url: true, stage: true, result: true, analysisResult: true },
    });

    if (!task) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }

    if (task.stage !== "SHORTLISTED") {
      return NextResponse.json(
        { error: `Expected stage SHORTLISTED, got ${task.stage}` },
        { status: 409 },
      );
    }

    const profile = task.result ? JSON.parse(task.result) : null;
    const analysis = task.analysisResult ? JSON.parse(task.analysisResult) : null;
    const vars = buildVars(profile ?? {}, analysis ?? {});
    const providerUserId: string | null =
      profile?.provider_id ||
      profile?.public_identifier ||
      extractIdentifier(task.url);

    if (!providerUserId) {
      return NextResponse.json(
        { error: "Could not resolve LinkedIn provider ID for this candidate" },
        { status: 422 },
      );
    }

    const channel = await prisma.channel.findFirst({
      where: { requisitionId, type: "LINKEDIN", status: { in: ["ACTIVE", "PAUSED"] } },
      include: { sendingAccount: true },
      orderBy: { createdAt: "desc" },
    });

    if (!channel) {
      return NextResponse.json(
        { error: "No LinkedIn channel for this requisition" },
        { status: 400 },
      );
    }

    const account = channel.sendingAccount;
    if (!account) {
      return NextResponse.json(
        { error: "Channel has no sending account configured" },
        { status: 400 },
      );
    }

    // Pull invite note from channel config (first invite rule, if any)
    let inviteNote: string | undefined;
    try {
      const cfg = channel.config as any;
      const firstRule = cfg?.inviteRules?.[0];
      if (firstRule?.noteTemplate) {
        inviteNote = renderTemplate(firstRule.noteTemplate, vars).slice(0, 300);
      }
    } catch { /* skip */ }

    const { invitationId } = await sendInvitation({
      accountId: account.accountId,
      providerUserId,
      message: inviteNote,
      accountDsn: account.dsn ?? undefined,
      accountApiKey: account.apiKey ?? undefined,
    });

    const now = new Date();

    await prisma.$transaction([
      stageEventExplicit(),
      prisma.task.update({
        where: { id: taskId },
        data: { stage: "CONTACT_REQUESTED", stageUpdatedAt: now },
      }),
      prisma.outreachMessage.create({
        data: {
          campaignId: channel.id,
          taskId,
          channel: "LINKEDIN_INVITE",
          status: "SENT",
          renderedBody: inviteNote ?? "",
          approvedAt: now,
          sentAt: now,
          providerMessageId: invitationId || null,
        },
      }),
      prisma.stageEvent.create({
        data: {
          taskId,
          fromStage: "SHORTLISTED",
          toStage: "CONTACT_REQUESTED",
          actor: "USER",
          reason: "LinkedIn invitation sent",
        },
      }),
    ]);

    return NextResponse.json({ ok: true, invitationId });
  } catch (error: any) {
    console.error("[send-invite] failed:", error);
    const message = error?.message || "Internal server error";
    const status = error?.statusCode && error.statusCode < 500 ? error.statusCode : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
