import type { DuplicateKind } from "@prisma/client";

export type DuplicatePairInput = {
  requisitionId: string;
  taskAId: string;
  taskBId: string;
  kind: DuplicateKind;
  matchValue: string;
};

// Canonical ordering: taskAId < taskBId lexicographically.
// Enforced at the DB level by the CHECK constraint added in
// 20260601000002_duplicate_pair_ordering. Centralising this here keeps
// every call site aligned and prevents the "(A,B) and (B,A) coexist"
// failure mode that the constraint exists to rule out.
export function orderedPair(
  requisitionId: string,
  taskId1: string,
  taskId2: string,
  kind: DuplicateKind,
  matchValue: string,
): DuplicatePairInput {
  const [a, b] = taskId1 < taskId2 ? [taskId1, taskId2] : [taskId2, taskId1];
  return { requisitionId, taskAId: a, taskBId: b, kind, matchValue };
}
