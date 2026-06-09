// ─── Thread worker: processes one ChannelThread tick ─────────────────────────
//
// Called by the outreach-tick cron for every ChannelThread whose nextActionAt
// has passed. Each call advances the thread by exactly one step:
//   PENDING  → send initial message (invite / InMail / email / WhatsApp)
//   ACTIVE   → send next followup (or archive if all exhausted)
//   Any      → archive if provider timeout detected
//
// On success the worker sets the next nextActionAt.
// On failure the cron resets nextActionAt to now+5min for automatic retry.
//
// All API calls are OUTSIDE database transactions — we only hold row locks
// during the brief UPDATE that claims the thread in the cron query.

import { prisma } from "@/lib/prisma";
import { ChannelType, OutreachType, CandidateStage, type Prisma } from "@prisma/client";
import { CONFIG } from "@/lib/config";
import {
  sendInvitation,
  sendInMail,
  startChat,
  sendChatMessage,
  sendEmail,
  sendWhatsApp,
  listSentInvitations,
  cancelInvitation,
} from "@/lib/services/unipile.service";
import { buildVars, renderTemplate } from "@/lib/outreach/render-template";
import { recomputeTaskStage } from "./stage-rollup";
import {
  matchRule,
  quietHoursEnd,
  type LinkedInConfig,
  type EmailConfig,
  type WAConfig,
  type LinkedInInviteRule,
  type QuietHours,
  type FollowupRule,
} from "./types";

// ─── Race protection ──────────────────────────────────────────────────────────
//
// Between the moment processThread reads its row and the moment we commit a
// closing transaction, several events can race us:
//   1. A reply webhook flips this thread to REPLIED.
//   2. A reply on a sibling thread flips this one to PAUSED.
//   3. A timeout sweep flips it to ARCHIVED.
//   4. A recruiter sets task.manualStage to INTERVIEW / HIRED / REJECTED.
//
// In all four cases the right answer is "do not send (or, if the API call
// already left the building, do not record the send as a state advance)."
//
// `verifyThreadStillSendable` is the pre-API guard: re-read status + manual
// stage one more time just before the (slow) provider HTTP call.
//
// Closing transactions further use updateMany with a status filter so an
// in-flight webhook that lands DURING the API call still cannot overwrite
// the REPLIED state with our outdated MESSAGED. If updateMany matches 0
// rows, we skip the ThreadMessage insert too — the row would point at a
// thread state that the rest of the system has already decided is over.

const MANUAL_WINS_FOR_STAGE = new Set<CandidateStage>([
  CandidateStage.INTERVIEW,
  CandidateStage.HIRED,
  CandidateStage.REJECTED,
]);

type SendableCheck =
  | { ok: true }
  | { ok: false; reason: string };

async function verifyThreadStillSendable(threadId: string): Promise<SendableCheck> {
  const cur = await prisma.channelThread.findUnique({
    where: { id: threadId },
    select: {
      status: true,
      task: { select: { manualStage: true } },
    },
  });
  if (!cur) return { ok: false, reason: "thread not found" };
  if (cur.status !== "PENDING" && cur.status !== "ACTIVE") {
    return { ok: false, reason: `status flipped to ${cur.status}` };
  }
  const ms = cur.task.manualStage;
  if (ms && MANUAL_WINS_FOR_STAGE.has(ms)) {
    return { ok: false, reason: `task.manualStage=${ms}` };
  }
  return { ok: true };
}

// Closing-transaction status guard: the where clause includes status filter so
// a webhook that flipped the thread to REPLIED/PAUSED/ARCHIVED in the meantime
// cannot be clobbered by our update. Returns true if the update landed.
type GuardedThreadUpdateData = Parameters<typeof prisma.channelThread.updateMany>[0]["data"];
// Use the unchecked variant so call sites can pass flat foreign-key fields
// (threadId, accountId) rather than nested connect objects.
type ThreadMessageCreateData = Prisma.ThreadMessageUncheckedCreateInput;

async function commitSentMessage(
  threadId: string,
  accountId: string,
  threadData: GuardedThreadUpdateData,
  messageData: ThreadMessageCreateData,
  tag: string,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    // Always clear the pending-send marker on a successful commit (idempotent),
    // and bind the sending account stickily to the thread (EC-9.3). For
    // pre-existing threads the first commit sets accountId; subsequent commits
    // write the same value (worker always reads thread.account first, then
    // falls back to channel.sendingAccount).
    const dataWithMarkerCleared: GuardedThreadUpdateData = {
      ...threadData,
      accountId,
      pendingSendKey: null,
      pendingSendStartedAt: null,
      // P1 #41 — successful commit resets the circuit-breaker counter so
      // recoverable transient failures don't accumulate forever.
      consecutiveFailures: 0,
    };
    const res = await tx.channelThread.updateMany({
      where: { id: threadId, status: { in: ["PENDING", "ACTIVE"] } },
      data: dataWithMarkerCleared,
    });
    if (res.count === 0) {
      // A webhook (REPLIED) or sibling-pause / archive flipped this thread
      // while the provider API call was in flight. The message has already
      // been sent — we can't unsend it — but we DO NOT advance our local
      // state, so subsequent ticks won't try to send another follow-up to
      // a candidate who has already replied.
      console.warn(`${tag} Status changed during send — outbound message has left, but local state preserved`);
      return false;
    }
    try {
      await tx.threadMessage.create({
        // EC-9.3 — frozen-at-send forensic record of which account sent this.
        data: { ...messageData, accountId },
      });
    } catch (err: any) {
      if (err.code === "P2002") {
        // EC-6.1 — duplicate (threadId, providerMessageId). The provider
        // returned the same message ID twice (likely a transparent retry
        // succeeded earlier). The thread row is already updated with the
        // latest counters; just swallow the duplicate row.
        console.warn(`${tag} Duplicate ThreadMessage suppressed by unique constraint`);
        return true;
      }
      throw err;
    }
    // Outreach is throttled by budgets that are intentionally SEPARATE from the
    // scraping/sourcing budget (Account.dailyCount):
    //   1. the per-channel daily send cap (Channel.dailyCap), enforced via
    //      isDailyCapReached() counting ThreadMessage rows for the channel; and
    //   2. the per-account LinkedIn WEEKLY invite cap (Account.weeklyCount).
    // We deliberately do NOT bump Account.dailyCount here. That counter is the
    // scraping pipeline's budget; previously lumping outreach into it meant
    // heavy sourcing on a shared account starved outreach (and vice-versa).
    // Keeping the two budgets independent means neither cannibalizes the other.
    //
    // P1 #27 — still bump the weekly counter (the weekly cap check only applies
    // to LinkedIn channels, but we increment unconditionally to keep this
    // simple). Set weeklyResetAt to 7 days out if it's null or already expired.
    const now = new Date();
    const weekFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    await tx.account.update({
      where: { id: accountId },
      data: {
        weeklyCount: { increment: 1 },
        requestCount: { increment: 1 },
        lastUsedAt: now,
        // Only push weeklyResetAt forward if it's null or in the past — once
        // set within an active 7-day window we leave it alone so the window
        // tracks the FIRST send in the current week, not the most recent.
        weeklyResetAt: undefined, // placeholder; we set below conditionally
      },
    });
    // Conditional weeklyResetAt: set only when null or expired. Done as a
    // separate update because Prisma doesn't support conditional column
    // updates in a single update call.
    await tx.account.updateMany({
      where: {
        id: accountId,
        OR: [{ weeklyResetAt: null }, { weeklyResetAt: { lt: now } }],
      },
      data: { weeklyResetAt: weekFromNow },
    });
    return true;
  });
}

// Phase 3 #11 / EC-4.1 — write a marker BEFORE the provider API call so a
// crash between the API success and the DB commit leaves a forensic trail
// (pendingSendKey IS NOT NULL AND pendingSendStartedAt < now-10min). The
// commit clears the marker; a future heal job will find stale ones and
// reset them rather than silently re-sending.
//
// Returns the key on success, or null if the thread is no longer sendable
// (caller should bail and skip the API call).
async function markPendingSend(threadId: string): Promise<string | null> {
  const key = crypto.randomUUID();
  const res = await prisma.channelThread.updateMany({
    where: { id: threadId, status: { in: ["PENDING", "ACTIVE"] } },
    data: { pendingSendKey: key, pendingSendStartedAt: new Date() },
  });
  return res.count > 0 ? key : null;
}

// Same pattern but for state-only transitions where the only update is on the
// thread row itself (no ThreadMessage write). E.g., quiet-hour reschedules,
// daily-cap reschedules, retry waits.
async function guardedThreadUpdate(
  threadId: string,
  data: GuardedThreadUpdateData,
): Promise<boolean> {
  const res = await prisma.channelThread.updateMany({
    where: { id: threadId, status: { in: ["PENDING", "ACTIVE"] } },
    data,
  });
  return res.count > 0;
}

// ─── Public entry point ───────────────────────────────────────────────────────

export async function processThread(threadId: string): Promise<void> {
  const thread = await prisma.channelThread.findUnique({
    where: { id: threadId },
    include: {
      channel: {
        include: { sendingAccount: true },
      },
      // EC-9.3 — sticky thread.account binding takes precedence over
      // channel.sendingAccount. Once set on the first send, follow-ups always
      // come from this exact account regardless of channel-level config edits.
      account: true,
      task: {
        select: {
          id: true,
          result: true,
          analysisResult: true,
          contact: { select: { email: true, workEmail: true, personalEmail: true, phone: true } },
        },
      },
    },
  });

  if (!thread) {
    console.warn(`[ThreadWorker] Thread ${threadId} not found — skipping`);
    return;
  }

  // Terminal states — nothing to do
  if (thread.status === "ARCHIVED" || thread.status === "REPLIED" || thread.status === "PAUSED") return;

  // EC-9.3 — prefer the bound account; fall back to channel.sendingAccount
  // for threads created before sticky binding shipped. The first send will
  // backfill thread.accountId so subsequent ticks pick the bound account.
  const account = thread.account ?? thread.channel.sendingAccount;
  if (!account) {
    console.warn(`[ThreadWorker] Thread ${threadId}: no sending account on channel ${thread.channelId} — archiving`);
    await archiveThread(thread.id, "No sending account configured");
    return;
  }

  // EC-9.6 — soft-deleted accounts are unusable; treat exactly like DISABLED.
  if (account.deletedAt) {
    console.warn(`[ThreadWorker] Thread ${threadId}: sending account "${account.name}" soft-deleted — archiving`);
    await archiveThread(thread.id, `Sending account deleted (${account.accountId})`);
    return;
  }

  // Phase 3 #13 / EC-9.4 / EC-9.5 — gate on account health BEFORE any provider
  // call. A DISABLED account never recovers; archive cleanly with a structured
  // reason. COOLDOWN / BUSY are transient; reschedule until they recover so we
  // don't re-trigger the same rate-limit error on the next tick.
  if (account.status === "DISABLED") {
    console.warn(`[ThreadWorker] Thread ${threadId}: sending account "${account.name}" DISABLED — archiving`);
    await archiveThread(thread.id, `Sending account disabled (${account.accountId})`);
    return;
  }
  if (account.status === "COOLDOWN" || account.status === "BUSY") {
    const minWait = new Date(Date.now() + 5 * 60 * 1000); // at least 5 min
    const nextAt = account.cooldownUntil && account.cooldownUntil > minWait
      ? account.cooldownUntil
      : minWait;
    await guardedThreadUpdate(thread.id, { nextActionAt: nextAt });
    console.log(`[ThreadWorker] Thread ${threadId}: account "${account.name}" ${account.status} — rescheduled to ${nextAt.toISOString()}`);
    return;
  }

  // Outreach is NOT gated on the account-wide scraping budget (Account.dailyCount).
  // That counter belongs to the sourcing pipeline; gating outreach on it let
  // heavy scraping on a shared account starve outreach even when the channel's
  // own send cap still had room. Outreach throttling lives in two places now:
  //   • the per-channel daily send cap (Channel.dailyCap), enforced inside
  //     processLinkedIn / processEmail / processWhatsApp via isDailyCapReached();
  //   • the per-account weekly invite cap below (LinkedIn only).

  // P1 #27 / EC-13.6 — LinkedIn weekly invite cap. Only applies to LinkedIn
  // (other providers have no weekly notion). Reschedule to the weekly reset
  // window if hit.
  if (thread.channelType === ChannelType.LINKEDIN && account.weeklyCount >= CONFIG.WEEKLY_SAFE_LIMIT) {
    const nextAt = account.weeklyResetAt && account.weeklyResetAt > new Date()
      ? account.weeklyResetAt
      : startOfNextWeek();
    await guardedThreadUpdate(thread.id, { nextActionAt: nextAt });
    console.log(`[ThreadWorker] Thread ${threadId}: account "${account.name}" weekly invite cap hit (${account.weeklyCount}/${CONFIG.WEEKLY_SAFE_LIMIT}) — rescheduled to ${nextAt.toISOString()}`);
    return;
  }

  // Build template vars from stored profile + analysis
  const profile = thread.task.result ? JSON.parse(thread.task.result as string) : {};
  const analysis = thread.task.analysisResult ? JSON.parse(thread.task.analysisResult as string) : {};
  const vars = buildVars(profile, analysis);
  const contact = thread.task.contact ?? null;

  const config = thread.channel.config as Record<string, unknown>;
  const candidateLabel = [vars.name, vars.role && vars.company ? `${vars.role} @ ${vars.company}` : (vars.company || vars.role)].filter(Boolean).join(", ") || threadId.slice(-6);
  const tag = `[ThreadWorker ${thread.channelType} "${candidateLabel}"]`;
  console.log(`${tag} Processing — status=${thread.status} taskId=${thread.taskId} via="${account.name}"`);

  try {
    switch (thread.channelType) {
      case ChannelType.LINKEDIN:
        await processLinkedIn(thread as FullThread, config as unknown as LinkedInConfig, vars, account, profile, tag);
        break;
      case ChannelType.EMAIL:
        await processEmail(thread as FullThread, config as unknown as EmailConfig, vars, account, contact, tag);
        break;
      case ChannelType.WHATSAPP:
        await processWhatsApp(thread as FullThread, config as unknown as WAConfig, vars, account, contact, tag);
        break;
    }

    // Recompute task stage after every thread state change
    await recomputeTaskStage(thread.taskId);
  } catch (err: any) {
    console.error(`${tag} Error: ${err.message}`);

    // P1 #41 / EC-13.13 — circuit breaker. Increment the consecutive-failure
    // counter and archive the thread if we've blown past the threshold.
    // Stops a single broken candidate from doom-looping forever (each failure
    // costs an API call + retry slot). The counter resets on a successful
    // commit (see commitSentMessage).
    try {
      const updated = await prisma.channelThread.update({
        where: { id: thread.id },
        data: { consecutiveFailures: { increment: 1 } },
        select: { consecutiveFailures: true },
      });
      if (updated.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        const reason = `Circuit breaker: ${updated.consecutiveFailures} consecutive failures (${(err.message ?? "unknown").slice(0, 180)})`;
        console.warn(`${tag} ${reason} — archiving thread`);
        await archiveThread(thread.id, reason);
        // Don't re-throw — the thread is now ARCHIVED and the cron should not
        // retry it. Returning normally lets pg-boss / outreach-tick treat
        // this as "handled."
        return;
      }
    } catch (counterErr: any) {
      // Counter update itself failed (e.g., the thread row was deleted).
      // Just log and re-throw the original error so cron handles it.
      console.warn(`${tag} consecutiveFailures bump failed: ${counterErr.message}`);
    }

    throw err; // let the cron handle retry scheduling
  }
}

// P1 #41 — circuit breaker threshold. After this many consecutive failures
// on a single thread, we archive rather than retry. Picked by feel: 5 means
// ~25 minutes of retry attempts (cron resets nextActionAt to now+5min on
// each failure) before the thread is shut down.
const MAX_CONSECUTIVE_FAILURES = 5;

// ─── LinkedIn ─────────────────────────────────────────────────────────────────

async function processLinkedIn(
  thread: FullThread,
  config: LinkedInConfig,
  vars: ReturnType<typeof buildVars>,
  account: AccountRow,
  profile: Record<string, unknown>,
  tag: string,
): Promise<void> {
  const providerState = (thread.providerState as ProviderState | null) ?? {};
  const providerUserId = String(profile.provider_id || profile.public_identifier || "");

  const connectionLabel = profile.network_distance === "FIRST_DEGREE" || profile.network_distance === "DISTANCE_1"
    ? "1st-degree"
    : profile.network_distance === "SECOND_DEGREE" ? "2nd-degree"
    : profile.network_distance === "THIRD_DEGREE" ? "3rd-degree"
    : String(profile.network_distance ?? "unknown");
  console.log(`${tag} processLinkedIn — status=${thread.status} phase=${providerState.phase ?? "none"} connection=${connectionLabel} followups=${thread.followupsSent}/${thread.followupsTotal}${providerUserId ? "" : " [MISSING LinkedIn ID]"}`);

  if (!providerUserId) {
    console.log(`${tag} Archiving — no LinkedIn provider ID on profile`);
    await archiveThread(thread.id, "No LinkedIn provider ID on task profile");
    return;
  }

  // ── Enforce daily cap ──
  const capReached = await isDailyCapReached(thread.channelId, thread.channel.dailyCap);
  if (capReached) {
    // Push to tomorrow 00:01 so it's picked up after reset
    const tomorrow = startOfNextDay();
    await guardedThreadUpdate(thread.id, { nextActionAt: tomorrow });
    console.log(`${tag} Channel daily cap reached — rescheduled to ${tomorrow.toISOString()}`);
    return;
  }
  console.log(`${tag} Daily cap OK`);

  // ── Phase: PENDING — send initial message ──────────────────────────────────
  if (thread.status === "PENDING") {
    const rule = matchRule<LinkedInInviteRule>(
      parseFloat(String(vars.score)) || 0,
      config.inviteRules ?? [],
    ) ?? config.inviteRules.find(r => r.key === thread.matchedRuleKey);

    if (!rule) {
      console.log(`${tag} Archiving — rule key "${thread.matchedRuleKey}" not found in config (${config.inviteRules?.length ?? 0} rules)`);
      await archiveThread(thread.id, `Matched rule key "${thread.matchedRuleKey}" not found in config`);
      return;
    }

    console.log(`${tag} PENDING phase — matched rule key="${rule.key}" inviteType=${rule.inviteType}`);

    if (rule.inviteType === "CONNECTION_REQUEST") {
      // Skip the invite API call if the profile already shows a 1st-degree
      // connection. Avoids a wasted API round-trip + error recovery loop.
      const alreadyConnected =
        profile.network_distance === "FIRST_DEGREE" ||
        profile.network_distance === "DISTANCE_1" ||
        profile.is_relationship === true;

      console.log(`${tag} Connection check: ${connectionLabel}, is_relationship=${String(profile.is_relationship ?? "")} → alreadyConnected=${alreadyConnected}`);

      if (alreadyConnected) {
        console.log(`${tag} Already connected — skipping invite, setting CONNECTED phase for DM`);
        await guardedThreadUpdate(thread.id, {
          status: "ACTIVE",
          providerState: { phase: "CONNECTED" },
          nextActionAt: new Date(),
          candidateProviderId: providerUserId,
        });
        return;
      }
      console.log(`${tag} Not connected — sending CONNECTION_REQUEST invite (via "${account.name}")`);
      await sendLinkedInInvite(thread, rule, vars, account, config, providerUserId, tag);
    } else {
      console.log(`${tag} InMail path — sending InMail (via "${account.name}")`);
      await sendLinkedInInMail(thread, rule, vars, account, config, providerUserId, tag);
    }
    return;
  }

  // ── Phase: ACTIVE + INVITE_PENDING — check for timeout ────────────────────
  if (providerState.phase === "INVITE_PENDING") {
    // nextActionAt was set to inviteSentAt + archiveAfterInviteDays by the invite send.
    // Reaching here means it expired without a webhook firing. Before archiving,
    // re-fetch the profile to check if they silently accepted (Unipile webhook
    // can lag up to 8 h; the recruiter may also have manually accepted outside
    // Unipile's visibility window).
    console.log(`${tag} INVITE_PENDING — nextActionAt expired, re-checking profile for silent acceptance`);
    try {
      const freshProfile = await import("@/lib/services/unipile.service").then(m =>
        m.fetchProfile(account.accountId, providerUserId, account.dsn ?? undefined, account.apiKey ?? undefined)
      );
      const nowConnected =
        freshProfile?.network_distance === "FIRST_DEGREE" ||
        freshProfile?.network_distance === "DISTANCE_1" ||
        freshProfile?.is_relationship === true;
      console.log(`${tag} Re-fetched profile: network_distance=${freshProfile?.network_distance} is_relationship=${freshProfile?.is_relationship} → nowConnected=${nowConnected}`);
      if (nowConnected) {
        console.log(`${tag} Silent acceptance detected — advancing to CONNECTED`);
        await guardedThreadUpdate(thread.id, {
          status: "ACTIVE",
          providerState: { phase: "CONNECTED" },
          nextActionAt: new Date(),
        });
        return;
      }
    } catch (profileErr: any) {
      console.warn(`${tag} Profile re-fetch failed during INVITE_PENDING check: ${profileErr.message} — proceeding with archive`);
    }
    console.log(`${tag} INVITE_PENDING — not connected, cancelling invite and archiving`);
    await cancelPendingInvite(account, providerUserId, tag);
    await archiveThread(thread.id, "Invite acceptance timeout");
    return;
  }

  // ── Phase: ACTIVE + CONNECTED — send first DM ────────────────────────────
  if (providerState.phase === "CONNECTED" && !thread.lastMessageAt) {
    // Already-connected candidates: we skipped the invite (inviteSentAt is null),
    // so the connection NOTE — our actual first reach-out — never reached them.
    // Send an "opener" first: the dedicated connectedFirstMessage if set, else the
    // connection note's content. The opener is an EXTRA message that does NOT
    // consume a follow-up slot (followupsSent stays 0), so followups[0..] still
    // send afterwards — mirroring a freshly-connected candidate who got the note
    // (via invite) and then followups[0..]. Freshly-connected candidates
    // (inviteSentAt set) skip the opener and start directly at followups[0].
    const isAlreadyConnected = !thread.inviteSentAt;
    const matchedRule = config.inviteRules?.find(r => r.key === thread.matchedRuleKey);
    const opener = isAlreadyConnected
      ? (config.connectedFirstMessage?.trim() || matchedRule?.noteTemplate?.trim() || "")
      : "";

    // Choose the first message + how it advances the follow-up counter:
    //   opener       → extra reach-out; followups[0] still pending (sent stays 0)
    //   followups[0] → the normal first DM; consumes slot 0       (sent → 1)
    let text: string;
    let newFollowupsSent: number;
    let nextFollowupIdx: number;
    if (opener) {
      text = renderTemplate(opener, vars);
      newFollowupsSent = 0;
      nextFollowupIdx = 0;
      console.log(`${tag} CONNECTED (already-connected, no invite sent) — sending ${config.connectedFirstMessage?.trim() ? "dedicated opener" : "connection-note opener"} before follow-ups`);
    } else {
      const firstDmTemplate = config.followups?.[0];
      if (!firstDmTemplate) {
        // Connect-only outreach: the pitch was delivered in the connection NOTE,
        // so acceptance means the candidate has been CONTACTED — not a dead end to
        // archive. Treat the note as the final message: mark the thread MESSAGED
        // (rollup → MESSAGED, candidate shows as Contacted) and open the reply-wait
        // window like any other final message.
        //
        // Reply detection still works without a chat: connect-only threads never
        // get a providerChatId (we never startChat), so the message webhook's
        // chat-id lookup can't match — but its sender-identity fallback matches on
        // candidateProviderId (set at invite-send) and marks REPLIED. See
        // handleNewMessage in app/api/webhooks/unipile/route.ts.
        //
        // Setting lastMessageAt (to the note's send time) both reports MESSAGED in
        // the rollup and stops the CONNECTED first-DM branch from re-firing. If no
        // reply lands before the window closes, the terminal branch archives. We
        // never park on nextActionAt=null (the heal cron would treat that as a
        // crashed-mid-claim thread).
        console.log(`${tag} No DM configured — connection note was the message; marking MESSAGED + reply-wait`);
        await guardedThreadUpdate(thread.id, {
          providerState: { phase: "MESSAGED" },
          lastMessageAt: thread.inviteSentAt ?? new Date(),
          nextActionAt: scheduleAfterSend(config, undefined),
        });
        return;
      }
      text = renderTemplate(firstDmTemplate.template, vars);
      newFollowupsSent = 1;
      nextFollowupIdx = 1;
      console.log(`${tag} CONNECTED phase — sending first DM (followups[0])`);
    }

    // Pre-API race check: re-read status + manualStage immediately before the
    // (slow) Unipile call. If a webhook or recruiter flipped the thread, skip.
    const sendable = await verifyThreadStillSendable(thread.id);
    if (!sendable.ok) {
      console.log(`${tag} Skipping first message: ${sendable.reason}`);
      return;
    }
    const pendingKey = await markPendingSend(thread.id);
    if (!pendingKey) {
      console.log(`${tag} Status flipped between verify and pending-mark — skipping first message`);
      return;
    }

    console.log(`${tag} Sending first message via "${account.name}" (${text.length} chars)`);
    let chatId: string;
    let messageId: string;
    try {
      ({ chatId, messageId } = await startChat({
        accountId: account.accountId,
        providerUserId,
        text,
        accountDsn: account.dsn ?? undefined,
        accountApiKey: account.apiKey ?? undefined,
      }));
      console.log(`${tag} startChat succeeded — chatId=${chatId}`);
    } catch (err: any) {
      // Not actually connected yet — reset to PENDING so the invite gets sent
      if ((err.message ?? "").toLowerCase().includes("no_connection_with_recipient")) {
        console.log(`${tag} DM failed: not connected yet (no_connection_with_recipient) — resetting to PENDING to send invite`);
        await guardedThreadUpdate(thread.id, {
          status: "PENDING",
          providerState: {},
          nextActionAt: new Date(),
        });
        return;
      }
      throw err;
    }

    const nextAt = scheduleAfterSend(config, config.followups?.[nextFollowupIdx]);

    const ok = await commitSentMessage(
      thread.id, account.id,
      {
        providerState: { phase: "MESSAGED" }, // moves task rollup off of CONNECTED
        providerChatId: chatId,
        lastMessageAt: new Date(),
        followupsSent: newFollowupsSent,
        nextActionAt: nextAt,
      },
      {
        threadId: thread.id,
        type: OutreachType.FIRST_DM,
        renderedBody: text,
        sentAt: new Date(),
        providerChatId: chatId,
        providerMessageId: messageId || null,
      },
      tag,
    );
    if (ok) console.log(`${tag} First message sent — chatId=${chatId}`);
    return;
  }

  // ── Phase: ACTIVE — send follow-up ────────────────────────────────────────
  if (thread.status === "ACTIVE" && thread.followupsSent < thread.followupsTotal) {
    console.log(`${tag} ACTIVE follow-up phase — followup ${thread.followupsSent + 1}/${thread.followupsTotal} providerChatId=${thread.providerChatId ?? "MISSING"}`);
    const followup = config.followups?.[thread.followupsSent];
    if (!followup || !thread.providerChatId) {
      console.log(`${tag} Archiving — missing followup config (followup=${!!followup}) or chatId (chatId=${thread.providerChatId ?? "null"})`);
      await archiveThread(thread.id, "Missing followup config or chat ID");
      return;
    }

    const sendable = await verifyThreadStillSendable(thread.id);
    if (!sendable.ok) {
      console.log(`${tag} Skipping follow-up: ${sendable.reason}`);
      return;
    }
    const pendingKey = await markPendingSend(thread.id);
    if (!pendingKey) {
      console.log(`${tag} Status flipped between verify and pending-mark — skipping follow-up`);
      return;
    }

    const text = renderTemplate(followup.template, vars);
    const { messageId } = await sendChatMessage({
      accountId: account.accountId,
      chatId: thread.providerChatId,
      text,
      accountDsn: account.dsn ?? undefined,
      accountApiKey: account.apiKey ?? undefined,
    });

    const nextFollowup = config.followups?.[thread.followupsSent + 1];
    const nextAt = scheduleAfterSend(config, nextFollowup);
    const newSent = thread.followupsSent + 1;

    const ok = await commitSentMessage(
      thread.id, account.id,
      {
        lastMessageAt: new Date(),
        followupsSent: newSent,
        nextActionAt: nextAt,
      },
      {
        threadId: thread.id,
        type: OutreachType.FOLLOWUP,
        renderedBody: text,
        sentAt: new Date(),
        providerChatId: thread.providerChatId,
        providerMessageId: messageId || null,
      },
      tag,
    );
    if (ok) console.log(`${tag} Follow-up ${newSent}/${thread.followupsTotal} sent`);
    return;
  }

  // Final follow-up already sent; reply-wait deadline has now elapsed with the
  // thread still un-replied (a reply would have flipped it to REPLIED/PAUSED and
  // we'd never reach here). Archive. The reply window itself was granted by
  // scheduleAfterSend when the last message went out — we are NOT cutting it short.
  if (thread.followupsSent >= thread.followupsTotal) {
    console.log(`${tag} Reply-wait elapsed (${thread.followupsSent}/${thread.followupsTotal} sent, no reply) — archiving`);
    await archiveThread(thread.id, "No reply within the reply-wait window after the final message");
  }
}

async function sendLinkedInInvite(
  thread: FullThread,
  rule: LinkedInInviteRule,
  vars: ReturnType<typeof buildVars>,
  account: AccountRow,
  config: LinkedInConfig,
  providerUserId: string,
  tag: string,
): Promise<void> {
  const note = rule.noteTemplate
    ? renderTemplate(rule.noteTemplate, vars).slice(0, 300)
    : undefined;

  const sendable = await verifyThreadStillSendable(thread.id);
  if (!sendable.ok) {
    console.log(`${tag} Skipping invite: ${sendable.reason}`);
    return;
  }
  const pendingKey = await markPendingSend(thread.id);
  if (!pendingKey) {
    console.log(`${tag} Status flipped between verify and pending-mark — skipping invite`);
    return;
  }

  let invitationId: string;
  try {
    const res = await sendInvitation({
      accountId: account.accountId,
      providerUserId,
      message: note,
      accountDsn: account.dsn ?? undefined,
      accountApiKey: account.apiKey ?? undefined,
    });
    invitationId = res.invitationId;
  } catch (err: any) {
    const body: string = (err.message ?? "").toLowerCase();

    // Invite already pending / recently sent — treat as INVITE_PENDING, wait for acceptance
    if (body.includes("cannot_resend_yet") || body.includes("invitation_already") || body.includes("already_invited_recently")) {
      console.log(`${tag} Invite already pending — reverting to INVITE_PENDING to wait`);
      await guardedThreadUpdate(thread.id, {
        status: "ACTIVE",
        providerState: { phase: "INVITE_PENDING" },
        inviteSentAt: thread.inviteSentAt ?? new Date(),
        nextActionAt: daysFromNow(config.archiveAfterInviteDays ?? 14),
        candidateProviderId: providerUserId,
      });
      return;
    }

    // Already a first-degree connection — skip invite, go straight to DM
    // Only match errors that unambiguously mean "you ARE already connected"
    const alreadyConnected =
      body.includes("already_connected") ||
      body.includes("already_in_relation") ||
      body.includes("action_already_performed") ||
      body.includes("is_already") ||
      err.statusCode === 409;

    if (alreadyConnected) {
      // P2 #8 / EC-4.3 — was: `await processThread(thread.id)` recursively.
      // Self-recursion bypasses the cron claim lock — a concurrent tick or
      // a parallel worker could pick up the same thread before the recursive
      // call's transaction commits, leading to two simultaneous processings.
      // Replaced with `nextActionAt = now()` so the next claim cycle picks
      // it up via the proper SKIP LOCKED claim. The marginal latency (≤1
      // tick interval) is worth the concurrency safety.
      console.log(`${tag} Already connected — skipping invite, queued for next tick to send DM`);
      await guardedThreadUpdate(thread.id, {
        status: "ACTIVE",
        providerState: { phase: "CONNECTED" },
        nextActionAt: new Date(),
        candidateProviderId: providerUserId,
      });
      return;
    }

    console.warn(`${tag} sendInvitation failed: status=${err.statusCode} msg=${err.message}`);
    throw err;
  }

  // nextActionAt = invite sent + archiveAfterInviteDays (invite timeout deadline)
  const timeoutAt = daysFromNow(config.archiveAfterInviteDays ?? 14);

  const ok = await commitSentMessage(
      thread.id, account.id,
    {
      status: "ACTIVE",
      providerState: { phase: "INVITE_PENDING", inviteSentAt: new Date().toISOString() },
      inviteSentAt: new Date(),
      nextActionAt: timeoutAt,
      candidateProviderId: providerUserId,
    },
    {
      threadId: thread.id,
      type: OutreachType.INVITE,
      renderedBody: note ?? "",
      sentAt: new Date(),
      providerMessageId: invitationId || null,
    },
    tag,
  );
  if (ok) console.log(`${tag} Invite sent — invitationId=${invitationId}`);
}

async function sendLinkedInInMail(
  thread: FullThread,
  rule: LinkedInInviteRule,
  vars: ReturnType<typeof buildVars>,
  account: AccountRow,
  config: LinkedInConfig,
  providerUserId: string,
  tag: string,
): Promise<void> {
  // Enforce separate InMail daily cap
  const inmailCapReached = await isDailyInMailCapReached(thread.channelId, thread.channel.dailyInMailCap);
  if (inmailCapReached) {
    const tomorrow = startOfNextDay();
    await guardedThreadUpdate(thread.id, { nextActionAt: tomorrow });
    console.log(`${tag} InMail daily cap reached — rescheduled to ${tomorrow.toISOString()}`);
    return;
  }

  const sendable = await verifyThreadStillSendable(thread.id);
  if (!sendable.ok) {
    console.log(`${tag} Skipping InMail: ${sendable.reason}`);
    return;
  }
  const pendingKey = await markPendingSend(thread.id);
  if (!pendingKey) {
    console.log(`${tag} Status flipped between verify and pending-mark — skipping InMail`);
    return;
  }

  const message = rule.messageTemplate ? renderTemplate(rule.messageTemplate, vars) : "";
  const { chatId, messageId } = await sendInMail({
    accountId: account.accountId,
    providerUserId,
    text: message,
    accountDsn: account.dsn ?? undefined,
    accountApiKey: account.apiKey ?? undefined,
  });

  const nextFollowup = config.followups?.[0];
  const nextAt = scheduleAfterSend(config, nextFollowup);

  const ok = await commitSentMessage(
      thread.id, account.id,
    {
      status: "ACTIVE",
      providerState: { phase: "INMAIL_SENT" },
      providerChatId: chatId,
      lastMessageAt: new Date(),
      nextActionAt: nextAt,
      // Bug 6: store candidateProviderId so the webhook fallback's indexed
      // lookup can find this thread without a JSON scan if the primary
      // chatId lookup fails (e.g. chatId not stored due to a crash).
      candidateProviderId: providerUserId,
    },
    {
      threadId: thread.id,
      type: OutreachType.INMAIL,
      renderedBody: message,
      sentAt: new Date(),
      providerChatId: chatId,
      providerMessageId: messageId || null,
    },
    tag,
  );
  if (ok) console.log(`${tag} InMail sent — chatId=${chatId}`);
}

// ─── Email ────────────────────────────────────────────────────────────────────

async function processEmail(
  thread: FullThread,
  config: EmailConfig,
  vars: ReturnType<typeof buildVars>,
  account: AccountRow,
  contact: ContactRow | null,
  tag: string,
): Promise<void> {
  const recipientEmail = contact?.workEmail || contact?.email || contact?.personalEmail || null;
  if (!recipientEmail) {
    const retryMinutes = config.contactRetryMinutes ?? 60;
    const maxDays = config.contactRetryMaxDays ?? 7;
    // P1 #25 / EC-8.8 — anchor on thread.createdAt instead of the LinkedIn-specific
    // thread.inviteSentAt (which is null for email threads, making the previous
    // fallback `new Date(now - 60s)` push the deadline ~7 days into the future
    // every retry → threads waiting on email enrichment never archived).
    const gaveUp = (Date.now() - thread.createdAt.getTime()) > maxDays * 24 * 60 * 60 * 1000;
    if (!gaveUp) {
      await guardedThreadUpdate(thread.id, { nextActionAt: minutesFromNow(retryMinutes) });
      console.log(`${tag} No email yet — retrying in ${retryMinutes}min (max ${maxDays}d)`);
    } else {
      await archiveThread(thread.id, `No email found after ${maxDays}-day wait`);
    }
    return;
  }

  // Enforce daily cap
  const capReached = await isDailyCapReached(thread.channelId, thread.channel.dailyCap);
  if (capReached) {
    await guardedThreadUpdate(thread.id, { nextActionAt: startOfNextDay() });
    return;
  }

  if (thread.status === "PENDING") {
    const rule = matchRule(0, config.emailRules ?? []) ??
      config.emailRules.find(r => r.key === thread.matchedRuleKey);
    if (!rule) {
      await archiveThread(thread.id, "Email rule not found");
      return;
    }

    const sendable = await verifyThreadStillSendable(thread.id);
    if (!sendable.ok) {
      console.log(`${tag} Skipping email: ${sendable.reason}`);
      return;
    }
    const pendingKey = await markPendingSend(thread.id);
    if (!pendingKey) {
      console.log(`${tag} Status flipped between verify and pending-mark — skipping email`);
      return;
    }

    const subject = renderTemplate(rule.subjectTemplate, vars);
    const body = renderTemplate(rule.bodyTemplate, vars);

    const result = await sendEmail({
      account,
      to: recipientEmail,
      toName: String(vars.name || ""),
      subject,
      body,
      tag,
    });
    if (!result.ok) {
      await archiveThread(thread.id, `Email send failed: ${result.error}`);
      return;
    }

    // P1 #20 / EC-6.6 — refuse to advance the thread if the provider didn't
    // give us a thread id back. The webhook handler matches inbound replies
    // by `providerThreadId === in_reply_to.id`; without a stored id, every
    // inbound reply on this thread looks like a fresh email and never gets
    // attributed back to us. Loud failure here is better than silent
    // reply-tracking loss in prod.
    if (!result.replyToId) {
      console.warn(`${tag} Email send returned no provider_id — refusing to advance thread (replies would never be tracked). Archiving with diagnostic.`);
      await archiveThread(
        thread.id,
        "Email provider did not return a thread id (provider_id) — outbound message left but reply tracking is broken. Investigate Unipile email integration.",
      );
      return;
    }

    const nextFollowup = config.followups?.[0];
    const nextAt = scheduleAfterSend(config, nextFollowup);

    const ok = await commitSentMessage(
      thread.id, account.id,
      {
        status: "ACTIVE",
        providerState: { phase: "SENT" },
        // Store the sent email's provider_id so follow-ups can thread via reply_to
        providerThreadId: result.replyToId,
        lastMessageAt: new Date(),
        nextActionAt: nextAt,
      },
      {
        threadId: thread.id,
        type: OutreachType.EMAIL,
        renderedSubject: subject,
        renderedBody: body,
        sentAt: new Date(),
        providerMessageId: result.messageId ?? null,
      },
      tag,
    );
    if (ok) console.log(`${tag} Email sent to ${recipientEmail}`);
    return;
  }

  // Follow-up emails
  if (thread.status === "ACTIVE" && thread.followupsSent < thread.followupsTotal) {
    const followup = config.followups?.[thread.followupsSent];
    if (!followup) {
      await archiveThread(thread.id, "Missing followup config");
      return;
    }

    const sendable = await verifyThreadStillSendable(thread.id);
    if (!sendable.ok) {
      console.log(`${tag} Skipping email followup: ${sendable.reason}`);
      return;
    }
    const pendingKey = await markPendingSend(thread.id);
    if (!pendingKey) {
      console.log(`${tag} Status flipped between verify and pending-mark — skipping email followup`);
      return;
    }

    const subject = renderTemplate(followup.subjectTemplate ?? "", vars);
    const body = renderTemplate(followup.template, vars);

    const result = await sendEmail({
      account,
      to: recipientEmail,
      toName: String(vars.name || ""),
      subject,
      body,
      tag,
      replyToId: thread.providerThreadId ?? undefined,
    });
    if (!result.ok) {
      await archiveThread(thread.id, `Email followup failed: ${result.error}`);
      return;
    }

    const nextFollowup = config.followups?.[thread.followupsSent + 1];
    const nextAt = scheduleAfterSend(config, nextFollowup);
    const newSent = thread.followupsSent + 1;

    const ok = await commitSentMessage(
      thread.id, account.id,
      { lastMessageAt: new Date(), followupsSent: newSent, nextActionAt: nextAt },
      {
        threadId: thread.id,
        type: OutreachType.FOLLOWUP,
        renderedSubject: subject,
        renderedBody: body,
        sentAt: new Date(),
        providerMessageId: result.messageId ?? null,
      },
      tag,
    );
    if (ok) console.log(`${tag} Email follow-up ${newSent}/${thread.followupsTotal} sent`);
    return;
  }

  // Reply-wait deadline elapsed after the final email with no reply — archive.
  // (scheduleAfterSend granted the window; reaching here means it expired.)
  if (thread.status === "ACTIVE" && thread.followupsSent >= thread.followupsTotal) {
    console.log(`${tag} Email reply-wait elapsed (no reply) — archiving`);
    await archiveThread(thread.id, "No reply within the reply-wait window after the final email");
  }
}

// ─── WhatsApp ─────────────────────────────────────────────────────────────────

async function processWhatsApp(
  thread: FullThread,
  config: WAConfig,
  vars: ReturnType<typeof buildVars>,
  account: AccountRow,
  contact: ContactRow | null,
  tag: string,
): Promise<void> {
  // Phone number in E.164 format from CandidateContact
  const phone = contact?.phone ?? null;
  if (!phone) {
    const retryMinutes = config.contactRetryMinutes ?? 60;
    const maxDays = config.contactRetryMaxDays ?? 7;
    // P1 #25 / EC-8.8 — anchor on thread.createdAt for WA threads (same fix
    // as the email branch above: thread.inviteSentAt is null for non-LinkedIn
    // threads, making the deadline never expire on the previous code path).
    const gaveUp = (Date.now() - thread.createdAt.getTime()) > maxDays * 24 * 60 * 60 * 1000;
    if (!gaveUp) {
      await guardedThreadUpdate(thread.id, { nextActionAt: minutesFromNow(retryMinutes) });
      console.log(`${tag} No phone yet — retrying in ${retryMinutes}min (max ${maxDays}d)`);
    } else {
      await archiveThread(thread.id, `No phone found after ${maxDays}-day wait`);
    }
    return;
  }

  // Enforce quiet hours before anything else
  if (config.quietHours) {
    const endsAt = quietHoursEnd(config.quietHours as QuietHours);
    if (endsAt) {
      await guardedThreadUpdate(thread.id, { nextActionAt: endsAt });
      console.log(`${tag} In quiet hours — rescheduled to ${endsAt.toISOString()}`);
      return;
    }
  }

  // Enforce daily cap
  const capReached = await isDailyCapReached(thread.channelId, thread.channel.dailyCap);
  if (capReached) {
    await guardedThreadUpdate(thread.id, { nextActionAt: startOfNextDay() });
    return;
  }

  if (thread.status === "PENDING") {
    const rule = matchRule(0, config.waRules ?? []) ??
      config.waRules.find(r => r.key === thread.matchedRuleKey);
    if (!rule) {
      await archiveThread(thread.id, "WhatsApp rule not found");
      return;
    }

    const sendable = await verifyThreadStillSendable(thread.id);
    if (!sendable.ok) {
      console.log(`${tag} Skipping WhatsApp: ${sendable.reason}`);
      return;
    }
    const pendingKey = await markPendingSend(thread.id);
    if (!pendingKey) {
      console.log(`${tag} Status flipped between verify and pending-mark — skipping WhatsApp`);
      return;
    }

    const message = renderTemplate(rule.messageTemplate, vars);
    const result = await sendWhatsApp({ account, message, phone, tag });
    if (!result.ok) {
      await archiveThread(thread.id, `WhatsApp send failed: ${result.error}`);
      return;
    }

    const nextFollowup = config.followups?.[0];
    const nextAt = scheduleAfterSend(config, nextFollowup);

    const ok = await commitSentMessage(
      thread.id, account.id,
      {
        status: "ACTIVE",
        providerState: { phase: "DELIVERED" },
        providerChatId: result.chatId ?? null,
        lastMessageAt: new Date(),
        nextActionAt: nextAt,
      },
      {
        threadId: thread.id,
        type: OutreachType.WHATSAPP,
        renderedBody: message,
        sentAt: new Date(),
        providerChatId: result.chatId ?? null,
        providerMessageId: result.messageId ?? null,
      },
      tag,
    );
    if (ok) console.log(`${tag} WhatsApp sent to ${phone}`);
    return;
  }

  // Follow-ups
  if (thread.status === "ACTIVE" && thread.followupsSent < thread.followupsTotal) {
    const followup = config.followups?.[thread.followupsSent];
    if (!followup || !thread.providerChatId) {
      await archiveThread(thread.id, "Missing followup config or chat ID");
      return;
    }

    // P1 #39 / EC-13.7 — WhatsApp 24-hour rolling window. Outside the window
    // Meta requires an approved Business template; sending free-form text
    // either fails or charges premium. We don't yet support template sends,
    // so refuse-with-archive instead. Recruiter can re-engage manually via
    // an approved template.
    const WA_WINDOW_MS = 24 * 60 * 60 * 1000;
    const lastInbound = thread.lastInboundAt;
    const outsideWindow = !lastInbound || (Date.now() - lastInbound.getTime()) > WA_WINDOW_MS;
    if (outsideWindow) {
      const reason = lastInbound
        ? `Outside WhatsApp 24h window (last inbound ${lastInbound.toISOString()}) — needs approved template, not yet supported`
        : "Outside WhatsApp 24h window (no inbound message ever) — needs approved template, not yet supported";
      console.log(`${tag} ${reason}`);
      await archiveThread(thread.id, reason);
      return;
    }

    const sendable = await verifyThreadStillSendable(thread.id);
    if (!sendable.ok) {
      console.log(`${tag} Skipping WhatsApp followup: ${sendable.reason}`);
      return;
    }
    const pendingKey = await markPendingSend(thread.id);
    if (!pendingKey) {
      console.log(`${tag} Status flipped between verify and pending-mark — skipping WhatsApp followup`);
      return;
    }

    const message = renderTemplate(followup.template, vars);
    const result = await sendWhatsApp({ account, message, phone, chatId: thread.providerChatId, tag });
    if (!result.ok) {
      await archiveThread(thread.id, `WhatsApp followup failed: ${result.error}`);
      return;
    }

    const nextFollowup = config.followups?.[thread.followupsSent + 1];
    const nextAt = scheduleAfterSend(config, nextFollowup);
    const newSent = thread.followupsSent + 1;

    const ok = await commitSentMessage(
      thread.id, account.id,
      { lastMessageAt: new Date(), followupsSent: newSent, nextActionAt: nextAt },
      {
        threadId: thread.id,
        type: OutreachType.WHATSAPP,
        renderedBody: message,
        sentAt: new Date(),
        providerChatId: thread.providerChatId,
        providerMessageId: result.messageId ?? null,
      },
      tag,
    );
    if (ok) console.log(`${tag} WhatsApp follow-up ${newSent}/${thread.followupsTotal} sent`);
    return;
  }

  // Reply-wait deadline elapsed after the final WhatsApp message with no reply —
  // archive. (scheduleAfterSend granted the window; reaching here means it expired.)
  if (thread.status === "ACTIVE" && thread.followupsSent >= thread.followupsTotal) {
    console.log(`${tag} WhatsApp reply-wait elapsed (no reply) — archiving`);
    await archiveThread(thread.id, "No reply within the reply-wait window after the final WhatsApp message");
  }
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

// Finds the pending invite for a candidate and cancels it via Unipile.
// Used before archiving a timed-out INVITE_PENDING thread. Non-throwing.
async function cancelPendingInvite(
  account: AccountRow,
  providerUserId: string,
  tag: string,
): Promise<void> {
  try {
    const sent = await listSentInvitations({
      accountId: account.accountId,
      accountDsn: account.dsn ?? undefined,
      accountApiKey: account.apiKey ?? undefined,
    });
    const match = sent.find(
      inv => inv.invitedUserId === providerUserId || inv.invitedUserPublicId === providerUserId,
    );
    if (!match) return; // already accepted or withdrawn
    const ok = await cancelInvitation({
      invitationId: match.id,
      accountId: account.accountId,
      accountDsn: account.dsn ?? undefined,
      accountApiKey: account.apiKey ?? undefined,
    });
    if (ok) console.log(`${tag} Cancelled pending invite ${match.id}`);
  } catch (err: any) {
    console.warn(`${tag} Failed to cancel invite: ${err.message}`);
  }
}

// Idempotent: only writes if the thread is still PENDING/ACTIVE. A second call
// (e.g., concurrent timeout sweep) is a no-op and preserves the original
// archivedAt / archivedReason.
//
// The status guard is `in: [PENDING, ACTIVE]` rather than `not: ARCHIVED` so we
// never clobber a REPLIED or PAUSED thread. Every archiveThread caller runs
// inside processThread, which slow-path API calls can straddle: a reply webhook
// (→ REPLIED) or a sibling-reply pause (→ PAUSED) can land AFTER processThread
// read the row but BEFORE this archive. The worker must never auto-archive a
// candidate who just replied — that transition always wins. (ARCHIVED is also
// excluded, preserving the original idempotency.)
export async function archiveThread(threadId: string, reason: string): Promise<void> {
  await prisma.channelThread.updateMany({
    where: { id: threadId, status: { in: ["PENDING", "ACTIVE"] } },
    data: {
      status: "ARCHIVED",
      archivedAt: new Date(),
      archivedReason: reason,
      nextActionAt: null,
    },
  });
}

// Mark a thread REPLIED and pause sibling threads:
//   1. Same-Task siblings on other channels (always)
//   2. Cross-Task siblings on the SAME candidate (Phase 6 #28 / EC-10.1) —
//      threads belonging to other Tasks that share this Task's
//      candidateProfileId. This is the cross-requisition pause: a candidate
//      who replied on R1's email shouldn't keep getting messaged on R2's
//      WhatsApp.
//
// Idempotent: if the thread is already REPLIED (or terminal in any other way),
// no rows are updated and sibling-pause is skipped — a second concurrent
// webhook or poll-fallback for the same reply does not re-write state or
// generate extra StageEvents.
export async function markThreadReplied(threadId: string, taskId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // P1 #39 — also set lastInboundAt on REPLIED so the WA 24h window
    // calculation in processWhatsApp (followup branch) has a fresh anchor
    // when the thread gets re-engaged after a "dismiss reply" action.
    const flip = await tx.channelThread.updateMany({
      where: { id: threadId, status: { in: ["PENDING", "ACTIVE"] } },
      data: { status: "REPLIED", nextActionAt: null, lastInboundAt: new Date() },
    });
    if (flip.count === 0) return; // already REPLIED / PAUSED / ARCHIVED — nothing to do

    // 1. Pause every other active thread on the same task
    await tx.channelThread.updateMany({
      where: {
        taskId,
        id: { not: threadId },
        status: { in: ["PENDING", "ACTIVE"] },
      },
      data: { status: "PAUSED", nextActionAt: null },
    });

    // 2. Cross-task pause: pause active threads on every other Task that
    //    shares this Task's candidateProfileId (i.e., the same physical
    //    candidate sourced into multiple requisitions). Only fires when
    //    candidateProfileId is set — legacy Tasks without it stay isolated.
    const taskRow = await tx.task.findUnique({
      where: { id: taskId },
      select: { candidateProfileId: true },
    });
    if (taskRow?.candidateProfileId) {
      await tx.channelThread.updateMany({
        where: {
          taskId: { not: taskId },
          status: { in: ["PENDING", "ACTIVE"] },
          task: { candidateProfileId: taskRow.candidateProfileId },
        },
        data: { status: "PAUSED", nextActionAt: null },
      });
    }
  });
}

// Resume paused sibling threads (e.g. recruiter dismissed an off-topic reply)
export async function resumeSiblingThreads(taskId: string, skipThreadId: string): Promise<void> {
  await prisma.channelThread.updateMany({
    where: {
      taskId,
      id: { not: skipThreadId },
      status: "PAUSED",
    },
    data: {
      status: "ACTIVE",
      // Give the recruiter 24h before next followup fires
      nextActionAt: daysFromNow(1),
    },
  });
}

// ─── Daily cap helpers ────────────────────────────────────────────────────────

async function isDailyCapReached(channelId: string, cap: number): Promise<boolean> {
  const todayStart = startOfToday();
  const count = await prisma.threadMessage.count({
    where: {
      thread: { channelId },
      type: { in: [OutreachType.INVITE, OutreachType.INMAIL, OutreachType.FIRST_DM, OutreachType.EMAIL, OutreachType.WHATSAPP] },
      sentAt: { gte: todayStart },
      status: "SENT",
    },
  });
  return count >= cap;
}

async function isDailyInMailCapReached(channelId: string, cap: number): Promise<boolean> {
  const todayStart = startOfToday();
  const count = await prisma.threadMessage.count({
    where: {
      thread: { channelId },
      type: OutreachType.INMAIL,
      sentAt: { gte: todayStart },
      status: "SENT",
    },
  });
  return count >= cap;
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

function minutesFromNow(minutes: number): Date {
  return new Date(Date.now() + minutes * 60 * 1000);
}

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

// Fallback reply-wait window when a channel config doesn't set replyWaitDays.
const DEFAULT_REPLY_WAIT_DAYS = 5;

// Schedule the worker's next visit after a successful send.
//
// • Another follow-up remains → schedule it (afterDays).
// • That was the FINAL message → schedule the reply-wait deadline. We do NOT
//   archive on the spot: the candidate gets `replyWaitDays` to respond (caught
//   by webhook or pollChatReplies). Only when this deadline fires with the
//   thread still un-replied does the terminal "followupsSent >= followupsTotal"
//   branch archive it.
//
// Critically this is NEVER null. A resting PENDING/ACTIVE thread must always
// carry a non-null nextActionAt, so the process-tasks heal cron can treat
// (status IN PENDING|ACTIVE, nextActionAt IS NULL) as "crashed mid-claim"
// without ever resurrecting a thread that is legitimately parked waiting for a
// reply. (That ambiguity is exactly what wrongly auto-archived candidates with
// zero reply window.)
function scheduleAfterSend(
  config: { replyWaitDays?: number },
  nextFollowup: FollowupRule | undefined,
): Date {
  if (nextFollowup) return daysFromNow(nextFollowup.afterDays);
  return daysFromNow(config.replyWaitDays ?? DEFAULT_REPLY_WAIT_DAYS);
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function startOfNextDay(): Date {
  const d = startOfToday();
  d.setDate(d.getDate() + 1);
  return d;
}

// P1 #27 — used when the LinkedIn weekly invite cap is hit. We don't track
// the calendar week boundary in DB; instead we reschedule for the existing
// weeklyResetAt if set, or start-of-next-week if not. This is good-enough:
// the weekly reset is set when weeklyCount first goes positive (see
// commitSentMessage), so the second-and-later sends update it forward.
function startOfNextWeek(): Date {
  const d = startOfToday();
  const dayOfWeek = d.getDay(); // 0 = Sunday
  const daysUntilNextMonday = (8 - dayOfWeek) % 7 || 7;
  d.setDate(d.getDate() + daysUntilNextMonday);
  return d;
}

// ─── Internal types ───────────────────────────────────────────────────────────

type ProviderState = Record<string, string>;

type AccountRow = {
  id: string;
  accountId: string;
  name: string;
  dsn: string | null;
  apiKey: string | null;
  status: import("@prisma/client").AccountStatus;
  cooldownUntil: Date | null;
  // P1 #24 — read at processThread time so we can enforce the account-wide
  // daily cap (shared across channels) without an extra query.
  dailyCount: number;
  deletedAt: Date | null;
  // P1 #27 — weekly cap + warmup tracking.
  weeklyCount: number;
  weeklyResetAt: Date | null;
  warmupUntil: Date | null;
};

type ContactRow = {
  email: string | null;
  workEmail: string | null;
  personalEmail: string | null;
  phone: string | null;
};

type FullThread = {
  id: string;
  taskId: string;
  channelId: string;
  channelType: ChannelType;
  status: string;
  providerState: unknown;
  matchedRuleKey: string | null;
  nextActionAt: Date | null;
  inviteSentAt: Date | null;
  lastMessageAt: Date | null;
  // P1 #39 — most recent inbound message time (any channel; meaningful for WA).
  lastInboundAt: Date | null;
  followupsSent: number;
  followupsTotal: number;
  providerChatId: string | null;
  providerThreadId: string | null;
  createdAt: Date;
  channel: {
    id: string;
    dailyCap: number;
    dailyInMailCap: number;
    sendingAccount: AccountRow | null;
  };
  task: {
    id: string;
    result: string | null;
    analysisResult: string | null;
    contact: ContactRow | null;
  };
};
