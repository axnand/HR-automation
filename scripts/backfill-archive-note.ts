/**
 * Backfill Task.archiveNote from StageEvent.reason for tasks already in
 * REJECTED or ARCHIVED stage that have a USER-set reason in StageEvent.
 * Safe to re-run: only updates rows where archiveNote IS NULL.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  let cursor: string | undefined;
  let total = 0;

  while (true) {
    const events = await prisma.stageEvent.findMany({
      take: 500,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      where: {
        actor: "USER",
        toStage: { in: ["REJECTED", "ARCHIVED"] },
        reason: { not: null },
        task: { archiveNote: null },
      },
      select: {
        id: true,
        taskId: true,
        reason: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    });

    if (events.length === 0) break;
    cursor = events[events.length - 1].id;

    // Keep only the latest reason per task (in case of multiple moves)
    const latest = new Map<string, string>();
    for (const e of events) {
      if (e.reason) latest.set(e.taskId, e.reason);
    }

    for (const [taskId, reason] of latest) {
      await prisma.task.updateMany({
        where: { id: taskId, archiveNote: null },
        data: { archiveNote: reason },
      });
      total++;
    }

    console.log(`Backfilled ${total} tasks so far…`);
    await new Promise(r => setTimeout(r, 100));
  }

  console.log(`Done. Total backfilled: ${total}`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
