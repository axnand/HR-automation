import { prisma } from "@/lib/prisma";

// Shape of one interview question.  `scope` is added at merge time so the UI
// can distinguish inherited global questions from role-specific ones.
export interface InterviewQuestion {
  id: string;
  order: number;
  text: string;
  mustAsk?: boolean;
  idealAnswer?: string;
  weight?: number;
}

export type ScopedInterviewQuestion = InterviewQuestion & {
  scope: "global" | "role";
};

function coerceQuestion(raw: unknown): InterviewQuestion | null {
  if (!raw || typeof raw !== "object") return null;
  const q = raw as Record<string, unknown>;
  if (typeof q.id !== "string" || !q.id.trim()) return null;
  if (typeof q.text !== "string" || !q.text.trim()) return null;
  return {
    id: q.id,
    order: typeof q.order === "number" ? q.order : 0,
    text: q.text,
    mustAsk: q.mustAsk === true,
    idealAnswer: typeof q.idealAnswer === "string" ? q.idealAnswer : undefined,
    weight: typeof q.weight === "number" ? q.weight : 1.0,
  };
}

function coerceQuestions(raw: unknown): InterviewQuestion[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(coerceQuestion).filter((q): q is InterviewQuestion => q !== null);
}

/**
 * Merge the org-wide global baseline with per-role questions, exactly mirroring
 * getEffectiveRules in lib/analyzer.ts:
 *
 *   - Global questions come first (scope: "global")
 *   - Role questions are appended (scope: "role")
 *   - Deduped by id (role-level wins if the same id appears in both)
 *
 * `requisitionConfigRaw` is the Requisition.config JSON string (nullable).
 * Returns the merged list frozen for snapshotting; also returns it typed for
 * injection into the SCAI token request.
 */
export async function getEffectiveInterviewQuestions(
  requisitionConfigRaw: string | null | undefined,
): Promise<ScopedInterviewQuestion[]> {
  const cfg = await prisma.interviewConfig.findUnique({
    where: { id: "global" },
    select: { globalQuestions: true },
  });
  const globalRaw = cfg?.globalQuestions;
  const globalQuestions = coerceQuestions(globalRaw).map(
    (q): ScopedInterviewQuestion => ({ ...q, scope: "global" }),
  );

  let roleQuestions: ScopedInterviewQuestion[] = [];
  if (requisitionConfigRaw) {
    try {
      const parsed = JSON.parse(requisitionConfigRaw);
      const raw = parsed?.interview?.questions;
      roleQuestions = coerceQuestions(raw).map(
        (q): ScopedInterviewQuestion => ({ ...q, scope: "role" }),
      );
    } catch {
      /* malformed config — fall through */
    }
  }

  // Merge: global first; dedupe by id (role wins on collision)
  const seen = new Set<string>();
  const merged: ScopedInterviewQuestion[] = [];
  for (const q of [...globalQuestions, ...roleQuestions]) {
    if (!seen.has(q.id)) {
      seen.add(q.id);
      merged.push(q);
    }
  }
  return merged;
}
