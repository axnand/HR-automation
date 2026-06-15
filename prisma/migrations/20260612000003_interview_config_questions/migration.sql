-- Phase 2 — global interview question baseline.
--
-- Adds two columns to InterviewConfig, the org-wide singleton (1 row, introduced
-- in Phase 3). InterviewConfig is a tiny isolated table with no in-flight worker
-- contention (the outreach worker touches ChannelThread, not this table), so a
-- single-shot ADD COLUMN ... NOT NULL DEFAULT is non-blocking per CLAUDE.md schema
-- rule #1 (nullable-first applies to Task and ChannelThread; small isolated tables
-- can take the default directly).
--
-- If this migration ran 1000× in error: idempotent in effect (additive DDL);
-- a re-run fails fast on "already exists" without data loss.

ALTER TABLE "InterviewConfig"
    ADD COLUMN "globalQuestions" JSONB NOT NULL DEFAULT '[]',
    ADD COLUMN "defaultAgentName" TEXT NOT NULL DEFAULT 'HR-Recruiter-Agent';
