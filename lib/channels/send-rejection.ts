// ─── Rejection notification sender ───────────────────────────────────────────
//
// Fired (fire-and-forget) by applyStageTransition when a recruiter moves a task
// to REJECTED. Sends ONE courtesy "we're not moving forward" message through
// the conversation the candidate already had, so recruiters don't have to
// inform each person manually.
//
// Design decisions (see conversation / CLAUDE.md):
//   • REJECTED only. ARCHIVED is frequently "role filled / on hold / parking"
//     and must stay silent — the caller only invokes us for REJECTED, and we
//     defend that here too.
//   • One channel per candidate. A candidate contacted on LinkedIn AND email
//     must not get two rejection messages. We pick the single thread the
//     candidate most engaged with (inbound reply), else the most recently
//     active one.
//   • Opt-in per channel. A channel without `rejectionTemplate` is skipped.
//   • Idempotent. If this task already has a REJECTION message, we never send
//     a second one (covers re-reject after un-reject, REJECTED↔ARCHIVED toggles).
//   • Guarded for bulk safety. The bulk-stage route fires this for up to 500
//     tasks at once; without throttling that's a 500-message burst from one
//     account → ban risk. We bound it with (a) a process-wide concurrency
//     semaphore, (b) account-health checks, (c) a per-channel daily rejection
//     cap, and (d) the WhatsApp 24h-window rule.
//
// We never send unsubstituted templates (renderTemplate throws on unknown
// tokens) and we never mutate thread status — archiveAll already set ARCHIVED.

import { CandidateStage, OutreachType, AccountStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { buildVars, renderTemplate } from "@/lib/outreach/render-template";
import { sendChatMessage, sendEmail } from "@/lib/services/unipile.service";

const WA_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_CONCURRENT_SENDS = 3;

// Process-wide concurrency limiter. The bulk-stage route awaits each
// applyStageTransition sequentially but fires this fire-and-forget, so up to
// `bulk size` of these can be in flight at once in the API process. The
// semaphore drips them out a few at a time instead of hammering the provider.
let active = 0;
const queue: Array<() => void> = [];
function acquire(): Promise<void> {
  return new Promise(resolve => {
    if (active < MAX_CONCURRENT_SENDS) {
      active++;
      resolve();
    } else {
      queue.push(resolve);
    }
  });
}
function release(): void {
  const next = queue.shift();
  if (next) next(); // hand the held slot directly to the next waiter
  else active--;
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

type AccountRow = {
  id: string;
  accountId: string;
  dsn: string | null;
  apiKey: string | null;
};

// An account is usable for an inline send only if it's ACTIVE and not
// soft-deleted. COOLDOWN/BUSY are transient — the worker would reschedule, but
// we have no queue to reschedule into, so we skip (candidate not notified).
async function resolveSendableAccount(accountDbId: string | null): Promise<AccountRow | null> {
  if (!accountDbId) return null;
  const acc = await prisma.account.findUnique({
    where: { id: accountDbId },
    select: { id: true, accountId: true, dsn: true, apiKey: true, status: true, deletedAt: true },
  });
  if (!acc || acc.deletedAt || acc.status !== AccountStatus.ACTIVE) return null;
  return { id: acc.id, accountId: acc.accountId, dsn: acc.dsn, apiKey: acc.apiKey };
}

export async function sendRejectionNotifications(
  taskId: string,
  toStage: CandidateStage,
  reason?: string | null,
): Promise<void> {
  // ARCHIVED stays silent — defend the caller's contract.
  if (toStage !== CandidateStage.REJECTED) return;
  const short = taskId.slice(-8);

  // Idempotency: one rejection per task, ever.
  const alreadyNotified = await prisma.threadMessage.count({
    where: { type: OutreachType.REJECTION, thread: { taskId } },
  });
  if (alreadyNotified > 0) {
    console.log(`[Rejection] task ${short} already notified — skipping`);
    return;
  }

  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: {
      result: true,
      analysisResult: true,
      contact: { select: { workEmail: true, email: true, personalEmail: true } },
    },
  });
  if (!task) return;

  const recipientEmail = task.contact?.workEmail || task.contact?.email || task.contact?.personalEmail || null;

  // Every thread with an established conversation. archiveAll already set these
  // ARCHIVED, so we deliberately don't filter on status.
  const threads = await prisma.channelThread.findMany({
    where: {
      taskId,
      OR: [{ providerChatId: { not: null } }, { providerThreadId: { not: null } }],
    },
    select: {
      id: true,
      channelType: true,
      providerChatId: true,
      providerThreadId: true,
      accountId: true,
      lastInboundAt: true,
      lastMessageAt: true,
      channel: { select: { id: true, config: true, dailyCap: true, sendingAccountId: true } },
    },
  });
  if (threads.length === 0) {
    console.log(`[Rejection] task ${short} — no conversation to notify on`);
    return;
  }

  // Build the set of genuinely sendable threads (template configured, account
  // healthy, recipient reachable, WA window open), then pick the best one.
  type Candidate = { thread: (typeof threads)[number]; account: AccountRow; recipientEmail: string | null };
  const candidates: Candidate[] = [];
  for (const t of threads) {
    const config = t.channel.config as Record<string, unknown>;
    if (typeof config.rejectionTemplate !== "string" || !config.rejectionTemplate.trim()) continue; // opt-in

    if (t.channelType === "WHATSAPP") {
      // Outside Meta's 24h window a free-form message fails / needs an approved
      // template (unsupported). Mirrors the worker's WA rule.
      const li = t.lastInboundAt;
      if (!li || Date.now() - li.getTime() > WA_WINDOW_MS) continue;
    }
    if (t.channelType === "EMAIL" && !recipientEmail) continue;

    const account = await resolveSendableAccount(t.accountId ?? t.channel.sendingAccountId);
    if (!account) continue;

    candidates.push({ thread: t, account, recipientEmail });
  }
  if (candidates.length === 0) {
    console.log(`[Rejection] task ${short} — no sendable channel (no template / account unavailable / WA window closed / no email)`);
    return;
  }

  // Prefer the channel the candidate engaged with (had an inbound message),
  // then the most recently active. Engagement always outranks recency.
  candidates.sort((a, b) => rankThread(b.thread) - rankThread(a.thread));
  const chosen = candidates[0];

  const config = chosen.thread.channel.config as Record<string, unknown>;
  const profile = task.result ? JSON.parse(task.result as string) : {};
  const analysis = task.analysisResult ? JSON.parse(task.analysisResult as string) : {};
  const vars = { ...buildVars(profile, analysis), reason: reason ?? "" };

  await acquire();
  try {
    // Per-channel daily rejection cap — re-checked inside the critical section
    // so a concurrent bulk burst can't all read 0 and blow past it. Bounds how
    // many rejections one channel fires per day; protects the account.
    const sentToday = await prisma.threadMessage.count({
      where: {
        type: OutreachType.REJECTION,
        status: "SENT",
        sentAt: { gte: startOfToday() },
        thread: { channelId: chosen.thread.channel.id },
      },
    });
    if (sentToday >= chosen.thread.channel.dailyCap) {
      console.warn(
        `[Rejection] task ${short} — channel ${chosen.thread.channel.id} hit daily rejection cap ` +
          `(${sentToday}/${chosen.thread.channel.dailyCap}); candidate NOT notified`,
      );
      return;
    }

    await sendOne(chosen, config.rejectionTemplate as string, config.rejectionSubjectTemplate as string | undefined, vars, toStage, short);
  } catch (err) {
    console.error(`[Rejection] task ${short} send failed:`, err);
  } finally {
    release();
  }
}

function rankThread(t: { lastInboundAt: Date | null; lastMessageAt: Date | null }): number {
  const engaged = t.lastInboundAt ? Number.MAX_SAFE_INTEGER : 0;
  const recency = t.lastMessageAt?.getTime() ?? 0;
  return engaged + recency;
}

type SendCandidate = {
  thread: {
    id: string;
    channelType: string;
    providerChatId: string | null;
    providerThreadId: string | null;
  };
  account: AccountRow;
  recipientEmail: string | null;
};

async function sendOne(
  candidate: SendCandidate,
  template: string,
  subjectTemplate: string | undefined,
  vars: ReturnType<typeof buildVars> & { reason: string },
  toStage: CandidateStage,
  short: string,
): Promise<void> {
  const { thread, account } = candidate;
  const renderedBody = renderTemplate(template, vars); // throws on unknown tokens → no send
  const tag = `[Rejection:${thread.id.slice(-6)}]`;
  let providerMessageId: string | null = null;
  let renderedSubject: string | undefined;

  if (thread.channelType === "LINKEDIN" || thread.channelType === "WHATSAPP") {
    if (!thread.providerChatId) return;
    const result = await sendChatMessage({
      accountId: account.accountId,
      chatId: thread.providerChatId,
      text: renderedBody,
      accountDsn: account.dsn ?? undefined,
      accountApiKey: account.apiKey ?? undefined,
    });
    providerMessageId = result.messageId || null;
  } else if (thread.channelType === "EMAIL") {
    if (!candidate.recipientEmail) return;
    renderedSubject = subjectTemplate ? renderTemplate(subjectTemplate, vars) : "Update on your application";
    const result = await sendEmail({
      account: { accountId: account.accountId, dsn: account.dsn, apiKey: account.apiKey },
      to: candidate.recipientEmail,
      toName: vars.name || candidate.recipientEmail,
      subject: renderedSubject,
      body: renderedBody,
      tag,
      replyToId: thread.providerThreadId ?? undefined, // thread the reply into the existing email
    });
    if (!result.ok) {
      console.error(`${tag} email send failed: ${result.error}`);
      return;
    }
    providerMessageId = result.messageId ?? null;
  } else {
    return;
  }

  await prisma.threadMessage.create({
    data: {
      threadId: thread.id,
      type: OutreachType.REJECTION,
      status: "SENT",
      renderedBody,
      renderedSubject,
      sentAt: new Date(),
      providerMessageId,
      accountId: account.id,
    },
  });
  console.log(`[Rejection] task ${short} notified via ${thread.channelType} (${tag})`);
}
