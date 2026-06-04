-- AddTable: CandidateFile
-- Purpose: per-candidate recruiter-uploaded attachments (resumes, portfolios, etc.)
-- Stored in S3 under candidate-attachments/{taskId}/{uuid}_{name}; storageKey is
-- server-side only and never sent to the browser directly.
-- Non-blocking: new table only, no ALTER on existing large tables.
-- Recovery: if run in error, DROP TABLE "CandidateFile" — no data loss elsewhere.

CREATE TABLE "CandidateFile" (
    "id"         TEXT         NOT NULL,
    "taskId"     TEXT         NOT NULL,
    "fileName"   TEXT         NOT NULL,
    "mimeType"   TEXT         NOT NULL,
    "storageKey" TEXT         NOT NULL,
    "fileSize"   INTEGER      NOT NULL,
    "uploadedBy" TEXT         NOT NULL DEFAULT '',
    "deletedAt"  TIMESTAMP(3),
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CandidateFile_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CandidateFile_taskId_createdAt_idx" ON "CandidateFile"("taskId", "createdAt");
CREATE INDEX "CandidateFile_taskId_deletedAt_idx" ON "CandidateFile"("taskId", "deletedAt");

ALTER TABLE "CandidateFile"
    ADD CONSTRAINT "CandidateFile_taskId_fkey"
    FOREIGN KEY ("taskId") REFERENCES "Task"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
