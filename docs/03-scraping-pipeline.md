# 03 — Scraping Pipeline

This document covers how a LinkedIn URL (or uploaded resume) goes from a raw string pasted by the recruiter all the way to a persisted, scored candidate record in the database.

---

## Overview

There are two scraping paths:

| Source | Queue | Handler |
|---|---|---|
| LinkedIn URL | `process-task` | `handleLinkedInJobs` in [lib/workers/task-handlers.ts](../lib/workers/task-handlers.ts) |
| Resume PDF / ZIP | `process-resume-task` | `handleResumeJobs` in [lib/workers/task-handlers.ts](../lib/workers/task-handlers.ts) |

Both paths share the same entry point (the recruiter submits URLs/files), the same queue system (pg-boss), and the same persistence layer (`persistLinkedInResult` or inline for resumes). They diverge in what they do at the "fetch" step.

---

## Step-by-step: LinkedIn URL path

### 1 — Recruiter submits URLs

**Route:** `POST /api/requisitions/[requisitionId]/candidates`

The recruiter pastes one or more LinkedIn URLs into the UI. The API route:

1. Canonicalizes each URL ([lib/canonicalize-url.ts](../lib/canonicalize-url.ts)) and deduplicates within the batch.
2. Creates a `Job` row (`status: PENDING`, `totalTasks: N`).
3. Creates one `Task` row per URL (`status: PENDING`, `source: "linkedin_url"`).
4. Calls `enqueueTaskBatch()` ([lib/queue.ts:125](../lib/queue.ts#L125)) which inserts rows directly into `pgboss.job` via Prisma raw SQL — no pg-boss client needed on the web process.

### 2 — Worker picks up the job

The Railway worker runs `worker.ts` which calls:

```ts
boss.work("process-task", { localConcurrency: 3 }, handleLinkedInJobs)
```

`localConcurrency: 3` means up to 3 LinkedIn tasks can process in parallel. This is intentionally low to stay within the Supabase PgBouncer session-mode connection limit (budget: pg-boss pool=3 + Prisma worker slots=5 = 8 total).

**File:** [worker.ts:12](../worker.ts#L12)

### 3 — Account acquisition

Before calling Unipile, the worker acquires a LinkedIn account from the pool:

```
acquireAccount("LINKEDIN")  →  lib/services/account.service.ts:88
```

Selection logic ([account.service.ts:43](../lib/services/account.service.ts#L43)):
- Only `ACTIVE` accounts (not BUSY / COOLDOWN / DISABLED)
- Not soft-deleted (`deletedAt IS NULL`)
- `dailyCount < CONFIG.DAILY_SAFE_LIMIT`
- `minuteCount < CONFIG.MAX_REQUESTS_PER_MINUTE`
- No active cooldown (`cooldownUntil IS NULL` or in the past)
- Ordered by `dailyCount ASC, lastUsedAt ASC` — fewest-used first (round-robin effect)
- Uses optimistic locking: tries to `UPDATE ... SET status = 'BUSY' WHERE status = 'ACTIVE'`; if another worker grabbed the same account concurrently, the update fails and the next candidate is tried.

If no account is available, the worker throws an error and pg-boss reschedules the job with backoff.

### 4 — Claim the Task

```ts
prisma.task.update({
  where: { id: taskId, status: { in: ["PENDING", "PROCESSING"] } },
  data: { status: "PROCESSING", accountId: account.id },
})
```

The `status: { in: [...] }` guard ensures that if two workers somehow pick up the same job (e.g., after a pg-boss retry), only one can claim it. The other gets `null` back and releases the account.

**File:** [task-handlers.ts:155](../lib/workers/task-handlers.ts#L155)

### 5 — Fetch profile from Unipile

```ts
fetchProfile(account.accountId, identifier, account.dsn, account.apiKey)
```

**File:** [lib/services/unipile.service.ts:158](../lib/services/unipile.service.ts#L158)

Endpoint called: `GET {DSN}/api/v1/users/{linkedin_identifier}?account_id={...}&linkedin_sections=*`

The `linkedin_sections=*` parameter requests all profile sections (work experience, education, skills, certifications). Timeout: 30 seconds.

The `identifier` is extracted from the URL by `extractIdentifier()` ([unipile.service.ts:40](../lib/services/unipile.service.ts#L40)):
```
"https://www.linkedin.com/in/johndoe?foo=bar"  →  "johndoe"
```

### 6 — Persist result + run AI analysis

Both happen inside `persistLinkedInResult()` ([lib/workers/persist-linkedin-result.ts](../lib/workers/persist-linkedin-result.ts)):

1. **AI analysis** (external, outside the DB transaction) — calls `analyzeProfile()` if the Job has a `jobDescription` in its config. See [docs/04-ai-analysis.md](./04-ai-analysis.md).
2. **Atomic DB write** — one `prisma.$transaction(...)` that:
   - Find-or-creates a `CandidateProfile` by `canonicalLinkedinUrl`
   - Creates an `AnalysisRecord` (if analysis ran)
   - Updates the `Task` to `status: DONE`, writes `result` (raw JSON), `analysisResult` (scored JSON), `candidateName`, `candidateProfileId`, and `analysisStatus`
3. **Sheet export** (external, best-effort, outside the transaction) — if `sheetWebAppUrl` is configured and the score meets the threshold.

**File:** [lib/workers/persist-linkedin-result.ts:31](../lib/workers/persist-linkedin-result.ts#L31)

### 7 — Auto-shortlist

After persistence, `maybeAutoShortlist()` ([task-handlers.ts:70](../lib/workers/task-handlers.ts#L70)) checks the requisition's `autoShortlistThreshold` (default 70%). If `scorePercent >= threshold` and the candidate is still at `SOURCED`, it:

1. Advances `Task.stage → SHORTLISTED` inside a transaction.
2. Creates a `StageEvent` (`actor: SYSTEM`).
3. Calls `fanOutToChannels()` ([lib/channels/fan-out.ts](../lib/channels/fan-out.ts)) which creates `ChannelThread` rows for all active channels whose score bands match this candidate.

### 8 — Account release

In the `finally` block, `releaseAccount(account.id, success)` ([account.service.ts:97](../lib/services/account.service.ts#L97)):
- Sets status back to `ACTIVE`
- Increments `dailyCount`, `requestCount`, `minuteCount` (only on success)
- Sets / refreshes `dailyResetAt` and `minuteResetAt`

---

## Step-by-step: Resume / ZIP path

### Entry point

**Routes:**
- Single PDF: `POST /api/requisitions/[requisitionId]/upload-profiles`
- ZIP of PDFs: same route, extracts files server-side with `jszip`

The route:
1. Uploads the PDF to S3 ([lib/s3.ts](../lib/s3.ts)).
2. Extracts text from the PDF via `pdf-parse`.
3. Creates a `Task` row with `source: "resume"`, `result` pre-set to `{ resumeText, sourceFileName, ... }`.
4. Enqueues to `process-resume-task`.

### Worker handler

`handleResumeJobs` ([task-handlers.ts:456](../lib/workers/task-handlers.ts#L456)) — no account acquisition needed (resumes don't need Unipile). It:

1. Reads the pre-extracted `resumeText` from `task.result`.
2. Calls `analyzeProfile(preloaded, jobConfig)` directly.
3. Updates `Task` to `DONE` + writes `analysisResult`.
4. Calls `maybeAutoShortlist()`.
5. Sheet export if configured.

---

## Error handling and retries

pg-boss is configured with `retryLimit: 3`, `retryDelay: 30s`, `retryBackoff: true` (30s → 60s → 120s).

| Error type | Behaviour |
|---|---|
| `RateLimitError` (HTTP 429) | `cooldownAccount()` → puts account in COOLDOWN for `CONFIG.COOLDOWN_DURATION_MS`. Task stays PENDING, pg-boss retries with backoff. On last attempt: `markTaskFailed()`. |
| `ServerError` (HTTP 5xx) | Retryable. Same pattern — reset to PENDING, re-throw for pg-boss. On last attempt: `markTaskFailed()`. |
| `NetworkError` (timeout) | Same as ServerError. |
| `ClientError` (HTTP 4xx) | Non-retryable. `markTaskFailed()` immediately. |
| No accounts available | Throws; pg-boss reschedules — no account state changed. |
| Job CANCELLED | Task marked FAILED immediately. |
| Job PAUSED | Task reset to PENDING, released without fail count. |

`markTaskFailed()` sets both `Task.status = FAILED` and `Task.analysisStatus = FAILED` so the recruiter UI can surface these in a "needs review" queue.

**File:** [task-handlers.ts:36](../lib/workers/task-handlers.ts#L36)

---

## Account rotation and rate limits

All rate-limit logic lives in [lib/services/account.service.ts](../lib/services/account.service.ts) and [lib/config.ts](../lib/config.ts).

| Counter | Scope | Reset trigger |
|---|---|---|
| `minuteCount` | Per account per minute | `minuteResetAt < now` — reset by `resetExpiredWindows()` at start of each acquisition |
| `dailyCount` | Per account per calendar day | `dailyResetAt < now` |
| `weeklyCount` | Per LinkedIn account per 7-day window | `weeklyResetAt < now` — enforces LinkedIn's ~100 invite/week limit |
| `cooldownUntil` | Per account, set on 429 | Absolute timestamp — account moves back to ACTIVE when it passes |

**Warmup ramp:** New accounts have `warmupUntil` set. While `now < warmupUntil`, the effective daily cap is `CONFIG.WARMUP_DAILY_CAP` (a lower number) instead of `CONFIG.DAILY_SAFE_LIMIT`. This prevents fresh LinkedIn accounts from being flagged for sudden activity spikes.

**Jitter:** `jitter()` ([lib/config.ts](../lib/config.ts)) is called before each Unipile fetch to add random millisecond delay, spreading concurrent requests so they don't all hit Unipile at the exact same moment.

---

## Flow summary

```
Recruiter pastes URLs
        │
        ▼
POST /api/requisitions/:id/candidates
  → Create Job + Task rows (PENDING)
  → INSERT into pgboss.job
        │
        ▼ (Railway worker polls every few seconds)
handleLinkedInJobs()
  → acquireAccount() — optimistic lock
  → task.status = PROCESSING
  → fetchProfile() — Unipile GET /users/:id
  → analyzeProfile() — LLM scoring
  → prisma.$transaction()
      · upsert CandidateProfile
      · create AnalysisRecord
      · task.status = DONE
  → maybeAutoShortlist()
      · if score >= threshold → task.stage = SHORTLISTED
      · fanOutToChannels() → creates ChannelThreads
  → releaseAccount()
        │
        ▼
Candidate appears in scored list
Outreach tick picks up ChannelThreads
```
