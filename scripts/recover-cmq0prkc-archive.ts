/**
 * One-shot recovery: undo the spurious `account_changed` mass-archive that hit
 * every live LinkedIn thread on JD-CMQ0PRKC at 2026-06-08 10:33.
 *
 * Root cause: PATCH /channels/[channelId] treats ANY request containing
 * `sendingAccountId` as an account change (it never loads/compares the old
 * value) and archives all live threads. A no-op channel save nuked the pipeline.
 *
 * This script restores each affected task to the EXACT stage it held immediately
 * before the archive — read from the authoritative audit trail (the
 * StageEvent whose toStage = ARCHIVED, reason = "All channel threads exhausted
 * or timed out"). No Unipile calls, so there is no external error surface.
 *
 * Per task:
 *   1. Restore its single ChannelThread: ARCHIVED → ACTIVE, clear archive
 *      fields, set providerState.phase consistent with the target stage, and
 *      FREEZE it (nextActionAt = null) so no outreach fires until the API bug
 *      is fixed and re-engagement is decided.
 *   2. recomputeTaskStage() re-derives task.stage (CLAUDE.md: never raw
 *      UPDATE Task SET stage).
 *
 * Idempotent: only touches tasks currently at ARCHIVED whose archive was the
 * account_changed incident. Safe to re-run.
 *
 * Dry-run:  npx tsx scripts/recover-cmq0prkc-archive.ts
 * Apply:    npx tsx scripts/recover-cmq0prkc-archive.ts --apply
 */

import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { recomputeTaskStage } from "@/lib/channels/stage-rollup";

const REQUISITION_ID = "cmq0prkcc000012nsx8cmnx0o";
const INCIDENT_REASON = "account_changed";
const APPLY = process.argv.includes("--apply");

// Target stage (from the archive audit event) → thread providerState.phase
const PHASE_FOR_STAGE: Record<string, string> = {
  CONNECTED: "CONNECTED",
  CONTACT_REQUESTED: "INVITE_PENDING",
  MESSAGED: "MESSAGED",
  REPLIED: "MESSAGED", // replied implies a chat exists; lastInboundAt drives REPLIED
};

async function main() {
  // Pull every ARCHIVED task on this requisition whose single thread was
  // archived by the incident, together with the pre-archive stage.
  const rows = await prisma.$queryRaw<Array<{
    task_id: string;
    name: string | null;
    prior_stage: string;
    thread_id: string;
    phase: string | null;
    has_msg: boolean;
  }>>`
    SELECT t.id                                   AS task_id,
           t."candidateName"                      AS name,
           se."fromStage"                         AS prior_stage,
           ct.id                                  AS thread_id,
           ct."providerState"->>'phase'           AS phase,
           (ct."lastMessageAt" IS NOT NULL)       AS has_msg
    FROM "Task" t
    JOIN "Job" j ON t."jobId" = j.id
    JOIN LATERAL (
      SELECT "fromStage"
      FROM "StageEvent"
      WHERE "taskId" = t.id AND "toStage" = 'ARCHIVED'
      ORDER BY "createdAt" DESC
      LIMIT 1
    ) se ON true
    JOIN "ChannelThread" ct
      ON ct."taskId" = t.id
     AND ct.status = 'ARCHIVED'
     AND ct."archivedReason" = ${INCIDENT_REASON}
    WHERE j."requisitionId" = ${REQUISITION_ID}
      AND t.stage = 'ARCHIVED'
      AND t."manualStage" IS NULL          -- never override a recruiter decision
      AND t."deletedAt" IS NULL
    ORDER BY se."fromStage", t."candidateName"`;

  console.log(`\n${APPLY ? "APPLY" : "DRY-RUN"} — ${rows.length} archived tasks to recover\n`);

  const byStage: Record<string, number> = {};
  for (const r of rows) byStage[r.prior_stage] = (byStage[r.prior_stage] ?? 0) + 1;
  console.log("Target stages:", byStage, "\n");

  const results: Array<{ name: string; target: string; final: string; ok: boolean }> = [];

  for (const r of rows) {
    const name = r.name ?? r.task_id.slice(-8);
    const target = r.prior_stage;
    const phase = PHASE_FOR_STAGE[target];

    if (!phase) {
      console.warn(`  [SKIP] ${name} — no phase mapping for prior stage ${target}`);
      continue;
    }

    if (!APPLY) {
      console.log(`  ${target.padEnd(17)} ← ${name}  (thread ${r.thread_id.slice(-6)}: ${r.phase ?? "?"} → ${phase}, ACTIVE, frozen)`);
      continue;
    }

    // 1. Un-archive + normalize the thread so the rollup derives `target`.
    await prisma.channelThread.update({
      where: { id: r.thread_id },
      data: {
        status: "ACTIVE",
        archivedAt: null,
        archivedReason: null,
        providerState: { phase },
        nextActionAt: null, // FROZEN — no outreach until re-armed
        pendingSendKey: null,
        pendingSendStartedAt: null,
      },
    });

    // 2. Re-derive the stage through the rollup (never raw UPDATE).
    const res = await recomputeTaskStage(r.task_id, { source: "SYSTEM" });
    const ok = res.stage === target;
    results.push({ name, target, final: res.stage, ok });
    console.log(`  ${ok ? "✓" : "✗"} ${name.padEnd(28)} ${target} → got ${res.stage}`);
  }

  if (APPLY) {
    const good = results.filter(r => r.ok).length;
    const bad = results.filter(r => !r.ok);
    console.log(`\n════════ Recovery complete: ${good}/${results.length} restored ════════`);
    if (bad.length) {
      console.log("MISMATCHES (need manual review):");
      for (const b of bad) console.log(`  ${b.name}: wanted ${b.target}, got ${b.final}`);
    }
    console.log("Threads are FROZEN (nextActionAt = null) — no outreach will fire.\n");
  } else {
    console.log("\nDry-run only. Re-run with --apply to execute.\n");
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
