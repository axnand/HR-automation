import { prisma } from "@/lib/prisma";
import { analyzeProfile, type AnalysisConfig } from "@/lib/analyzer";
import { exportToSheet, buildSheetPayload } from "@/lib/sheets";
import { canonicalizeLinkedinUrl } from "@/lib/canonicalize-url";

type ProfileData = {
  first_name?: string;
  last_name?: string;
  headline?: string;
  location?: string;
  [key: string]: unknown;
};

type AnalysisResult = Awaited<ReturnType<typeof analyzeProfile>>;

export type PersistResult = {
  analysisResultJson: string | null;
  analysisResult: AnalysisResult | null;
};

/**
 * Atomically persist a LinkedIn task's result:
 *  1. Run AI analysis (external — outside the transaction).
 *  2. Single transaction: create CandidateProfile + AnalysisRecord + update Task.
 *  3. Sheet export afterwards (best-effort, outside the transaction).
 *
 * Used by both the pg-boss worker (lib/workers/task-handlers.ts) and the HTTP
 * route fallback (app/api/process-tasks/route.ts) so the persistence shape stays
 * in one place.
 */
export async function persistLinkedInResult(args: {
  taskId: string;
  taskUrl: string;
  accountId: string;
  profileData: ProfileData;
  jobConfig: AnalysisConfig | null;
  tag: string;
}): Promise<PersistResult> {
  const { taskId, taskUrl, accountId, profileData, jobConfig, tag } = args;

  // ── External: AI analysis ──
  let analysisResultJson: string | null = null;
  let analysisResult: AnalysisResult | null = null;
  let analysisError: string | null = null;

  if (jobConfig?.jobDescription) {
    const t0 = Date.now();
    console.log(`${tag} [2/3] Running AI analysis (model: ${(jobConfig as any).aiModel || "unknown"})...`);
    try {
      analysisResult = await analyzeProfile(profileData, jobConfig);
      analysisResultJson = JSON.stringify(analysisResult);
      console.log(
        `${tag} [2/3] Analysis OK — ${Date.now() - t0}ms. ` +
        `score=${analysisResult.scorePercent}% (${analysisResult.totalScore}/${analysisResult.maxScore}) → ${analysisResult.recommendation}`
      );
    } catch (err: any) {
      analysisError = err.message || "Unknown analysis error";
      console.warn(`${tag} [2/3] Analysis FAILED after ${Date.now() - t0}ms: ${analysisError}`);
    }
  } else {
    console.log(`${tag} [2/3] Analysis SKIPPED — no jobDescription in config`);
  }

  const profileName = `${profileData.first_name || ""} ${profileData.last_name || ""}`.trim();
  const profileJson = JSON.stringify(profileData);

  // ── Atomic DB writes ──
  // Phase 6 #27 — link the Task to a canonical CandidateProfile by canonical
  // LinkedIn URL. Find-or-create avoids the legacy duplicate-CandidateProfile
  // problem; new analyses re-use the existing row, and Task.candidateProfileId
  // becomes the cross-task identity join key for reply propagation.
  const canonical = canonicalizeLinkedinUrl(taskUrl);

  await prisma.$transaction(async (tx) => {
    let candidateProfileId: string | null = null;

    if (canonical) {
      const existing = await tx.candidateProfile.findFirst({
        where: { canonicalLinkedinUrl: canonical },
        orderBy: { scrapedAt: "desc" },
        select: { id: true },
      });
      if (existing) {
        candidateProfileId = existing.id;
        // Refresh the snapshot fields on the canonical row so the most
        // recent profile data is what subsequent reads see.
        await tx.candidateProfile.update({
          where: { id: existing.id },
          data: {
            linkedinUrl: taskUrl,
            name: profileName,
            headline: profileData.headline || "",
            location: profileData.location || "",
            rawProfile: profileJson,
            scrapedAt: new Date(),
          },
        });
      } else {
        const created = await tx.candidateProfile.create({
          data: {
            linkedinUrl: taskUrl,
            canonicalLinkedinUrl: canonical,
            name: profileName,
            headline: profileData.headline || "",
            location: profileData.location || "",
            rawProfile: profileJson,
          },
          select: { id: true },
        });
        candidateProfileId = created.id;
      }
    } else {
      // Non-canonical URL (e.g., resume-only sources) — keep the legacy
      // create-each-time behaviour for these so analyses still link to a
      // CandidateProfile, but no cross-task identity.
      const created = await tx.candidateProfile.create({
        data: {
          linkedinUrl: taskUrl,
          name: profileName,
          headline: profileData.headline || "",
          location: profileData.location || "",
          rawProfile: profileJson,
        },
        select: { id: true },
      });
      candidateProfileId = created.id;
    }

    if (analysisResult && jobConfig?.jobDescription && candidateProfileId) {
      await tx.analysisRecord.create({
        data: {
          candidateId: candidateProfileId,
          linkedinUrl: taskUrl,
          candidateName: analysisResult.candidateInfo?.name || profileName,
          jobTitle: (jobConfig as any).jdTitle || "Untitled",
          jobDescription: jobConfig.jobDescription,
          scoringConfig: JSON.stringify({
            scoringRules: jobConfig.scoringRules,
            customScoringRules: jobConfig.customScoringRules,
            aiModel: (jobConfig as any).aiModel,
            customPrompt: jobConfig.customPrompt,
          }),
          analysisData: analysisResultJson!,
          totalScore: analysisResult.totalScore,
          maxScore: analysisResult.maxScore,
          scorePercent: analysisResult.scorePercent,
          recommendation: analysisResult.recommendation,
        },
      });
    }

    const candidateName =
      [profileData.first_name, profileData.last_name].filter(Boolean).join(" ") || null;

    await tx.task.update({
      where: { id: taskId },
      data: {
        status: "DONE",
        result: profileJson,
        analysisResult: analysisResultJson,
        accountId,
        candidateName,
        // P1 #37 / EC-13.1 — explicit analysis sub-state. OK when we have a
        // parsed result; PENDING when analysis was skipped (no JD configured),
        // so the recruiter UI can distinguish "analyzed clean" from "analysis
        // not run yet" without inferring from analysisResult IS NULL.
        analysisStatus: analysisResult ? "OK" : analysisError ? "FAILED" : "PENDING",
        errorMessage: analysisError,
        // Bind Task to the canonical CandidateProfile (for cross-task identity)
        ...(candidateProfileId ? { candidateProfileId } : {}),
      },
    });
  });

  // ── External: sheet export (best-effort) ──
  const sheetUrl = (jobConfig as any)?.sheetWebAppUrl;
  if (analysisResult && sheetUrl) {
    const minThreshold = (jobConfig as any).minScoreThreshold ?? 0;
    if (analysisResult.scorePercent >= minThreshold) {
      const t0 = Date.now();
      console.log(`${tag} [3/3] Exporting to sheet (score ${analysisResult.scorePercent}% >= threshold ${minThreshold}%)...`);
      const payload = buildSheetPayload(
        taskUrl,
        analysisResult,
        (jobConfig as any).jdTitle || "Bulk Analysis",
        jobConfig!.scoringRules as Record<string, boolean | undefined>,
        jobConfig!
      );
      try {
        await exportToSheet(sheetUrl, payload);
        console.log(`${tag} [3/3] Sheet export OK — ${Date.now() - t0}ms`);
      } catch (err: any) {
        console.warn(`${tag} [3/3] Sheet export FAILED after ${Date.now() - t0}ms: ${err.message}`);
      }
    } else {
      console.log(`${tag} [3/3] Sheet export SKIPPED — score ${analysisResult.scorePercent}% < threshold ${minThreshold}%`);
    }
  } else if (!sheetUrl) {
    console.log(`${tag} [3/3] Sheet export SKIPPED — no sheetWebAppUrl configured`);
  }

  return { analysisResultJson, analysisResult };
}
