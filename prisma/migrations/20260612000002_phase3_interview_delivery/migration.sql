-- Phase 3 — interview link delivery. See docs/interview-flow.md §6 / Phase 3.
--
-- Purely additive and non-blocking (CLAUDE.md schema conventions):
--   • New enum + a brand-new singleton table (InterviewConfig) — isolated.
--   • Four NULLable columns on InterviewSession, a small isolated table with no
--     in-flight worker contention (the outreach worker ticks ChannelThread, not
--     this table). No locks on Task or ChannelThread.
--   • accessToken is a NULLable UNIQUE column. Postgres treats NULLs as distinct
--     in unique indexes, so pre-existing rows (NULL token) are unaffected until
--     scripts/backfill-interview-access-token.ts populates them — chunked,
--     idempotent, off the hot path (schema rule #2). New rows get a token at
--     creation, so the backfill only touches Phase-1 rows.
--   • If this migration ran 1000× in error: it is idempotent in effect (additive
--     DDL); a re-run fails fast on "already exists" without data loss.

-- CreateEnum
CREATE TYPE "InterviewSentVia" AS ENUM ('LINKEDIN', 'EMAIL', 'WHATSAPP', 'LINK_ONLY');

-- AlterTable (all NULLable — no rewrite, no default backfill)
ALTER TABLE "InterviewSession"
    ADD COLUMN "sentVia" "InterviewSentVia",
    ADD COLUMN "accessToken" TEXT,
    ADD COLUMN "expiresAt" TIMESTAMP(3),
    ADD COLUMN "sentAt" TIMESTAMP(3);

-- CreateIndex (NULLable unique — multiple NULLs allowed; existing rows unaffected)
CREATE UNIQUE INDEX "InterviewSession_accessToken_key" ON "InterviewSession"("accessToken");

-- CreateTable
CREATE TABLE "InterviewConfig" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "defaultMessageTemplate" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InterviewConfig_pkey" PRIMARY KEY ("id")
);
