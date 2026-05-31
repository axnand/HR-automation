/**
 * Backfill ChannelThread.updatedAt with createdAt for rows added before
 * the column existed (migration 20260601000003).
 *
 * Safe to re-run — only touches rows where updatedAt IS NULL. Runs in
 * 500-row batches with a short sleep between batches to avoid contention
 * with the live worker, per CLAUDE.md schema-migration rule #2.
 *
 * After this completes on prod, ship the follow-up migration that adds
 *   DEFAULT CURRENT_TIMESTAMP
 *   ALTER COLUMN updatedAt SET NOT NULL
 * and switch the Prisma schema from `DateTime?` to `DateTime`.
 *
 * Usage:  npx tsx scripts/backfill-channel-thread-updated-at.ts
 */
import { prisma } from "@/lib/prisma";

const BATCH_SIZE = 500;
const SLEEP_MS = 100;

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  let totalUpdated = 0;
  let batch = 0;

  console.log("Starting ChannelThread.updatedAt backfill...");

  while (true) {
    const rows = await prisma.channelThread.findMany({
      where: { updatedAt: null },
      select: { id: true, createdAt: true },
      take: BATCH_SIZE,
      orderBy: { id: "asc" },
    });

    if (rows.length === 0) break;

    await Promise.all(
      rows.map(r =>
        prisma.channelThread.update({
          where: { id: r.id },
          data: { updatedAt: r.createdAt },
        }),
      ),
    );
    totalUpdated += rows.length;

    batch++;
    console.log(`Batch ${batch}: updated ${rows.length} (total: ${totalUpdated})`);

    if (rows.length < BATCH_SIZE) break;
    await sleep(SLEEP_MS);
  }

  console.log(`Done. Total rows updated: ${totalUpdated}`);
  await prisma.$disconnect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
