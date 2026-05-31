-- Enforce at most one default AiProvider, mirroring the partial unique
-- indexes already in place for PromptTemplate and EvaluationConfig
-- (see 20260503000002_unique_default_template). Prisma's schema syntax
-- can't express partial unique indexes; apply via raw SQL.
--
-- The route at app/api/ai-providers/route.ts already does an
-- updateMany(isDefault=false) before promoting a new default, but that
-- pair of writes is not atomic — a concurrent promote could leave two
-- rows with isDefault=true. The partial unique index makes the race
-- visible (second writer gets a constraint error) instead of silently
-- producing non-deterministic defaults.

-- Demote any duplicate defaults that already exist (keep most-recently-updated).
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY "updatedAt" DESC) AS rn
  FROM "AiProvider"
  WHERE "isDefault" = true
)
UPDATE "AiProvider" SET "isDefault" = false
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

CREATE UNIQUE INDEX IF NOT EXISTS "AiProvider_unique_default"
  ON "AiProvider" ("isDefault") WHERE "isDefault" = true;
