# 10 — Known Landmines

Non-obvious rules enforced in the current codebase that a new developer would otherwise break. Each entry explains what the rule is, where it's enforced, and what breaks if you violate it.

---

## 1. Task rows are append-only

**What:** `Task` rows must **never** be hard-deleted, except through the explicit GDPR bulk-erase route (`DELETE /api/requisitions/[id]/candidates/bulk-erase`). That route logs the erasure to `GdprErasure` before deleting.

**Why:** Tasks are the audit backbone of the system. The `StageEvent` table, `ChannelThread` rows, `ThreadMessage` rows, and `AnalysisRecord` rows all cascade-delete when a Task is deleted — you lose the entire outreach and scoring history for that candidate.

**Soft-delete instead:**
```ts
await prisma.task.update({
  where: { id: taskId },
  data: { deletedAt: new Date(), deletedReason: "duplicate_resolved" },
});
```

**Where enforced:** [prisma/schema.prisma:192](../prisma/schema.prisma#L192) (comment), [CLAUDE.md](../CLAUDE.md)

---

## 2. The Prisma soft-delete filter is invisible

**What:** The extended Prisma client in [lib/prisma.ts](../lib/prisma.ts) automatically injects `{ deletedAt: null }` into every `task.findMany`, `task.findFirst`, `task.findFirstOrThrow`, and `task.count`. You will never see soft-deleted tasks in these queries unless you explicitly override.

**Why it bites you:** If you write `prisma.task.findMany({ where: { jobId: '...' } })` expecting to see all tasks including deleted ones, you won't. The filter merges silently.

**To bypass (intentional admin views only):**
```ts
prisma.task.findMany({ where: { deletedAt: { not: null } } })
```

**`findUnique` is NOT filtered** — PK lookups are deliberate and always return the row regardless of `deletedAt`.

**Where enforced:** [lib/prisma.ts:17](../lib/prisma.ts#L17)

---

## 3. Never raw-update Task.stage

**What:** Always call `recomputeTaskStage(taskId)` — never `prisma.task.update({ data: { stage: '...' } })` directly in application code.

**Why:** Two things break silently if you bypass this:
1. The Postgres trigger `task_stage_audit` fires and writes a `StageEvent` row, but with incomplete/wrong actor info since it can't see your intent.
2. The `recomputeTaskStage()` function respects `manualStage` (recruiter overrides) — a raw update can accidentally downgrade a candidate the recruiter deliberately moved to INTERVIEW.

The one exception is the explicit `StageEvent` write path inside `recomputeTaskStage()` itself — it uses `markStageEventExplicit()` to suppress the duplicate trigger row.

**Where enforced:** [lib/channels/stage-rollup.ts:59](../lib/channels/stage-rollup.ts#L59), [CLAUDE.md](../CLAUDE.md)

---

## 4. ChannelThread.accountId is sticky — never re-derive it

**What:** Once `ChannelThread.accountId` is set (on the first outbound send), it must never be changed or re-computed from `channel.sendingAccount`.

**Why:** The conversation history on LinkedIn (DM thread), WhatsApp (chat), or email (reply chain) belongs to the account that sent the first message. If you switch accounts mid-sequence:
- LinkedIn: the second account has no context of the previous DM — it appears as a new conversation to the candidate.
- Email: `reply_to` threading breaks — follow-ups no longer thread under the same email.
- WhatsApp: the phone number changes from the recipient's perspective.

**In the code:** `processThread()` reads `thread.account` first and only falls back to `thread.channel.sendingAccount` if `thread.account` is null (legacy pre-sticky threads). The first `commitSentMessage()` call binds `accountId` permanently.

**Where enforced:** [lib/channels/thread-worker.ts:258](../lib/channels/thread-worker.ts#L258), [prisma/schema.prisma:396](../prisma/schema.prisma#L396) (comment)

---

## 5. Webhook lookup must be scoped by (providerChatId, account.id)

**What:** When handling `new_message` webhook events, the thread lookup must always scope by **both** `providerChatId` and `account.id`. Never look up a thread by `providerChatId` alone.

**Why:** Unipile chat IDs are scoped to an account — the same `chat_id` value could technically be reused across different Unipile accounts, or could exist on two different LinkedIn accounts in the same pool. Looking up by chat ID alone could match the wrong candidate's thread in a multi-account setup.

**Where enforced:** [app/api/webhooks/unipile/route.ts](../app/api/webhooks/unipile/route.ts) (comment at top)

---

## 6. processThread closing transactions must use updateMany with a status guard

**What:** Any DB write that "commits" the result of an outbound API call (message sent, invite sent) must use `updateMany` with `WHERE status IN ('PENDING', 'ACTIVE')`, not `update`.

**Why:** The provider API call takes 1–5 seconds. In that window, a webhook can arrive and flip the thread to `REPLIED`. If your closing transaction uses `update` (which throws if the row is not found or doesn't match), or doesn't check status, you can clobber the `REPLIED` state with your stale `MESSAGED` state — hiding the fact that the candidate already replied.

`commitSentMessage()` checks `res.count === 0` after the `updateMany` and skips the `ThreadMessage` insert if the thread was already flipped.

**Where enforced:** [lib/channels/thread-worker.ts:98](../lib/channels/thread-worker.ts#L98) — `commitSentMessage()`

---

## 7. Do not add a cleanup cron that hard-deletes Task rows

**What:** There must be no cron, scheduled job, or automated script that deletes `Task` rows in bulk.

**Why:** A previous cleanup cron did this and was permanently retired (commit `2646e58`). The incident it was involved in caused irreversible data loss. Soft-deleted rows are cheap. If storage becomes a real concern, write a one-off script with a backup step inside the same transaction — never an automated recurring purge.

**Where enforced:** [CLAUDE.md](../CLAUDE.md), [prisma/schema.prisma:192](../prisma/schema.prisma#L192)

---

## 8. Schema migrations: nullable first, backfill second, tighten third

**What:** When adding a `NOT NULL` column to `Task` or `ChannelThread`, never do it in a single migration. The correct sequence is: (1) add nullable, (2) backfill in chunks via a script under `scripts/`, (3) second migration adds `NOT NULL`.

**Why:** Both tables have live rows. The worker processes tasks continuously. A blocking `ALTER TABLE ... ADD COLUMN ... NOT NULL DEFAULT ...` on a large table acquires an `AccessExclusiveLock` and stalls the entire worker.

Exception: trivially-defaultable columns on small tables (not `Task` or `ChannelThread`) are fine to add as `NOT NULL` with a default in a single migration.

**Where enforced:** [CLAUDE.md](../CLAUDE.md)

---

## 9. Stage trigger + markStageEventExplicit: don't create duplicate StageEvents

**What:** The Postgres trigger `task_stage_audit` auto-creates a `StageEvent` on every `Task.stage` write. When `recomputeTaskStage()` writes its own `StageEvent`, it calls `markStageEventExplicit()` first, which sets a Postgres session variable that the trigger checks before inserting.

**Why it matters for new code:** If you add a new code path that writes `Task.stage` AND also creates a `StageEvent` in the same transaction, you will get two `StageEvent` rows — one from your code and one from the trigger. Always use `markStageEventExplicit()` before your explicit `StageEvent.create()`.

**Where enforced:** [lib/channels/stage-event-context.ts](../lib/channels/stage-event-context.ts), [lib/channels/stage-rollup.ts:103](../lib/channels/stage-rollup.ts#L103)

---

## 10. manualStage wins — only four values trigger it

**What:** `Task.manualStage` overrides the derived rollup **only** for `INTERVIEW`, `HIRED`, `REJECTED`, and `ARCHIVED`. Setting `manualStage` to `SHORTLISTED` or `MESSAGED` has no special effect — the rollup will just overwrite `Task.stage` with whatever the threads say on the next recompute.

**Why:** The `MANUAL_WINS` set in `recomputeTaskStage()` is intentionally restricted to terminal recruiter decisions. Lower stages (SHORTLISTED, CONNECTED, etc.) must always reflect actual thread state.

**Where enforced:** [lib/channels/stage-rollup.ts:38](../lib/channels/stage-rollup.ts#L38)

---

## 11. WhatsApp follow-ups require a 24-hour active inbound window

**What:** WhatsApp follow-up messages (second message onward) are only sent if `lastInboundAt` is within the past 24 hours. If the window has expired, the thread is archived with a diagnostic reason rather than sending the follow-up.

**Why:** Meta's WhatsApp Business policy restricts free-form messaging to within 24 hours of the last inbound message. Sending outside this window either fails or charges for a Business template message. The system doesn't yet support Business templates.

**Where enforced:** [lib/channels/thread-worker.ts:1115](../lib/channels/thread-worker.ts#L1115)

---

## 12. Enqueueing tasks from the web process uses raw SQL, not a pg-boss client

**What:** The web (Vercel) process inserts jobs into the pg-boss queue by writing directly to `pgboss.job` via `prisma.$executeRawUnsafe()`. It does **not** start a pg-boss client instance.

**Why:** Starting a pg-boss instance opens its own connection pool and a supervisor loop. In a serverless environment this would leak connections and fail after cold starts. The raw SQL approach re-uses Prisma's existing connection and inherits the queue config (retry limits, expiry) from the `pgboss.queue` table that the Railway worker initialized.

**Where enforced:** [lib/queue.ts:86](../lib/queue.ts#L86) (comment block)

---

## 13. The `OutreachMessage` model is legacy — don't write to it

**What:** The `OutreachMessage` table belongs to an old campaign system that was replaced by the `ChannelThread` / `ThreadMessage` architecture. It is kept for historical inbound reply attribution only. No new code should write to it.

**Where enforced:** [prisma/schema.prisma:287](../prisma/schema.prisma#L287) (comment)
