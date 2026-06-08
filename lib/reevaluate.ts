import { prisma } from "@/lib/prisma";
import { analyzeProfile, getEffectiveRules, type AnalysisConfig } from "@/lib/analyzer";
import { recomputeTaskScore } from "@/lib/recalculate-scores";

// ─── Single-profile AI re-evaluation ────────────────────────────────────────
//
// Re-runs the AI scorer against a task's ALREADY-SCRAPED profile (Task.result)
// using the requisition's CURRENT scoring config. This is the operation a
// recruiter wants after editing a scoring rule (e.g. "an MBA rule that now also
// counts a non-MBA master's"): the stored per-rule AI scores are stale and a
// pure arithmetic recompute (lib/recalculate-scores.ts) can't fix them — only a
// fresh LLM pass with the new rule text can.
//
// Crucially it does NOT re-scrape LinkedIn — it reuses the cached raw profile,
// so a re-evaluation is a single LLM call (no Unipile account, no Airscale
// credits, no rate-limit risk). It also does NOT touch the candidate's pipeline
// stage: re-evaluation is a scoring correction, not a sourcing event. HR
// overrides are preserved by routing the fresh scores through recomputeTaskScore.

export interface ScoreSnapshot {
  totalScore: number;
  maxScore: number;
  scorePercent: number;
  recommendation: string;
}

export interface ReevaluateResult {
  taskId: string;
  ok: boolean;
  error?: string;
  before?: ScoreSnapshot;
  after?: ScoreSnapshot;
}

function snapshot(a: any): ScoreSnapshot | undefined {
  if (!a || typeof a.totalScore !== "number") return undefined;
  return {
    totalScore: a.totalScore,
    maxScore: a.maxScore,
    scorePercent: a.scorePercent,
    recommendation: a.recommendation,
  };
}

/**
 * Re-evaluate a single task in place. Returns the before/after score snapshots
 * for UI display. Never throws on expected failure modes (missing profile,
 * missing config) — those come back as { ok: false, error }. Genuine AI/DB
 * errors propagate so the caller can decide retry/HTTP-status behaviour.
 */
export async function reevaluateTask(taskId: string): Promise<ReevaluateResult> {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      url: true,
      result: true,
      analysisResult: true,
      candidateProfileId: true,
      job: { select: { config: true, requisitionId: true } },
      overrides: { select: { paramKey: true, override: true } },
    },
  });

  if (!task) return { taskId, ok: false, error: "Task not found" };
  if (!task.result) {
    return { taskId, ok: false, error: "No cached profile — run a fresh scrape before re-evaluating" };
  }

  // Resolve the LIVE requisition config (the recruiter's latest scoring rules).
  // Fall back to the job snapshot for tasks not tied to a requisition.
  let config: AnalysisConfig | null = null;
  if (task.job?.requisitionId) {
    const req = await prisma.requisition.findUnique({
      where: { id: task.job.requisitionId },
      select: { config: true },
    });
    if (req?.config) {
      try { config = JSON.parse(req.config) as AnalysisConfig; } catch { /* fall through */ }
    }
  }
  if (!config && task.job?.config) {
    try { config = JSON.parse(task.job.config) as AnalysisConfig; } catch { /* ignore */ }
  }
  if (!config?.jobDescription) {
    return { taskId, ok: false, error: "No job description configured for this requisition" };
  }

  let profileData: any;
  try {
    profileData = JSON.parse(task.result);
  } catch {
    return { taskId, ok: false, error: "Cached profile is corrupt" };
  }

  const before = task.analysisResult
    ? (() => { try { return snapshot(JSON.parse(task.analysisResult!)); } catch { return undefined; } })()
    : undefined;

  // ── Fresh AI pass (single LLM call; no re-scrape) ──
  const fresh = await analyzeProfile(profileData, config);
  const analysisData: any = { ...fresh };

  // ── Re-apply HR overrides + roll up totals against the SAME live rule set ──
  const effectiveRules = getEffectiveRules({
    scoringRules: config.scoringRules,
    customScoringRules: config.customScoringRules,
    builtInRuleDescriptions: config.builtInRuleDescriptions,
    ruleDefinitions: config.ruleDefinitions,
  });
  const overrideMap = new Map(task.overrides.map(o => [o.paramKey, o.override]));
  const recomputed = recomputeTaskScore(analysisData, effectiveRules, overrideMap);

  analysisData.totalScore = recomputed.totalScore;
  analysisData.maxScore = recomputed.maxScore;
  analysisData.scorePercent = recomputed.scorePercent;
  analysisData.recommendation = recomputed.recommendation;
  analysisData.unscoredRules = recomputed.unscoredRules;
  analysisData.hasOverrides = task.overrides.length > 0;

  const json = JSON.stringify(analysisData);

  // Task.analysisResult is the UI's source of truth. Stage is intentionally
  // left untouched — re-evaluation corrects a score, it does not advance the
  // pipeline (see CLAUDE.md stage-rollup invariants).
  await prisma.task.update({
    where: { id: taskId },
    data: { analysisResult: json, analysisStatus: "OK" },
  });

  // ── Audit: append an AnalysisRecord per re-evaluation (history of scores) ──
  // Best-effort — the Task is already updated, so the UI is consistent even if
  // this fails. Requires a linked CandidateProfile (the AnalysisRecord owner).
  if (task.candidateProfileId) {
    try {
      await prisma.analysisRecord.create({
        data: {
          candidateId: task.candidateProfileId,
          linkedinUrl: task.url,
          candidateName: fresh.candidateInfo?.name || "",
          jobTitle: (config as any).jdTitle || "Re-evaluation",
          jobDescription: config.jobDescription,
          scoringConfig: JSON.stringify({
            scoringRules: config.scoringRules,
            customScoringRules: config.customScoringRules,
            aiModel: (config as any).aiModel,
            customPrompt: config.customPrompt,
            reevaluation: true,
          }),
          analysisData: json,
          totalScore: recomputed.totalScore,
          maxScore: recomputed.maxScore,
          scorePercent: recomputed.scorePercent,
          recommendation: recomputed.recommendation,
        },
      });
    } catch {
      // Non-fatal — Task already reflects the new score.
    }
  }

  return { taskId, ok: true, before, after: snapshot(analysisData) };
}
