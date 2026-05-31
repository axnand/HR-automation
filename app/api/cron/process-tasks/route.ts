import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { refreshCooldowns } from "@/lib/services/account.service";
import { CONFIG } from "@/lib/config";

export const maxDuration = 30;
export const dynamic = "force-dynamic";

/**
 * Safety-net cron — runs every 10 minutes.
 *
 * pg-boss handles task stall recovery and retries natively.
 * This cron only handles account-level cleanup and data retention.
 *
 * 1. Reset BUSY accounts that have no PROCESSING tasks (account state ≠ task state)
 * 2. Refresh expired account cooldowns
 * 3. Clean up old completed/failed jobs and tasks (48h retention)
 * 4. Clear raw profile data older than DATA_RETENTION_DAYS (if configured)
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (
    process.env.NODE_ENV === "production" &&
    process.env.CRON_SECRET &&
    authHeader !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  console.log("[Cron] Running maintenance...");

  try {
    // 1. Reset BUSY accounts with no active PROCESSING tasks
    const busyAccounts = await prisma.account.findMany({
      where: { status: "BUSY" },
      select: { id: true },
    });

    let resetAccounts = 0;
    for (const acct of busyAccounts) {
      const processingCount = await prisma.task.count({
        where: { accountId: acct.id, status: "PROCESSING" },
      });
      if (processingCount === 0) {
        await prisma.account
          .update({ where: { id: acct.id, status: "BUSY" }, data: { status: "ACTIVE" } })
          .catch(() => {});
        resetAccounts++;
      }
    }

    if (resetAccounts > 0) {
      console.log(`[Cron] Reset ${resetAccounts} orphaned BUSY accounts`);
    }

    // 1b. Recover stuck ChannelThreads. The outreach tick claims threads by
    // setting nextActionAt = NULL. If the Railway worker restarts between
    // claim and processThread() (or between API call and DB commit), the
    // thread becomes invisible to the scheduler — nothing else looks for
    // (status IN PENDING|ACTIVE, nextActionAt IS NULL). Without this
    // recovery the candidate's outreach silently stops.
    //
    // 10-minute floor on createdAt / pendingSendStartedAt avoids racing
    // with an in-flight tick (claim → processThread window is sub-second).
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
    const stuckResult = await prisma.channelThread.updateMany({
      where: {
        status: { in: ["PENDING", "ACTIVE"] },
        nextActionAt: null,
        OR: [
          // Worker crashed after claim but before reaching markPendingSend
          { pendingSendKey: null, createdAt: { lt: tenMinAgo } },
          // Worker crashed between provider API call and DB commit
          { pendingSendKey: { not: null }, pendingSendStartedAt: { lt: tenMinAgo } },
        ],
      },
      data: {
        nextActionAt: new Date(),
        pendingSendKey: null,
        pendingSendStartedAt: null,
      },
    });
    if (stuckResult.count > 0) {
      console.log(`[Cron] Recovered ${stuckResult.count} stuck ChannelThreads`);
    }

    // 2. Refresh expired cooldowns
    await refreshCooldowns();

    // 3. Auto-delete of stale jobs/tasks DISABLED — analysis data is valuable, storage is cheap.
    //    Re-enable here if a soft-delete/archival strategy is added.
    const staleJobs: { id: string }[] = [];
    const cleanedTasks = 0;

    // 4. Clear raw profiles older than DATA_RETENTION_DAYS
    let clearedProfiles = 0;
    const retentionDays = CONFIG.DATA_RETENTION_DAYS;
    if (retentionDays > 0) {
      const profileCutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
      const cleared = await prisma.candidateProfile.updateMany({
        where: { scrapedAt: { lt: profileCutoff }, rawProfile: { not: null } },
        data: { rawProfile: null },
      });
      clearedProfiles = cleared.count;
      if (clearedProfiles > 0) {
        console.log(`[Cron] Cleared rawProfile from ${clearedProfiles} old candidate records`);
      }
    }

    return NextResponse.json({
      message: "Maintenance complete",
      resetAccounts,
      recoveredThreads: stuckResult.count,
      clearedProfiles,
    });
  } catch (error) {
    console.error("[Cron] Error:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
