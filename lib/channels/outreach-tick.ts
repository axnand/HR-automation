// ─── Outreach tick — shared scheduler logic ──────────────────────────────────
//
// Extracted so it can be invoked directly from the worker process (in-process
// setInterval) and from the HTTP cron route. Avoids depending on an HTTP fetch
// that requires NEXT_PUBLIC_APP_URL to be set.

import { prisma } from "@/lib/prisma";
import { processThread, markThreadReplied } from "@/lib/channels/thread-worker";
import { listSentInvitations, listChatMessages } from "@/lib/services/unipile.service";
import { recomputeTaskStage } from "@/lib/channels/stage-rollup";
import { buildVars } from "@/lib/outreach/render-template";

const MAX_PER_TICK = 200;
const RETRY_DELAY_MS = 5 * 60 * 1000;

export async function runOutreachTick(): Promise<{
  processed: number;
  failed: number;
  total: number;
  pollAccepted: number;
  pollReplied: number;
}> {
  const now = new Date();

  let claimedIds: string[] = [];
  try {
    // Phase 3 #14 / EC-4.5 — exclude threads belonging to a non-ACTIVE Channel.
    // Subquery rather than JOIN keeps FOR UPDATE SKIP LOCKED scoped to
    // "ChannelThread" rows only; locking "Channel" rows here would block
    // recruiter UI edits to the channel config.
    const claimed = await prisma.$queryRaw<{ id: string }[]>`
      WITH claimed AS (
        UPDATE "ChannelThread"
        SET "nextActionAt" = NULL
        WHERE id IN (
          SELECT id
          FROM   "ChannelThread"
          WHERE  status IN ('PENDING', 'ACTIVE')
            AND  "nextActionAt" IS NOT NULL
            AND  "nextActionAt" <= ${now}
            AND  "channelId" IN (
                   SELECT id FROM "Channel" WHERE status = 'ACTIVE'
                 )
          ORDER  BY "nextActionAt" ASC
          LIMIT  ${MAX_PER_TICK}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id
      )
      SELECT id FROM claimed
    `;
    claimedIds = claimed.map(r => r.id);
  } catch (err: any) {
    console.error("[OutreachTick] Failed to claim threads:", err.message);
    return { processed: 0, failed: 0, total: 0, pollAccepted: 0, pollReplied: 0 };
  }

  if (claimedIds.length === 0) {
    return { processed: 0, failed: 0, total: 0, pollAccepted: 0, pollReplied: 0 };
  }

  console.log(`[OutreachTick] Claimed ${claimedIds.length} threads`);

  let processed = 0;
  let failed = 0;

  for (const threadId of claimedIds) {
    try {
      await processThread(threadId);
      processed++;
    } catch (err: any) {
      failed++;
      // Fetch candidateName for a useful error log — on the failure path an extra
      // query is fine since this is already an exceptional case.
      const failedTask = await prisma.task.findFirst({
        where: { channelThreads: { some: { id: threadId } } },
        select: { id: true, candidateName: true },
      }).catch(() => null);
      const cLabel = failedTask?.candidateName ?? `threadId:${threadId.slice(-8)}`;
      console.error(`[OutreachTick] "${cLabel}" failed (taskId=${failedTask?.id ?? "?"} threadId=${threadId}): ${err.message}`);
      await prisma.channelThread
        .updateMany({
          where: {
            id: threadId,
            status: { in: ["PENDING", "ACTIVE"] },
          },
          data: { nextActionAt: new Date(Date.now() + RETRY_DELAY_MS) },
        })
        .catch(e => console.error(`[OutreachTick] Failed to reset thread ${threadId}:`, e.message));
    }
  }

  console.log(`[OutreachTick] Done — processed=${processed} failed=${failed}`);

  // Neither pollJobInviteAcceptances nor pollChatReplies are called here.
  // Both hit Unipile/LinkedIn APIs and would fire ~2 800+ times/day if run
  // on the 30 s tick. They are driven by /api/cron/poll-acceptances (cron-job.org,
  // once daily) which runs both in sequence as a single safe fallback sweep.

  return { processed, failed, total: claimedIds.length, pollAccepted: 0, pollReplied: 0 };
}

// Exported for the on-demand "Check Acceptances" button in the recruiter UI.
// Pass a requisitionId to scope to one job; omit for the global tick fallback.
export async function pollJobInviteAcceptances(requisitionId?: string): Promise<number> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  // When called from the UI button we skip the 1-hour age filter so recruiters
  // can check fresh invites immediately during testing / time-sensitive outreach.
  // The global tick keeps the age filter so it doesn't thrash just-sent invites.
  const inviteSentFilter = requisitionId ? {} : { inviteSentAt: { lt: oneHourAgo } };

  const pendingThreads = await prisma.channelThread.findMany({
    where: {
      status: "ACTIVE",
      providerState: { path: ["phase"], equals: "INVITE_PENDING" },
      ...(requisitionId ? { channel: { requisitionId } } : {}),
      ...inviteSentFilter,
    },
    select: {
      id: true,
      taskId: true,
      candidateProviderId: true,
      task: { select: { result: true, analysisResult: true, candidateName: true } },
      // EC-9.3: prefer thread's sticky account; fall back to channel default.
      account: { select: { accountId: true, dsn: true, apiKey: true } },
      channel: {
        select: {
          sendingAccount: { select: { accountId: true, dsn: true, apiKey: true } },
        },
      },
    },
  });

  if (pendingThreads.length === 0) return 0;

  // Group by the effective account — thread's sticky account takes precedence
  // over channel.sendingAccount (EC-9.3: the conversation belongs to the account
  // that sent the invite, not whatever the channel's current default is).
  type ThreadRow = typeof pendingThreads[number];
  type AccRow = NonNullable<ThreadRow["account"]>;
  const byAccount = new Map<string, { acc: AccRow; threads: ThreadRow[] }>();
  for (const t of pendingThreads) {
    const acc = t.account ?? t.channel.sendingAccount;
    if (!acc) continue;
    const bucket = byAccount.get(acc.accountId) ?? { acc, threads: [] };
    bucket.threads.push(t);
    byAccount.set(acc.accountId, bucket);
  }

  let accepted = 0;

  for (const { acc, threads } of byAccount.values()) {
    const sentInvites = await listSentInvitations({
      accountId: acc.accountId,
      limit: 200,
      accountDsn: acc.dsn ?? undefined,
      accountApiKey: acc.apiKey ?? undefined,
    });

    const sentProviderIds = new Set(sentInvites.map(i => i.invitedUserId).filter(Boolean) as string[]);
    const sentPublicIds = new Set(sentInvites.map(i => i.invitedUserPublicId).filter(Boolean) as string[]);

    for (const thread of threads) {
      try {
        // Prefer candidateProviderId (set at send time); fall back to parsing task.result
        // for threads sent before the column was added.
        let pid: string | undefined = thread.candidateProviderId ?? undefined;
        let pubId: string | undefined;
        if (!pid) {
          const profile = thread.task.result ? JSON.parse(thread.task.result as string) : null;
          pid = profile?.provider_id;
          pubId = profile?.public_identifier;
        }

        const stillPending = (pid && sentProviderIds.has(pid)) || (pubId && sentPublicIds.has(pubId));
        if (stillPending) continue;

        const current = await prisma.channelThread.findUnique({
          where: { id: thread.id },
          select: { providerState: true },
        });
        const phase = (current?.providerState as Record<string, string> | null)?.phase;
        if (phase !== "INVITE_PENDING") continue;

        await prisma.channelThread.update({
          where: { id: thread.id },
          data: {
            providerState: { phase: "CONNECTED" },
            nextActionAt: new Date(),
          },
        });
        await recomputeTaskStage(thread.taskId);
        const profile = thread.task.result ? JSON.parse(thread.task.result as string) : {};
        const analysis = thread.task.analysisResult ? JSON.parse(thread.task.analysisResult as string) : {};
        const vars = buildVars(profile, analysis);
        const candidateName = vars.name || thread.id.slice(-6);
        console.log(`[OutreachTick] pollInviteAcceptances: "${candidateName}" accepted invite → CONNECTED`);
        accepted++;
      } catch (err: any) {
        const cLabel = thread.task.candidateName ?? `taskId:${thread.taskId.slice(-8)}`;
        console.warn(`[OutreachTick] pollInviteAcceptances: error for "${cLabel}" (threadId=${thread.id}): ${err.message}`);
      }
    }
  }

  if (accepted > 0) {
    console.log(`[OutreachTick] pollInviteAcceptances: ${accepted} newly accepted`);
  }
  return accepted;
}

// ─── Reply polling ────────────────────────────────────────────────────────────
//
// Fallback for missed/delayed webhooks. For every ACTIVE thread that has a
// providerChatId (DM/InMail/WA sent), fetch the last few messages from Unipile
// and check if any inbound message arrived after our last outbound send.
//
// Runs on every outreach tick. Skips threads where webhook already fired
// (status would already be REPLIED).

export async function pollChatReplies(): Promise<number> {
  const activeThreadsWithChat = await prisma.channelThread.findMany({
    where: {
      status: "ACTIVE",
      providerChatId: { not: null },
      lastMessageAt: { not: null },
    },
    select: {
      id: true,
      taskId: true,
      providerChatId: true,
      lastMessageAt: true,
      task: { select: { result: true, analysisResult: true, candidateName: true } },
      channel: {
        select: {
          sendingAccount: { select: { accountId: true, dsn: true, apiKey: true } },
        },
      },
    },
  });

  if (activeThreadsWithChat.length === 0) return 0;

  let replied = 0;

  for (const thread of activeThreadsWithChat) {
    try {
      const acc = thread.channel.sendingAccount;
      if (!acc || !thread.providerChatId) continue;

      const messages = await listChatMessages({
        chatId: thread.providerChatId,
        accountId: acc.accountId,
        limit: 5,
        accountDsn: acc.dsn ?? undefined,
        accountApiKey: acc.apiKey ?? undefined,
      });

      // Check if any message is inbound (not from us) and newer than our last sent message
      const lastSentAt = thread.lastMessageAt!;
      const hasReply = messages.some(
        m => !m.fromMe && new Date(m.date) > lastSentAt,
      );

      if (hasReply) {
        await markThreadReplied(thread.id, thread.taskId);
        await recomputeTaskStage(thread.taskId);
        const replyProfile = thread.task.result ? JSON.parse(thread.task.result as string) : {};
        const replyAnalysis = thread.task.analysisResult ? JSON.parse(thread.task.analysisResult as string) : {};
        const replyVars = buildVars(replyProfile, replyAnalysis);
        console.log(`[OutreachTick] pollChatReplies: "${replyVars.name || thread.id.slice(-6)}" replied → REPLIED`);
        replied++;
      }
    } catch (err: any) {
      const cLabel = thread.task.candidateName ?? `taskId:${thread.taskId.slice(-8)}`;
      console.warn(`[OutreachTick] pollChatReplies: error for "${cLabel}" (threadId=${thread.id}): ${err.message}`);
    }
  }

  if (replied > 0) {
    console.log(`[OutreachTick] pollChatReplies: ${replied} new replies detected`);
  }
  return replied;
}
