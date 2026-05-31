-- Fill in the timestamp gaps flagged in the schema audit.
--
-- CandidateContact had neither createdAt nor updatedAt — the worst
-- offender per the audit, because enrichment providers do overwrite
-- email/phone values and there was previously no way to tell when.
--
-- Job had createdAt but no updatedAt, despite mutating counters
-- (processedCount, successCount, failedCount, status).
--
-- Both tables are small enough that single-shot ADD COLUMN NOT NULL
-- DEFAULT CURRENT_TIMESTAMP is safe (Postgres 11+ stores the default as
-- metadata and does not rewrite the table). The CLAUDE.md rule that
-- forbids single-shot only applies to Task / ChannelThread.

ALTER TABLE "CandidateContact"
  ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "Job"
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
