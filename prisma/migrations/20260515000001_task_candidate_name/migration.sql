-- Add denormalized candidateName column to Task for cheap log labels.
-- Nullable so failed scrapes (no profile data) are not excluded.
-- No default, no NOT NULL — a plain ADD COLUMN is non-blocking on all
-- Postgres versions and safe under live worker traffic.
ALTER TABLE "Task" ADD COLUMN "candidateName" TEXT;
