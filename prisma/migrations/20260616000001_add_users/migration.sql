-- Add recruiter user accounts for authentication.
--
-- Purpose: powers the Auth.js Credentials provider. Passwords are bcrypt-hashed
-- at cost 12 — never stored in plaintext. role is an enum for future RBAC.
--
-- Non-blocking: brand-new isolated table, no FK on existing tables.
-- Recovery: if run in error, DROP TABLE "User"; DROP TYPE "UserRole"; — no data
-- loss elsewhere.

CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'RECRUITER', 'VIEWER');

CREATE TABLE "User" (
    "id"           TEXT        NOT NULL,
    "email"        TEXT        NOT NULL,
    "name"         TEXT,
    "passwordHash" TEXT        NOT NULL,
    "role"         "UserRole"  NOT NULL DEFAULT 'RECRUITER',
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE INDEX "User_email_idx" ON "User"("email");
