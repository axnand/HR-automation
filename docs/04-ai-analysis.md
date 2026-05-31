# 04 — AI Analysis

This document explains how a scraped LinkedIn profile (or uploaded resume) becomes a numeric score and recommendation.

**Primary file:** [lib/analyzer.ts](../lib/analyzer.ts)

---

## What the scoring system produces

Every analyzed candidate gets an `AnalysisResult` ([analyzer.ts:120](../lib/analyzer.ts#L120)):

| Field | What it is |
|---|---|
| `totalScore` | Integer — sum of all enabled rule scores |
| `maxScore` | Integer — maximum possible given enabled rules |
| `scorePercent` | `totalScore / maxScore × 100`, rounded to 1 decimal |
| `recommendation` | `"Strong Fit"` (≥70%), `"Moderate Fit"` (40–70%), `"Not a Fit"` (<40%) |
| `scoring` | Object: each score-parameter key → numeric value or `""` |
| `scoringLogs` | Object: each rule key → human-readable reasoning string |
| `candidateInfo` | Extracted candidate facts (name, current role, tenure stats, education) |
| `skillBreakdown` | `{ matchedSkills, missingSkills, matchPercent }` |
| `strengths / gaps / flags` | LLM-generated lists — flags are only genuine disqualifiers |
| `remarks` | LLM-generated overall assessment |
| `experienceSummary` | LLM-generated 2–3 sentence career summary |

This JSON is stored in `Task.analysisResult` and in `AnalysisRecord.analysisData`.

---

## Scoring rules

There are 7 built-in rules + unlimited custom rules. Each can be toggled on/off per requisition.

### Built-in rules

| Rule key | Max points | How scored |
|---|---|---|
| `stability` | 10 | **Deterministic** — avg tenure: >2.5yr → 10, 1.5–2.5yr → 7, <1.5yr → 0 |
| `growth` | 15 | LLM — internal promotion → 15, external step-up → 10, no growth → 0 |
| `graduation` | 15 | LLM — BTech/BE Tier-1 → 15, Tier-2 → 10; Non-BTech Tier-1 → 7, Tier-2 → 5 |
| `companyType` | 15 | LLM — B2B SalesTech/CRM → 15, Other B2B SaaS → 10, IT services → 7, B2C/other → 0 |
| `mba` | 15 | LLM — MBA Tier-1 → 15, other MBA → 10, no MBA → 0 |
| `skillMatch` | 10 | LLM — >70% of JD-required skills matched → 10, 40–70% → 5, <40% → 0 |
| `location` | 5 | **Deterministic** — token-match between candidate location and JD location field |

Default max total: **85 points** (all rules enabled, no custom rules).

**File:** [analyzer.ts:167](../lib/analyzer.ts#L167) — `DEFAULT_RULE_DEFINITIONS`

### Custom rules

Recruiters can add custom rules (via Settings → Evaluation Configs or the ScoringRulesTab). Each custom rule has:
- A name and `maxPoints` (recruiter-defined)
- A `criteria` string — natural language instructions passed verbatim to the LLM
- An `enabled` toggle

Custom rules are appended after the built-in rules. Each gets a `custom_{id}` score-parameter key.

---

## Two-pass scoring

### Pass 1 — Deterministic pre-computation

Before calling the LLM, the system computes `stability` and `location` locally:

**Stability** ([analyzer.ts:446](../lib/analyzer.ts#L446) — `computeCareerStats`):
- Parses `work_experience` array from the Unipile profile
- Groups by company name and sums months per company
- Computes average tenure across all companies
- Applies the threshold table above

**Location** ([analyzer.ts:397](../lib/analyzer.ts#L397) — `scoreLocationMatch`):
- Tokenizes both the candidate's `location` field and the `Location:` line in the JD
- Returns 5 if any token from the candidate location matches a JD token, 0 otherwise

For **resume uploads**, the LLM scores stability and location itself from the raw text (since there's no structured `work_experience` JSON). The pre-computed values are used as fallback only.

### Pass 2 — LLM evaluation

The LLM is given a system prompt containing:
1. **Identity** — e.g. "You are a strict ATS evaluator."
2. **Critical instructions** — behavioral rules (no benefit of the doubt, evidence-based, disqualifier check)
3. **Optional guidelines** — per-requisition custom instructions from the recruiter
4. **Optional recruiter context** — freeform JD context
5. **Scoring rules** — one numbered block per enabled non-pre-computed rule with the exact criteria text

And a user prompt containing:
- The full JD text
- Structured candidate profile: name, headline, location, career stats, experience (grouped by company to make internal promotions visible), education, pre-extracted education details, skills, certifications

**System prompt builder:** [analyzer.ts:713](../lib/analyzer.ts#L713) — `buildSystemPrompt`
**User prompt builder:** [analyzer.ts:802](../lib/analyzer.ts#L802) — `buildUserPrompt`

The LLM returns a JSON object — the system validates and parses it.

### Pass 3 — Merge

Deterministic scores overwrite the LLM's stability/location values (for LinkedIn profiles). All scores are capped at `param.maxPoints`. The final `totalScore` and `scorePercent` are computed from the merged object.

---

## LLM provider configuration

The system supports multiple providers via [lib/ai-adapter.ts](../lib/ai-adapter.ts):

- **OpenAI-compatible** (default) — any API that speaks the OpenAI chat completions format
- **Anthropic** — direct Anthropic SDK
- **AWS Bedrock** — via `aws4fetch` request signing

Providers are configured in the `AiProvider` table (Settings → AI Providers). The default provider is set via `AppSettings.aiProviderId`. A per-requisition override is stored in `Job.config.aiProviderId`.

The model is configured per requisition (`Job.config.aiModel`) and falls back to `AppSettings.aiModel` (default: `"gpt-4.1"`).

**File:** [lib/ai-adapter.ts](../lib/ai-adapter.ts)

---

## Prompt customization layers

The system has four layers of prompt customization, evaluated from most-specific to least:

| Layer | Where configured | What it overrides |
|---|---|---|
| `EvaluationConfig` | Settings → Evaluation Configs | Full preset: role, guidelines, critical instructions, rule overrides, prompt envelope |
| Per-requisition config | Requisition → JD tab | `customPrompt` (recruiter context injected into the prompt) |
| `PromptTemplate` | Settings → Prompt Templates | Saved reusable prompt text blocks |
| `AppSettings` | Settings → General | Default `promptRole`, `promptGuidelines`, `criticalInstructions` |

**Prompt envelope** — `EvaluationConfig.promptEnvelope` allows overriding the structural scaffolding of the prompt (identity line template, section headers, JSON response schema wrapper). Most teams never touch this.

---

## Cost tracking

Token usage is logged to the console after every analysis call:

```
[Analyzer] AI response (openai). prompt: 3842 (cached: 2048, hit: 53%, written: 1794), completion: 412, total: 4254
```

- `cached_tokens` — tokens served from the provider's prompt cache (cheaper)
- `cache_write_tokens` — tokens written to cache this call
- `hit` — cache hit percentage

The system prompt (which includes the JD and scoring rules) is cacheable across all candidates in the same batch because it is built identically for each. The date token (`Today's date is...`) is deliberately placed in the **user** prompt so the system prompt stays stable and the cache remains valid for the entire batch.

Token usage is stored in `Task.analysisResult.__debug.usage` for debugging. It is not yet aggregated into a dashboard.

---

## Score overrides

Recruiters can manually override individual score parameters from the candidate detail view. Overrides are stored in the `ScoreOverride` table ([prisma/schema.prisma:536](../prisma/schema.prisma#L536)) and merged into the displayed score at read time.

**API:** `PATCH /api/tasks/[taskId]/overrides`

---

## Analysis status

`Task.analysisStatus` tracks the analysis sub-step independently from `Task.status` (the whole task lifecycle):

| Value | Meaning |
|---|---|
| `PENDING` | Analysis not yet run, or skipped (no JD configured) |
| `OK` | Analysis ran and produced a parsable scored result |
| `FAILED` | Analysis errored after retries — surface in recruiter "needs review" queue |

A task can be `status: DONE` + `analysisStatus: PENDING` if the Job had no JD configured. The scrape succeeded; scoring was skipped intentionally.

**File:** [prisma/schema.prisma:97](../prisma/schema.prisma#L97)
