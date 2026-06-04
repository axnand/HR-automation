import { prisma } from "@/lib/prisma";
import { ChannelType, ThreadStatus } from "@prisma/client";
import { extractIdentifier } from "@/lib/services/unipile.service";

// WhatsApp free-form messaging window. Outside it, Meta requires an approved
// template, so a free-form interview link can't be sent — same rule the
// thread-worker enforces (lib/channels/thread-worker.ts). Unlike the worker, an
// out-of-window interview send must NOT archive the thread (gap C / §6); we just
// mark the channel un-sendable and surface the reason.
export const WA_WINDOW_MS = 24 * 60 * 60 * 1000;

// Tie-break order when lastInboundAt is equal (or null on every thread).
// LinkedIn > WhatsApp > Email (gap E, docs/interview-flow.md §8).
const CHANNEL_PRIORITY: Record<ChannelType, number> = {
  LINKEDIN: 3,
  WHATSAPP: 2,
  EMAIL: 1,
};

// Minimal sending-account credentials. dsn/apiKey may be null — the Unipile
// service falls back to env (UNIPILE_DSN / UNIPILE_API_KEY) in that case.
export type AccountCreds = {
  id: string;
  accountId: string; // Unipile account_id
  dsn: string | null;
  apiKey: string | null;
};

// Everything the delivery primitive needs to actually send on a channel.
// Never serialize this to the client — it carries account credentials.
export type InterviewSendTarget =
  | { kind: "LINKEDIN"; account: AccountCreds; providerChatId: string | null; providerUserId: string | null }
  | { kind: "EMAIL"; account: AccountCreds; to: string }
  | { kind: "WHATSAPP"; account: AccountCreds; phone: string; chatId: string | null };

export type InterviewChannelCandidate = {
  channelType: ChannelType;
  threadId: string;
  channelId: string;
  status: ThreadStatus;
  lastInboundAt: Date | null;
  sendable: boolean;
  reason: string | null; // why not sendable (recruiter-facing); null when sendable
  target: InterviewSendTarget | null; // internal — present iff sendable
};

export type PickInterviewChannelResult = {
  picked: InterviewChannelCandidate | null; // highest-ranked SENDABLE candidate, or null → LINK_ONLY
  candidates: InterviewChannelCandidate[]; // all non-archived threads, ranked best-first
};

// Safe projection for API responses — strips the credential-bearing target.
export type PublicInterviewChannel = {
  channelType: ChannelType;
  status: ThreadStatus;
  sendable: boolean;
  reason: string | null;
};

export function toPublicChannel(c: InterviewChannelCandidate): PublicInterviewChannel {
  return { channelType: c.channelType, status: c.status, sendable: c.sendable, reason: c.reason };
}

function firstEmail(contact: {
  email: string | null;
  personalEmail: string | null;
  workEmail: string | null;
  linkedinEmail: string | null;
} | null): string | null {
  if (!contact) return null;
  return contact.email || contact.personalEmail || contact.workEmail || contact.linkedinEmail || null;
}

function linkedInProviderId(resultRaw: string | null, url: string): string | null {
  let profile: any = null;
  if (resultRaw) {
    try {
      profile = JSON.parse(resultRaw);
    } catch {
      /* ignore */
    }
  }
  return profile?.provider_id || profile?.public_identifier || extractIdentifier(url) || null;
}

/**
 * Resolve and rank the channels an interview link could go out on for a
 * candidate (Task). Considers only non-ARCHIVED threads — PAUSED and REPLIED
 * count as sendable (gap C: the INTERVIEW stage move pauses every thread just
 * before the send, so excluding PAUSED would leave nothing to send on).
 *
 * `picked` is the highest-ranked SENDABLE channel (most recent inbound first,
 * then channel priority); null means no open channel → caller falls back to
 * LINK_ONLY (copy-link). `candidates` lists every non-archived thread with a
 * sendable flag + reason, for the composer dropdown and the bulk breakdown.
 */
export async function pickInterviewChannel(taskId: string): Promise<PickInterviewChannelResult> {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: {
      url: true,
      result: true,
      contact: {
        select: { email: true, personalEmail: true, workEmail: true, linkedinEmail: true, phone: true },
      },
      channelThreads: {
        where: { status: { not: ThreadStatus.ARCHIVED } },
        select: {
          id: true,
          channelId: true,
          channelType: true,
          status: true,
          lastInboundAt: true,
          providerChatId: true,
          accountId: true,
          account: { select: { id: true, accountId: true, dsn: true, apiKey: true, deletedAt: true, status: true } },
          channel: {
            select: {
              id: true,
              sendingAccount: { select: { id: true, accountId: true, dsn: true, apiKey: true, deletedAt: true, status: true } },
            },
          },
        },
      },
    },
  });

  if (!task) return { picked: null, candidates: [] };

  const email = firstEmail(task.contact);
  const phone = task.contact?.phone ?? null;
  const providerUserId = linkedInProviderId(task.result, task.url);

  const candidates: InterviewChannelCandidate[] = task.channelThreads.map((t) => {
    // Sticky thread account wins; otherwise the channel's default sender (EC-9.3).
    const acc = t.account ?? t.channel.sendingAccount;
    const base = {
      channelType: t.channelType,
      threadId: t.id,
      channelId: t.channelId,
      status: t.status,
      lastInboundAt: t.lastInboundAt,
    };

    if (!acc || acc.deletedAt || acc.status === "DISABLED") {
      return { ...base, sendable: false, reason: "No active sending account on this channel", target: null };
    }
    const account: AccountCreds = { id: acc.id, accountId: acc.accountId, dsn: acc.dsn, apiKey: acc.apiKey };

    switch (t.channelType) {
      case "LINKEDIN": {
        if (!t.providerChatId && !providerUserId) {
          return { ...base, sendable: false, reason: "No LinkedIn conversation or profile id to message", target: null };
        }
        return {
          ...base,
          sendable: true,
          reason: null,
          target: { kind: "LINKEDIN", account, providerChatId: t.providerChatId, providerUserId },
        };
      }
      case "EMAIL": {
        if (!email) {
          return { ...base, sendable: false, reason: "No email address on file for this candidate", target: null };
        }
        return { ...base, sendable: true, reason: null, target: { kind: "EMAIL", account, to: email } };
      }
      case "WHATSAPP": {
        if (!phone) {
          return { ...base, sendable: false, reason: "No phone number on file for this candidate", target: null };
        }
        const outsideWindow = !t.lastInboundAt || Date.now() - t.lastInboundAt.getTime() > WA_WINDOW_MS;
        if (outsideWindow) {
          return {
            ...base,
            sendable: false,
            reason: "Outside the WhatsApp 24h window — free-form messages need an approved template",
            target: null,
          };
        }
        return {
          ...base,
          sendable: true,
          reason: null,
          target: { kind: "WHATSAPP", account, phone, chatId: t.providerChatId },
        };
      }
      default:
        return { ...base, sendable: false, reason: "Unsupported channel", target: null };
    }
  });

  // Rank: most recent inbound first (nulls last), then channel priority.
  candidates.sort((a, b) => {
    const at = a.lastInboundAt ? a.lastInboundAt.getTime() : -Infinity;
    const bt = b.lastInboundAt ? b.lastInboundAt.getTime() : -Infinity;
    if (at !== bt) return bt - at;
    return CHANNEL_PRIORITY[b.channelType] - CHANNEL_PRIORITY[a.channelType];
  });

  const picked = candidates.find((c) => c.sendable) ?? null;
  return { picked, candidates };
}
