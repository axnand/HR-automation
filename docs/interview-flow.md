# AI Interview Flow — Context & Implementation Plan

> **Purpose of this doc:** give any agent/engineer picking up the interview
> feature the full picture — what already exists, the external SCAI APIs we
> depend on, how it plugs into the existing outreach pipeline, the proposed
> schema, and the phased build plan. Read this before touching interview code.

**Status:** Phase 1 **shipped & verified** (session backbone + candidate launch).
**Phase 3 (delivery) built** — all four triggers (A/B/C/E), the ad-hoc delivery
primitive, the standalone capability route (§9 "Level 1" pulled forward), and the
Interviews panel. Migration `20260601000007_phase3_interview_delivery` is written
but **not yet applied** — run `prisma migrate deploy` + (optionally) the
accessToken backfill before exercising it against the DB (see §12). Transcript
endpoint **confirmed** (§3.3) — Phase 4 unblocked. Phase 2 and Phases 4–6 not
started.
**Last updated:** 2026-06-02

---

## 1. Goal

Let a candidate take an **AI-driven voice interview** in the browser:

1. Recruiter authors interview questions for a role (requisition).
2. An interview link is delivered to the candidate via the channel already open
   with them (LinkedIn / Email / WhatsApp), or manually.
3. Candidate clicks the link → joins a **LiveKit** room in the browser.
4. The **SCAI AI agent** auto-joins the same room and conducts the interview
   using the recruiter's questions (SCAI handles the dynamic questioning).
5. Candidate finishes and disconnects.
6. We **fetch the transcript** from SCAI, **score it with AI** against the
   authored questions, and surface a structured result on the candidate card.

**The SCAI team owns:** the AI agent, dynamic questioning logic, transcription,
and recording. **We own:** the web client, question authoring, link delivery,
session correlation, transcript fetch, scoring, and result UI.

---

## 2. What already exists (built in this codebase)

### LiveKit web client (done)
Ported from a reference implementation (`scai.tsx`). All under
`components/interview/`:

- `components/interview/InterviewRoom.tsx` — `<LiveKitRoom>` wrapper. Props:
  `{ token, serverUrl, fullPage?, onClose?, onDisconnected?, onRoomConnected? }`.
  Connects on token, publishes mic, renders agent state, speaker mute via
  remote-track volume, fires `onRoomConnected` with the room SID.
- `components/interview/InterviewControlBar.tsx` — mic toggle, speaker toggle,
  agent bar visualizer, disconnect button.
- `components/interview/TranscriptionView.tsx` — live transcript via
  `RoomEvent.TranscriptionReceived` (display only; **not persisted** — the
  real transcript comes from SCAI's API post-call, see §3.2/§3.3).

### Phase 1 integration — session backbone (done & verified)
- **`InterviewSession` table** (§5.1) + migration
  `prisma/migrations/20260601000006_add_interview_session/`. Applied to the dev
  DB. 1 `Task` : many sessions.
- `app/api/interview/sessions/route.ts` —
  `POST { taskId }` creates a session (generates `roomId`, status `PENDING`,
  returns `{ session }`); `GET ?taskId=` lists a candidate's sessions
  newest-first.
- `app/api/interview/sessions/[id]/route.ts` — `GET` resolves a session;
  `PATCH { ended:true }` stamps `endedAt` and moves it to `COMPLETED`
  (guards against clobbering an already-`COMPLETED`/`ANALYZED` row).
- `app/api/interview/token/route.ts` — `POST { sessionId }` (preferred):
  resolves the session, reuses its `roomId`, calls SCAI server-side, mints the
  LiveKit token, and flips the session to `IN_PROGRESS` (+ `startedAt`). Refuses
  to re-mint a `COMPLETED`/`ANALYZED`/`EXPIRED` session (409). Marks `FAILED`
  on SCAI error. Legacy `{ name?, roomId? }` ad-hoc path retained for quick
  `/interview?name=` testing.
- `app/(app)/interview/[id]/page.tsx` — the per-session candidate page: fetches
  a token by `sessionId`, mounts `InterviewRoom`, marks the session ended on
  disconnect.
- **Candidate launch button** — "Start Interview" in the candidate detail header
  (`app/(app)/candidates/[taskId]/page.tsx`): creates a session and opens
  `/interview/<id>` in a new tab. **This is the only place the link↔candidate
  association is currently surfaced** — see §10 for the gap and the planned
  Interviews panel.

Verified end-to-end against the dev DB: create → token mint (`IN_PROGRESS`) →
end (`COMPLETED`) → re-join blocked (409); page route serves; session listing
returns rows. `tsc --noEmit` clean.

> **Deferred (security phase), so a new agent isn't surprised:** the page still
> lives inside `(app)` (recruiter shell), the URL uses the session `id` (not a
> capability `accessToken`), and there is no expiry / `Referrer-Policy`. See §9.

### Env vars (added to `.env`)
```
SCAI_API_URL="https://dev-agentapi.salescode.ai"
SCAI_API_KEY="YXV0aA==:..."          # long-lived management API key
SCAI_ORG_ID="hccbckinddemo"
NEXT_PUBLIC_LIVEKIT_URL="wss://scai-ap-south-1-dev-mw04j9tt.livekit.cloud"
```
> The transcript-search API (§3.2) uses the **same** `SCAI_API_KEY` + `SCAI_ORG_ID`
> but a **different base host** (`dev-apimgmt` vs `dev-agentapi`). Add a
> `SCAI_APIMGMT_URL` env when wiring Phase 4.

### Dependencies installed
`@livekit/components-react`, `@livekit/components-styles`, `livekit-client`,
`framer-motion`.

---

## 3. SCAI APIs we depend on

### 3.1 Generate room token  ✅ working
```
POST https://dev-agentapi.salescode.ai/auth/generate_room_token?hydrate-saas=false
Headers:
  Content-Type: application/json
  api-key:        $SCAI_API_KEY
  organizationId: $SCAI_ORG_ID
  lob:            hccbckinddemo        # ⚠️ REQUIRED as a HEADER, not just in body
Body:
{
  "pid":  "mock_pid_<uuid>",           # generate a fresh uuid per request
  "name": "HR-Recruiter-Agent",
  "room": "interview_<uuid>",          # our roomId; store it on the session
  "agent_dispatch": true,              # makes the AI agent auto-join
  "agent_metadata": {
    "outlet_id": "hirro",
    "outlet_name": "Hirro",
    "agent_name": "HR-Recruiter-Agent",
    "country_code": "",
    "lob": "hccbckinddemo",
    "source": "RECRUITMENT_LIVE_TRANSCRIPT"   # ⚠️ our marker — filter on this later
  },
  "enable_recording": false
}
→ 200 { "token": "<livekit-jwt>" }
```
**Gotcha learned:** omitting the `lob` **header** returns
`{"detail":[{"loc":["header","lob"],"msg":"Field required"}]}`.

**Phase 2 will extend this body** to carry the **merged question list** (global
baseline + per-role, §5.2) — injected into the request **body** under
`agent_metadata` (or `agent_config`; the original reference `generateRoomToken`
passed an `agent_config` object). This is a JSON body field, **not an HTTP
header** — only `api-key`/`organizationId`/`lob` are headers. **Confirm the exact
field name + format with the SCAI team.**

### 3.2 Search calls — list of calls + metadata (NOT transcript text)  ✅ working
```
POST https://dev-apimgmt.salescode.ai/v1/calls/search
Headers:
  Content-Type: application/json
  accept: application/json
  api-key:        $SCAI_API_KEY
  organizationId: $SCAI_ORG_ID
  lob:            hccbckinddemo
Body:
{ "page":0, "size":14, "orderBy":"created_at", "orderDirection":"DESC",
  "source":"RECRUITMENT_LIVE_TRANSCRIPT" }   # ⚠️ filter to OUR interview calls only
```
Returns `content[]`; each call has the fields we need:
```
id, roomName ("interview_<uuid>"), callId ("RM_xxx"),
status, source, sentiment, noOfMessages, callDuration,
startedAt, endedAt, statusTimeline { statusTimelines: [{status, timeStamp}] }
```
**Status lifecycle observed:** `CONNECTED → COMPLETED → NOT_ORDERED`. These are
repurposed sales-call statuses; for interviews the signal that the call is
**finished** is `COMPLETED` in the timeline. (`NOT_ORDERED`/`ORDERED` are
sales-domain leftovers — ignore the semantics, just use them as "call ended".)

**Correlation:** match by `roomName === session.roomId`, then capture `callId`.
Without the `source` filter this endpoint returns ALL org calls (phone,
WhatsApp, etc.) — always filter.

### 3.3 Fetch a single call's transcript + summary  ✅ working (verified 2026-06-02)
The **search** endpoint (§3.2) only returns a message *count* (`noOfMessages`),
NOT the text — that's what caused earlier confusion. The transcript text lives in
the **per-call detail** endpoint:

```
GET https://dev-apimgmt.salescode.ai/v1/calls/{callId}
Headers: api-key, organizationId, lob, accept   (same as §3.2)
```
⚠️ Use the **`callId`** (`"RM_xxx"`, from the §3.2 search result), NOT the uuid
`id` — `GET /v1/calls/{uuid}` returns 404.

Response includes everything from search PLUS two extra fields:
```jsonc
{
  "callId": "RM_xxx",
  "roomName": "interview_<uuid>",        // correlate back to session.roomId
  "noOfMessages": 12, "callDuration": 92.0, "sentiment": "NEUTRAL",
  "transcript": {
    "total_messages": 12,
    "messages": [
      { "role": "assistant" | "user",
        "content": "<the spoken text>",
        "metadata": { "timestamp": "...", "node": "introduction",
                      "intent": "proceed", "final_model_used": "...", ... } }
    ]
  },
  "summary": {                            // BONUS — SCAI pre-computes this
    "summary": "<free-text recap of the call>",
    "notes": [ { "Title": "...", "Items": ["..."], "StartTime": "00:00", "EndTime": "00:25" } ],
    "sentiment": "NEUTRAL", "sentiment_reason": "...",
    "reason_not_ordered": "...", "reason_not_ordered_tag": "..."
  }
}
```

- `transcript.messages[]` (`role` + `content`, with per-turn `metadata` carrying
  the agent `node` and detected `intent`) is the **canonical post-call
  transcript** — this is what Phase 5 scores against.
- `summary` is a freebie: SCAI already produces a recap + notes + sentiment. We
  can surface it immediately and still run our own question-based scoring.

**Full fetch flow (no external blocker):**
`search by roomName` (§3.2) → get `callId` → `GET /v1/calls/{callId}` → store
`transcript`. Both calls use the same `SCAI_API_KEY` + `SCAI_ORG_ID` + `lob`.

> Note: the live in-browser stream (`RoomEvent.TranscriptionReceived`, our
> `TranscriptionView`) is display-only and lost on disconnect — the canonical
> transcript is this endpoint.

---

## 4. How this plugs into the existing pipeline (read these files)

The interview is a **new action injected into a mature outreach system**. Key
facts a new agent must understand:

- **Stages** (`prisma/schema.prisma` enum `CandidateStage`):
  `SOURCED → SHORTLISTED → CONTACT_REQUESTED → CONNECTED → MESSAGED → REPLIED →
  INTERVIEW → HIRED/REJECTED` (+ `ARCHIVED`). `INTERVIEW/HIRED/REJECTED/ARCHIVED`
  are **manual-wins** — set by the recruiter, override the automated rollup.
  See `lib/channels/stage-rollup.ts` (`MANUAL_WINS`, line ~38).

- **Outreach = per-thread followup sequence.** Each `ChannelThread` (LinkedIn /
  Email / WhatsApp) walks a `config.followups[] = { template, afterDays }` array.
  The worker sends the next step each tick — `lib/channels/thread-worker.ts`
  (`processThread`, line ~229).

- **Reply STOPS automation.** `markThreadReplied` (thread-worker.ts ~1229) flips
  the thread to `REPLIED` and PAUSES sibling threads. **Any** inbound message
  triggers this — there is **no intent classification today** (that's deferred
  trigger D). Reply detection: webhook `handleNewMessage` in
  `app/api/webhooks/unipile/route.ts` (~304) + `pollChatReplies` fallback in
  `lib/channels/outreach-tick.ts`.

- **Manual stage moves run through ONE chokepoint:** `applyStageTransition` in
  `lib/channels/stage-transition.ts`. Moving to `INTERVIEW` already fires a
  `pauseActive` effect (line ~96). **This is where trigger A hooks in.**

- **Template variables** — `lib/outreach/render-template.ts` supports
  `{{name}}`, `{{firstName}}`, `{{company}}`, `{{role}}`, `{{score}}`. **Adding
  `{{interviewLink}}` here = trigger C.**

- **Ad-hoc send routes already exist** — `send-dm/route.ts` and
  `send-invite/route.ts` under
  `app/api/requisitions/[requisitionId]/candidates/[taskId]/`. **A
  `send-interview` route mirrors these = trigger B.** Bulk send mirrors
  `candidates/bulk-stage/route.ts` = trigger E.

- **AI scoring is a solved pattern** — `lib/analyzer.ts` + `lib/ai-adapter.ts`,
  `OPENAI_API_KEY` in `.env`, results stored as `Task.analysisResult` JSON.
  Phase 5 reuses this pattern.

- **Worker** — `worker.ts` ticks every minute and calls `runOutreachTick`.
  External cron hits the same logic. **Phase 4's transcript poll adds a tick
  here.** Per CLAUDE.md: any cross-process serialization must use a Postgres
  advisory lock, not an in-memory mutex.

### Constraints from `CLAUDE.md` that apply here
- `Task` rows are **append-only** — no hard deletes; no purge crons.
- Schema migrations: **add columns NULL-able first**, backfill in chunked
  idempotent scripts, tighten to `NOT NULL` in a second migration. No
  single-shot `ADD COLUMN ... NOT NULL` on `Task`/`ChannelThread`.
- Stage changes go through `recomputeTaskStage` / `applyStageTransition` — never
  raw `UPDATE Task SET stage`.
- Raw SQL / triggers live in migration files only, never inline in app code.

---

## 5. Proposed schema

### 5.1 `InterviewSession` (new table)
1 `Task` : many sessions (re-interviews allowed).

**Currently migrated** (`20260601000006_add_interview_session`) — this is the
real shipped shape (do not add fields here that aren't in the migration):
```prisma
model InterviewSession {
  id                String                 @id @default(cuid())
  taskId            String
  task              Task                   @relation(fields: [taskId], references: [id], onDelete: Cascade)

  roomId            String                 @unique  // "interview_<uuid>"; correlates to SCAI roomName
  callId            String?                         // SCAI "RM_xxx", backfilled post-call (Phase 4)

  status            InterviewSessionStatus @default(PENDING)

  questionsSnapshot Json?                           // merged question list, frozen at creation (Phase 2)
  transcript        Json?                           // fetched post-call (Phase 4 / §3.3)
  analysis          Json?                           // structured scorecard (Phase 5)
  score             Float?                          // denormalized overall, for sorting/filtering
  recommendation    String?                         // PROCEED | HOLD | REJECT

  startedAt         DateTime?                        // candidate joined
  endedAt           DateTime?                        // candidate disconnected
  createdAt         DateTime               @default(now())
  updatedAt         DateTime               @updatedAt

  @@index([taskId])
  @@index([status])
}

enum InterviewSessionStatus {
  PENDING       // created, not yet joined (also: link minted but unsendable → see LINK_ONLY)
  SENT          // link delivered to candidate (Phase 3)
  IN_PROGRESS   // candidate joined the room
  COMPLETED     // call ended (+ transcript fetched in Phase 4)
  ANALYZED      // AI scoring done (Phase 5)
  EXPIRED       // link expired without a completed interview
  FAILED        // token / dispatch / transcript error
}
```

**Not yet migrated — added when the phase that needs them lands** (all nullable,
clean single-shot adds per the nullable-first convention):
- **Phase 3 (delivery):** `sentVia InterviewSentVia?` + `sentAt DateTime?` —
  which channel the link went out on, and when.
  `enum InterviewSentVia { LINKEDIN EMAIL WHATSAPP LINK_ONLY }`.
- **Security phase:** `accessToken String? @unique` (capability token in the URL,
  replacing the `id`) + `expiresAt DateTime?`. See §9.

> Phase 1 link uses the session `id` in `/interview/<id>`. `roomId` is never
> exposed to the browser. The capability `accessToken` replaces `id` in the
> security phase (§9).

### 5.2 Question storage — two-tier: global baseline + per-role (mirrors scoring rules)
**Model:** a **global question set that applies to every role**, plus **per-role
questions** a recruiter adds for a specific requisition. At interview time the two
are merged. This is exactly how scoring rules already work in this codebase:
global defaults live in a singleton, per-role overrides live in
`Requisition.config` (the long-lived role config JSON,
`prisma/schema.prisma:161`), and a helper merges them (`getEffectiveRules` in
`lib/analyzer.ts`). We mirror that pattern.

**Per-role questions → `Requisition.config` JSON** (no migration — this is the
same blob that already holds per-role scoring rules):
```jsonc
// Requisition.config (parsed JSON), new key:
"interview": {
  "trigger": "MANUAL" | "ON_INTERVIEW_STAGE",   // per-role delivery policy (Phase 3)
  "questions": [
    { "id": "q-role-1", "order": 1, "text": "...", "mustAsk": true,
      "idealAnswer": "...", "weight": 1.0 }      // idealAnswer/weight feed Phase 5
  ]
}
```

**Global questions → a singleton** (applies across all roles). Mirror how global
scoring/prompt defaults live in the `AppSettings` singleton. Either add an
`interviewQuestions` JSON column to `AppSettings`, or — cleaner, keeps interview
concerns together — a small dedicated singleton:
```prisma
model InterviewConfig {
  id              String   @id @default("global")  // single row
  globalQuestions Json     @default("[]")           // [{ id, order, text, mustAsk, idealAnswer, weight }]
  defaultAgentName String  @default("HR-Recruiter-Agent")
  updatedAt       DateTime @updatedAt
}
```

**Merge at interview time** — a helper mirroring `getEffectiveRules`:
```ts
// getEffectiveInterviewQuestions(requisitionConfig) =>
//   [...globalQuestions, ...role.interview.questions]   (global first, then role)
// Deduped by id; each tagged { scope: "global" | "role" } for the UI.
```
The merged list is what gets snapshotted onto `InterviewSession.questionsSnapshot`
at creation and injected into the SCAI token request (see §3.1 / Phase 2).

**Disabling a global question for one role** (optional, later): mirror the scoring
toggle pattern — a `role.interview.disabledGlobalIds: string[]`. Not needed for v1
(v1 = global always applies, role appends).

**Migration path:** if questions ever need cross-role querying/reuse beyond this,
promote to a dedicated `InterviewQuestion` table. Not needed now.

---

## 6. Triggers (how the link reaches the candidate)

Two independent decisions: **WHEN** (trigger) and **HOW** (delivery). Delivery is
always "send a message on the open channel" reusing
`sendChatMessage / sendEmail / sendWhatsApp`. Build the delivery primitive once;
every trigger calls it.

| # | Trigger | Hook point | In scope? |
|---|---------|-----------|-----------|
| A | On move to `INTERVIEW` stage | `applyStageTransition` INTERVIEW effect | ✅ Phase 3 |
| B | Manual "Send Interview" button | new `send-interview` route (mirrors `send-dm`) | ✅ Phase 3 |
| C | `{{interviewLink}}` in any template | `render-template.ts` + per-thread link gen | ✅ Phase 3 |
| E | Bulk send to a column | mirror `bulk-stage` route | ✅ Phase 3 |
| D | Auto on positive-intent reply | intent classifier in `handleNewMessage` | ⏸️ Deferred (Phase 7) |

D is deferred (Phase 7) — once A/B/C/E exist it's just another caller of the
delivery primitive, gated behind a per-requisition opt-in + a conservative
intent classifier.

### Delivery mechanics (decided — applies to A/B/C/E)

**One channel-picker, used everywhere.** `pickInterviewChannel(task)` ranks the
candidate's threads by `ChannelThread.lastInboundAt` (`schema.prisma:453`) —
newest = the channel they last replied on, almost always the REPLIED thread that
got them to INTERVIEW — ties broken by a fixed channel priority. There is **no
pre-existing "active thread" concept**; this helper is new.
- **A (stage drag)** → uses the picker's output directly (no human in the loop),
  **but only when the role opts in** — gated by the per-role trigger default below.
- **B (button, single send)** → **always opens a composer** (decided): a dialog
  pre-filling the picked channel (`Channel: LinkedIn ▾`, overridable) and the
  rendered message text (editable). Recruiter glances, optionally tweaks, sends.
  Rationale: the message reaches a real candidate and can't be unsent — the extra
  click is cheap insurance against the wrong channel/wording.
- **E (bulk)** → a **confirmation dialog, never silent** (decided): auto-suggests
  each candidate's best channel and shows the breakdown
  (`18 LinkedIn · 9 Email · 3 WhatsApp · 0 skipped`). The recruiter may **override
  one channel for the whole batch** (`Send all via: Email ▾`); the breakdown then
  **recomputes live** so they see the cost *before* sending
  (`24 Email · 6 skipped (no Email thread)`). Candidates lacking the chosen channel
  are **flagged and skipped**, never silently dropped.
- **C (channel template)** → not channel-picked; the link rides whatever thread
  that channel's template runs on.

**Trigger A is opt-in per role — default `MANUAL`** (decided).
`Requisition.config.interview.trigger` gates whether dragging to INTERVIEW
auto-sends. Default **`MANUAL`**: dragging the card does *nothing* extra, so a
recruiter merely organizing the board never accidentally fires a link at a
candidate. A team opts into `ON_INTERVIEW_STAGE` to get the auto-send. While
`MANUAL`, the link goes out only via the button (B) or bulk (E).

**No sendable channel → don't block.** Mint the session + link regardless; if the
picker finds nothing sendable, leave status `PENDING`, set `sentVia = LINK_ONLY`,
surface **Copy Link**. In bulk these are the "skipped — no channel" count.

**Message text = a template, not a bare link.** New `{{interviewLink}}` var in
`render-template.ts`. Template shape `{ subject?, body }` (subject required only
for the email variant). Two-tier like questions/scoring: global default + optional
per-role override. **Refuse to send any template whose body lacks
`{{interviewLink}}`.**

**Per-channel constraints at send time:**
- **Email** needs a `subject`.
- **LinkedIn** — the 300-char clamp (`thread-worker.ts:669`) is on the
  *connection-invite note only*. Interview links go to already-connected/replied
  candidates as a DM/InMail (no such limit) — don't carry the invite clamp over.
- **WhatsApp 24h window** — do our own `now - lastInboundAt > 24h` check; on a
  miss **do NOT archive** — leave `PENDING`, surface "outside WhatsApp window, use
  another channel or Copy Link". The one channel where an auto-picked thread can
  still fail at send time.

**Trigger A ordering — never hold a DB txn across a network call.**
`applyStageTransition` runs `pauseActive` inside a transaction
(`stage-transition.ts:250`). Do the Unipile send **outside** it: commit the stage
transition → reuse-or-create session → mint link → send → stamp
`SENT`/`sentVia`/`sentAt`. If the send fails, the stage stays `INTERVIEW`
(recruiter intent honored) and the session sits `PENDING` + error (= scenario 6).
The interview send is an **ad-hoc send** (like `send-dm`) that bypasses the paused
followup scheduler.

**Dedup — two guards:**
1. One open (`PENDING`/`SENT`) session per task → reuse its link (no dup links).
2. If already `SENT`: trigger A is a **no-op**; trigger B requires a confirm
   ("already sent via LinkedIn 2h ago — send again?"). Never auto-resend.

**Failure handling.** Never mark `SENT` for a send that didn't leave — leave
`PENDING` + error. WA-window failure must not archive.

**Timeline visibility — `OutreachMessage` only (decided during build).** The
candidate timeline reads `OutreachMessage`. The interview send writes one
`OutreachMessage` row (`channel = "<CHANNEL>_INTERVIEW"`, e.g. `LINKEDIN_INTERVIEW`)
and deliberately does **not** write a `ThreadMessage` or touch the
`ChannelThread`: an interview link is an ad-hoc out-of-band send, not a step in
the thread's followup sequence (the thread stays PAUSED). This matches the
closest ad-hoc precedent — `send-invite` also writes only `OutreachMessage`.
(`send-dm` dual-writes because it *is* the first step of the LinkedIn sequence;
the interview send is not.)

**Missing template ≠ blocked drag.** If a requisition has no interview template,
trigger A's stage drag still succeeds (manual intent honored); the auto-send is
skipped with a surfaced warning. Don't block the drag.

---

## 7. Phased plan

Dependency shape (AI scoring + intent detection permanently dropped — see §7 "Dropped"):
```
P1 Session backbone ──┬──> P2 Question authoring ──> P4 Transcript ──> P6 Result UI
                      └──> P3 Delivery + triggers ──────────────────────────────────┘
```
P2 and P3 each depend only on P1 and are independent of each other. P4 depends on P1
(and optionally P2 for the questionsSnapshot). P6 depends on P4.

### Phase 1 — Interview session backbone  ✅ INTEGRATION SHIPPED
**Shipped & verified (see §2 for files):**
- `InterviewSession` table (§5.1) + migration.
- `POST/GET /api/interview/sessions` (create + list per candidate).
- `GET/PATCH /api/interview/sessions/[id]` (resolve + mark ended).
- `/api/interview/token` accepts `{ sessionId }`, reuses `roomId`, mints token,
  flips session `PENDING → IN_PROGRESS`; 409 on re-join of a finished session.
- `/interview/[id]` candidate page + **"Start Interview"** button on the
  candidate detail header.

**Deferred to the security/hardening phase (NOT done — by design):**
- Move the page OUT of `(app)` into a standalone public route
  `app/interview/[token]/` (no `AppShell`). Currently inside the recruiter shell.
- Capability `accessToken` in the URL instead of the session `id`.
- Link **expiry** (`expiresAt`) and `Referrer-Policy: no-referrer`.
- See §9 for the full security model and §11 for remaining edge cases.

**Gap to make the association visible/testable in the UI:** there is currently
no panel showing a candidate's interview sessions (status / link / result). The
only surface is the launch button. See **§10** for the planned Interviews panel —
this is what makes "link ↔ candidate" inspectable in the UI.

### Phase 2 — Question authoring: global baseline + per-role (§5.2)
- **Storage** (§5.2): global questions in the `InterviewConfig` singleton;
  per-role questions in `Requisition.config.interview.questions`. Merge helper
  `getEffectiveInterviewQuestions` (mirrors `getEffectiveRules`).
- **Global authoring UI** — a section in Settings (`/settings`) to edit the
  org-wide baseline questions.
- **Per-role authoring UI** — an **"Interview" tab** on the job page (mirror
  `ScoringRulesTab` in `components/jobs/`): shows inherited global questions
  (read-only) + add/reorder/edit role-specific ones.
- **Snapshot + injection** — at session creation, snapshot the merged list onto
  `InterviewSession.questionsSnapshot`; at token mint, inject it into the SCAI
  request **body** under `agent_metadata.questions` (same object that already
  carries `outlet_id`, `source`, etc. — decided 2026-06-02). Questions go in
  the request **body**, NOT an HTTP header. If SCAI later needs a different key
  it is a one-line change in the token route.
- **Ships:** global + role questions authored → merged list snapshotted + carried
  to the agent → live interview asks them. No external blockers.

### Phase 3 — Delivery primitive + triggers A, B, C, E  ✅ BUILT (migration pending)

**Schema (Stage 0)** — `20260601000007_phase3_interview_delivery`:
`InterviewSession += sentVia/sentAt/accessToken(@unique)/expiresAt`,
`enum InterviewSentVia`, `InterviewConfig` singleton (`defaultMessageTemplate`).
Backfill: `scripts/backfill-interview-access-token.ts` (chunked, idempotent).

**Delivery primitive (Stage 1)** — `lib/interview/`:
- `channel.ts` `pickInterviewChannel(taskId)` — ranks non-ARCHIVED threads by
  `lastInboundAt` (tie-break LINKEDIN>WHATSAPP>EMAIL); PAUSED/REPLIED are
  sendable; resolves account + address + WA-window per channel (gaps C/E).
- `session.ts` `getOrCreateOpenInterviewSession` — advisory-locked reuse-or-create
  (gap D); also the chokepoint for the "Start Interview" button.
- `templates.ts` `getEffectiveInterviewTemplate` (role→global→default, mirrors
  `getEffectiveRules`; gap A) + `render.ts` shared renderer; `{{interviewLink}}`
  added to `render-template.ts`.
- `send.ts` `sendInterviewLink` — ad-hoc send (no CONNECTED guard; WA-window
  miss does NOT archive; never mutates the thread). Records `OutreachMessage`
  only (timeline), advances the session to SENT + sentVia/sentAt. LINK_ONLY when
  nothing sendable.

**Standalone route (Stage 2, §9 pulled forward)** — `app/interview/[token]/`
(outside `(app)`, no AppShell, `Referrer-Policy: no-referrer`); token route
accepts `accessToken` + enforces `expiresAt` when set; `{{interviewLink}}` and the
"Start Interview" button now use `/interview/<accessToken>`. (Old in-shell
`/interview/[id]` + `/interview` tester removed.)

**Triggers**
- B — `…/[taskId]/send-interview` GET (composer preview) + POST; composer
  `components/interview/SendInterviewDialog.tsx`; Interviews panel
  `components/interview/InterviewsPanel.tsx` on the candidate page (§10).
- A — `applyStageTransition` fires `maybeAutoSendInterviewOnStage` (fire-and-forget,
  post-commit) gated by per-role `trigger` (default `MANUAL`).
- E — `…/bulk-send-interview/preview` (side-effect-free breakdown) + `…/bulk-send-interview`
  (execute); `components/interview/BulkSendInterviewDialog.tsx` (force-one-channel
  override w/ live recompute + skip list).
- C — `lib/interview/followup-link.ts` injects the link into worker-rendered
  followups that use `{{interviewLink}}` (cheap regex gate). Session is left
  PENDING (flips to IN_PROGRESS on join); SENT-marking via followup is a noted
  follow-up.

### Phase 4 — Post-call transcript ingestion  (UNBLOCKED — endpoint confirmed)
- Add a tick to `worker.ts`/`runOutreachTick`: for `SENT`/`IN_PROGRESS`
  sessions, poll `/v1/calls/search` by `roomName` + `source`, detect
  `COMPLETED`, capture `callId`.
- Fetch transcript via `GET /v1/calls/{callId}` (§3.3 — confirmed working). Store
  `transcript` (+ optionally SCAI's `summary`/`sentiment`) on the session, mark
  `COMPLETED`. Idempotent; advisory-lock if serialization needed.
- **Ships:** finishing a real call lands the transcript on the session row.

### Phase 5 — ~~AI scoring~~ DROPPED
AI scoring and recommendation generation are **permanently out of scope** (product
decision 2026-06-02). The `analysis`, `score`, and `recommendation` columns on
`InterviewSession` remain in the schema (nullable, harmless) but will never be
populated. Do not build or plan around them.

### Phase 6 — Result surfacing (simplified — transcript + summary only)
Show the candidate what happened in the interview. No AI scoring, no recommendations —
just the raw material SCAI already returns for free:

- **Interviews panel** on the candidate page (panel built in Phase 3) — extend
  each session row to show, once `COMPLETED`:
  - SCAI `summary.summary` (free-text recap SCAI pre-computes, §3.3)
  - SCAI `summary.sentiment` (NEUTRAL / POSITIVE / NEGATIVE)
  - Full `transcript.messages[]` — expandable, showing each turn
    (`role: assistant | user`, `content`) in a readable thread view
- **No score badge, no recommendation, no auto-advance on score** — all dropped.
- **Ships:** recruiter opens the candidate page after an interview, sees what
  was said and SCAI's summary. Loop is visibly closed.

### Dropped (permanent, not deferred)
- **Phase 5** — AI scoring / recommendation (see above).
- **Phase 7** — intent-driven auto-send (trigger D). No LLM intent classifier,
  no auto-send on positive reply. Trigger D will never be built.
- Auto-advance stage on strong score — requires scoring, which is dropped.

### Sequencing note
All remaining phases are fully unblocked (no external dependencies). Recommended
order: **P2 → P4 → P6**.
- P2 first: questions get snapshotted onto the session at creation time, so any
  interview taken after P2 ships will have `questionsSnapshot` populated — making
  the transcript view in P6 richer (each answer can be shown alongside the question
  it was answering).
- P4 next: worker tick + transcript fetch. Short, self-contained.
- P6 last: purely UI — extend the Interviews panel to render what P4 stored.

---

## 8. Open decisions / external dependencies

1. ~~**Transcript-fetch endpoint**~~ — ✅ RESOLVED (2026-06-02).
2. ~~**Question injection field**~~ — ✅ DECIDED (2026-06-02): inject questions
   directly into `agent_metadata.questions` in the SCAI token request body (same
   object that already carries `outlet_id`, `source`, etc.). If the SCAI team
   later needs a different field name it is a one-line change in the token route.
   **Phase 2 is fully unblocked.**
3. ~~**Link expiry / single-use**~~ — ✅ DECIDED: capability-URL model, see §9.
4. ~~**Build order**~~ — ✅ DECIDED: P4 → P6 → P2.
5. ~~**Auto-advance on strong score**~~ — DROPPED (scoring is dropped).
6. **Recruiter-app auth** — deferred. The recruiter app (`(app)/*`) is
   unauthenticated. Level 1 isolates the *candidate* but doesn't close this;
   revisit with a middleware gate or separate subdomain later.

### Phase 3 — gaps to close before/while building (found 2026-06-02)

- **A. Interview message template storage** — ✅ DECIDED (2026-06-02): mirror the
  questions pattern. Global default `defaultMessageTemplate Json` on the
  `InterviewConfig` singleton (introduced now by Phase 3 since Phase 2 hasn't
  shipped — Phase 2 later adds `globalQuestions`/`defaultAgentName` to the same
  model), per-role override at `Requisition.config.interview.messageTemplate`.
  Shape `{ subject?, body }`; refuse to send any body lacking `{{interviewLink}}`.
- **B. Standalone candidate route** — ✅ DECIDED (2026-06-02): **pull it forward
  into Phase 3.** A real link must NOT open inside the recruiter shell. Phase 3
  now includes the §9 "Level 1" route: `app/interview/[token]/page.tsx` (no
  `AppShell`), capability `accessToken` in the URL (not `id`), token-mint accepts
  `accessToken`, `Referrer-Policy: no-referrer`. `{{interviewLink}}` renders
  `/interview/<accessToken>`. This makes external sends safe from day one.
- **C. "Sendable thread" set + the PAUSED interaction.** Trigger A's `pauseActive`
  flips PENDING/ACTIVE threads to PAUSED *before* the send. So `pickInterviewChannel`
  must treat **PAUSED and REPLIED as sendable** (only ARCHIVED is excluded) — else
  trigger A pauses every thread and then finds nothing to send on. The REPLIED
  thread has the newest `lastInboundAt`, so it naturally wins. The ad-hoc send
  **must not resume** the thread (no status flip back to ACTIVE, no `nextActionAt`)
  — record the message only; followups stay paused.
- **D. Dedup guard #1 has a race.** "Reuse the one open session per task" isn't
  enforced by the schema (only `roomId` is `@unique`). Two overlapping sends
  (bulk + manual, or double-click) can each see "no open session" and mint two.
  Add a partial unique index (one non-terminal session per task) or wrap
  reuse-or-create in a txn with a row lock / advisory lock.
- **E. Channel tie-break order not pinned.** When `lastInboundAt` ties (or is null
  on all threads), `pickInterviewChannel` needs a deterministic fallback priority,
  e.g. `LINKEDIN > WHATSAPP > EMAIL`. Pick one.
- **F. Bulk (E) scope vs stage.** Confirm bulk-send = "send link to selected
  candidates" only, with no stage change (stage move is trigger A's job), vs
  "move to INTERVIEW *and* send". Default to send-only to keep the two triggers
  orthogonal.
- **G. Trigger C session minting in the worker.** When a *scheduled followup*
  template contains `{{interviewLink}}`, the worker (the very scheduler A/B/E
  bypass) must reuse-or-create a session at render time to mint the link. Lowest-
  priority of the four — consider shipping A/B/E first and C last.

> **Build-order check (open-decision #4):** ✅ DECIDED — recruiter-flow-first,
> **starting Phase 3 now**. Gate B is resolved by folding the §9 standalone route
> into Phase 3 (above), so external sends are safe without waiting on a separate
> security phase. Remaining §9 hardening (link expiry, single-use re-join) can
> stay a fast-follow.

---

## 9. Security model — candidate access (DECIDED: capability URL, "Level 1")

**Principle: candidates never log in.** They're external; we have no identity
for them. Access is via a **capability URL** — possession of an unguessable
token grants access to exactly one interview and nothing else (same pattern as
password-reset / Calendly links).

**Why this matters:** the interview page was originally at
`app/(app)/interview/page.tsx` — inside the `(app)` route group, which wraps
everything in `AppShell` (`app/(app)/layout.tsx`). A candidate opening that link
got the full recruiter shell with nav into `/jobs`, `/candidates`, `/settings`.
There is also no `middleware.ts` — those routes are unauthenticated.

**The Level 1 design — ✅ shipped in Phase 3 (points 1–3 + most of 4):**

1. ✅ **Standalone route, outside `(app)`** — `app/interview/[token]/page.tsx`
   (+ `layout.tsx` setting `Referrer-Policy: no-referrer`). No `AppShell`, no
   navigation surface. The old in-shell `/interview/[id]` + `/interview` tester
   were removed.
2. ✅ **Capability token in the URL** — `/interview/<accessToken>` where
   `accessToken` is `crypto.randomBytes(32).toString("base64url")`, stored
   `@unique` on `InterviewSession`. NOT the `id`, NOT `roomId`. Minted at session
   creation (`lib/interview/access-token.ts`); backfill for legacy rows.
3. ✅ **Capability-gated token mint** — `POST /api/interview/token` accepts the
   `accessToken`, verifies joinable, returns only a room-scoped LiveKit JWT.
   (Legacy `{ sessionId }` retained for recruiter-side launch.)
4. **Hardening — partial.** ✅ `Referrer-Policy: no-referrer`; ✅ `expiresAt`
   *enforced* when set (410). **Remaining (fast-follow):** a policy that actually
   *sets* `expiresAt`, and full single-use re-join semantics (today a finished
   session is 409'd; an `IN_PROGRESS` one is re-joinable, which is intended).

**Known gap (accepted for now):** Level 1 stops the candidate from *navigating*
into the app, but a candidate who has the domain could still manually type
`/jobs` and hit the unauthenticated recruiter app. Closing that is a **separate**
task — a Next.js middleware gate on `(app)` (allowlisting `/interview/*`,
`/api/interview/token`, `/api/webhooks/*`) or a separate subdomain for the
candidate surface. Tracked as open-decision #6.

---

## 10. How an interview link associates with a candidate (UI)

This is the piece the recruiter needs to **see and test**, and it is currently
only half-built.

### Current state (Phase 1)
- The association lives in the DB: `InterviewSession.taskId → Task`. Every
  session row is tied to exactly one candidate, and `roomId` ties it to the SCAI
  call.
- The **only** UI surface is the **"Start Interview"** button on the candidate
  detail page. Clicking it creates a session and opens `/interview/<id>`.
- There is **no UI to view a candidate's sessions** — you cannot see the link,
  the status (`PENDING`/`IN_PROGRESS`/`COMPLETED`), when it ran, or (later) the
  score. To inspect the association today you must call
  `GET /api/interview/sessions?taskId=<id>` directly.

### Planned: "Interviews" panel on the candidate detail page (next concrete step)
A small section on `app/(app)/candidates/[taskId]/page.tsx` that:
- Lists this candidate's sessions (newest first) from
  `GET /api/interview/sessions?taskId=`.
- Per row: status badge, created/started/ended times, a **Copy Link** button
  (the candidate URL), an **Open** button, and — once Phases 4/5 land — the
  transcript + score/recommendation.
- "Start Interview" moves into this panel.

This panel is what makes the link↔candidate association **visible and testable**
in the UI. It's effectively the Phase-1 slice of Phase 6 (Result surfacing);
recommend building it now so the rest of the flow is observable as we add it.

### End-to-end association + transcript test path
Once the panel + Phase 4 exist, the full testable loop is:
1. Open a candidate → **Interviews panel** → Start Interview (creates session,
   `roomId` stored).
2. Take the interview in the opened room; disconnect.
3. Worker polls SCAI `/v1/calls/search` by `roomName === session.roomId`,
   sees `COMPLETED`, stores `callId` (testable **now** — §3.2).
4. Worker fetches the transcript via `GET /v1/calls/{callId}` (§3.3, working) and
   stores it on the session.
5. Panel shows transcript → (Phase 5) score appears.

---

## 11. Current state & how to test right now

**Works today (Phase 1 integration, security deferred):**
- Open any candidate at `/candidates/<taskId>` → click **Start Interview** →
  new tab opens `/interview/<sessionId>` → LiveKit room connects, the
  `HR-Recruiter-Agent` dispatches and talks. Disconnect → session `COMPLETED`.
- Inspect the association via API:
  `curl '/api/interview/sessions?taskId=<id>'`.
- Confirm the call reached SCAI:
  `POST /v1/calls/search` with `source:"RECRUITMENT_LIVE_TRANSCRIPT"`, match
  `roomName` to the session's `roomId` (§3.2) — shows `COMPLETED`, `callId`,
  `noOfMessages`.

- Fetch the actual transcript text of that call (verified):
  `GET /v1/calls/{callId}` → `transcript.messages[]` + `summary` (§3.3).

**Not yet testable in the UI (needs build):**
- Auto-fetching the transcript onto the session row → **Phase 4** (endpoint confirmed, no blocker).
- Viewing the transcript + SCAI summary in the Interviews panel → **Phase 6**.
- Question authoring (global + per-role) → **Phase 2** (blocked on SCAI `agent_config` field confirmation).
- ~~Score/recommendation~~ — **dropped**.

**Open edge cases still un-handled (from the catalogue):**
- Link **expiry** — `expiresAt` is *enforced* when set, but nothing sets it yet.
- **Agent-never-joins timeout** (page can hang on "establishing connection").
- ~~**Multiple-session policy**~~ — ✅ resolved: `getOrCreateOpenInterviewSession`
  (advisory-locked) reuses the one open session; the "Start Interview" button and
  all send triggers go through it.
- **Double-join / multiple tabs**, **unsupported browser** — not handled.

---

## 12. Applying & testing Phase 3

**Apply the migration (not yet run):**
```
npx prisma migrate deploy          # applies 20260601000007_phase3_interview_delivery
npx prisma generate                # already run during build; harmless to repeat
npx tsx scripts/backfill-interview-access-token.ts   # optional: only for pre-Phase-3 sessions
```
> The migration is purely additive (new enum + 4 nullable cols on InterviewSession
> + InterviewConfig table) — non-blocking per CLAUDE.md. Until it's applied, any
> code path touching the new columns will fail at runtime even though `tsc` passes.

**Manual test path (after migrate):**
1. **B (composer)** — candidate page → Interviews panel → **Send** → pick channel,
   edit text, Send. Appears in the panel (SENT + channel) and the Activity timeline
   ("Interview link sent").
2. **Standalone route** — open the panel's **Open**/**Copy link** → `/interview/<token>`
   loads with NO recruiter shell; room connects.
3. **A (stage gate)** — set `Requisition.config.interview.trigger = "ON_INTERVIEW_STAGE"`,
   drag a candidate to INTERVIEW → link auto-sends. Default (`MANUAL`) → nothing fires.
4. **E (bulk)** — CandidatesTab → select → **Send Interview** → breakdown shows the
   per-channel split; force a channel → breakdown + skip list recompute; confirm.
5. **WA window** — a WhatsApp-only candidate outside the 24h window → composer shows
   the channel disabled with the reason; the send errors (PENDING) and does NOT
   archive the thread.
6. **C (followup)** — put `{{interviewLink}}` in a channel followup template; the
   worker mints/reuses a session and renders a real link on the scheduled send.
