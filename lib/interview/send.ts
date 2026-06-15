import { prisma } from "@/lib/prisma";
import { ChannelType, InterviewSentVia } from "@prisma/client";
import { getBaseUrl } from "@/lib/trigger";
import { startChat, sendChatMessage, sendEmail, sendWhatsApp } from "@/lib/services/unipile.service";
import { getOrCreateOpenInterviewSession } from "./session";
import { pickInterviewChannel, InterviewChannelCandidate } from "./channel";
import { renderInterviewMessage, safeParseJson } from "./render";

const SENT_VIA_BY_CHANNEL: Record<ChannelType, InterviewSentVia> = {
  LINKEDIN: InterviewSentVia.LINKEDIN,
  EMAIL: InterviewSentVia.EMAIL,
  WHATSAPP: InterviewSentVia.WHATSAPP,
};

export type SendInterviewLinkSource = "MANUAL" | "STAGE_TRIGGER" | "BULK" | "FOLLOWUP";

export type SendInterviewLinkInput = {
  taskId: string;
  /** Explicit channel (composer choice / forced bulk). Omit to auto-pick. */
  channelType?: ChannelType;
  /** Composer-edited final body. Already link-substituted; must contain the link. */
  customText?: string;
  /** Composer-edited email subject (email channel only). */
  customSubject?: string;
  /** false (default) → no-op if the session is already SENT; true → resend. */
  allowResend?: boolean;
  source: SendInterviewLinkSource;
};

export type SendInterviewLinkResult =
  | {
      ok: true;
      sessionId: string;
      link: string;
      sentVia: InterviewSentVia;
      channelType: ChannelType | null; // null for LINK_ONLY
      alreadySent?: boolean; // true when we skipped because it was already sent / in progress
      noChannel?: boolean; // true for LINK_ONLY (nothing sendable)
      providerMessageId?: string | null;
    }
  | {
      ok: false;
      code: "NOT_FOUND" | "NO_LINK_VAR" | "CHANNEL_NOT_SENDABLE" | "SEND_FAILED";
      error: string;
      sessionId?: string;
      link?: string;
    };

/**
 * Deliver an interview link to a candidate on an already-open channel — the
 * single delivery primitive behind triggers A/B/C/E (docs/interview-flow.md §6).
 *
 * Ad-hoc by design, mirroring send-dm's MECHANISM but not its guards:
 *   • Does NOT check task.stage (trigger A moves the task to INTERVIEW first; a
 *     CONNECTED guard would 409 against the stage we just set).
 *   • Does its OWN WhatsApp 24h-window check (in the picker) and on a miss leaves
 *     the session PENDING + surfaces the reason — it never archives the thread,
 *     unlike the followup worker.
 *   • Never mutates the ChannelThread (no status flip, no nextActionAt): the
 *     thread stays PAUSED and the followup sequence stays paused. We only record
 *     an OutreachMessage (timeline/audit) + advance the session.
 *
 * The Unipile send happens OUTSIDE any DB transaction (network call); only the
 * record-write is transactional. Failures leave the session PENDING + return an
 * error — we never mark SENT for a send that didn't leave.
 */
export async function sendInterviewLink(input: SendInterviewLinkInput): Promise<SendInterviewLinkResult> {
  const { taskId, channelType, customText, customSubject, allowResend = false, source } = input;

  // findUnique is intentionally not soft-delete filtered (CLAUDE.md) — guard here.
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      deletedAt: true,
      candidateName: true,
      result: true,
      analysisResult: true,
      job: { select: { requisition: { select: { config: true } } } },
    },
  });
  if (!task || task.deletedAt) {
    return { ok: false, code: "NOT_FOUND", error: "Candidate not found" };
  }

  // Resolve the channel BEFORE minting a session, so a forced channel that isn't
  // sendable (the common bulk "skip" case) returns without creating a stray
  // PENDING session.
  const { picked, candidates } = await pickInterviewChannel(taskId);
  let candidate: InterviewChannelCandidate | null;
  if (channelType) {
    candidate = candidates.find((c) => c.channelType === channelType) ?? null;
    if (!candidate) {
      return { ok: false, code: "CHANNEL_NOT_SENDABLE", error: `No ${channelType} conversation open with this candidate` };
    }
    if (!candidate.sendable || !candidate.target) {
      return { ok: false, code: "CHANNEL_NOT_SENDABLE", error: candidate.reason ?? `Cannot send on ${channelType}` };
    }
  } else {
    candidate = picked;
  }

  // Reuse-or-create the one open session (advisory-locked; resolves dedup race).
  const { session } = await getOrCreateOpenInterviewSession(taskId);
  const link = `${getBaseUrl()}/interview/${session.accessToken}`;

  // Dedup guard #2 — don't re-send / interrupt.
  if (session.status === "IN_PROGRESS") {
    return { ok: true, sessionId: session.id, link, sentVia: InterviewSentVia.LINK_ONLY, channelType: null, alreadySent: true };
  }
  if (session.status === "SENT" && !allowResend) {
    return {
      ok: true,
      sessionId: session.id,
      link,
      sentVia: session.sentVia ?? InterviewSentVia.LINK_ONLY,
      channelType: null,
      alreadySent: true,
    };
  }

  // No sendable channel anywhere → LINK_ONLY (mint the link for manual copy).
  if (!candidate || !candidate.target) {
    await prisma.interviewSession.updateMany({
      where: { id: session.id, status: "PENDING" },
      data: { sentVia: InterviewSentVia.LINK_ONLY },
    });
    console.log(`[interview/send] taskId=${taskId} source=${source} → LINK_ONLY (no sendable channel)`);
    return { ok: true, sessionId: session.id, link, sentVia: InterviewSentVia.LINK_ONLY, channelType: null, noChannel: true };
  }

  // ── Build the message ──────────────────────────────────────────────────────
  let body: string;
  let subject: string | null = null;

  if (typeof customText === "string") {
    // Composer-edited text carries the {{interviewLink}} token (preferred) or the
    // already-substituted raw link. Accept either; refuse if neither is present
    // (§8 gap A — never send interview copy with no link). Substitute the token
    // with the real link before sending.
    const hasToken = /\{\{\s*interviewLink\s*\}\}/i.test(customText);
    if (!hasToken && !customText.includes(link)) {
      return { ok: false, code: "NO_LINK_VAR", error: "Message must contain the interview link", sessionId: session.id, link };
    }
    body = customText.replace(/\{\{\s*interviewLink\s*\}\}/gi, link);
    if (candidate.channelType === "EMAIL") {
      subject = customSubject ?? (await renderInterviewMessage({
        requisitionConfigRaw: task.job?.requisition?.config ?? null,
        profile: safeParseJson(task.result),
        analysis: safeParseJson(task.analysisResult),
        link,
        forChannel: "EMAIL",
      })).subject;
    }
  } else {
    const rendered = await renderInterviewMessage({
      requisitionConfigRaw: task.job?.requisition?.config ?? null,
      profile: safeParseJson(task.result),
      analysis: safeParseJson(task.analysisResult),
      link,
      forChannel: candidate.channelType,
    });
    if (!rendered.hasLinkVar) {
      return { ok: false, code: "NO_LINK_VAR", error: "Interview template is missing the {{interviewLink}} variable", sessionId: session.id, link };
    }
    body = rendered.body;
    subject = candidate.channelType === "EMAIL" ? (customSubject ?? rendered.subject) : null;
  }

  // ── Send (network call, outside any DB transaction) ─────────────────────────
  const target = candidate.target;
  const tag = `interview:${taskId}`;
  let providerMessageId: string | null = null;
  let providerChatId: string | null = null;

  try {
    if (target.kind === "LINKEDIN") {
      if (target.providerChatId) {
        const { messageId } = await sendChatMessage({
          accountId: target.account.accountId,
          chatId: target.providerChatId,
          text: body,
          accountDsn: target.account.dsn ?? undefined,
          accountApiKey: target.account.apiKey ?? undefined,
        });
        providerMessageId = messageId || null;
        providerChatId = target.providerChatId;
      } else {
        const { chatId, messageId } = await startChat({
          accountId: target.account.accountId,
          providerUserId: target.providerUserId!,
          text: body,
          accountDsn: target.account.dsn ?? undefined,
          accountApiKey: target.account.apiKey ?? undefined,
        });
        providerMessageId = messageId || null;
        providerChatId = chatId || null;
      }
    } else if (target.kind === "EMAIL") {
      const res = await sendEmail({
        account: { accountId: target.account.accountId, dsn: target.account.dsn, apiKey: target.account.apiKey },
        to: target.to,
        subject: subject ?? "Interview invitation",
        body,
        tag,
      });
      if (!res.ok) return { ok: false, code: "SEND_FAILED", error: res.error, sessionId: session.id, link };
      providerMessageId = res.messageId ?? null;
    } else {
      // WHATSAPP
      const res = await sendWhatsApp({
        account: { accountId: target.account.accountId, dsn: target.account.dsn, apiKey: target.account.apiKey },
        message: body,
        phone: target.phone,
        chatId: target.chatId ?? undefined,
        tag,
      });
      if (!res.ok) return { ok: false, code: "SEND_FAILED", error: res.error, sessionId: session.id, link };
      providerMessageId = res.messageId ?? null;
      providerChatId = res.chatId ?? target.chatId ?? null;
    }
  } catch (err: any) {
    // Provider/rate/network error — leave the session PENDING, surface it.
    console.error(`[interview/send] taskId=${taskId} channel=${candidate.channelType} source=${source} send failed:`, err?.message ?? err);
    return { ok: false, code: "SEND_FAILED", error: err?.message ?? "Send failed", sessionId: session.id, link };
  }

  // ── Record (transactional). Timeline = OutreachMessage, the same surface the
  // ad-hoc send-dm / send-invite routes write. We deliberately do NOT write a
  // ThreadMessage or touch the ChannelThread: an interview link is an ad-hoc
  // out-of-band send, not part of the thread's followup sequence (the thread
  // stays PAUSED). See docs/interview-flow.md §6. ──────────────────────────────
  const now = new Date();
  const sentVia = SENT_VIA_BY_CHANNEL[candidate.channelType];
  await prisma.$transaction([
    prisma.outreachMessage.create({
      data: {
        campaignId: `${candidate.channelId}:interview`,
        taskId,
        channel: `${candidate.channelType}_INTERVIEW`,
        status: "SENT",
        renderedSubject: subject,
        renderedBody: body,
        approvedAt: now,
        sentAt: now,
        providerMessageId,
        providerChatId,
      },
    }),
    prisma.interviewSession.updateMany({
      where: { id: session.id, status: { in: ["PENDING", "SENT"] } },
      data: { status: "SENT", sentVia, sentAt: now },
    }),
  ]);

  const cLabel = task.candidateName ?? `taskId:${taskId.slice(-8)}`;
  console.log(`[interview/send] "${cLabel}" → ${candidate.channelType} (source=${source} session=${session.id})`);

  return { ok: true, sessionId: session.id, link, sentVia, channelType: candidate.channelType, providerMessageId };
}
