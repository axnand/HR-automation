# 08 — Scripts and Runbooks

Scripts live in [scripts/](../scripts/). Run them with `npx tsx scripts/<name>.ts` from the repo root (requires `DATABASE_URL` in your environment).

---

## Active / operational scripts

### `recompute-stages.ts`

**File:** [scripts/recompute-stages.ts](../scripts/recompute-stages.ts)
**Run:** `npx tsx scripts/recompute-stages.ts`

Iterates every `Task` that has at least one `ChannelThread` and calls `recomputeTaskStage()` on it. Idempotent — safe to run multiple times.

**When to use:** After a migration or manual DB edit that changed thread statuses outside the normal code path; after rolling back a bad deploy that may have corrupted stage values; after the 2026-04-29-style mass-reset incident.

---

### `check-task.ts`

**File:** [scripts/check-task.ts](../scripts/check-task.ts)
**Run:** `npx tsx scripts/check-task.ts`

Quick diagnostic: prints a single task with all related channel threads, account, job, and requisition data as JSON. Hardcodes a task ID fragment — edit `TASK_ID` at the top of the file before running.

**When to use:** A candidate appears stuck or in the wrong stage; you want to inspect the raw DB state without opening a Prisma Studio or writing a one-off query.

---

### `check-candidate.ts`

**File:** [scripts/check-candidate.ts](../scripts/check-candidate.ts)
**Run:** `npx tsx scripts/check-candidate.ts`

Similar to `check-task.ts` but looks up by candidate identifier (edit the constant at the top). Useful when you have a LinkedIn URL or candidate name but not a task ID.

---

## Historical scripts (do not re-run)

These scripts have already been applied to the production database. They are kept for reference only. Re-running them is safe (most are idempotent) but pointless — the backfill already happened.

| Script | What it did |
|---|---|
| `scripts/backfill-analysis-status.ts` | Populated `Task.analysisStatus` for tasks that existed before the `analysisStatus` column was added. All existing rows got `OK` or `PENDING` based on whether `analysisResult` was non-null. |
| `scripts/backfill-candidate-identity.ts` | Linked existing `Task` rows to `CandidateProfile` rows by computing `canonicalLinkedinUrl` and finding or creating the profile. Populated `Task.candidateProfileId`. |
| `scripts/backfill-candidate-name.ts` | Denormalized `candidateName` into `Task` rows for tasks that had a `result` JSON but no `candidateName` field (before the field was added to the schema). |
| `scripts/backfill-queue.ts` | Re-enqueued all `PENDING` tasks that were stuck because the pg-boss queue table was missing or reset. Referenced in `package.json` as `npm run worker:backfill`. |
| `scripts/backfill-requisitions.mjs` | One-off data migration: created `Requisition` rows from legacy `Job` rows that predated the Requisition model. `.mjs` extension because it was written before the TypeScript migration. |
| `scripts/seed-accounts.ts` | Seeded the initial set of LinkedIn sending accounts from a hardcoded list. Used once during initial setup. |
| `scripts/test-analyzer.ts` | Dev-time script for running the analyzer against a hardcoded profile to verify scoring logic. Not production data — safe to run locally for testing prompt changes. |

---

## Common runbooks

### A task is stuck in PROCESSING

A task can get stuck if the Railway worker crashed mid-processing and left the task in `PROCESSING` status without cleaning up.

1. Check the Railway logs for the relevant `taskId` around the time it got stuck.
2. The `process-tasks` maintenance cron runs daily and resets orphaned PROCESSING tasks back to PENDING — but you can trigger it manually:
   ```
   curl -H "Authorization: Bearer $CRON_SECRET" https://your-app.vercel.app/api/cron/process-tasks
   ```
3. Alternatively, update directly (use with care):
   ```sql
   UPDATE "Task" SET status = 'PENDING', "accountId" = NULL
   WHERE id = '<taskId>' AND status = 'PROCESSING';
   ```
4. The next time the worker polls, it will pick up the PENDING task and retry.

---

### An account is stuck in BUSY or COOLDOWN

**BUSY with no active tasks:** The `process-tasks` cron resets these automatically. Trigger it manually (see above) or reset directly:
```sql
UPDATE "Account" SET status = 'ACTIVE'
WHERE id = '<accountId>' AND status = 'BUSY';
```

**COOLDOWN that should have expired:** Check `cooldownUntil`. The `refreshCooldowns()` function runs at the start of each acquisition cycle and in the maintenance cron. If somehow expired cooldowns aren't refreshing:
```sql
UPDATE "Account" SET status = 'ACTIVE', "cooldownUntil" = NULL
WHERE status = 'COOLDOWN' AND "cooldownUntil" < now();
```

---

### Candidate stage looks wrong

1. Open the candidate detail page and check the **Stage Events** tab (audit trail).
2. If the stage is wrong but the threads look correct, run `recompute-stages.ts` or call `recomputeTaskStage()` directly via a script.
3. If the stage was incorrectly set by a recruiter via `manualStage`, clear it:
   ```sql
   UPDATE "Task" SET "manualStage" = NULL WHERE id = '<taskId>';
   -- then recompute
   ```
4. If you suspect a mass-reset incident (many candidates suddenly moved to a wrong stage), trigger the stage-snapshot route immediately to capture the current distribution:
   ```
   curl https://your-app.vercel.app/api/cron/stage-snapshot
   ```
   Compare the returned `alerts` array for anomalies.

---

### A Job is stuck in PROCESSING but all tasks are DONE/FAILED

The Job progress counter can get out of sync if a worker crashed after updating a Task but before updating the Job counters.

Fix:
```sql
UPDATE "Job"
SET
  "processedCount" = (SELECT COUNT(*) FROM "Task" WHERE "jobId" = '<jobId>' AND status IN ('DONE','FAILED')),
  "successCount"   = (SELECT COUNT(*) FROM "Task" WHERE "jobId" = '<jobId>' AND status = 'DONE'),
  "failedCount"    = (SELECT COUNT(*) FROM "Task" WHERE "jobId" = '<jobId>' AND status = 'FAILED'),
  status = 'COMPLETED'
WHERE id = '<jobId>';
```

---

### ChannelThread is stuck with nextActionAt in the past

The outreach tick sets `nextActionAt = NULL` when it claims a thread. If a thread has `nextActionAt` set to a time in the past but the tick never claimed it, it's likely a Railway worker downtime or the tick is crashing.

1. Check Railway logs for outreach tick errors.
2. Manually trigger the tick via the HTTP route:
   ```
   curl -H "Authorization: Bearer $CRON_SECRET" https://your-app.vercel.app/api/cron/outreach-tick
   ```
3. If a specific thread is in a broken state (e.g., `pendingSendKey` is non-null and `pendingSendStartedAt` is old), it means the worker crashed mid-send. Inspect manually:
   ```sql
   SELECT id, status, "nextActionAt", "pendingSendKey", "pendingSendStartedAt"
   FROM "ChannelThread"
   WHERE "pendingSendKey" IS NOT NULL
     AND "pendingSendStartedAt" < now() - interval '10 minutes';
   ```
   For each such thread: clear the pending marker, set `nextActionAt = now()`, and let the tick re-process it.

---

### pg-boss queue is empty but tasks are PENDING

This can happen if the Railway worker was restarted after a database wipe of the `pgboss` schema, or if jobs were inserted before the queue was initialized.

Re-enqueue all PENDING tasks:
```
npm run worker:backfill
```

This runs [scripts/backfill-queue.ts](../scripts/backfill-queue.ts) which finds all `PENDING` tasks and re-inserts them into pg-boss.
