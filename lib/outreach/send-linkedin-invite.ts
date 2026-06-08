// ─── Shared LinkedIn invite send ─────────────────────────────────────────────
//
// Single source of truth for "send a LinkedIn connection request for a task".
// Used by BOTH the single-card endpoint (candidates/[taskId]/send-invite) and
// the bulk endpoint (candidates/bulk-send-invite), so the side effects —
// sending the invite, advancing the stage, and creating the ChannelThread that
// the accept/reply webhooks match on — can never drift between the two paths.
//
// Sends the invite via Unipile FIRST (an external call — never inside a DB
// transaction), then atomically: advance stage → CONTACT_REQUESTED, write the
// legacy OutreachMessage + StageEvent, and create the ChannelThread (phase
// INVITE_PENDING) + its first ThreadMessage. Returns a discriminated result so
// callers can map to HTTP status (single) or per-task outcomes (bulk).

import { prisma } from "@/lib/prisma";
import { sendInvitation, extractIdentifier } from "@/lib/services/unipile.service";
import { buildVars, renderTemplate } from "@/lib/outreach/render-template";
import { markStageEventExplicit } from "@/lib/channels/stage-event-context";
import { OutreachType } from "@prisma/client";

export type SendInviteResult =
  | { ok: true; invitationId: string | null; threadCreated: boolean }
  | { ok: false; kind: "not_found"; message: string }
  | { ok: false; kind: "wrong_stage"; message: string; currentStage: string }
  | { ok: false; kind: "no_provider_id"; message: string }
  | { ok: false; kind: "no_channel"; message: string }
  | { ok: false; kind: "no_account"; message: string }
  | { ok: false; kind: "send_failed"; message: string; statusCode?: number };

export async function sendLinkedInInviteForTask(
  taskId: string,
  requisitionId: string,
): Promise<SendInviteResult> {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: { id: true, url: true, stage: true, result: true, analysisResult: true },
  });
  if (!task) return { ok: false, kind: "not_found", message: "Task not found" };
  if (task.stage !== "SHORTLISTED") {
    return { ok: false, kind: "wrong_stage", message: `Expected stage SHORTLISTED, got ${task.stage}`, currentStage: task.stage };
  }

  const profile = task.result ? JSON.parse(task.result) : null;
  const analysis = task.analysisResult ? JSON.parse(task.analysisResult) : null;
  const vars = buildVars(profile ?? {}, analysis ?? {});
  const providerUserId: string | null =
    profile?.provider_id || profile?.public_identifier || extractIdentifier(task.url);
  if (!providerUserId) {
    return { ok: false, kind: "no_provider_id", message: "Could not resolve LinkedIn provider ID for this candidate" };
  }

  const channel = await prisma.channel.findFirst({
    where: { requisitionId, type: "LINKEDIN", status: { in: ["ACTIVE", "PAUSED"] } },
    include: { sendingAccount: true },
    orderBy: { createdAt: "desc" },
  });
  if (!channel) return { ok: false, kind: "no_channel", message: "No LinkedIn channel for this requisition" };
  const account = channel.sendingAccount;
  if (!account) return { ok: false, kind: "no_account", message: "Channel has no sending account configured" };

  // Pull invite note from channel config (first invite rule, if any)
  let inviteNote: string | undefined;
  try {
    const cfg = channel.config as any;
    const firstRule = cfg?.inviteRules?.[0];
    if (firstRule?.noteTemplate) inviteNote = renderTemplate(firstRule.noteTemplate, vars).slice(0, 300);
  } catch { /* skip */ }

  // External call FIRST — outside any transaction.
  let invitationId: string | null = null;
  try {
    const res = await sendInvitation({
      accountId: account.accountId,
      providerUserId,
      message: inviteNote,
      accountDsn: account.dsn ?? undefined,
      accountApiKey: account.apiKey ?? undefined,
    });
    invitationId = res.invitationId;
  } catch (error: any) {
    return { ok: false, kind: "send_failed", message: error?.message || "Failed to send invitation", statusCode: error?.statusCode };
  }

  const now = new Date();
  const cfg = channel.config as any;
  const archiveDays: number = cfg?.archiveAfterInviteDays ?? 14;
  const inviteTimeoutAt = new Date(now.getTime() + archiveDays * 24 * 60 * 60 * 1000);
  const followupsTotal: number = Array.isArray(cfg?.followups) ? cfg.followups.length : 0;
  const matchedRuleKey: string | null = cfg?.inviteRules?.[0]?.key ?? null;

  let threadCreated = false;
  await prisma.$transaction(async (tx) => {
    await markStageEventExplicit(tx);
    await tx.task.update({
      where: { id: taskId },
      data: { stage: "CONTACT_REQUESTED", stageUpdatedAt: now },
    });
    await tx.outreachMessage.create({
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
    });
    await tx.stageEvent.create({
      data: {
        taskId,
        fromStage: "SHORTLISTED",
        toStage: "CONTACT_REQUESTED",
        actor: "USER",
        reason: "LinkedIn invitation sent",
      },
    });

    // Create a ChannelThread so the invite-accepted and message-received
    // webhooks can match this conversation and auto-advance the stage. Without
    // it the task stays stuck at CONTACT_REQUESTED forever (webhooks look up
    // threads by candidateProviderId / providerChatId).
    const existingThread = await tx.channelThread.findFirst({
      where: { taskId, channelId: channel.id },
      select: { id: true },
    });
    if (!existingThread) {
      const thread = await tx.channelThread.create({
        data: {
          taskId,
          channelId: channel.id,
          channelType: "LINKEDIN",
          status: "ACTIVE",
          providerState: { phase: "INVITE_PENDING" },
          inviteSentAt: now,
          nextActionAt: inviteTimeoutAt,
          candidateProviderId: providerUserId,
          accountId: account.id,
          matchedRuleKey,
          followupsSent: 0,
          followupsTotal,
        },
      });
      await tx.threadMessage.create({
        data: {
          threadId: thread.id,
          accountId: account.id,
          type: OutreachType.INVITE,
          renderedBody: inviteNote ?? "",
          sentAt: now,
          providerMessageId: invitationId || null,
        },
      });
      threadCreated = true;
    }
  });

  return { ok: true, invitationId, threadCreated };
}
