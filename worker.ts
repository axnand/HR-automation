import { startBoss, stopBoss, getBoss } from "@/lib/queue";
import { handleLinkedInJobs, handleResumeJobs } from "@/lib/workers/task-handlers";
import { runOutreachTick } from "@/lib/channels/outreach-tick";
import { runInterviewTranscriptTick } from "@/lib/interview/transcript-tick";

async function main() {
  console.log("[Worker] Starting...");

  const boss = await startBoss();

  // localConcurrency is capped to stay within Supabase PgBouncer Session-mode limits.
  // pg-boss pool=3 + 3 LinkedIn + 2 resume = 8 total connections (pool_size ≤ 15 on free tier).
  await boss.work<{ taskId: string }>(
    "process-task",
    { localConcurrency: 3, includeMetadata: true },
    handleLinkedInJobs as any
  );

  await boss.work<{ taskId: string }>(
    "process-resume-task",
    { localConcurrency: 2, includeMetadata: true },
    handleResumeJobs as any
  );

  console.log("[Worker] Ready. Listening for jobs...");

  // ── Outreach tick: process due ChannelThreads every 30s ─────────────────────
  // Runs in-process so it doesn't depend on NEXT_PUBLIC_APP_URL or external cron.
  // Reentrancy-safe: skip if a previous tick is still running.
  let tickRunning = false;
  setInterval(async () => {
    if (tickRunning) return;
    tickRunning = true;
    try {
      await runOutreachTick();
    } catch (err: any) {
      console.error("[Worker] Outreach tick error:", err.message);
    } finally {
      tickRunning = false;
    }
  }, 30_000);

  // ── Interview transcript tick: poll SCAI for completed calls every 60s ───────
  // Advisory-locked in runInterviewTranscriptTick — safe across worker + cron.
  let transcriptTickRunning = false;
  setInterval(async () => {
    if (transcriptTickRunning) return;
    transcriptTickRunning = true;
    try {
      await runInterviewTranscriptTick();
    } catch (err: any) {
      console.error("[Worker] Interview transcript tick error:", err.message);
    } finally {
      transcriptTickRunning = false;
    }
  }, 60_000);

  // Log queue depth every 60 seconds
  setInterval(async () => {
    try {
      const b = getBoss();
      const [li, resume] = await Promise.all([
        b.getQueueStats("process-task").catch(() => null),
        b.getQueueStats("process-resume-task").catch(() => null),
      ]);
      console.log(
        `[Worker] process-task: queued=${li?.queuedCount ?? "?"} active=${li?.activeCount ?? "?"} | ` +
        `process-resume-task: queued=${resume?.queuedCount ?? "?"} active=${resume?.activeCount ?? "?"}`
      );
    } catch { /* non-fatal */ }
  }, 60_000);

  const shutdown = async (signal: string) => {
    console.log(`[Worker] ${signal} received — shutting down gracefully...`);
    await stopBoss();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Keep process alive
  await new Promise(() => {});
}

main().catch((err) => {
  console.error("[Worker] Fatal error:", err);
  process.exit(1);
});
