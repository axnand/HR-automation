// ─── Shared stage transition helper ──────────────────────────────────────────
//
// Exposed for both the single-candidate PATCH route and the bulk-drag
// endpoint so the same transition matrix + side-effects + audit + optimistic
// concurrency live in one place.
//
// applyStageTransition(taskId, toStage, opts):
//   - validates the transition
//   - honors If-Match-style optimistic concurrency on stageUpdatedAt
//   - writes Task.stage / manualStage in a transaction with the matching
//     thread side-effect (archive / pause / resurrect / fan-out)
//   - emits an audit StageEvent (suppressed task_stage_audit trigger)
//   - kicks off fan-out asynchronously when applicable
//
// Returns a discriminated union; HTTP route adapters map each kind to a
// status code (200, 404, 409, 422).

import { prisma } from "@/lib/prisma";
import { CandidateStage } from "@prisma/client";
import { fanOutToChannels } from "@/lib/channels/fan-out";

export const SYSTEM_DERIVED = new Set<CandidateStage>([
  CandidateStage.CONTACT_REQUESTED,
  CandidateStage.CONNECTED,
  CandidateStage.MESSAGED,
  CandidateStage.REPLIED,
]);

export const MANUAL_WINS = new Set<CandidateStage>([
  CandidateStage.INTERVIEW,
  CandidateStage.HIRED,
  CandidateStage.REJECTED,
  CandidateStage.ARCHIVED,
]);

export type ThreadEffect =
  | "none"
  | "fanOut"
  | "archiveOpen"
  | "pauseActive"
  | "archiveAll"
  | "resurrectAndFanOut"
  | "archiveAndFanOut"  // recruiter drags back to SHORTLISTED from an active outreach stage — start over
  | "syncConnected"     // manual forward-sync: mark thread phase CONNECTED so rollup agrees
  | "syncMessaged"      // manual forward-sync: set lastMessageAt so rollup sees MESSAGED
  | "syncReplied";      // manual forward-sync: mark thread REPLIED + pause siblings

export type Transition =
  | { kind: "allow"; effect: ThreadEffect; setManualStage: CandidateStage | null }
  | { kind: "refuse"; reason: string };

export function evaluateTransition(from: CandidateStage, to: CandidateStage): Transition {
  if (from === to) {
    return {
      kind: "allow",
      effect: "none",
      setManualStage: MANUAL_WINS.has(to) ? to : null,
    };
  }

  // Within the system-derived chain, only allow forward moves (manual sync for
  // webhook lag — Unipile polls invite acceptance up to 8 h late). Backward
  // moves are refused: the rollup would revert them on the next tick anyway,
  // confusing the recruiter. Each forward effect also patches the underlying
  // ChannelThread so the rollup agrees and won't snap back.
  const SD_ORDER: CandidateStage[] = [
    CandidateStage.CONTACT_REQUESTED,
    CandidateStage.CONNECTED,
    CandidateStage.MESSAGED,
    CandidateStage.REPLIED,
  ];
  if (SYSTEM_DERIVED.has(from) && SYSTEM_DERIVED.has(to)) {
    const fromIdx = SD_ORDER.indexOf(from);
    const toIdx = SD_ORDER.indexOf(to);
    if (toIdx <= fromIdx) {
      return {
        kind: "refuse",
        reason: "Cannot move backwards within automated stages — the system will update this automatically.",
      };
    }
    // Forward sync: pick the most advanced effect needed.
    let effect: ThreadEffect;
    if (to === CandidateStage.REPLIED) effect = "syncReplied";
    else if (to === CandidateStage.MESSAGED) effect = "syncMessaged";
    else effect = "syncConnected";
    return { kind: "allow", effect, setManualStage: null };
  }

  // Recruiter UI exposes columns for every stage; refusing a drag (even into
  // system-derived ones from non-system stages) breaks the kanban workflow.
  // Allow the drag, write the recruiter's intent in `stage`, skip thread
  // side-effects for system-derived targets, and let the rollup reconcile.

  let effect: ThreadEffect = "none";

  if (to === CandidateStage.INTERVIEW || to === CandidateStage.HIRED) {
    effect = "pauseActive";
  } else if (to === CandidateStage.REJECTED || to === CandidateStage.ARCHIVED) {
    effect = "archiveAll";
  } else if (to === CandidateStage.SOURCED) {
    if (
      from === CandidateStage.SHORTLISTED ||
      SYSTEM_DERIVED.has(from) ||
      from === CandidateStage.INTERVIEW ||
      from === CandidateStage.HIRED ||
      from === CandidateStage.REJECTED
    ) {
      effect = "archiveOpen";
    }
  } else if (to === CandidateStage.SHORTLISTED) {
    if (from === CandidateStage.SOURCED) {
      effect = "fanOut";
    } else if (SYSTEM_DERIVED.has(from)) {
      // Recruiter is explicitly resetting a candidate mid-outreach back to
      // SHORTLISTED. This is a "start over" signal — the previous invite/DM
      // sequence is abandoned. Archive all live threads so fan-out creates
      // fresh ones (potentially on a new account if the channel pool changed).
      effect = "archiveAndFanOut";
    } else if (
      from === CandidateStage.ARCHIVED ||
      from === CandidateStage.REJECTED ||
      from === CandidateStage.HIRED ||
      from === CandidateStage.INTERVIEW
    ) {
      effect = "resurrectAndFanOut";
    }
  } else if (SYSTEM_DERIVED.has(to)) {
    // Cross-category forward drag into a system-derived stage (e.g., SOURCED →
    // CONNECTED, SHORTLISTED → CONNECTED, INTERVIEW → MESSAGED). This covers:
    //   • Recruiter marks someone connected because channels aren't active.
    //   • Recruiter knows the invite was accepted (Unipile webhook lag up to 8h).
    //   • Recruiter manually advances when the automation has stalled.
    //
    // Apply the same sync effects as the within-SD forward-move path so that
    // any existing ACTIVE/PENDING/PAUSED threads are updated to match the
    // intended stage. The rollup then agrees on the next tick instead of
    // snapping the stage back to what the stale threads indicate.
    //
    // If there are no threads (channels not configured / paused), the sync
    // effects are no-ops and the rollup's no-threads path leaves task.stage
    // at the value we're writing here.
    if (to === CandidateStage.REPLIED) effect = "syncReplied";
    else if (to === CandidateStage.MESSAGED) effect = "syncMessaged";
    else if (to === CandidateStage.CONNECTED) effect = "syncConnected";
    // CONTACT_REQUESTED: no standard sync effect — leave threads as-is.
  }

  return {
    kind: "allow",
    effect,
    setManualStage: MANUAL_WINS.has(to) ? to : null,
  };
}

export type ApplyTransitionInput = {
  taskId: string;
  toStage: CandidateStage;
  reason?: string | null;
  /** Optional optimistic-concurrency check. ISO string of the last-known stageUpdatedAt. */
  expectedStageUpdatedAt?: string | null;
};

export type ApplyTransitionResult =
  | {
      ok: true;
      task: { id: string; stage: CandidateStage; manualStage: CandidateStage | null; stageUpdatedAt: Date; jobId: string | null };
      effect: ThreadEffect;
    }
  | { ok: false; kind: "not_found" }
  | { ok: false; kind: "concurrency_conflict"; currentStage: CandidateStage; currentStageUpdatedAt: string }
  | { ok: false; kind: "transition_refused"; reason: string }
  | { ok: false; kind: "internal"; error: string };

export async function applyStageTransition(input: ApplyTransitionInput): Promise<ApplyTransitionResult> {
  const { taskId, toStage, reason, expectedStageUpdatedAt } = input;

  try {
    const existing = await prisma.task.findUnique({
      where: { id: taskId },
      select: { stage: true, jobId: true, stageUpdatedAt: true, candidateName: true },
    });
    if (!existing) {
      return { ok: false, kind: "not_found" };
    }

    if (expectedStageUpdatedAt) {
      const currentIso = existing.stageUpdatedAt.toISOString();
      if (expectedStageUpdatedAt !== currentIso) {
        return {
          ok: false,
          kind: "concurrency_conflict",
          currentStage: existing.stage,
          currentStageUpdatedAt: currentIso,
        };
      }
    }

    const transition = evaluateTransition(existing.stage, toStage);
    if (transition.kind === "refuse") {
      return { ok: false, kind: "transition_refused", reason: transition.reason };
    }

    const manualStageWrite =
      transition.setManualStage !== null
        ? { manualStage: transition.setManualStage }
        : { manualStage: null };

    const now = new Date();
    const fromStage = existing.stage;

    const updated = await prisma.$transaction(async (tx) => {
      // Suppress the task_stage_audit trigger — we write our own richer
      // StageEvent inside this transaction.
      await tx.$executeRaw`SELECT set_config('app.stage_event_explicit', 'true', true)`;

      const t = await tx.task.update({
        where: { id: taskId },
        data: {
          stage: toStage,
          ...manualStageWrite,
          stageUpdatedAt: now,
        },
        select: { id: true, stage: true, manualStage: true, stageUpdatedAt: true, jobId: true },
      });

      await tx.stageEvent.create({
        data: {
          taskId,
          fromStage,
          toStage,
          actor: "USER",
          reason: reason ?? null,
        },
      });

      switch (transition.effect) {
        case "none":
          break;
        case "archiveOpen":
          await tx.channelThread.updateMany({
            where: { taskId, status: { in: ["PENDING", "ACTIVE"] } },
            data: {
              status: "ARCHIVED",
              archivedAt: now,
              archivedReason: `Recruiter unshortlisted to ${toStage}`,
              nextActionAt: null,
            },
          });
          break;
        case "pauseActive":
          await tx.channelThread.updateMany({
            where: { taskId, status: { in: ["PENDING", "ACTIVE"] } },
            data: { status: "PAUSED", nextActionAt: null },
          });
          break;
        case "archiveAll":
          await tx.channelThread.updateMany({
            where: { taskId, status: { not: "ARCHIVED" } },
            data: {
              status: "ARCHIVED",
              archivedAt: now,
              archivedReason: `Recruiter set stage to ${toStage}`,
              nextActionAt: null,
            },
          });
          break;
        case "resurrectAndFanOut":
          await tx.channelThread.updateMany({
            where: { taskId, status: "ARCHIVED" },
            data: {
              status: "PENDING",
              archivedAt: null,
              archivedReason: null,
              nextActionAt: now,
              pendingSendKey: null,
              pendingSendStartedAt: null,
            },
          });
          await tx.channelThread.updateMany({
            where: { taskId, status: "PAUSED" },
            data: { status: "ACTIVE", nextActionAt: now },
          });
          break;
        case "archiveAndFanOut":
          // Archive every live thread — recruiter is starting this candidate
          // over from scratch. Fan-out (below) will create fresh threads, which
          // will pick the current account pool (may differ from the old threads).
          await tx.channelThread.updateMany({
            where: { taskId, status: { in: ["PENDING", "ACTIVE", "PAUSED"] } },
            data: {
              status: "ARCHIVED",
              archivedAt: now,
              archivedReason: "manual_reset",
              nextActionAt: null,
              pendingSendKey: null,
              pendingSendStartedAt: null,
            },
          });
          break;
        case "syncConnected":
          // Recruiter manually synced ahead of webhook. Update providerState so
          // the rollup derives CONNECTED on its next tick. Set nextActionAt=now
          // so the worker picks up the thread and sends the first DM — without
          // this, the thread sits idle (nextActionAt was the invite timeout, far
          // in the future) and no providerChatId is ever created, which means
          // future reply webhooks can't match the thread.
          // PAUSED threads are included: a sibling reply may have paused this
          // thread, but the recruiter's explicit forward drag overrides that.
          await tx.channelThread.updateMany({
            where: { taskId, status: { in: ["ACTIVE", "PENDING", "PAUSED"] } },
            data: {
              status: "ACTIVE",
              providerState: { phase: "CONNECTED" },
              lastMessageAt: null,
              nextActionAt: now,
            },
          });
          break;
        case "syncMessaged":
          // Set lastMessageAt so the rollup sees MESSAGED. Also nudge the worker
          // so any follow-up scheduling re-evaluates against the new timestamp.
          // PAUSED threads included for the same reason as syncConnected above.
          await tx.channelThread.updateMany({
            where: { taskId, status: { in: ["ACTIVE", "PENDING", "PAUSED"] } },
            data: {
              status: "ACTIVE",
              providerState: { phase: "MESSAGED" },
              lastMessageAt: now,
              nextActionAt: now,
            },
          });
          break;
        case "syncReplied":
          // Mark active thread(s) as REPLIED; pause any remaining PENDING ones.
          // Mirrors what the webhook-driven path does via sibling-pause in recomputeTaskStage.
          await tx.channelThread.updateMany({
            where: { taskId, status: "ACTIVE" },
            data: { status: "REPLIED" },
          });
          await tx.channelThread.updateMany({
            where: { taskId, status: "PENDING" },
            data: { status: "PAUSED", nextActionAt: null },
          });
          break;
        case "fanOut":
          // Run outside the transaction (below) — fanOutToChannels has its
          // own queries that wouldn't share this tx client.
          break;
      }

      return t;
    });

    if (
      (transition.effect === "fanOut" || transition.effect === "resurrectAndFanOut" || transition.effect === "archiveAndFanOut") &&
      updated.jobId
    ) {
      fanOutToChannels(taskId, updated.jobId).catch(err =>
        console.error("[applyStageTransition] fanOut failed:", err),
      );
    }

    const cLabel = existing.candidateName ?? `taskId:${taskId.slice(-8)}`;
    console.log(`[StageTransition] "${cLabel}" ${fromStage} → ${toStage} (taskId=${taskId} effect=${transition.effect} actor=USER)`);

    return { ok: true, task: updated, effect: transition.effect };
  } catch (err: any) {
    console.error("[applyStageTransition] failed:", err);
    return { ok: false, kind: "internal", error: err?.message ?? "Unknown error" };
  }
}
