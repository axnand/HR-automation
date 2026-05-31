-- Add updatedAt to ChannelThread.
--
-- CLAUDE.md rule #1: "Adding a column — NULL-able first" — and explicitly
-- calls out Task and ChannelThread as tables that must NOT take the
-- single-shot ADD COLUMN NOT NULL DEFAULT path. So:
--
--   1. This migration:           ADD COLUMN nullable, no default.
--   2. scripts/backfill-channel-thread-updated-at.ts: chunked backfill
--      (500/batch, idempotent) setting updatedAt = createdAt.
--   3. Follow-up migration:      SET DEFAULT CURRENT_TIMESTAMP + NOT NULL
--      once the backfill is verified complete.
--
-- The Prisma schema declares the column as `DateTime? @updatedAt` for the
-- duration of this two-phase rollout. Prisma will populate it on every
-- update; old rows that the backfill missed will stay NULL but won't break
-- readers (the field is optional in the generated types).

ALTER TABLE "ChannelThread" ADD COLUMN "updatedAt" TIMESTAMP(3);
