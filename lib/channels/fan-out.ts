// ─── Fan-out: create ChannelThreads when a task is shortlisted ────────────────
//
// Called after a task reaches SHORTLISTED stage (either by auto-shortlist
// in the worker or manual promotion). Evaluates every active Channel for
// the requisition and creates one ChannelThread per matching channel.
//
// Idempotent: the @@unique([taskId, channelId]) constraint prevents duplicates,
// so calling this multiple times is safe.

import { prisma } from "@/lib/prisma";
import { ChannelType } from "@prisma/client";
import { matchRule, type LinkedInConfig, type EmailConfig, type WAConfig } from "./types";
import { triggerOutreach } from "@/lib/trigger";

// P1 #14 / EC-9.2 — pick a sending account for a new ChannelThread.
//
// Selection order:
//   1. ChannelAccountPool entries for this channel (highest priority first;
//      tiebreaker: account with fewest existing bound threads — round-robin).
//      Excludes soft-deleted, DISABLED, and over-cap accounts.
//   2. Fall back to channel.sendingAccountId (legacy single-account binding).
//   3. Return null when nothing usable exists; caller can still create the
//      thread (worker will archive at first tick with a clear reason).
async function pickAccountForChannel(
  channelId: string,
  fallbackSendingAccountId: string | null,
): Promise<string | null> {
  const pool = await prisma.channelAccountPool.findMany({
    where: {
      channelId,
      account: {
        deletedAt: null,
        status: { not: "DISABLED" },
      },
    },
    orderBy: [{ priority: "desc" }],
    select: {
      accountId: true,
      account: {
        select: { id: true, _count: { select: { threadsBound: true } } },
      },
    },
  });

  if (pool.length > 0) {
    // Round-robin within priority tier: pick the account with the fewest
    // bound threads. Prisma can't sort by a nested aggregate so we do it
    // in JS.
    const sorted = [...pool].sort((a, b) => {
      return (a.account._count.threadsBound ?? 0) - (b.account._count.threadsBound ?? 0);
    });
    return sorted[0].accountId;
  }

  return fallbackSendingAccountId;
}

// Parse the candidate's score (0–100) out of the stored analysisResult JSON.
// Missing or malformed analysis → score 0 (fail-soft: a bad analysis shouldn't
// block fan-out entirely).
export function parseScore(analysisResult: string | null, taskId?: string): number {
  if (!analysisResult) return 0;
  try {
    const analysis = JSON.parse(analysisResult) as { scorePercent?: number };
    return analysis?.scorePercent ?? 0;
  } catch (err: any) {
    console.error(`[fanOut] ${taskId ? `Task ${taskId} ` : ""}malformed analysisResult: ${err.message}`);
    return 0;
  }
}

// Decide whether a channel should get a thread for a candidate with the given
// score, and if so, the rule key + follow-up count to stamp on the thread.
// Returns null when no rule band matches (candidate is out of range).
//
// This is the SINGLE source of truth shared by fan-out (thread creation) and
// the "missing threads" badge — so the badge count always equals exactly what
// fan-out would create.
export function evaluateChannelForScore(
  channel: { type: ChannelType; config: unknown },
  score: number,
): { matchedRuleKey: string; followupsTotal: number } | null {
  const config = channel.config as Record<string, unknown>;
  if (channel.type === ChannelType.LINKEDIN) {
    const cfg = config as unknown as LinkedInConfig;
    const rule = matchRule(score, cfg.inviteRules ?? []);
    return rule ? { matchedRuleKey: rule.key, followupsTotal: (cfg.followups ?? []).length } : null;
  }
  if (channel.type === ChannelType.EMAIL) {
    const cfg = config as unknown as EmailConfig;
    const rule = matchRule(score, cfg.emailRules ?? []);
    return rule ? { matchedRuleKey: rule.key, followupsTotal: (cfg.followups ?? []).length } : null;
  }
  if (channel.type === ChannelType.WHATSAPP) {
    const cfg = config as unknown as WAConfig;
    const rule = matchRule(score, cfg.waRules ?? []);
    return rule ? { matchedRuleKey: rule.key, followupsTotal: (cfg.followups ?? []).length } : null;
  }
  return null;
}

// Core fan-out: create the missing ChannelThreads for one task across every
// ACTIVE channel whose rules match the candidate's score. Idempotent via
// @@unique([taskId, channelId]). Does NOT trigger the outreach tick and does
// NOT throw — it returns counts + failures so callers can decide how to react.
// The bulk endpoint loops this and triggers the tick once at the end; the
// single-task wrapper below triggers per call.
export async function fanOutToChannelsCore(
  taskId: string,
  jobId: string,
): Promise<{ created: number; channelCount: number; failures: Array<{ channelId: string; error: Error }> }> {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: { requisitionId: true },
  });
  if (!job?.requisitionId) return { created: 0, channelCount: 0, failures: [] };

  const [task, channels] = await Promise.all([
    prisma.task.findUnique({
      where: { id: taskId },
      select: {
        analysisResult: true,
        // Only non-ARCHIVED threads block fan-out. ARCHIVED threads from a
        // previous outreach round (manual_reset, account_changed, timeout)
        // must not prevent fresh threads being created for the same channel.
        channelThreads: {
          where: { status: { not: "ARCHIVED" } },
          select: { channelId: true },
        },
      },
    }),
    prisma.channel.findMany({
      where: { requisitionId: job.requisitionId, status: "ACTIVE" },
    }),
  ]);

  if (!task || channels.length === 0) return { created: 0, channelCount: channels.length, failures: [] };

  const score = parseScore(task.analysisResult, taskId);
  const existingChannelIds = new Set(task.channelThreads.map(t => t.channelId));

  const failures: Array<{ channelId: string; error: Error }> = [];
  let created = 0;

  for (const channel of channels) {
    if (existingChannelIds.has(channel.id)) continue;

    const evaluated = evaluateChannelForScore(channel, score);
    if (!evaluated) continue;

    // P1 #14 — pick a bound account at thread creation, so the worker has a
    // sticky account from the very first tick rather than re-resolving via
    // channel.sendingAccount each time. Empty pool → fall back to the
    // legacy single-account binding.
    const boundAccountId = await pickAccountForChannel(channel.id, channel.sendingAccountId);

    try {
      await prisma.channelThread.create({
        data: {
          taskId,
          channelId: channel.id,
          channelType: channel.type,
          matchedRuleKey: evaluated.matchedRuleKey,
          followupsTotal: evaluated.followupsTotal,
          nextActionAt: new Date(),
          ...(boundAccountId ? { accountId: boundAccountId } : {}),
        },
      });
      created++;
    } catch (err: any) {
      // P2002 = unique([taskId, channelId]) — thread already exists, safe to skip
      if (err?.code === "P2002") continue;
      console.error(`[fanOutToChannels] Task ${taskId} channel ${channel.id} thread creation failed: ${err.message}`);
      failures.push({ channelId: channel.id, error: err });
    }
  }

  return { created, channelCount: channels.length, failures };
}

export async function fanOutToChannels(taskId: string, jobId: string): Promise<void> {
  const { created, channelCount, failures } = await fanOutToChannelsCore(taskId, jobId);

  // Kick the outreach-tick cron immediately — newly created threads have
  // nextActionAt=now() and would otherwise wait up to ~60s for the next tick.
  // Nothing created → nothing to kick.
  if (created > 0) triggerOutreach();

  if (failures.length > 0) {
    throw new Error(
      `fanOutToChannels: ${failures.length}/${channelCount} channel(s) failed for task ${taskId}: ` +
      failures.map(f => `${f.channelId}=${f.error.message}`).join("; ")
    );
  }
}
