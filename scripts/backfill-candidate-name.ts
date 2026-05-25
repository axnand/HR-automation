/**
 * Backfill Task.candidateName from the stored task.result JSON blob.
 *
 * Safe to re-run — only processes rows where candidateName IS NULL and
 * result IS NOT NULL. Runs in 500-row batches with a short sleep between
 * each to avoid contending with the live worker.
 *
 * Usage:  npx tsx scripts/backfill-candidate-name.ts
 */
import { prisma } from "@/lib/prisma";

const BATCH_SIZE = 500;
const SLEEP_MS = 100;

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function extractName(resultJson: string): string | null {
  try {
    const p = JSON.parse(resultJson);
    return [p.first_name, p.last_name].filter(Boolean).join(" ") || null;
  } catch {
    return null;
  }
}

async function main() {
  let cursor: string | undefined;
  let totalUpdated = 0;
  let batch = 0;

  console.log("Starting candidateName backfill...");

  while (true) {
    const rows = await prisma.task.findMany({
      where: {
        candidateName: null,
        result: { not: null },
      },
      select: { id: true, result: true },
      take: BATCH_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: "asc" },
    });

    if (rows.length === 0) break;

    cursor = rows[rows.length - 1].id;

    const updates = rows.flatMap(r => {
      const name = extractName(r.result!);
      if (!name) return [];
      return [{ id: r.id, name }];
    });

    if (updates.length > 0) {
      await Promise.all(
        updates.map(u =>
          prisma.task.update({
            where: { id: u.id },
            data: { candidateName: u.name },
          }),
        ),
      );
      totalUpdated += updates.length;
    }

    batch++;
    console.log(`Batch ${batch}: processed ${rows.length} rows, updated ${updates.length} (total updated: ${totalUpdated})`);

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
