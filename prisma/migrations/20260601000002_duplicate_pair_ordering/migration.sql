-- Prevent inverse pair duplication on DuplicatePair.
--
-- @@unique([taskAId, taskBId]) blocks exact repeats but does nothing
-- against (A, B) and (B, A) coexisting as two separate rows. The two
-- existing write sites (app/api/requisitions/[requisitionId]/upload-profiles
-- and .../runs) currently always insert newer-id-first by construction,
-- but the schema does not enforce that. A future code path inserting
-- (older, newer) would silently double-up the duplicates UI.
--
-- Fix: canonicalize so taskAId < taskBId for all rows, then add a CHECK
-- constraint so future writers can't violate it without a constraint error.
--
-- Step 1: collapse any pair that already exists in both orderings — keep
--         the row whose A < B (canonical), delete the other.
DELETE FROM "DuplicatePair" d
USING "DuplicatePair" e
WHERE d."taskAId" > d."taskBId"
  AND e."taskAId" = d."taskBId"
  AND e."taskBId" = d."taskAId"
  AND e."taskAId" < e."taskBId";

-- Step 2: swap A/B for any remaining misordered rows so the invariant holds.
UPDATE "DuplicatePair"
SET "taskAId" = "taskBId", "taskBId" = "taskAId"
WHERE "taskAId" > "taskBId";

-- Step 3: enforce going forward. NOT VALID skips re-checking the whole
--         table (already validated above by the cleanup), and the
--         subsequent VALIDATE confirms cheaply.
ALTER TABLE "DuplicatePair"
  ADD CONSTRAINT "DuplicatePair_ordered_ids" CHECK ("taskAId" < "taskBId") NOT VALID;

ALTER TABLE "DuplicatePair" VALIDATE CONSTRAINT "DuplicatePair_ordered_ids";
