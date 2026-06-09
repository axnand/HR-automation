/**
 * One-off: set replyWaitDays = 7 on the Talent Acquisition Head LinkedIn channel.
 *
 * The channel had no replyWaitDays, so it was relying on the code default (5).
 * This persists an explicit 7-day reply window (visible in the channel editor)
 * for the ~23 pending candidates and all future ones on this role.
 *
 * Validates the new config through validateLinkedInConfig (the same check the
 * PATCH endpoint runs) before writing. Idempotent: no-op if already set to 7.
 *
 * Run: npx tsx scripts/set-ta-head-reply-wait.ts
 */
import { prisma } from "@/lib/prisma";
import { validateLinkedInConfig } from "@/lib/channels/types";

const REQUISITION_ID = "cmq0prkcc000012nsx8cmnx0o"; // Talent Acquisition Head
const REPLY_WAIT_DAYS = 7;

async function main() {
  const channel = await prisma.channel.findFirst({
    where: { requisitionId: REQUISITION_ID, type: "LINKEDIN" },
    select: { id: true, name: true, config: true },
  });

  if (!channel) {
    console.error("No LINKEDIN channel found for requisition", REQUISITION_ID);
    process.exit(1);
  }

  const config = { ...(channel.config as Record<string, unknown>) };
  if (config.replyWaitDays === REPLY_WAIT_DAYS) {
    console.log(`No-op: "${channel.name}" already has replyWaitDays=${REPLY_WAIT_DAYS}`);
    return;
  }

  const prev = config.replyWaitDays ?? "(unset → code default 5)";
  config.replyWaitDays = REPLY_WAIT_DAYS;

  const check = validateLinkedInConfig(config);
  if (!check.ok) {
    console.error("Refusing to write — config failed validation:", check.error);
    process.exit(1);
  }

  await prisma.channel.update({
    where: { id: channel.id },
    data: { config: config as object },
  });

  console.log(`Updated "${channel.name}" (${channel.id}): replyWaitDays ${prev} → ${REPLY_WAIT_DAYS}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
