-- Add REJECTION to OutreachType enum for auto-sent candidate notification messages.
-- Purpose: distinguishes recruiter-triggered rejection/archive notifications from
-- regular outreach (FOLLOWUP). Audit queries can filter by type to report on
-- how many candidates were formally notified vs. just silently archived.
-- Latency: ALTER TYPE ADD VALUE is non-blocking in Postgres — no table rewrite,
-- no lock on ThreadMessage. Safe to run while the worker is live.
-- Rollback: deploy old code first (it never creates REJECTION rows), then
-- optionally rename the value to 'REJECTION_DISABLED' to soft-disable it.
ALTER TYPE "OutreachType" ADD VALUE IF NOT EXISTS 'REJECTION';
