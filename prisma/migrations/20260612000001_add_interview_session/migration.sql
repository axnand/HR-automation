-- AI interview session backbone (Phase 1). See docs/interview-flow.md.
--
-- Brand-new table + enum — non-destructive, no backfill, no locks on Task or
-- ChannelThread (CLAUDE.md migration conventions satisfied: creating an
-- isolated table cannot stall in-flight outreach). The only FK is
-- InterviewSession → Task (ON DELETE CASCADE); it adds no constraint to the
-- Task table itself beyond the standard referenced-key, so no rewrite of Task.

-- CreateEnum
CREATE TYPE "InterviewSessionStatus" AS ENUM ('PENDING', 'SENT', 'IN_PROGRESS', 'COMPLETED', 'ANALYZED', 'EXPIRED', 'FAILED');

-- CreateTable
CREATE TABLE "InterviewSession" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "callId" TEXT,
    "status" "InterviewSessionStatus" NOT NULL DEFAULT 'PENDING',
    "questionsSnapshot" JSONB,
    "transcript" JSONB,
    "analysis" JSONB,
    "score" DOUBLE PRECISION,
    "recommendation" TEXT,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InterviewSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InterviewSession_roomId_key" ON "InterviewSession"("roomId");

-- CreateIndex
CREATE INDEX "InterviewSession_taskId_idx" ON "InterviewSession"("taskId");

-- CreateIndex
CREATE INDEX "InterviewSession_status_idx" ON "InterviewSession"("status");

-- AddForeignKey
ALTER TABLE "InterviewSession" ADD CONSTRAINT "InterviewSession_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
