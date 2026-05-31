# 07 — Cron Jobs and Workers

This document covers every scheduled background process in the system: what it does, where it runs, and how it is triggered.

---

## Overview

Background work is split across two platforms:

| Platform | What runs there |
|---|---|
| **Railway** (persistent Node process) | pg-boss job workers + outreach tick loop |
| **Vercel** (serverless cron) | Account maintenance + webhook cleanup |
| **External scheduler** (cron-job.org) | Invite acceptance polling |

---

## Railway worker — `worker.ts`

**File:** [worker.ts](../worker.ts)
**Start command:** `npm run worker` (which runs `tsx worker.ts`)

The Railway worker is a **persistent long-running Node process**. It does three things:

### 1. LinkedIn scraping queue

```ts
boss.work("process-task", { localConcurrency: 3 }, handleLinkedInJobs)
```

Polls pg-boss for `process-task` jobs. Up to 3 tasks processed concurrently. Each job picks up a `Task` row, acquires a LinkedIn account, calls Unipile to fetch the profile, runs AI analysis, and persists the result.

**Handler:** [lib/workers/task-handlers.ts:408](../lib/workers/task-handlers.ts#L408)

### 2. Resume processing queue

```ts
boss.work("process-resume-task", { localConcurrency: 2 }, handleResumeJobs)
```

Polls for `process-resume-task` jobs. Up to 2 concurrent. Each job reads the pre-extracted PDF text from `Task.result`, runs AI analysis, and persists the score.

**Handler:** [lib/workers/task-handlers.ts:456](../lib/workers/task-handlers.ts#L456)

### 3. Outreach tick (every 30 seconds)

```ts
setInterval(async () => { await runOutreachTick(); }, 30_000)
```

In-process `setInterval`. Not a separate cron — runs inside the same Railway process. Re-entrant-safe: if a previous tick is still running, the new interval fires are skipped (`tickRunning` flag).

Each tick:
- Claims up to 200 due `ChannelThread` rows using `FOR UPDATE SKIP LOCKED`
- Calls `processThread()` for each claimed thread
- Advances the thread by one step (sends invite, DM, email, or WhatsApp; or archives if timed out)

**File:** [lib/channels/outreach-tick.ts](../lib/channels/outreach-tick.ts)
**Details:** [docs/05-outreach-and-stages.md](./05-outreach-and-stages.md)

### pg-boss connection

The worker starts a pg-boss instance with a dedicated 3-connection pool (separate from Prisma's pool). pg-boss maintains queue state in the `pgboss` schema of the same PostgreSQL database.

Queue config ([lib/queue.ts:42](../lib/queue.ts#L42)):
- `retryLimit: 3` with exponential backoff (30s → 60s → 120s)
- `expireInSeconds: 300` — jobs stuck longer than 5 minutes are automatically retried
- `deleteAfterSeconds: 86400` — completed job records deleted after 24h

**File:** [lib/queue.ts](../lib/queue.ts)

### Graceful shutdown

The worker listens for `SIGTERM` and `SIGINT`. On shutdown it calls `boss.stop({ graceful: true, timeout: 25000 })` — waits up to 25 seconds for in-flight jobs to finish before exiting.

---

## Vercel cron jobs (live)

Both are configured in [vercel.json](../vercel.json). They require `Authorization: Bearer {CRON_SECRET}` in production.

### `/api/cron/process-tasks` — Account maintenance

**Schedule:** `0 0 * * *` (daily at midnight UTC)
**File:** [app/api/cron/process-tasks/route.ts](../app/api/cron/process-tasks/route.ts)
**Max duration:** 30s

Despite its name (a legacy artifact), this route does **account maintenance**, not task processing. Tasks are processed continuously by the Railway worker.

What it does:
1. **Resets orphaned BUSY accounts** — finds accounts in `BUSY` status with no `PROCESSING` tasks and resets them to `ACTIVE`. Handles the case where a worker crash left the account status stuck.
2. **Refreshes expired cooldowns** — calls `refreshCooldowns()` to flip `COOLDOWN → ACTIVE` for any account whose `cooldownUntil` has passed. (The worker does this too; this is a daily safety net.)
3. **Clears old raw profiles** — if `DATA_RETENTION_DAYS > 0`, nulls out `CandidateProfile.rawProfile` for profiles older than that threshold (saves storage on free-tier setups). Task deletion is intentionally disabled — `analysisResult` data is kept forever.

### `/api/cron/cleanup-webhooks` — Prune old webhook events

**Schedule:** `30 3 * * *` (daily at 03:30 UTC)
**File:** [app/api/cron/cleanup-webhooks/route.ts](../app/api/cron/cleanup-webhooks/route.ts)
**Max duration:** 60s

Deletes `WebhookEvent` rows older than 90 days. The `WebhookEvent` table is a deduplication log for incoming Unipile webhooks — rows are only needed for the retry window, not forever.

---

## External cron — invite acceptance polling

### `/api/cron/poll-acceptances`

**Scheduler:** cron-job.org (external, not Vercel) — once per day (or configurable)
**File:** [app/api/cron/poll-acceptances/route.ts](../app/api/cron/poll-acceptances/route.ts)
**Max duration:** 60s

Calls both `pollJobInviteAcceptances()` and `pollChatReplies()` in parallel — the two Unipile API polling functions that are deliberately **not** run on the 30s outreach tick.

Why not in the tick?  
Polling Unipile's sent-invitations list or chat messages every 30s would generate ~2,800+ calls/account/day and trigger LinkedIn automation flags. Running this once or a few times per day is safe.

A random 10–30s jitter is injected at the start of the handler to prevent simultaneous wall-clock hits when multiple accounts are polled.

**What it does:**
- `pollJobInviteAcceptances()` — for each `INVITE_PENDING` thread, fetches Unipile's "sent invitations" list. If the invite is no longer pending (candidate accepted), advances the thread to `CONNECTED` and triggers `recomputeTaskStage()`.
- `pollChatReplies()` — for each `ACTIVE` thread with a `providerChatId`, fetches the last 5 messages. If any inbound message arrived after `lastMessageAt`, marks the thread `REPLIED` (same path as the webhook handler).

---

## Dead cron routes (exist in code, not scheduled)

These routes exist under `app/api/cron/` but nothing triggers them automatically. They are safe to call manually for diagnostics.

| Route | File | Why it's dead |
|---|---|---|
| `/api/cron/outreach-tick` | [app/api/cron/outreach-tick/route.ts](../app/api/cron/outreach-tick/route.ts) | The actual outreach tick runs in-process in Railway every 30s. This HTTP route is a backup trigger for testing but is not scheduled. |
| `/api/cron/stage-snapshot` | [app/api/cron/stage-snapshot/route.ts](../app/api/cron/stage-snapshot/route.ts) | Captures a `StageSnapshot` and runs anomaly detection. The route comment shows a Vercel cron schedule (`0 8 * * *`) but it was never added to `vercel.json`. Call manually after a suspicious mass-stage-change to capture a snapshot and check for anomalies. |

---

## Advisory locks

The CLAUDE.md notes that any global serialization across both the web process and the Railway worker must use **Postgres advisory locks** — in-memory mutexes in the web process would not be visible to the worker.

Currently, `FOR UPDATE SKIP LOCKED` in the outreach tick claim query serves as the distributed mutex for thread processing. No explicit `pg_advisory_lock()` calls are in the codebase today, but this is the correct approach for any future global coordination.

---

## Monitoring and alerting

There is no automated alerting today. Failures surface in:
- **Railway logs** — worker process stderr, structured JSON lines for each task outcome
- **Vercel logs** — cron function stdout

Structured log lines from the worker use the format:
```json
{ "event": "task_done", "taskId": "...", "jobId": "...", "accountId": "...", "source": "linkedin", "durationMs": 4200, "outcome": "success" }
```

The stage-snapshot route ([app/api/cron/stage-snapshot/route.ts](../app/api/cron/stage-snapshot/route.ts)) has anomaly detection built in — if called, it compares today's `StageSnapshot` against recent ones and logs `level: "warn"` events for large unexplained stage drops. Wire this to Slack/email when needed.
