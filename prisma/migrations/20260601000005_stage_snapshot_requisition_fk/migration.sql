-- Make StageSnapshot.requisitionId a real FK instead of a free-floating
-- string that can dangle once a Requisition is hard-deleted.
--
-- Semantics: ON DELETE SET NULL. Snapshots are an append-only audit
-- artefact for anomaly detection (P1 #34 / EC-12.5) — we want them to
-- survive the deletion of the requisition they referenced, but we also
-- want the dangling-id case to be NULL rather than a string pointing at
-- nothing. This preserves history without lying about referential
-- integrity.
--
-- Step 1: NULL out any rows already pointing at a non-existent requisition
--         (must happen before adding the FK, or the constraint creation fails).
UPDATE "StageSnapshot" s
SET "requisitionId" = NULL
WHERE "requisitionId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "Requisition" r WHERE r.id = s."requisitionId"
  );

-- Step 2: add the FK. NOT VALID + VALIDATE keeps the ACCESS EXCLUSIVE lock
--         window tiny; the row check is then done concurrently.
ALTER TABLE "StageSnapshot"
  ADD CONSTRAINT "StageSnapshot_requisitionId_fkey"
  FOREIGN KEY ("requisitionId") REFERENCES "Requisition"("id")
  ON DELETE SET NULL ON UPDATE CASCADE
  NOT VALID;

ALTER TABLE "StageSnapshot" VALIDATE CONSTRAINT "StageSnapshot_requisitionId_fkey";
