import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { CandidateStage } from "@prisma/client";
import { markThreadReplied } from "@/lib/channels/thread-worker";
import { recomputeTaskStage } from "@/lib/channels/stage-rollup";

export const dynamic = "force-dynamic";

// ─── Shared-secret header verification ────────────────────────────────────────
//
// Unipile's webhook API does not natively HMAC-sign payloads. The supported
// auth mechanism is a static shared-secret header configured per webhook via
// the `headers` field on POST /api/v1/webhooks. We register every webhook with
// `x-unipile-secret: $UNIPILE_WEBHOOK_SECRET` and verify it here.

function verifySecret(req: NextRequest): boolean {
  const expected = process.env.UNIPILE_WEBHOOK_SECRET;
  if (!expected) {
    // Fail-closed in production: a missing secret in prod is a misconfiguration,
    // not a license to accept unauthenticated traffic. Allow only in non-prod env.
    if (process.env.NODE_ENV === "production") {
      console.error("[Webhook/Unipile] UNIPILE_WEBHOOK_SECRET unset in production — rejecting");
      return false;
    }
    return true;
  }

  const got = req.headers.get("x-unipile-secret") ?? "";
  return timingSafeEqual(got, expected);
}

// Constant-time string comparison to prevent timing-attack secret leakage.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

// ─── Webhook event deduplication ─────────────────────────────────────────────
//
// Unipile retries failed deliveries. We deduplicate using WebhookEvent.id
// (the provider's own event ID). Returns true if this is a fresh event.

// P2 #7 / EC-3.5 — per-event-type dedupe key. Each event has a known
// canonical ID field; using it explicitly avoids cross-event collisions
// the old waterfall-fallback could produce (e.g., picking chat_id from
// new_message, then later picking the same chat_id from a chat-level
// status event and treating them as the same delivery).
function extractDedupeId(eventType: string, data: any): string | null {
  if (!data) return null;
  switch (eventType) {
    case "users.new_relation":
    case "users_relations.invitation_accepted":
    case "new_relation":
      // The new_relation payload includes account_id + user_provider_id but
      // NOT invitation_id. Compose a stable dedupe key from both so retries
      // from Unipile are dropped without hitting the DB handler again.
      if (data.account_id && data.user_provider_id) {
        return `${data.account_id}:${data.user_provider_id}`;
      }
      return data.invitation_id ?? data.event_id ?? null;
    case "messaging.message_received":
    case "messaging.new_message":
    case "message_received":
      // Inbound message: message_id is unique per message.
      return data.message_id ?? data.event_id ?? null;
    case "mail_received":
    case "emails.mail_received":
      // Inbound email: provider_id is the unique mail identifier.
      return data.message_id ?? data.provider_id ?? data.event_id ?? null;
    default:
      // Unknown event type: prefer event_id (most specific) and fall back
      // to nothing rather than a generic `id` that may collide.
      return data.event_id ?? null;
  }
}

async function dedupeEvent(provider: string, eventType: string, eventId: string | null): Promise<boolean> {
  if (!eventId) return true; // no id to dedupe on — process it
  try {
    await prisma.webhookEvent.create({
      data: { id: eventId, provider, eventType },
    });
    return true;
  } catch (err: any) {
    if (err.code === "P2002") {
      // Unique constraint = duplicate event — skip
      return false;
    }
    throw err;
  }
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  if (!verifySecret(req)) {
    console.warn("[Webhook/Unipile] Invalid or missing x-unipile-secret header");
    return NextResponse.json({ error: "Invalid secret" }, { status: 401 });
  }

  const rawBody = await req.text();

  let event: { type: string; data: any };
  try {
    const parsed = JSON.parse(rawBody);
    // Unipile new flat format: { event: "message_received", account_id, chat_id, ... }
    // Unipile old wrapped format: { type: "messaging.message_received", data: { ... } }
    // Some flat events (new_relation) omit the event field — derive from webhook_name.
    if (parsed.type) {
      event = parsed;
    } else if (parsed.event) {
      event = { type: parsed.event, data: parsed };
    } else if (parsed.webhook_name) {
      const nameToType: Record<string, string> = {
        "outreach-relations": "new_relation",
        "outreach-messaging": "message_received",
        "outreach-email":     "mail_received",
      };
      event = { type: nameToType[parsed.webhook_name] ?? parsed.webhook_name, data: parsed };
    } else {
      event = parsed;
    }
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // P2 #7 / EC-3.5 / EC-6.2 — per-event-type dedupe key extraction. The
  // previous implementation walked a generic fallback chain
  // (event_id ?? message_id ?? invitation_id ?? id), which could pick a
  // chat-level `id` for a `message_received` event and collide with an
  // unrelated chat-level event later. Each event type has a known ID field;
  // pick the right one explicitly so distinct events never share dedupe keys.
  const eventId = extractDedupeId(event.type, event.data);
  console.log(`[Webhook/Unipile] event=${event.type} eventId=${eventId ?? "none"}`);

  const isDuplicate = !(await dedupeEvent("unipile", event.type, eventId ? `${event.type}:${eventId}` : null));
  if (isDuplicate) {
    console.log(`[Webhook/Unipile] Duplicate event ${event.type}:${eventId} — skipping`);
    return NextResponse.json({ ok: true, duplicate: true });
  }

  try {
    switch (event.type) {
      case "users.new_relation":
      case "users_relations.invitation_accepted":
      case "new_relation":
        await handleInvitationAccepted(event.data);
        break;
      case "messaging.message_received":
      case "messaging.new_message":
      case "message_received":
        await handleNewMessage(event.data);
        break;
      case "mail_received":
      case "emails.mail_received":
        await handleMailReceived(event.data);
        break;
      default:
        console.log(`[Webhook/Unipile] Unhandled event type: ${event.type}`);
    }
  } catch (err: any) {
    console.error(`[Webhook/Unipile] Handler error for ${event.type}:`, err.message);
    return NextResponse.json({ ok: false, error: err.message });
  }

  return NextResponse.json({ ok: true });
}

// ─── Invitation accepted ──────────────────────────────────────────────────────

async function handleInvitationAccepted(data: any) {
  // Try to match a ChannelThread by the stored invitation message ID
  // Bug 5: data?.id is an unsafe catch-all — it could pick up an unrelated webhook
  // envelope ID and produce a spurious DB match. Unipile's new_relation payload
  // does not include invitation_id; if absent we fall through to the provider-ID path.
  const invitationId = data?.invitation_id;
  if (invitationId) {
    const threadMsg = await prisma.threadMessage.findFirst({
      where: { providerMessageId: invitationId, type: "INVITE" },
      select: { threadId: true },
    });
    if (threadMsg) {
      await handleThreadInviteAccepted(threadMsg.threadId);
      return;
    }
  }

  // Fallback: scan INVITE_PENDING threads and match by LinkedIn provider_id
  const attendeeProviderId: string | undefined =
    data?.user_provider_id ??
    data?.user_public_identifier ??
    data?.attendee_provider_id ??
    data?.provider_id ??
    data?.attendee?.provider_id;

  if (attendeeProviderId) {
    const accountId = data?.account_id;
    const thread = await findThreadByProviderUserId(attendeeProviderId, accountId);
    if (thread) {
      await handleThreadInviteAccepted(thread.id);
      return;
    }
  }

  console.warn("[Webhook/Unipile] invitation_accepted: could not match any channel thread — payload:", JSON.stringify(data));
}

async function handleThreadInviteAccepted(threadId: string): Promise<void> {
  const thread = await prisma.channelThread.findUnique({
    where: { id: threadId },
    select: { id: true, taskId: true, status: true, providerState: true, task: { select: { candidateName: true } } },
  });
  if (!thread) return;

  // EC-3.1 — refuse to mutate threads that are no longer in an actionable state.
  // Without this, a delayed invite-accept webhook for a thread we already
  // archived (timeout) would resurrect providerState/nextActionAt onto an
  // ARCHIVED row, which the cron CTE wouldn't pick up but which corrupts
  // dashboards and analytics.
  if (thread.status !== "ACTIVE" && thread.status !== "PENDING") {
    return;
  }

  const ps = (thread.providerState as Record<string, string> | null) ?? {};
  if (ps.phase !== "INVITE_PENDING") {
    return;
  }

  // Status-guarded update: a sibling-reply that flipped this thread to PAUSED
  // between the read above and the update below should not be clobbered.
  const res = await prisma.channelThread.updateMany({
    where: { id: threadId, status: { in: ["ACTIVE", "PENDING"] } },
    data: {
      providerState: { phase: "CONNECTED" },
      nextActionAt: new Date(),
    },
  });
  if (res.count === 0) return;

  await recomputeTaskStage(thread.taskId, { source: "WEBHOOK" });
  const cLabel = thread.task.candidateName ?? `taskId:${thread.taskId.slice(-8)}`;
  console.log(`[Webhook/Unipile] "${cLabel}" invite accepted → CONNECTED (taskId=${thread.taskId})`);
}

async function findThreadByProviderUserId(
  providerUserId: string,
  accountId?: string,
): Promise<{ id: string } | null> {
  const accountFilter = accountId
    ? { OR: [
        { channel: { sendingAccount: { accountId } } },
        { account: { accountId } },
      ] }
    : {};

  // Primary path: indexed candidateProviderId column (set at invite send time).
  // O(1) lookup; covers all threads created after the column was deployed.
  // Bug 2: include PAUSED so a sibling-pause that happened between invite-send
  // and acceptance doesn't cause the acceptance webhook to be silently dropped.
  const indexed = await prisma.channelThread.findFirst({
    where: {
      candidateProviderId: providerUserId,
      status: { in: ["ACTIVE", "PENDING", "PAUSED"] },
      ...accountFilter,
    },
    select: { id: true },
  });
  if (indexed) return indexed;

  // Fallback: JSON scan of task.result for threads sent before the column was
  // added (candidateProviderId IS NULL). Covers the migration window.
  // Bug 2: include PAUSED (same reason as above).
  // Bug 6: providerChatId: null removed — the primary chatId lookup already
  // failed by the time we reach this fallback, so excluding threads that
  // have a chatId stored (e.g. InMail threads) would leave them unrecoverable.
  const legacy = await prisma.channelThread.findMany({
    where: {
      candidateProviderId: null,
      status: { in: ["ACTIVE", "PENDING", "PAUSED"] },
      ...accountFilter,
    },
    select: {
      id: true,
      task: { select: { result: true } },
    },
  });

  for (const t of legacy) {
    try {
      const profile = t.task.result ? JSON.parse(t.task.result as string) : null;
      const pid = profile?.provider_id || profile?.public_identifier;
      if (pid === providerUserId) return { id: t.id };
    } catch { /* skip */ }
  }
  return null;
}

// ─── Inbound message received ─────────────────────────────────────────────────

async function handleNewMessage(data: any) {
  const chatId = data?.chat_id ?? data?.chatId ?? data?.chat?.id;
  // Unipile flat format: compare account_info.user_id with sender.attendee_provider_id.
  // If they match, the connected account sent the message (outbound echo from our API or
  // another device). The legacy boolean fields (is_from_me, from_me, etc.) are NOT present
  // in Unipile's flat webhook payload and must not be relied upon.
  const fromMeRaw = data?.is_from_me ?? data?.from_me ?? data?.is_sender;
  const accountUserId: string | undefined = data?.account_info?.user_id;
  const senderProviderId: string | undefined = data?.sender?.attendee_provider_id;
  const isOutboundEcho = !!(accountUserId && senderProviderId && accountUserId === senderProviderId);
  const isInbound = fromMeRaw !== true && !isOutboundEcho;
  const accountIdFromPayload: string | undefined = data?.account_id;

  if (!chatId) {
    console.warn("[Webhook/Unipile] new_message: no chat_id in payload — full data:", JSON.stringify(data));
    return;
  }
  if (!isInbound) {
    console.log(`[Webhook/Unipile] new_message: outbound echo for chatId=${chatId} — ignoring`);
    return;
  }
  if (data?.is_group === true || data?.is_group === 1) {
    console.log(`[Webhook/Unipile] new_message: group chat message (subject="${data?.subject ?? ""}") — ignoring`);
    return;
  }

  // Phase 3 #16 / EC-3.7 / EC-10.2 — when the same Unipile account messages
  // the same person from two different requisitions, LinkedIn returns the
  // SAME chat_id. A naive findFirst would mark a random one of those threads
  // as REPLIED. Scope by (providerChatId, account.id) to disambiguate, then
  // update *every* matching thread so all relevant requisitions see the
  // reply. (markThreadReplied is idempotent — see lib/channels/thread-worker.ts.)
  // Bug 3: include PAUSED — a sibling reply may have paused this thread, but
  // a reply directly to this chat should still be recorded as REPLIED.
  const threads = await prisma.channelThread.findMany({
    where: {
      providerChatId: chatId,
      status: { in: ["ACTIVE", "PENDING", "PAUSED"] },
      ...(accountIdFromPayload
        ? { channel: { sendingAccount: { accountId: accountIdFromPayload } } }
        : {}),
    },
    select: { id: true, taskId: true, task: { select: { candidateName: true } } },
  });

  if (threads.length === 0) {
    // P1 #18 / EC-3.2 — out-of-order webhook backfill.
    //
    // We get here when `messaging.message_received` arrives BEFORE
    // `users.new_relation` (candidate accepts the invite and replies in quick
    // succession). At that moment the thread is still INVITE_PENDING and has
    // no `providerChatId` stored, so the lookup-by-chat-id returns nothing.
    //
    // Fallback: pull the sender's provider_id from the payload and try to
    // match an INVITE_PENDING thread for the same account. If we find one,
    // backfill `providerChatId` on the thread, mark it CONNECTED → REPLIED,
    // and propagate. This recovers the reply that would otherwise be lost.
    // Resolve the actual sender object. Unipile flat format may include a
    // top-level `sender` object (preferred) or bury it in an attendees array.
    // For WhatsApp the ID fields are `attendee_provider_id` / `attendee_public_identifier`;
    // for LinkedIn they may be `provider_id`. Check both forms.
    const attendeeList: any[] = Array.isArray(data?.attendees) ? data.attendees : [];
    const explicitSender = data?.sender ?? data?.from ?? data?.author;
    const senderAttendee = explicitSender ?? attendeeList.find((a: any) => !a.is_me);
    const senderProviderId: string | undefined =
      senderAttendee?.provider_id ??
      senderAttendee?.attendee_provider_id ??
      senderAttendee?.attendee_id ??
      senderAttendee?.attendee_public_identifier;

    console.log(`[Webhook/Unipile] new_message fallback: chatId=${chatId} account=${accountIdFromPayload ?? "none"} senderProviderId=${senderProviderId ?? "none"} attendees=${JSON.stringify(attendeeList)}`);

    if (senderProviderId) {
      const fallback = await findThreadByProviderUserId(senderProviderId, accountIdFromPayload);
      if (fallback) {
        await prisma.channelThread.updateMany({
          where: { id: fallback.id, status: { in: ["ACTIVE", "PENDING", "PAUSED"] } },
          data: { providerChatId: chatId, providerState: { phase: "CONNECTED" } },
        });
        const t = await prisma.channelThread.findUnique({
          where: { id: fallback.id },
          select: { id: true, taskId: true, task: { select: { candidateName: true } } },
        });
        if (t) {
          await markThreadReplied(t.id, t.taskId);
          await recomputeTaskStage(t.taskId, { source: "WEBHOOK" });
          const cLabel = t.task.candidateName ?? `taskId:${t.taskId.slice(-8)}`;
          console.log(`[Webhook/Unipile] "${cLabel}" replied via LinkedIn (backfill/out-of-order chatId=${chatId} taskId=${t.taskId})`);
          return;
        }
      }
    }

    console.log(`[Webhook/Unipile] new_message: no active thread for chatId=${chatId} senderProviderId=${senderProviderId ?? "none"} (account=${accountIdFromPayload ?? "unknown"}) — ignoring`);
    return;
  }

  for (const t of threads) {
    await markThreadReplied(t.id, t.taskId);
    await recomputeTaskStage(t.taskId, { source: "WEBHOOK" });
    const cLabel = t.task.candidateName ?? `taskId:${t.taskId.slice(-8)}`;
    console.log(`[Webhook/Unipile] "${cLabel}" replied via LinkedIn (chatId=${chatId} taskId=${t.taskId})`);
  }
  if (threads.length > 1) {
    console.log(`[Webhook/Unipile] new_message: ${threads.length} threads matched chatId=${chatId} — all marked REPLIED`);
  }
}

// ─── Inbound email received (Gmail / Outlook) ─────────────────────────────────

async function handleMailReceived(data: any) {
  // Unipile sets in_reply_to.id to the Unipile provider_id of the parent email
  const inReplyToId: string | undefined =
    data?.in_reply_to?.id ??
    data?.in_reply_to?.message_id;

  if (!inReplyToId) {
    // Not a reply — a fresh inbound email, nothing to match against
    return;
  }

  const accountIdFromPayload: string | undefined = data?.account_id;

  // Same multi-thread / account-scoping treatment as handleNewMessage.
  // providerThreadId holds the provider_id of the email we sent (stored at send time).
  // Bug 3: include PAUSED for the same reason as in handleNewMessage.
  const threads = await prisma.channelThread.findMany({
    where: {
      providerThreadId: inReplyToId,
      status: { in: ["ACTIVE", "PENDING", "PAUSED"] },
      ...(accountIdFromPayload
        ? { channel: { sendingAccount: { accountId: accountIdFromPayload } } }
        : {}),
    },
    select: { id: true, taskId: true, task: { select: { candidateName: true } } },
  });

  if (threads.length === 0) {
    console.log(`[Webhook/Unipile] mail_received: no active email thread for in_reply_to=${inReplyToId} (account=${accountIdFromPayload ?? "unknown"}) — ignoring`);
    return;
  }

  for (const t of threads) {
    await markThreadReplied(t.id, t.taskId);
    await recomputeTaskStage(t.taskId, { source: "WEBHOOK" });
    const cLabel = t.task.candidateName ?? `taskId:${t.taskId.slice(-8)}`;
    console.log(`[Webhook/Unipile] "${cLabel}" replied via email (taskId=${t.taskId})`);
  }
}
