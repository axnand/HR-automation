/**
 * One-off: restore the 3 candidates on the "Talent Acquisition Head"
 * requisition that were wrongly auto-archived ("All follow-ups exhausted").
 *
 * Root cause: after the final follow-up was sent, the thread was parked at
 * nextActionAt=NULL. The process-tasks heal cron mistook that for a
 * crashed-mid-claim thread, re-armed it, and the next outreach tick archived
 * it via the "followupsSent >= followupsTotal" branch — giving the candidate
 * ZERO reply window. (Proper fix lands separately in the worker.)
 *
 * This script ONLY un-archives the specific threads listed below, and only if
 * they are still ARCHIVED with the exact auto-exhaust reason — so it is a
 * no-op on re-run and cannot touch HR-archived candidates.
 *
 * Restore semantics: thread → ACTIVE again, archive fields cleared, and
 * nextActionAt set to a fresh reply window. During that window pollChatReplies
 * will catch any reply (REPLIED), and the task stage rolls ARCHIVED → MESSAGED
 * via recomputeTaskStage (the blessed path — keeps StageEvent audit correct).
 *
 * Run: npx tsx scripts/restore-wrongly-archived.ts
 */
import { prisma } from "@/lib/prisma";
import { recomputeTaskStage } from "@/lib/channels/stage-rollup";

// Fresh reply window granted on restore. The candidates were cut short with no
// chance to reply; give them a week. (The permanent per-channel reply-wait fix
// lands in the worker separately.)
const REPLY_WINDOW_DAYS = 7;

// The exact reason the buggy path stamped — guard against touching anything else.
const AUTO_EXHAUST_REASON = "All follow-ups exhausted — no reply received";

// taskId → threadId for the 3 wrongly system-archived candidates.
const TARGETS: { name: string; taskId: string; threadId: string }[] = [
  { name: "Himanshu Kalra", taskId: "cmq556dph000e7qt03q01kbtu", threadId: "cmq556yva0007906sturmf4wt" },
  { name: "Manoj Thakur",   taskId: "cmq4zzcbf0002130rt1y254r8", threadId: "cmq52z3xu0004vc8bh366deaz" },
  { name: "Renu R.",        taskId: "cmq0wmvmv00098wr1fihubqr9", threadId: "cmq4tdr1q0015aitcoqktp4f2" },
];

async function main() {
  const nextActionAt = new Date(Date.now() + REPLY_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  for (const t of TARGETS) {
    const before = await prisma.channelThread.findUnique({
      where: { id: t.threadId },
      select: { status: true, archivedReason: true },
    });

    if (!before) {
      console.log(`SKIP ${t.name}: thread ${t.threadId} not found`);
      continue;
    }
    if (before.status !== "ARCHIVED" || before.archivedReason !== AUTO_EXHAUST_REASON) {
      console.log(`SKIP ${t.name}: not auto-exhaust-archived (status=${before.status}, reason=${before.archivedReason ?? "null"}) — left as-is`);
      continue;
    }

    // Guarded un-archive: only flips a row that is still ARCHIVED.
    const res = await prisma.channelThread.updateMany({
      where: { id: t.threadId, status: "ARCHIVED", archivedReason: AUTO_EXHAUST_REASON },
      data: {
        status: "ACTIVE",
        archivedAt: null,
        archivedReason: null,
        nextActionAt,
        // Clear any stale crash/circuit-breaker markers so the thread starts clean.
        pendingSendKey: null,
        pendingSendStartedAt: null,
        consecutiveFailures: 0,
      },
    });

    if (res.count === 0) {
      console.log(`SKIP ${t.name}: thread changed between read and write — no-op`);
      continue;
    }

    const rollup = await recomputeTaskStage(t.taskId, { source: "SYSTEM" });
    console.log(`RESTORED ${t.name}: thread → ACTIVE, reply window until ${nextActionAt.toISOString()}; task stage ${rollup.fromStage ?? "(unchanged)"} → ${rollup.stage}`);
  }

  console.log("Done.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
