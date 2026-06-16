-- Convert User.role from enum to plain TEXT so new roles can be added
-- from the UI without schema migrations.
--
-- ALTER TYPE USING cast: Postgres allows ALTER COLUMN ... TYPE TEXT USING
-- col::TEXT, which is non-blocking for small tables and preserves the
-- existing 'ADMIN' / 'RECRUITER' / 'VIEWER' values verbatim.
--
-- Recovery: if run in error the column is already TEXT with the same values
-- — safe to re-run (idempotent in effect).

ALTER TABLE "User"
  ALTER COLUMN "role" TYPE TEXT USING "role"::TEXT,
  ALTER COLUMN "role" SET DEFAULT 'RECRUITER';

DROP TYPE IF EXISTS "UserRole";
