# 05 — Outreach and Stages

This document covers the outreach engine: how candidates move through the pipeline, how messages are sent, and how replies trigger stage transitions.

---

## Candidate stages

`Task.stage` is a `CandidateStage` enum ([prisma/schema.prisma:11](../prisma/schema.prisma#L11)):

```
SOURCED → SHORTLISTED → CONTACT_REQUESTED → CONNECTED → MESSAGED → REPLIED
                                                                         │
                              ┌──────────────────────────────────────────┘
                              ▼ (recruiter sets manually)
                       INTERVIEW → HIRED
                              │
                              └─ REJECTED
                    ARCHIVED  (all threads exhausted or recruiter action)
```

Stages below `REPLIED` are **system-derived** from thread states. Stages from `INTERVIEW` onward are **recruiter-set** (via `manualStage`).

---

## manualStage vs materialized stage

`Task.stage` is a **materialized rollup** — it is derived from the state of all `ChannelThread` rows for that task. It is **never** the source of truth on its own.

`Task.manualStage` is set when a recruiter explicitly moves a candidate to `INTERVIEW`, `HIRED`, `REJECTED`, or `ARCHIVED` via the UI. It **always wins** over the derived rollup:

```ts
// lib/channels/stage-rollup.ts:38
const MANUAL_WINS = new Set(["INTERVIEW", "HIRED", "REJECTED", "ARCHIVED"])
```

**Never raw-update `Task.stage` directly.** Always call `recomputeTaskStage()` ([lib/channels/stage-rollup.ts:59](../lib/channels/stage-rollup.ts#L59)) — it respects `manualStage`, computes the correct derived value, writes the `StageEvent`, and returns a typed `{ stage, changed, fromStage, source }` contract.

### Stage derivation logic

`recomputeTaskStage()` scans all `ChannelThread` rows for the task:

1. If `manualStage ∈ MANUAL_WINS` → use manualStage, stop.
2. If no threads → leave stage unchanged.
3. If all threads are `ARCHIVED` → `ARCHIVED`.
4. Otherwise, derive from thread states using priority order:

| Thread state | providerState.phase | Derived stage |
|---|---|---|
| REPLIED | any | `REPLIED` (short-circuits — highest priority) |
| ACTIVE | `INVITE_PENDING` | `CONTACT_REQUESTED` |
| ACTIVE | `CONNECTED` + no DM sent yet | `CONNECTED` |
| ACTIVE | anything else | `MESSAGED` |
| PAUSED / PENDING | any | no contribution (skip) |

The derived stage only ever **raises** — it never downgrades a task from MESSAGED back to SHORTLISTED.

**File:** [lib/channels/stage-rollup.ts](../lib/channels/stage-rollup.ts)

---

## Channels and ChannelThreads

A `Channel` is a configured outreach method for a requisition (LinkedIn, Email, or WhatsApp). One requisition can have multiple channels.

When a candidate is auto-shortlisted, `fanOutToChannels()` ([lib/channels/fan-out.ts](../lib/channels/fan-out.ts)) creates a `ChannelThread` row for each active channel whose configured score band matches the candidate's score. Each thread starts with `status: PENDING` and a `nextActionAt` set to "now" (ready immediately).

A `ChannelThread` tracks one candidate on one channel through its full lifecycle.

---

## The outreach tick

**Every 30 seconds** the Railway worker calls `runOutreachTick()` ([lib/channels/outreach-tick.ts:16](../lib/channels/outreach-tick.ts#L16)).

### Claim step (atomic, concurrent-safe)

The tick uses `FOR UPDATE SKIP LOCKED` to claim up to 200 due threads atomically:

```sql
UPDATE "ChannelThread"
SET    "nextActionAt" = NULL
WHERE  id IN (
  SELECT id FROM "ChannelThread"
  WHERE  status IN ('PENDING', 'ACTIVE')
    AND  "nextActionAt" IS NOT NULL
    AND  "nextActionAt" <= now
    AND  "channelId" IN (SELECT id FROM "Channel" WHERE status = 'ACTIVE')
  ORDER  BY "nextActionAt" ASC
  LIMIT  200
  FOR UPDATE SKIP LOCKED
)
RETURNING id
```

`SKIP LOCKED` means two workers running simultaneously will each get a different set of threads — no double-processing.

Setting `nextActionAt = NULL` is the "claim" — a crashed worker leaves `nextActionAt = NULL` threads which are picked up by the maintenance cron.

### processThread — one step per tick

For each claimed thread, `processThread(threadId)` ([lib/channels/thread-worker.ts:229](../lib/channels/thread-worker.ts#L229)) advances it by exactly one step. The step depends on the channel type and current state:

**LinkedIn channel state machine:**

```
PENDING
  └─ matchRule() finds the right inviteRule
      ├─ CONNECTION_REQUEST → sendInvitation() → providerState: { phase: INVITE_PENDING }
      │                        nextActionAt = inviteSentAt + archiveAfterInviteDays
      └─ INMAIL → sendInMail() → providerState: { phase: INMAIL_SENT }

ACTIVE + phase: INVITE_PENDING
  └─ nextActionAt expired → re-fetch profile to check silent acceptance
      ├─ now connected → providerState: { phase: CONNECTED }, nextActionAt = now
      └─ still not connected → cancelInvite() + archiveThread("Invite acceptance timeout")

ACTIVE + phase: CONNECTED + no DM yet
  └─ startChat() → providerState: { phase: MESSAGED }, saves chatId
      nextActionAt = config.followups[0].afterDays from now

ACTIVE + followupsSent < followupsTotal
  └─ sendChatMessage() on existing chatId
      nextActionAt = config.followups[next].afterDays from now
      if last followup → archiveThread("All follow-ups exhausted")
```

**Email channel:** waits for `CandidateContact.email` to be populated (retries every `contactRetryMinutes`, gives up after `contactRetryMaxDays`), then sends via Unipile email API.

**WhatsApp channel:** same contact-wait pattern using `CandidateContact.phone`, plus 24-hour messaging window enforcement (Meta policy — follow-ups only allowed within 24h of last inbound message).

### Race protection

Between reading a thread and committing the send result, several events can race:
- A webhook flips the thread to `REPLIED`
- A sibling thread's reply flips this one to `PAUSED`
- A recruiter sets `manualStage`

Two guards prevent clobbering:

1. **Pre-API check:** `verifyThreadStillSendable()` re-reads status + manualStage immediately before the Unipile API call.
2. **Post-API commit:** `commitSentMessage()` uses `updateMany` with `WHERE status IN ('PENDING', 'ACTIVE')` — if 0 rows updated, the send already happened but local state is not advanced.

**File:** [lib/channels/thread-worker.ts:71](../lib/channels/thread-worker.ts#L71)

### Crash recovery marker

Before every API call, the worker writes `pendingSendKey + pendingSendStartedAt` to the thread row. On successful commit, these are cleared. If the worker crashes between the API call and the DB commit, a future heal job can find stale markers (`pendingSendKey IS NOT NULL AND pendingSendStartedAt < now - 10min`) and recover.

**File:** [lib/channels/thread-worker.ts:204](../lib/channels/thread-worker.ts#L204)

---

## Webhook → reply → stage transition

When a candidate replies (LinkedIn DM, InMail, email, or WhatsApp), Unipile delivers a webhook:

**Route:** `POST /api/webhooks/unipile` ([app/api/webhooks/unipile/route.ts](../app/api/webhooks/unipile/route.ts))

### Deduplication

Every webhook is first inserted into `WebhookEvent` with the provider's event ID. `INSERT ... ON CONFLICT DO NOTHING` — if Unipile retries, the duplicate is silently dropped.

### Secret verification

Unipile webhooks include an `x-unipile-secret` header. Verified using constant-time comparison to prevent timing-attack leakage. Missing secret in production → reject (fail-closed).

### Event handling

The webhook handler supports multiple event types from Unipile:

| Event | Action |
|---|---|
| `users.new_relation` / `new_relation` | LinkedIn invite accepted → find thread by `candidateProviderId`, advance to `CONNECTED` |
| `new_message` | New inbound message → find thread by `(providerChatId, account.id)`, call `markThreadReplied()` |

Thread lookup for reply events: scoped by `(providerChatId, account.id)` — **never** by `providerChatId` alone, because the same chat ID could theoretically appear on different accounts.

### markThreadReplied()

**File:** [lib/channels/thread-worker.ts:1229](../lib/channels/thread-worker.ts#L1229)

1. Flips the replied thread to `REPLIED`.
2. Pauses all other `PENDING / ACTIVE` threads on the **same task** (sibling-pause).
3. **Cross-task pause** — if the task has a `candidateProfileId`, also pauses active threads on every other task that shares the same profile (same physical person, different requisitions).
4. Calls `recomputeTaskStage(taskId)` → `Task.stage → REPLIED`.

---

## Sending account pool

Each channel has a `sendingAccountId` (default account) and an optional `ChannelAccountPool` (list of allowed accounts with priority weights).

`fanOutToChannels()` selects the best account from the pool (highest priority, fewest active threads). Once a thread is created and the first message sent, `ChannelThread.accountId` is set and **never changed** — the conversation belongs to that account. All follow-ups use the same account regardless of later channel config changes.

**File:** [lib/channels/fan-out.ts](../lib/channels/fan-out.ts)

---

## Daily caps

Two separate daily caps are enforced per tick:

1. **Account-level cap** (`Account.dailyCount >= effectiveAccountDailyCap`) — enforced in `processThread()` before any channel logic. When hit, thread is rescheduled to tomorrow.
2. **Channel-level cap** (`Channel.dailyCap`) — counts `ThreadMessage` rows with `sentAt >= today` for this channel. Enforced inside each channel handler.

Both caps reset at end-of-day. LinkedIn also has a **weekly invite cap** (`Account.weeklyCount >= CONFIG.WEEKLY_SAFE_LIMIT`) that reschedules to the next weekly reset.

---

## Circuit breaker

Each `ChannelThread` has a `consecutiveFailures` counter. On every unhandled error in `processThread()`, the counter is incremented. When it reaches 5, the thread is archived with a structured reason rather than retrying forever.

The counter resets to 0 on every successful `commitSentMessage()`.

**File:** [lib/channels/thread-worker.ts:387](../lib/channels/thread-worker.ts#L387)

---

## StageEvent audit trail

Every `Task.stage` change — whether from a recruiter drag, a webhook, or the outreach tick — creates a `StageEvent` row. Two write paths:

1. **Postgres trigger** `task_stage_audit` — fires `AFTER UPDATE OF stage ON "Task"`. Catches any direct update that bypasses application code.
2. **Application code** — `recomputeTaskStage()` writes its own `StageEvent` and uses `markStageEventExplicit()` to suppress the trigger for that specific transaction (prevents duplicate rows).

`StageEvent.actor` values: `USER` (recruiter action), `SYSTEM` (outreach tick / auto-shortlist), `RULE`, `WEBHOOK`.
