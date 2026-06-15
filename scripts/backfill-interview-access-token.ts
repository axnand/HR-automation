/**
 * Backfill InterviewSession.accessToken for rows created before the column
 * existed (migration 20260612000002_phase3_interview_delivery). The capability
 * token is the candidate URL segment (/interview/<accessToken>); new rows get
 * one at creation time, this fills the Phase-1 legacy rows.
 *
 * Safe to re-run — only touches rows where accessToken IS NULL. Processes in
 * 500-row batches with a short sleep between batches to avoid contention, per
 * CLAUDE.md schema-migration rule #2. Idempotent.
 *
 * Run this AFTER applying the migration and BEFORE relying on accessToken-based
 * links for old sessions. (Optional in practice — only matters if you reuse a
 * pre-Phase-3 session; the standalone route can fall back during the window.)
 *
 * Usage:  npx tsx scripts/backfill-interview-access-token.ts
 */
import { prisma } from "@/lib/prisma";
import { newInterviewAccessToken } from "@/lib/interview/access-token";

const BATCH_SIZE = 500;
const SLEEP_MS = 100;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  let totalUpdated = 0;
  let batch = 0;

  console.log("Starting InterviewSession.accessToken backfill...");

  while (true) {
    const rows = await prisma.interviewSession.findMany({
      where: { accessToken: null },
      select: { id: true },
      take: BATCH_SIZE,
      orderBy: { id: "asc" },
    });

    if (rows.length === 0) break;

    // One update per row — each token must be distinct, so no bulk updateMany.
    // Volume is tiny (Phase-1 test sessions), so the per-row cost is irrelevant.
    for (const r of rows) {
      await prisma.interviewSession.update({
        where: { id: r.id },
        data: { accessToken: newInterviewAccessToken() },
      });
    }
    totalUpdated += rows.length;

    batch++;
    console.log(`Batch ${batch}: updated ${rows.length} (total: ${totalUpdated})`);

    if (rows.length < BATCH_SIZE) break;
    await sleep(SLEEP_MS);
  }

  console.log(`Done. Total rows updated: ${totalUpdated}`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
