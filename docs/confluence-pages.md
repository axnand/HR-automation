# Confluence Handover — Page Drafts

> Four pages ready to paste into Confluence. Tone, depth, and structure are consistent across all four. Diagrams are referenced inline; render the `.mmd` files to PNG (paste into https://mermaid.live → Export → PNG) and attach in Confluence, or use the Mermaid Diagram macro if your space has it installed.

---
---

# Page 1 — Project Overview

## What is Hirro

Hirro is an internal recruitment automation tool built for the Salescode recruiter and intern teams. It replaces three otherwise-manual workflows:

1. **Profile scraping** — paste a list of LinkedIn URLs and the system fetches full profiles via Unipile, using a rotating pool of LinkedIn accounts.
2. **AI candidate scoring** — every scraped profile is evaluated by an LLM against the role's custom scoring rules, producing a numeric score, fit recommendation, and detailed reasoning.
3. **Outreach automation** — shortlisted candidates flow into a pipeline and automatically receive LinkedIn invites, InMails, and follow-up DMs (with email and WhatsApp also supported) on a configurable cadence. Replies trigger automatic stage transitions via webhooks.

The product is internal-only — no external customer access.

## Who uses it

| Role | What they do in the app |
|---|---|
| **Recruiter** | Creates job roles (requisitions), reviews scored candidates, configures outreach channels, manages the candidate pipeline |
| **Intern** | Pastes LinkedIn URLs and resume PDFs in bulk, monitors scoring results |

## The product in three steps

```
1. SOURCE             →   2. SCORE                →   3. REACH OUT
─────────                 ──────────                  ────────────
Paste LinkedIn URLs       AI evaluates each            Auto-shortlisted candidates
or upload resume PDFs.    profile against the          flow into outreach channels.
                          role's scoring rules.        Invites, DMs and follow-ups
                                                       are sent on a schedule.
                          Each candidate gets a        Webhook replies move
                          0-100% score and a fit       candidates through pipeline
                          recommendation.              stages automatically.
```

## Where it runs

| Component | Platform | Notes |
|---|---|---|
| Frontend + API routes | **Vercel** (region `bom1`) | Next.js 16, App Router |
| Background worker | **Railway** | Persistent Node process running `worker.ts` |
| Database | **PostgreSQL** on the E2E server | Owned by the Promos team |
| Job queue | pg-boss, inside the same Postgres | Schema `pgboss`, auto-managed |
| Scraping + outreach API | **Unipile** | LinkedIn, Email, WhatsApp |
| AI scoring | Configurable LLM provider | Defaults to OpenAI; also supports Anthropic, AWS Bedrock, Gemini, Groq, Mistral, DeepSeek, Together AI |
| Resume storage | **AWS S3** | Resume PDFs uploaded by users |

## Tech stack at a glance

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (App Router) |
| Language | TypeScript |
| ORM | Prisma 5 |
| Database | PostgreSQL |
| Job queue | pg-boss 12 |
| UI | React 19, Tailwind CSS 4, shadcn/ui, Radix UI |
| File storage | AWS S3 |

## Quick links

- **GitHub repository** — _add link_
- **Vercel project dashboard** — _add link_
- **Railway service** — _add link_
- **Unipile dashboard** — _add link_
- **Full engineering docs** — `docs/` folder in the repo (10 markdown files covering database schema, scraping pipeline, AI scoring, outreach engine, cron jobs, runbooks, and environment setup)

## What's on the other pages

| Page | What you'll find there |
|---|---|
| **System Architecture** | Architecture diagram, database ER diagram, how Vercel and Railway divide the work |
| **How It Works** | The full candidate journey — from URL paste to reply — including stage transitions and webhook flow |
| **Operations & Maintenance** | Cron schedule, environment variables, where credentials live, common runbooks, access handover checklist |

---
---

# Page 2 — System Architecture

## Architecture diagram

> 📎 **Attach:** render `docs/architecture-diagram.mmd` to PNG and embed here.

The system has three logical pieces that always run together:

- **Vercel** hosts the UI and all API routes — anything serving an HTTP request from the browser.
- **Railway** runs the long-lived background worker — anything that needs to keep running between requests.
- **PostgreSQL** (E2E server) holds both the application data and the pg-boss job queue.

External integrations (Unipile, the LLM provider, AWS S3) are called from whichever side of the system needs them.

## Tech stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (App Router) |
| Language | TypeScript |
| ORM | Prisma 5 |
| Database | PostgreSQL |
| Job queue | pg-boss 12 (in the same Postgres) |
| UI | React 19, Tailwind CSS 4, shadcn/ui, Radix UI |
| Scraping + outreach | Unipile REST API |
| LLM | OpenAI-compatible, Anthropic, or AWS Bedrock (configurable) |
| File storage | AWS S3 (resume PDFs) |

## Vercel vs Railway — why two backends?

Vercel serverless functions have a 30-60 second execution limit and cannot maintain a long-running process. Recruitment automation needs something that keeps running between requests — a process that polls a queue, runs every 30 seconds, and handles webhooks without spinning up cold.

So the system splits cleanly:

- **Vercel handles all HTTP traffic** — UI pages, API routes, webhook receivers, and a few low-frequency cron jobs.
- **Railway handles all background work** — pg-boss workers for LinkedIn scraping and resume parsing, plus the in-process outreach tick that fires every 30 seconds to send the next due message.

Both processes connect to the same PostgreSQL database and the same pg-boss queue tables. Coordination between them happens through database state (claim queries, `FOR UPDATE SKIP LOCKED`), not in-memory messaging.

## Database

> 📎 **Attach:** render `docs/db-diagram.mmd` to PNG and embed here.

The database is PostgreSQL on the E2E server, managed via Prisma. The full schema lives in `prisma/schema.prisma` in the repo.

### Core models

| Model | Purpose |
|---|---|
| **Requisition** | A job role. Owns its JD, scoring rules, and outreach channels. |
| **Job** | A single bulk-analysis run against a Requisition. |
| **Task** | One candidate (LinkedIn URL or resume). Holds the raw profile, score, and current pipeline stage. |
| **Account** | A Unipile-registered sending account (LinkedIn / Email / WhatsApp), with rate-limit counters. |
| **Channel** | One outreach channel per Requisition per type. Holds the followup templates and score bands. |
| **ChannelThread** | One row per `(Task, Channel)` — tracks the full outreach lifecycle for one candidate on one channel. |
| **ThreadMessage** | An immutable record of every outbound message sent. |
| **CandidateProfile** | Canonical per-person record. Lets the same person be tracked across multiple requisitions. |
| **AnalysisRecord** | Full snapshot of an AI scoring run — preserved even if the JD changes later. |
| **StageEvent** | Audit log of every candidate stage transition. |

The full field-by-field reference (every column, every index, every relationship) lives in `docs/02-database-schema.md` in the repo.

---
---

# Page 3 — How It Works (End-to-End)

This page walks through what actually happens when a recruiter pastes a LinkedIn URL — all the way to a candidate replying.

## The candidate journey

### 1. Recruiter creates a job role (Requisition)
The recruiter opens the app, clicks **New Role**, and fills in the title, JD, scoring rules, and outreach channels. This creates a `Requisition` row that owns all subsequent activity.

### 2. Recruiter adds candidates
From the role's **Candidates** tab, the recruiter:
- Pastes a batch of LinkedIn URLs, OR
- Uploads resume PDFs / a ZIP of PDFs, OR
- Adds candidates manually

This creates one `Job` row (the bulk run) and one `Task` row per URL or file. Each task is enqueued into pg-boss for processing.

### 3. The Railway worker picks up each task
- For LinkedIn URLs: the worker acquires a LinkedIn account from the rotation pool, calls Unipile to fetch the full profile, and stores the raw JSON.
- For resumes: the worker reads the pre-extracted PDF text from the task row.

Either way, the worker then runs **AI analysis** against the role's scoring config.

### 4. AI scores the candidate
The analyzer combines deterministic pre-computation (stability and location) with an LLM call (everything else). It produces:
- A numeric score (out of the role's configured max, e.g. 85)
- A fit recommendation: **Strong Fit** (≥70%), **Moderate Fit** (40-70%), or **Not a Fit** (<40%)
- Per-rule scoring reasoning, strengths, gaps, and flagged disqualifiers

Results are stored on the `Task` and on an immutable `AnalysisRecord` row.

### 5. Auto-shortlist (if score is high enough)
If the score exceeds the role's `autoShortlistThreshold` (default 70%), the system automatically:
- Moves the candidate to the **SHORTLISTED** stage
- Creates a `ChannelThread` for every active outreach Channel whose score band matches

The candidate is now ready for outreach.

### 6. Outreach tick sends the first message
Every 30 seconds, the Railway worker scans for due threads and advances each by one step. For a new LinkedIn thread that means:
- Send a connection invite (or InMail, depending on the matched rule)
- Wait for the candidate to accept
- Send the first DM once connected
- Send follow-ups on the configured schedule (e.g. day 3, day 7, day 14)

For email and WhatsApp threads: same pattern, different provider.

### 7. Candidate replies → webhook → stage update
When the candidate replies, Unipile delivers a webhook to `POST /api/webhooks/unipile`. The handler:
- Marks the thread as `REPLIED`
- Pauses every other open thread on the same task (sibling-pause)
- Also pauses threads on other requisitions where the same person is being sourced (cross-task pause)
- Recomputes the candidate's stage to `REPLIED`

The recruiter sees the candidate move into the **REPLIED** column on the pipeline.

### 8. Recruiter moves candidate forward manually
From the pipeline view, the recruiter drags the candidate into **INTERVIEW**, **HIRED**, or **REJECTED** as the conversation progresses. These stages are recorded as `manualStage` and always win over any derived rollup.

## Stage state machine

Candidates move through these pipeline stages:

```
                                       (recruiter sets manually)
                                       ┌──────────────────────┐
                                       │                      │
SOURCED → SHORTLISTED → CONTACT_REQUESTED → CONNECTED → MESSAGED → REPLIED → INTERVIEW → HIRED
                                                                                  │
                                                                                  └→ REJECTED

                                                  ARCHIVED  (all threads exhausted or recruiter action)
```

- Stages from SOURCED through REPLIED are **system-derived** from the underlying outreach thread states — they reflect actual channel activity.
- INTERVIEW, HIRED, REJECTED, and ARCHIVED are **recruiter-set** via drag-and-drop on the pipeline. Once set, they cannot be overridden by automation.

## How the outreach tick works

The Railway worker runs `setInterval(runOutreachTick, 30_000)`. Each tick:

1. **Claims** up to 200 due threads atomically, using `FOR UPDATE SKIP LOCKED` so two workers can't pick the same row.
2. For each claimed thread, calls `processThread()` which advances it by exactly one step depending on its channel type and current phase.
3. Each step writes the next `nextActionAt` timestamp so the thread is naturally re-scheduled for its next followup.

Steps that fail are retried 5 minutes later. After 5 consecutive failures on the same thread, a circuit breaker archives it with a structured reason.

## How webhook replies work

```
Candidate replies on LinkedIn
        │
        ▼
Unipile delivers webhook to POST /api/webhooks/unipile
        │
        ▼
Handler verifies shared-secret header
        │
        ▼
Handler dedupes via WebhookEvent table (provider's own event ID)
        │
        ▼
Looks up ChannelThread by (providerChatId + account.id)
        │
        ▼
markThreadReplied():
    · flip this thread to REPLIED
    · pause sibling threads on same Task
    · pause sibling threads on same CandidateProfile (cross-requisition)
        │
        ▼
recomputeTaskStage(taskId) → Task.stage = REPLIED
```

A second cron polls Unipile directly once a day as a fallback in case any webhooks are missed.

## AI scoring at a glance

The scoring engine combines 7 built-in rules (toggleable per role) with any number of custom rules the recruiter adds.

### Built-in rules

| Rule | Max points | Scored by |
|---|---|---|
| Stability | 10 | Deterministic — average tenure across employers |
| Growth | 15 | LLM — internal promotions vs lateral moves |
| Graduation | 15 | LLM — BTech/BE vs Non-BTech × institution tier |
| Company Type | 15 | LLM — B2B SalesTech vs other B2B vs services vs B2C |
| MBA | 15 | LLM — Tier 1 MBA vs other |
| Skill Match | 10 | LLM — % of JD-required skills the candidate has |
| Location | 5 | Deterministic — token match against JD location |

Default total: **85 points**.

### How a score is produced

1. The system pre-computes stability and location locally (no LLM call needed).
2. The system builds a system prompt containing the role identity, behavioral rules, scoring criteria, and a JSON output schema.
3. The candidate's structured profile is sent as the user prompt.
4. The LLM returns a JSON object with scores, reasoning, strengths, gaps, and flagged disqualifiers.
5. The system merges deterministic + LLM scores, validates, and persists.

### Custom rules

Recruiters can add any number of custom rules (each with its own name, max points, and natural-language criteria). Custom rules are appended to the built-in set and scored by the LLM alongside them.

### Prompt customization

The prompt can be customized at four layers, from most-specific to least: **EvaluationConfig** (full preset) → **per-requisition customPrompt** → **PromptTemplate** (saved snippets) → **AppSettings defaults**.

---
---

# Page 4 — Operations & Maintenance

## Scheduled jobs

### Vercel cron (configured in `vercel.json`)

| Route | Schedule | What it does |
|---|---|---|
| `/api/cron/process-tasks` | Daily, 00:00 UTC | Account maintenance: resets orphaned BUSY accounts, refreshes expired cooldowns, recovers stuck outreach threads, clears old raw profile data (when retention is enabled) |
| `/api/cron/cleanup-webhooks` | Daily, 03:30 UTC | Deletes `WebhookEvent` rows older than 90 days |
| `/api/cron/stage-snapshot` | Daily, 08:00 UTC | Captures daily stage-distribution snapshot per role; runs anomaly detection for unexplained large stage shifts |

### External cron (cron-job.org)

| Route | Schedule | What it does |
|---|---|---|
| `/api/cron/poll-acceptances` | Configurable (typically daily) | Polls Unipile for invite acceptances and chat replies as a safety net against missed webhooks |

### In-process (Railway worker)

The Railway worker runs `worker.ts` continuously. Inside that process:

- **pg-boss workers** for the `process-task` (LinkedIn scrape, 3 concurrent) and `process-resume-task` (resume parse, 2 concurrent) queues.
- **Outreach tick** runs every 30 seconds via `setInterval`. Re-entrant-safe — skips if the previous tick is still running.

The worker shuts down gracefully on `SIGTERM`/`SIGINT` with up to 25 seconds for in-flight jobs to finish.

## Environment variables

Every variable below is actually read by the code. Variables defined in `.env.example` but unused are not listed.

### Required

| Variable | Used by | Purpose |
|---|---|---|
| `DATABASE_URL` | Vercel + Railway | Prisma connection string (via PgBouncer) |
| `DIRECT_URL` | Vercel + Railway | Direct Postgres URL for migrations |
| `DIRECT_DATABASE_URL` | Railway | pg-boss connection (can equal `DIRECT_URL`) |

### Unipile

| Variable | Purpose |
|---|---|
| `UNIPILE_DSN` | API base URL — per-account overrides in DB take precedence |
| `UNIPILE_API_KEY` | API key — per-account overrides in DB take precedence |
| `UNIPILE_WEBHOOK_SECRET` | Shared secret verified on every incoming webhook |

### AI / LLM

| Variable | Purpose |
|---|---|
| `OPENAI_API_KEY` | Fallback OpenAI key used when no `AiProvider` row exists. Once providers are configured in the UI, not strictly needed. |

### AWS S3

| Variable | Purpose |
|---|---|
| `AWS_ACCESS_KEY_ID` | S3 access key |
| `AWS_SECRET_ACCESS_KEY` | S3 secret key |
| `AWS_S3_REGION` | Bucket region |
| `AWS_S3_BUCKET` | Bucket name |

### Security / cron / app

| Variable | Purpose |
|---|---|
| `CRON_SECRET` | Bearer token required by cron routes in production |
| `EXTENSION_SECRET` | Auth for the Chrome extension config endpoint |
| `NEXT_PUBLIC_APP_URL` | Public URL of the deployed app — used for webhook registration |
| `VERCEL_URL` | Auto-injected fallback for `NEXT_PUBLIC_APP_URL` |
| `DATA_RETENTION_DAYS` | If > 0, clears raw profile JSON for candidates older than this many days |
| `POLL_ACCEPTANCES_COOLDOWN_SECS` | Optional cooldown between successive poll-acceptances runs |

### External integrations

| Variable | Purpose |
|---|---|
| `AIRSCALE_API_KEY` | Airscale contact enrichment provider |
| `NEXT_PUBLIC_LIVEKIT_URL` | LiveKit server for the experimental interview room |

## Where credentials live

| Credential | Stored in |
|---|---|
| All Vercel env vars | Vercel dashboard → Project Settings → Environment Variables |
| Railway env vars | Railway dashboard → Service → Variables |
| Per-account Unipile DSN / API keys | `Account` table (managed via Settings → Accounts UI) |
| LLM provider API keys | `AiProvider` table (managed via Settings → AI Providers UI) |
| Google Apps Script web-app URLs (for sheet export) | `SheetIntegration` table (managed via Settings → Sheet Integrations UI) |
| PostgreSQL credentials | E2E server, owned by the Promos team |

## Common operational procedures

### A candidate's outreach has stalled
1. Open the candidate detail page → check the most recent **ChannelThread** entries for `status` and `nextActionAt`.
2. If `nextActionAt` is in the past and the thread is still PENDING/ACTIVE, the daily maintenance cron will recover it within 24 hours. To recover immediately:
   ```
   curl -H "Authorization: Bearer $CRON_SECRET" https://<app-url>/api/cron/process-tasks
   ```
3. Check the candidate's **Stage Events** for the audit trail.

### A LinkedIn account is stuck in BUSY or COOLDOWN
- **BUSY with no active tasks**: trigger the maintenance cron (above) or update directly in Settings → Accounts.
- **COOLDOWN that hasn't released**: the account will release automatically when `cooldownUntil` passes. To force-release earlier, edit the account in the Settings UI.

### A scoring job is stuck at PROCESSING
The Railway worker has not restarted. Check the Railway logs for errors. The daily maintenance cron also handles orphaned PROCESSING tasks by resetting them to PENDING.

### Re-enqueue PENDING tasks after a queue reset
```
npm run worker:backfill
```
Runs `scripts/backfill-queue.ts` which finds all PENDING tasks and inserts them back into pg-boss.

### Capture a stage-distribution snapshot on demand
```
curl https://<app-url>/api/cron/stage-snapshot
```
Returns the captured snapshot and any detected anomalies.

## Access handover checklist

### Vercel
- [ ] Add new maintainer to the Vercel team
- [ ] Share all environment variable values
- [ ] Confirm cron jobs are listed in Vercel → Deployments → Cron tab

### Railway
- [ ] Add new maintainer to the Railway project
- [ ] Share Railway environment variables
- [ ] Confirm the service is running (`npm run worker`)
- [ ] Restart policy set to "Always"

### External scheduler (cron-job.org)
- [ ] Share cron-job.org login
- [ ] Job hits `GET /api/cron/poll-acceptances` with the correct `Authorization: Bearer $CRON_SECRET`

### Unipile
- [ ] Share Unipile dashboard login
- [ ] Confirm webhook is registered pointing to `https://<app-url>/api/webhooks/unipile`
- [ ] Share per-account credentials if per-account DSN/API keys are used

### Database (E2E server)
- [ ] Coordinate with the Promos team to hand over PostgreSQL access
- [ ] Share `DATABASE_URL` and `DIRECT_URL`
- [ ] Confirm new maintainer can run `npx prisma migrate deploy` against production

### AWS
- [ ] Share or rotate the AWS IAM credentials for the S3 bucket
- [ ] IAM user needs `s3:PutObject` and `s3:GetObject` on the bucket

### GitHub
- [ ] Add collaborator (or transfer ownership) to the `salescode-hirro` repository
- [ ] Confirm push access to `main`

### LLM providers
- [ ] Share underlying OpenAI / Anthropic / other provider account credentials
- [ ] Confirm the API keys in the Settings → AI Providers UI are current
