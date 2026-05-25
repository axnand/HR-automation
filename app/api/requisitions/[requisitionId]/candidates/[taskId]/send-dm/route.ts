import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { startChat, extractIdentifier } from "@/lib/services/unipile.service";
import { buildVars, renderTemplate } from "@/lib/outreach/render-template";
import { resolveRequisitionId } from "@/lib/resolve-requisition";
import { recomputeTaskStage } from "@/lib/channels/stage-rollup";

export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ requisitionId: string; taskId: string }> },
) {
  const { requisitionId: rawReqId, taskId } = await params;
  try {
    const requisitionId = await resolveRequisitionId(rawReqId);

    const task = await prisma.task.findUnique({
      where: { id: taskId },
      select: { id: true, url: true, stage: true, result: true, analysisResult: true, candidateName: true },
    });

    if (!task) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }

    if (task.stage !== "CONNECTED") {
      return NextResponse.json(
        { error: `Expected stage CONNECTED, got ${task.stage}` },
        { status: 409 },
      );
    }

    const profile = task.result ? JSON.parse(task.result) : null;
    const analysis = task.analysisResult ? JSON.parse(task.analysisResult) : null;
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

    const cfg = channel.config as any;
    const firstFollowup = cfg?.followups?.[0];
    if (!firstFollowup?.template) {
      return NextResponse.json(
        { error: "No first-DM template configured on the LinkedIn channel (followups[0])" },
        { status: 400 },
      );
    }

    const vars = buildVars(profile ?? {}, analysis ?? {});
    const text = renderTemplate(firstFollowup.template, vars);

    // Find or create the LinkedIn ChannelThread for this task. We MUST have
    // a thread with providerChatId set so future reply webhooks can match.
    // Without this the rollup also snaps Task.stage back to CONNECTED on the
    // next tick. Includes ARCHIVED so we resurrect rather than collide with
    // the @@unique([taskId, channelId]) constraint.
    let thread = await prisma.channelThread.findFirst({
      where: { taskId, channelId: channel.id },
      orderBy: { createdAt: "desc" },
    });
    if (!thread) {
      const cLabel = task.candidateName ?? taskId;
      console.log(`[send-dm] No ChannelThread for "${cLabel}" (taskId=${taskId}) — creating one`);
      thread = await prisma.channelThread.create({
        data: {
          taskId,
          channelId: channel.id,
          channelType: "LINKEDIN",
          status: "ACTIVE",
          providerState: { phase: "CONNECTED" },
          followupsTotal: (cfg?.followups ?? []).length,
          accountId: account.id,
        },
      });
    }

    const { chatId, messageId } = await startChat({
      accountId: account.accountId,
      providerUserId,
      text,
      accountDsn: account.dsn ?? undefined,
      accountApiKey: account.apiKey ?? undefined,
    });

    const now = new Date();
    const nextFollowup = cfg?.followups?.[1];
    const nextAt = nextFollowup ? new Date(now.getTime() + (nextFollowup.afterDays ?? 0) * 86_400_000) : null;

    // Keep all non-stage side-effects in one atomic transaction.
    // task.stage is NOT updated here — recomputeTaskStage (called below) derives
    // it from the ChannelThread state written in this transaction, which is the
    // correct source of truth (CLAUDE.md: never raw-update task.stage).
    await prisma.$transaction([
      prisma.outreachMessage.create({
        data: {
          campaignId: `${channel.id}:dm`,
          taskId,
          channel: "LINKEDIN_DM",
          status: "SENT",
          renderedBody: text,
          approvedAt: now,
          sentAt: now,
          providerMessageId: messageId || null,
          providerChatId: chatId || null,
        },
      }),
      prisma.channelThread.update({
        where: { id: thread.id },
        data: {
          status: "ACTIVE",
          providerState: { phase: "MESSAGED" },
          providerChatId: chatId || thread.providerChatId,
          archivedAt: null,
          archivedReason: null,
          lastMessageAt: now,
          followupsSent: Math.max(thread.followupsSent, 1),
          nextActionAt: nextAt,
          accountId: thread.accountId ?? account.id,
        },
      }),
      prisma.threadMessage.create({
        data: {
          threadId: thread.id,
          type: "FIRST_DM",
          status: "SENT",
          renderedBody: text,
          sentAt: now,
          providerMessageId: messageId || null,
          providerChatId: chatId || null,
          accountId: account.id,
        },
      }),
    ]);

    // Derive task.stage from the thread state we just committed (providerState.phase
    // = "MESSAGED" + lastMessageAt set → rollup computes MESSAGED).
    await recomputeTaskStage(taskId, { source: "MANUAL" });

    return NextResponse.json({ ok: true, chatId, messageId });
  } catch (error: any) {
    console.error(`[send-dm] failed for taskId=${taskId}: ${error?.message ?? error}`);
    const message = error?.message || "Internal server error";
    const status = error?.statusCode && error.statusCode < 500 ? error.statusCode : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
