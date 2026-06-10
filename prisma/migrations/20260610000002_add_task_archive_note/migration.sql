-- AddColumn Task.archiveNote
-- Nullable text field set by the recruiter when moving a candidate to
-- REJECTED or ARCHIVED. Stored on the task so the archive list can display
-- it without joining StageEvent. Safe to add without a backfill — NULL means
-- "no reason given" and the UI renders nothing for those rows.
ALTER TABLE "Task" ADD COLUMN "archiveNote" TEXT;
