// ─── Task stage rollup ────────────────────────────────────────────────────────
//
// Task.stage is a materialized rollup of all ChannelThread statuses for that task.
// Call recomputeTaskStage() after ANY thread status or providerState change.
// It respects manualStage (set by the recruiter for INTERVIEW / HIRED / REJECTED).
//
// P1 #16 / #17 — the function returns a typed event contract
// `{ stage, changed, fromStage, source }` so future downstream consumers
// (Slack notifications, ATS sync, analytics) can subscribe to a single
// event source and dedupe naturally instead of double-firing on
// system-rollup-after-manual. Source identifies who triggered the
// recompute. Pass `source` from the caller (defaults to SYSTEM); manual
// recruiter routes pass MANUAL, webhook handlers pass WEBHOOK.

import { prisma } from "@/lib/prisma";
import { CandidateStage } from "@prisma/client";
import { markStageEventExplicit } from "@/lib/channels/stage-event-context";

export type StageRollupSource = "SYSTEM" | "MANUAL" | "WEBHOOK";

export interface StageRollupResult {
  /** The current task.stage after the rollup (always populated). */
  stage: CandidateStage;
  /** True only when this rollup write actually changed the stored stage. */
  changed: boolean;
  /** What the stage was before this rollup, if it changed. Undefined when unchanged. */
  fromStage?: CandidateStage;
  /** Who triggered this rollup. Useful for downstream effect dedupe. */
  source: StageRollupSource;
}

// Stages a recruiter sets manually — these always win over any derived state.
// ARCHIVED is included so that a recruiter dragging a candidate to ARCHIVED
// is honored even if some thread is still PENDING (the side-effect of that
// drag, in the candidate PATCH route, is to archive every thread, but the
// rollup must still respect the recruiter's intent during the brief window
// before those archives commit).
const MANUAL_WINS = new Set<CandidateStage>(["INTERVIEW", "HIRED", "REJECTED", "ARCHIVED"]);

// Priority order for derived rollup (higher index = higher priority)
const STAGE_PRIORITY: Record<CandidateStage, number> = {
  SOURCED:           0,
  SHORTLISTED:       1,
  CONTACT_REQUESTED: 2,
  CONNECTED:         3,
  MESSAGED:          4,
  REPLIED:           5,
  INTERVIEW:         6,
  HIRED:             7,
  REJECTED:          8,
  ARCHIVED:         -1, // special — only wins when ALL threads are archived
};

type TxClient = Omit<
  typeof prisma,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

export async function recomputeTaskStage(
  taskId: string,
  options: { tx?: TxClient; source?: StageRollupSource } = {},
): Promise<StageRollupResult> {
  const tx: TxClient = options.tx ?? prisma;
  const source: StageRollupSource = options.source ?? "SYSTEM";

  const [task, threads] = await Promise.all([
    tx.task.findUnique({
      where: { id: taskId },
      select: { stage: true, manualStage: true, candidateName: true },
    }),
    tx.channelThread.findMany({
      where: { taskId },
      select: { status: true, providerState: true, lastMessageAt: true },
    }),
  ]);

  if (!task) throw new Error(`recomputeTaskStage: task ${taskId} not found`);

  const cLabel = task.candidateName ?? `taskId:${taskId.slice(-8)}`;

  // Recruiter decision always wins
  if (task.manualStage && MANUAL_WINS.has(task.manualStage)) {
    if (task.stage !== task.manualStage) {
      await tx.task.update({
        where: { id: taskId },
        data: { stage: task.manualStage, stageUpdatedAt: new Date() },
      });
      console.log(`[StageRollup] "${cLabel}" ${task.stage} → ${task.manualStage} (taskId=${taskId} source=${source} reason=manualStage)`);
      return { stage: task.manualStage, changed: true, fromStage: task.stage, source };
    }
    return { stage: task.manualStage, changed: false, source };
  }

  // No threads yet — leave stage as-is (SOURCED or SHORTLISTED)
  if (threads.length === 0) {
    return { stage: task.stage, changed: false, source };
  }

  // All threads archived → task is archived
  if (threads.every(t => t.status === "ARCHIVED")) {
    if (task.stage !== "ARCHIVED") {
      // Wrap writes in a transaction so set_config(... is_local=true) inside
      // markStageEventExplicit persists across the task.update + stageEvent.create.
      // Without this, the audit trigger task_stage_audit would emit a duplicate row.
      await prisma.$transaction(async (innerTx) => {
        await markStageEventExplicit(innerTx);
        await innerTx.task.update({
          where: { id: taskId },
          data: { stage: "ARCHIVED", stageUpdatedAt: new Date() },
        });
        await innerTx.stageEvent.create({
          data: {
            taskId,
            fromStage: task.stage,
            toStage: "ARCHIVED",
            actor: "SYSTEM",
            reason: "All channel threads exhausted or timed out",
          },
        });
      });
      console.log(`[StageRollup] "${cLabel}" ${task.stage} → ARCHIVED (taskId=${taskId} source=${source})`);
      return { stage: "ARCHIVED", changed: true, fromStage: task.stage, source };
    }
    return { stage: "ARCHIVED", changed: false, source };
  }

  // P2 #5 / EC-5.5 — initialize from the current task.stage rather than
  // hardcoded SHORTLISTED. With the previous baseline, a task in a higher
  // stage (CONNECTED / MESSAGED / REPLIED) whose threads were all PAUSED
  // would silently downgrade to SHORTLISTED on the next rollup, because
  // PAUSED threads don't bump `derived`. Initializing from task.stage
  // means rollup only RAISES the stage; downgrades require an explicit
  // archive or recruiter override (manualStage).
  let derived: CandidateStage = task.stage;
  // Special case: if the current stage is one of the "manual-only" terminals
  // (ARCHIVED handled above; INTERVIEW/HIRED/REJECTED only via manualStage,
  // and we only get here when manualStage was NOT in MANUAL_WINS), then the
  // recruiter has cleared the manual override and we should redo the
  // derivation from the floor. Otherwise stale terminal stages stick.
  const TERMINAL_FLOORS = new Set<CandidateStage>([
    CandidateStage.INTERVIEW,
    CandidateStage.HIRED,
    CandidateStage.REJECTED,
    CandidateStage.ARCHIVED,
  ]);
  if (TERMINAL_FLOORS.has(derived)) {
    derived = "SHORTLISTED";
  }

  for (const thread of threads) {
    if (thread.status === "ARCHIVED") continue;

    let threadStage: CandidateStage;

    if (thread.status === "REPLIED") {
      // Replied always wins — short-circuit
      derived = "REPLIED";
      break;
    } else if (thread.status === "PAUSED" || thread.status === "PENDING") {
      // Paused/pending threads don't advance the stage
      continue;
    } else {
      // ACTIVE — derive from providerState
      const ps = (thread.providerState as Record<string, string> | null) ?? {};
      if (ps.phase === "INVITE_PENDING") {
        threadStage = "CONTACT_REQUESTED";
      } else if (ps.phase === "CONNECTED" && !thread.lastMessageAt) {
        // Connected on LinkedIn but no DM has been sent yet
        threadStage = "CONNECTED";
      } else {
        // Anything else (INMAIL_SENT, SENT, DELIVERED, MESSAGED, or CONNECTED+lastMessageAt)
        // means a message has been sent → MESSAGED
        threadStage = "MESSAGED";
      }
      if (STAGE_PRIORITY[threadStage] > STAGE_PRIORITY[derived]) {
        derived = threadStage;
      }
    }
  }

  if (derived !== task.stage) {
    // Wrap writes in a transaction (see comment above on the ARCHIVED branch).
    await prisma.$transaction(async (innerTx) => {
      await markStageEventExplicit(innerTx);
      await innerTx.task.update({
        where: { id: taskId },
        data: { stage: derived, stageUpdatedAt: new Date() },
      });
      await innerTx.stageEvent.create({
        data: {
          taskId,
          fromStage: task.stage,
          toStage: derived,
          actor: "SYSTEM",
          reason: "Stage recomputed from channel thread states",
        },
      });
    });
    console.log(`[StageRollup] "${cLabel}" ${task.stage} → ${derived} (taskId=${taskId} source=${source})`);
    return { stage: derived, changed: true, fromStage: task.stage, source };
  }

  return { stage: derived, changed: false, source };
}
