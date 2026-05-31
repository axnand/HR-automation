# 06 — UI Walkthrough

All pages live under `app/(app)/` and are wrapped in `AppShell` ([components/layout/AppShell.tsx](../components/layout/AppShell.tsx)) which renders the collapsible sidebar. The sidebar has exactly two navigation items: **Jobs** (`/`) and **Settings** (`/settings`).

---

## Page map

```
/                          Jobs list (home)
/jobs/[jobId]              Requisition detail  (8 tabs)
/candidates/[taskId]       Single candidate detail
/settings                  App settings        (6 tabs)
/interview                 LiveKit interview room  ← NOT in nav, experimental
```

---

## 1. Jobs List — `/`

**File:** [app/(app)/page.tsx](../app/(app)/page.tsx)
**API:** `GET /api/requisitions?page=1&limit=100`

The home screen. Shows all requisitions as cards (grid or list view). Divided into **Active** and **Inactive** sections.

Key interactions:
- **New Role** button → modal to create a `Requisition` (title, department, recruiter, start date)
- Click a card → navigates to `/jobs/JD-{id.slice(0,8).toUpperCase()}`
- **Edit** icon on card → inline edit modal (title, department, recruiter, active/inactive toggle, delete)
- **Filter bar** — filter by status (active/inactive), department, recruiter, date range, has-active-run; sortable by last updated / created / most candidates / most runs
- Auto-polls every 5 seconds when any requisition has an `activeRunStatus` (a Job is in PROCESSING state)

**Component:** [components/jobs/JobCard.tsx](../components/jobs/JobCard.tsx)

---

## 2. Requisition Detail — `/jobs/[jobId]`

**File:** [app/(app)/jobs/[jobId]/page.tsx](../app/(app)/jobs/%5BjobId%5D/page.tsx)

The main workspace for a role. Has 8 tabs:

### Tab: Dashboard

**Component:** [components/jobs/DashboardTab.tsx](../components/jobs/DashboardTab.tsx)

Summary stats for the most recent run: total candidates, scored / failed / pending counts, score distribution histogram, recommendation breakdown (Strong Fit / Moderate Fit / Not a Fit).

### Tab: Candidates

**Component:** [components/jobs/CandidatesTab.tsx](../components/jobs/CandidatesTab.tsx)
**API:** `GET /api/requisitions/[id]/candidates`

The scored candidate table — the primary recruiter workspace. Each row shows:
- Candidate name, current role, company, location
- `scorePercent` + recommendation badge
- Stage badge
- Source (LinkedIn / resume)

Actions per candidate:
- Click row → opens candidate detail sheet (inline drawer or `/candidates/[taskId]`)
- **Retry** failed tasks
- **Enrich** (fetch contact info via Airscale integration)
- Bulk actions: **bulk stage**, **bulk enrich**, **bulk erase** (GDPR)

Add candidates via:
- **Bulk Add** modal ([components/jobs/BulkAddModal.tsx](../components/jobs/BulkAddModal.tsx)) — paste LinkedIn URLs
- **Add Manually** modal ([components/jobs/AddManuallyModal.tsx](../components/jobs/AddManuallyModal.tsx)) — enter details without scraping
- **Upload Resumes** modal ([components/jobs/UploadResumesModal.tsx](../components/jobs/UploadResumesModal.tsx)) — PDF uploads or ZIP

Job-level controls in the header: **Pause** / **Resume** / **Cancel** a running job.

### Tab: Pipeline

**Component:** [components/jobs/PipelineTab.tsx](../components/jobs/PipelineTab.tsx)
**API:** `GET /api/requisitions/[id]/pipeline`

Kanban-style board. Columns are the `CandidateStage` values (SOURCED → SHORTLISTED → ... → REPLIED → INTERVIEW → HIRED / REJECTED). Cards show candidate name, score, and outreach status.

**Drag-and-drop** moves candidates between stages. For terminal stages (INTERVIEW, HIRED, REJECTED, ARCHIVED) the stage is written to `Task.manualStage`; for others it updates `Task.stage` directly with a MANUAL actor StageEvent.

**Components:** [components/outreach/CandidateKanbanCard.tsx](../components/outreach/CandidateKanbanCard.tsx), [components/outreach/KanbanColumn.tsx](../components/outreach/KanbanColumn.tsx)

### Tab: Channels

**Component:** [components/jobs/ChannelsTab.tsx](../components/jobs/ChannelsTab.tsx)
**API:** `GET /api/requisitions/[id]/channels`, `POST`, `PUT`, `DELETE`

Configure outreach channels for this requisition. Each channel has:
- Type (LinkedIn / Email / WhatsApp)
- Status (Active / Paused)
- Daily cap and InMail cap
- Sending account (or pool of accounts)
- Full JSON config: invite rules, followup sequences, score thresholds, archive timeouts, quiet hours

**Channel form:** [components/jobs/ChannelForm.tsx](../components/jobs/ChannelForm.tsx)

**Account pool management:** `GET/POST/DELETE /api/requisitions/[id]/channels/[channelId]/pool` — add/remove accounts from a channel's rotation pool.

### Tab: Scoring Rules

**Component:** [components/jobs/ScoringRulesTab.tsx](../components/jobs/ScoringRulesTab.tsx)

Toggle built-in rules on/off, add/remove custom rules, preview the system prompt that will be sent to the LLM. Per-rule description overrides. Changes are saved to `Requisition.config` and also snapshotted into each `Job.config` at run time.

### Tab: JD Description

**Component:** [components/jobs/JdDescriptionTab.tsx](../components/jobs/JdDescriptionTab.tsx)
**API:** `GET/PUT /api/requisitions/[id]`

The Job Description text editor. Also lets the recruiter pick an AI provider/model, set the auto-shortlist threshold, configure the sheet export URL, and write a `customPrompt` (recruiter context injected into AI scoring).

Load from template: pulls a saved `JdTemplate` and pre-fills the editor.

### Tab: History

**Component:** [components/jobs/HistoryTab.tsx](../components/jobs/HistoryTab.tsx)
**API:** `GET /api/requisitions/[id]/runs`

List of all `Job` runs for this requisition: timestamps, task counts, pass/fail breakdown. Clicking a run filters the Candidates tab to that run.

### Tab: Resolutions

**Component:** [components/jobs/ResolutionsTab.tsx](../components/jobs/ResolutionsTab.tsx)
**API:** `GET /api/requisitions/[id]/duplicates`

Shows `DuplicatePair` rows detected for this requisition. The recruiter can review pairs side-by-side and resolve (keep A, keep B, or keep both). Resolving soft-deletes the losing Task.

**Drawer:** [components/jobs/ResolveDuplicatesDrawer.tsx](../components/jobs/ResolveDuplicatesDrawer.tsx)
**API:** `POST /api/duplicates/[pairId]/resolve`

---

## 3. Candidate Detail — `/candidates/[taskId]`

**File:** [app/(app)/candidates/[taskId]/page.tsx](../app/(app)/candidates/%5BtaskId%5D/page.tsx)

Full detail view for a single candidate. Sections:
- **Profile** — name, headline, location, current role, pulled from `task.result` (Unipile JSON)
- **Score breakdown** — each enabled rule with score and `scoringLogs` reasoning text; flag / gap / strength lists
- **Override controls** — per-parameter score override with reason (creates `ScoreOverride` rows)
- **Outreach history** — all `ChannelThread` and `ThreadMessage` records for this candidate
- **Notes** — add/view recruiter notes (`Note` rows)
- **Stage controls** — move to any stage
- **Contact info** — `CandidateContact` fields; trigger enrichment

---

## 4. Settings — `/settings`

**File:** [app/(app)/settings/page.tsx](../app/(app)/settings/page.tsx)

Six tabs, all accessible from the sidebar **Settings** link:

### Tab: Accounts

Manage Unipile-registered sending accounts (LinkedIn, Email, WhatsApp).
- View status (ACTIVE / COOLDOWN / BUSY / DISABLED), daily usage, last used timestamp
- Add new account (Unipile account_id + optional DSN/API key override)
- Soft-delete accounts — removes from pool but preserves historical FK references
- Test connectivity
- View InMail credit balance for LinkedIn accounts
- **Register Unipile webhook** button — calls `POST /api/webhooks/unipile/register` to create/update the webhook on Unipile's side pointing back to this app's `/api/webhooks/unipile` URL

**APIs:** `GET/POST /api/accounts`, `PUT/DELETE /api/accounts/[id]`, `POST /api/accounts/test`

### Tab: AI Providers

Configure LLM providers. Preset buttons for OpenAI, Gemini, Groq, Anthropic, Bedrock, Mistral, DeepSeek, Together AI, Ollama, and Custom. Each provider stores a base URL, API key, and list of available models.

The **default provider** is marked with a star and used as the fallback for all analysis runs that don't have a per-requisition override.

Test button verifies the API key + model before saving.

**APIs:** `GET/POST /api/ai-providers`, `PUT/DELETE /api/ai-providers/[id]`, `POST /api/ai-providers/test`

### Tab: JD Templates

Saved Job Description + scoring rule presets. Recruiters create templates once and load them into new requisitions without retyping.

**APIs:** `GET/POST /api/jd-templates`, `PUT/DELETE /api/jd-templates/[id]`

### Tab: Prompt Templates

Saved custom prompt text blocks (recruiter context). Can be loaded into the JD tab's `customPrompt` field.

**APIs:** `GET/POST /api/prompt-templates`, `PUT/DELETE /api/prompt-templates/[id]`

### Tab: Evaluation Configs

Full scoring configuration presets — bundling promptRole, guidelines, critical instructions, rule overrides, and prompt envelope settings into a named config. A config can be set as default and is automatically applied to all new analysis runs.

**APIs:** `GET/POST /api/evaluation-configs`, `PUT/DELETE /api/evaluation-configs/[id]`

### Tab: Sheet Integrations

Named Google Sheets export URLs. The app calls a Google Apps Script web app URL with candidate data; the script appends a row to the configured sheet.

**APIs:** `GET/POST /api/sheet-integrations`, `PUT/DELETE /api/sheet-integrations/[id]`

---

## 5. Interview Room — `/interview` (experimental)

**File:** [app/(app)/interview/page.tsx](../app/(app)/interview/page.tsx)

**Not linked from the sidebar.** An experimental LiveKit-powered video interview room. Uses the `@livekit/components-react` package. The components exist ([components/interview/](../components/interview/)) but this feature is not part of the main recruiter workflow. Access the URL directly if needed.

---

## Global components

| Component | Purpose |
|---|---|
| [components/GlobalJobProgress.tsx](../components/GlobalJobProgress.tsx) | Fixed bottom bar — shows a live progress indicator when a Job is currently PROCESSING. Polls `GET /api/jobs/:id` every few seconds. Rendered in the app layout, always visible. |
| [components/layout/Sidebar.tsx](../components/layout/Sidebar.tsx) | Collapsible sidebar; collapses to icon-only on desktop, slides in as a drawer on mobile. State persisted in `SidebarContext`. |
| [components/theme-toggle.tsx](../components/theme-toggle.tsx) | Light/dark mode toggle in the sidebar footer. Uses `next-themes`. |
