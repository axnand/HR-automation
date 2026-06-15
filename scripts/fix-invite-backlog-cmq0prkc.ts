/**
 * One-shot remediation: backfill ChannelThreads and fix stages for all
 * CONTACT_REQUESTED candidates in JD-CMQ0PRKC (Talent Acquisition Head)
 * where invites were sent manually via the Send Invite button (no ChannelThread
 * was created, so webhooks had nothing to match and stages froze).
 *
 * Per-candidate logic:
 *   - Has chat + inbound message  → REPLIED
 *   - Has chat + only outbound    → MESSAGED
 *   - No chat but FIRST_DEGREE    → CONNECTED (accepted invite, no DM yet)
 *   - No chat, not connected      → CONTACT_REQUESTED (invite still pending)
 *
 * Run: npx tsx scripts/fix-invite-backlog-cmq0prkc.ts
 * Safe to re-run — skips tasks already updated past CONTACT_REQUESTED.
 */

import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { fetchProfile } from "@/lib/services/unipile.service";
import { OutreachType } from "@prisma/client";

// ── Constants for this requisition ─────────────────────────────────────────
const REQUISITION_ID    = "cmq0prkcc000012nsx8cmnx0o";
const CHANNEL_ID        = "cmq3kyli9000110jvih4r3sb3";
const ACCOUNT_DB_ID     = "cmpxrptbt0000t3arpfi5jq65";
const UNIPILE_ACCT_ID   = "cbWBXqwcQlGsXf-vEgokug";  // Neha Sharma's LinkedIn
const ARCHIVE_DAYS      = 14;
const FOLLOWUPS_TOTAL   = 1;
const MATCHED_RULE_KEY  = "rule-1780822621298";

const DSN     = process.env.UNIPILE_DSN!;
const API_KEY = process.env.UNIPILE_API_KEY!;

// ── Unipile helpers ─────────────────────────────────────────────────────────

async function unipileGet<T = any>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${DSN}${path}`, {
      headers: { "X-API-KEY": API_KEY, Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(`    Unipile ${path} → ${res.status}: ${text.slice(0, 120)}`);
      return null;
    }
    return await res.json() as T;
  } catch (err: any) {
    console.warn(`    Unipile ${path} → ${err.message}`);
    return null;
  }
}

async function getChatsForUser(providerUserId: string): Promise<any[]> {
  const data = await unipileGet(
    `/api/v1/chat_attendees/${encodeURIComponent(providerUserId)}/chats` +
    `?account_id=${encodeURIComponent(UNIPILE_ACCT_ID)}&limit=10`,
  );
  return data?.items ?? [];
}

async function getMessagesForUser(providerUserId: string): Promise<any[]> {
  const data = await unipileGet(
    `/api/v1/chat_attendees/${encodeURIComponent(providerUserId)}/messages` +
    `?account_id=${encodeURIComponent(UNIPILE_ACCT_ID)}&limit=50`,
  );
  return data?.items ?? [];
}

// ── State resolution ────────────────────────────────────────────────────────

type ResolvedState =
  | { status: "REPLIED";       chatId: string; lastMessageAt: Date; lastInboundAt: Date }
  | { status: "MESSAGED";      chatId: string; lastMessageAt: Date }
  | { status: "CONNECTED" }
  | { status: "INVITE_PENDING" };

async function resolveState(providerUserId: string, name: string): Promise<ResolvedState> {
  const chats = await getChatsForUser(providerUserId);

  if (chats.length > 0) {
    // Use the most recently active chat (first in list)
    const chat = chats[0];
    // chat.id = Unipile internal ID — matches what startChat/webhooks use as chat_id
    const chatId: string = chat.id;

    const messages = await getMessagesForUser(providerUserId);
    // is_sender=1 → we sent; is_sender=0 → candidate sent (= inbound reply)
    // Exclude system event messages
    const dms = messages.filter((m: any) => !m.is_event || m.is_event === 0);

    const inbound  = dms.filter((m: any) => m.is_sender === 0);
    const outbound = dms.filter((m: any) => m.is_sender === 1);

    console.log(`    chat found: ${chatId}  outbound=${outbound.length}  inbound=${inbound.length}`);

    const latestTs = (msgs: any[]) =>
      msgs.reduce<Date | null>((best, m) => {
        const d = m.timestamp ? new Date(m.timestamp) : null;
        return d && (!best || d > best) ? d : best;
      }, null) ?? new Date();

    if (inbound.length > 0) {
      return {
        status: "REPLIED",
        chatId,
        lastMessageAt: latestTs([...outbound, ...inbound]),
        lastInboundAt: latestTs(inbound),
      };
    }
    if (outbound.length > 0) {
      return { status: "MESSAGED", chatId, lastMessageAt: latestTs(outbound) };
    }
    // Chat exists but no actual DMs (e.g., only a system event)
    return { status: "CONNECTED" };
  }

  // No chat — check LinkedIn connection status via profile
  try {
    const profile = await fetchProfile(UNIPILE_ACCT_ID, providerUserId);
    const connected =
      profile?.network_distance === "FIRST_DEGREE" ||
      profile?.network_distance === "DISTANCE_1"  ||
      profile?.is_relationship === true;
    console.log(`    no chat; network_distance=${profile?.network_distance ?? "unknown"} connected=${connected}`);
    if (connected) return { status: "CONNECTED" };
  } catch (err: any) {
    console.warn(`    fetchProfile error: ${err.message}`);
  }

  return { status: "INVITE_PENDING" };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!DSN || !API_KEY) throw new Error("UNIPILE_DSN / UNIPILE_API_KEY not set");

  // Fetch all CONTACT_REQUESTED tasks for this requisition, with their thread (if any)
  const tasks = await prisma.$queryRaw<Array<{
    task_id: string;
    candidateName: string;
    linkedin_provider_id: string | null;
    thread_id: string | null;
    thread_status: string | null;
  }>>`
    SELECT
      t.id                              AS task_id,
      t."candidateName",
      t.result::jsonb->>'provider_id'  AS linkedin_provider_id,
      ct.id                             AS thread_id,
      ct.status                         AS thread_status
    FROM "Task" t
    JOIN "Job" j ON t."jobId" = j.id
    LEFT JOIN "ChannelThread" ct
      ON ct."taskId" = t.id AND ct."channelId" = ${CHANNEL_ID}
    WHERE j."requisitionId" = ${REQUISITION_ID}
      AND t.stage          = 'CONTACT_REQUESTED'
      AND t."deletedAt"    IS NULL
    ORDER BY t."stageUpdatedAt" DESC
  `;

  console.log(`\nFound ${tasks.length} CONTACT_REQUESTED tasks to process\n`);

  const counts = { replied: 0, messaged: 0, connected: 0, invitePending: 0, skipped: 0, errors: 0 };

  for (const row of tasks) {
    const name           = row.candidateName ?? row.task_id.slice(-8);
    const providerUserId = row.linkedin_provider_id;

    if (!providerUserId) {
      console.log(`[SKIP] ${name} — no LinkedIn provider ID`);
      counts.skipped++;
      continue;
    }

    console.log(`\n[${name}]  pid=${providerUserId.slice(-8)}  existingThread=${row.thread_id?.slice(-8) ?? "none"}`);

    try {
      await new Promise(r => setTimeout(r, 600)); // 600ms between candidates to respect rate limits

      const state = await resolveState(providerUserId, name);
      console.log(`    → resolved: ${state.status}`);

      const now = new Date();

      await prisma.$transaction(async (tx) => {
        // ── 1. Upsert ChannelThread ──────────────────────────────────────
        let threadId: string;

        if (row.thread_id) {
          // Thread already exists (e.g. Rashmi) — bring it to the right state
          threadId = row.thread_id;

          if (state.status === "REPLIED") {
            await tx.channelThread.updateMany({
              where: { id: threadId, status: { in: ["PENDING", "ACTIVE", "PAUSED"] } },
              data: {
                status: "REPLIED",
                providerState: { phase: "MESSAGED" },
                providerChatId: state.chatId,
                lastMessageAt: state.lastMessageAt,
                lastInboundAt: state.lastInboundAt,
                nextActionAt: null,
                followupsSent: 1,
              },
            });
          } else if (state.status === "MESSAGED") {
            await tx.channelThread.updateMany({
              where: { id: threadId, status: { in: ["PENDING", "ACTIVE"] } },
              data: {
                status: "ACTIVE",
                providerState: { phase: "MESSAGED" },
                providerChatId: state.chatId,
                lastMessageAt: state.lastMessageAt,
                nextActionAt: null,
                followupsSent: 1,
              },
            });
          } else if (state.status === "CONNECTED") {
            await tx.channelThread.updateMany({
              where: { id: threadId, status: { in: ["PENDING", "ACTIVE"] } },
              data: {
                status: "ACTIVE",
                providerState: { phase: "CONNECTED" },
                nextActionAt: now,
              },
            });
          }
          // INVITE_PENDING → existing thread already correct, no update needed

        } else {
          // No thread — create one from scratch
          const base = {
            taskId:              row.task_id,
            channelId:           CHANNEL_ID,
            channelType:         "LINKEDIN" as const,
            accountId:           ACCOUNT_DB_ID,
            candidateProviderId: providerUserId,
            matchedRuleKey:      MATCHED_RULE_KEY,
            inviteSentAt:        now,
            followupsTotal:      FOLLOWUPS_TOTAL,
          };

          let extra: Record<string, unknown>;

          if (state.status === "REPLIED") {
            extra = {
              status:        "REPLIED",
              providerState: { phase: "MESSAGED" },
              providerChatId: state.chatId,
              lastMessageAt:  state.lastMessageAt,
              lastInboundAt:  state.lastInboundAt,
              nextActionAt:   null,
              followupsSent:  1,
            };
          } else if (state.status === "MESSAGED") {
            extra = {
              status:        "ACTIVE",
              providerState: { phase: "MESSAGED" },
              providerChatId: state.chatId,
              lastMessageAt:  state.lastMessageAt,
              nextActionAt:   null,
              followupsSent:  1,
            };
          } else if (state.status === "CONNECTED") {
            extra = {
              status:        "ACTIVE",
              providerState: { phase: "CONNECTED" },
              nextActionAt:  now,
              followupsSent: 0,
            };
          } else {
            // INVITE_PENDING
            extra = {
              status:        "ACTIVE",
              providerState: { phase: "INVITE_PENDING" },
              nextActionAt:  new Date(now.getTime() + ARCHIVE_DAYS * 24 * 60 * 60 * 1000),
              followupsSent: 0,
            };
          }

          const thread = await tx.channelThread.create({ data: { ...base, ...extra } });
          threadId = thread.id;
        }

        // ── 2. Update task stage if it changed ───────────────────────────
        const newStage =
          state.status === "REPLIED"  ? "REPLIED"  :
          state.status === "MESSAGED" ? "MESSAGED" :
          state.status === "CONNECTED"? "CONNECTED":
          null; // INVITE_PENDING → leave as CONTACT_REQUESTED

        if (newStage) {
          await tx.task.update({
            where: { id: row.task_id },
            data:  { stage: newStage, stageUpdatedAt: now },
          });
          await tx.stageEvent.create({
            data: {
              taskId:    row.task_id,
              fromStage: "CONTACT_REQUESTED",
              toStage:   newStage,
              actor:     "SYSTEM",
              reason:    "Backfill: stage resolved from Unipile chat history",
            },
          });
        }
      });

      if (state.status === "REPLIED")       counts.replied++;
      else if (state.status === "MESSAGED") counts.messaged++;
      else if (state.status === "CONNECTED")counts.connected++;
      else                                  counts.invitePending++;

    } catch (err: any) {
      console.error(`    ERROR: ${err.message}`);
      counts.errors++;
    }
  }

  console.log("\n════════════ Results ════════════");
  console.log(`REPLIED        ${counts.replied}`);
  console.log(`MESSAGED       ${counts.messaged}`);
  console.log(`CONNECTED      ${counts.connected}`);
  console.log(`INVITE_PENDING ${counts.invitePending}`);
  console.log(`SKIPPED        ${counts.skipped}`);
  console.log(`ERRORS         ${counts.errors}`);
  console.log("═════════════════════════════════\n");

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
