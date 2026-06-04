import { prisma } from "@/lib/prisma";
import { randomUUID } from "crypto";
import { Prisma, InterviewSessionStatus, InterviewSentVia } from "@prisma/client";
import { newInterviewAccessToken } from "./access-token";
import { getEffectiveInterviewQuestions } from "./questions";

// A session is "open" (reusable) until it reaches a terminal state. Reusing the
// open one is the dedup guarantee: repeat clicks, a bulk send overlapping a
// manual send, or trigger A racing trigger B all converge on a single link
// instead of minting duplicates (§6 dedup guard #1; §11 multiple-session policy).
export const OPEN_SESSION_STATUSES: InterviewSessionStatus[] = [
  InterviewSessionStatus.PENDING,
  InterviewSessionStatus.SENT,
  InterviewSessionStatus.IN_PROGRESS,
];

export type OpenInterviewSession = {
  id: string;
  roomId: string;
  accessToken: string;
  status: InterviewSessionStatus;
  sentVia: InterviewSentVia | null;
};

/**
 * Reuse the candidate's open interview session, or create one. Serialized
 * per-task with a Postgres transaction-scoped advisory lock so concurrent
 * callers across processes (API routes + the worker tick) can't both pass the
 * "no open session" check and mint duplicates (gap D). Per CLAUDE.md, global
 * serialization must use an advisory lock — not an in-memory mutex — because
 * the web app and worker.ts are separate processes.
 *
 * Re-interviews still work: a COMPLETED/ANALYZED/EXPIRED/FAILED session is NOT
 * "open", so the next send mints a fresh one.
 */
export async function getOrCreateOpenInterviewSession(
  taskId: string,
): Promise<{ session: OpenInterviewSession; created: boolean }> {
  const result = await prisma.$transaction(async (tx) => {
    // pg_advisory_xact_lock(int4, int4): key1 = hashtext(namespaced taskId),
    // key2 = a fixed namespace constant so this lock space can't collide with
    // other advisory locks. Auto-releases at transaction end.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`interview_session:${taskId}`}), 0)`;

    const existing = await tx.interviewSession.findFirst({
      where: { taskId, status: { in: OPEN_SESSION_STATUSES } },
      orderBy: { createdAt: "desc" },
      select: { id: true, roomId: true, accessToken: true, status: true, sentVia: true },
    });

    if (existing) {
      // Legacy Phase-1 rows may predate accessToken; mint one lazily so the
      // capability URL always resolves (belt-and-suspenders to the backfill).
      let accessToken = existing.accessToken;
      if (!accessToken) {
        accessToken = newInterviewAccessToken();
        await tx.interviewSession.update({ where: { id: existing.id }, data: { accessToken } });
      }
      return { session: { ...existing, accessToken }, created: false };
    }

    const created = await tx.interviewSession.create({
      data: {
        taskId,
        roomId: `interview_${randomUUID()}`,
        accessToken: newInterviewAccessToken(),
        status: InterviewSessionStatus.PENDING,
      },
      select: { id: true, roomId: true, accessToken: true, status: true, sentVia: true },
    });
    return { session: created as OpenInterviewSession, created: true };
  }, {
    // The advisory lock briefly serializes per-task; keep the timeout tight so a
    // stuck lock can't wedge a request.
    timeout: 10_000,
    isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  });

  // Phase 2: snapshot the merged question list onto newly created sessions.
  // Done here in the chokepoint — NOT in one API route — so EVERY entry point
  // (the "Start Interview" button, trigger A/B/C/E delivery) freezes the
  // questions at creation and the token route can inject them. Done post-commit
  // (outside the advisory-lock txn) so we don't open a second pooled connection
  // while the txn holds one (PgBouncer session-mode pool limits). Best-effort:
  // a snapshot failure must not block session creation / link delivery.
  if (result.created) {
    try {
      const taskRow = await prisma.task.findUnique({
        where: { id: taskId },
        select: { job: { select: { requisition: { select: { config: true } } } } },
      });
      const questions = await getEffectiveInterviewQuestions(taskRow?.job?.requisition?.config);
      if (questions.length > 0) {
        await prisma.interviewSession.update({
          where: { id: result.session.id },
          data: { questionsSnapshot: questions as unknown as Prisma.InputJsonValue },
        });
      }
    } catch (err) {
      console.error("[getOrCreateOpenInterviewSession] question snapshot failed:", err);
    }
  }

  return result;
}
