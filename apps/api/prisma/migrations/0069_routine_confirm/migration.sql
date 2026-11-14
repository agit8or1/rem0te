-- v0.46.1: whether everyday changes ask the person to confirm it is them
-- again (the step-up dialog) on top of their signed-in session.
--   'off'   — no extra confirmation: signing in (with its MFA) is enough.
--   'every' — a confirmation lasting 10 minutes, as 0.40–0.46 always asked.
-- "Everyday" is a fixed list in security-controls/review.ts (ROUTINE_ACTIONS):
-- direct-mode requests, software catalog writes, upgrading a computer to the
-- full agent, per-computer and per-business automatic agent updates, and
-- patch policies. Security settings, credentials, permissions, API keys,
-- passkeys, containment, notifications and the fleet-wide switches always ask.
-- A new installation asks (the default 'every'). An installation already in
-- use (it has user accounts when this runs) is switched to 'off': on the only
-- one there is, the owner asked for the confirmation to stop on everyday
-- changes. A fresh database has a settings row from earlier migrations but no
-- users until it is seeded, so it keeps 'every'. A Platform
-- Admin changes it under Settings → General; that change is audited
-- (ROUTINE_CONFIRM_CHANGED). This UPDATE is the one change that is not, and
-- the 0.46.1 changelog records it.
ALTER TABLE "PlatformSettings" ADD COLUMN "routineConfirm" TEXT NOT NULL DEFAULT 'every';
UPDATE "PlatformSettings" SET "routineConfirm" = 'off' WHERE EXISTS (SELECT 1 FROM "User");
ALTER TABLE "PlatformSettings" ADD CONSTRAINT "PlatformSettings_routine_confirm" CHECK ("routineConfirm" IN ('off', 'every'));

ALTER TYPE "ActivityAction" ADD VALUE 'ROUTINE_CONFIRM_CHANGED';
