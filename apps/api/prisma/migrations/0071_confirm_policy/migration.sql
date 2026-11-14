-- v0.49: Settings → Confirm it is you. Which functions ask a signed-in
-- person to confirm it is them again (the step-up: password, authenticator
-- code or passkey), per function, set by a Platform Admin.
--
-- The functions are a closed catalog in
-- apps/api/src/security-controls/confirm-catalog.ts. A row exists only for a
-- function that has been set; every function defaults to 'ask', and a row
-- whose key the catalog does not name is ignored (it asks). The always-ask
-- functions (own passkeys, a protected-device exception, turning a
-- confirmation off) are never written: ConfirmPolicyService refuses them.
--
-- This replaces two settings, so there is one source of truth:
--   PlatformSettings.routineConfirm (0069, 0.47) — 'off' let seven everyday
--     functions skip the confirmation. Where it is 'off', those seven become
--     'off' rows here; everything else asks. 0069 set it to 'off' only on an
--     installation already in use (it had users), so a fresh database — every
--     e2e suite's — has 'every' and gets no rows: it asks for everything.
--   PlatformSettings.stepUpActions (0.20) — the subset of six StepUpService
--     actions that asked. Nothing in the API or console wrote it after the
--     migrations that added it; it was all six on every installation unless
--     edited in the database. Any of the five configurable ones missing from
--     it becomes an 'off' row, so the behaviour does not change. The sixth,
--     passkey.manage, is always-ask from 0.49 whatever it said.
-- Both columns are then dropped. These INSERTs are the one change to the
-- policy that is not audited (CONFIRM_POLICY_CHANGED); the 0.49 changelog
-- records them.

ALTER TYPE "ActivityAction" ADD VALUE 'CONFIRM_POLICY_CHANGED';

CREATE TABLE "ConfirmPolicy" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConfirmPolicy_pkey" PRIMARY KEY ("key")
);
ALTER TABLE "ConfirmPolicy" ADD CONSTRAINT "ConfirmPolicy_value" CHECK ("value" IN ('ask', 'off'));
ALTER TABLE "ConfirmPolicy" ADD CONSTRAINT "ConfirmPolicy_key_charset" CHECK ("key" ~ '^[a-z][a-z.]{1,63}$');

-- The seven 0.47 everyday functions, where routineConfirm was 'off'.
INSERT INTO "ConfirmPolicy" ("key", "value", "updatedAt")
SELECT k, 'off', CURRENT_TIMESTAMP
FROM unnest(ARRAY[
  'actions.direct', 'scripts.direct', 'software.catalog', 'agent.migrate',
  'agent.autoupdate.computer', 'agent.autoupdate.business', 'patching.policy'
]) AS k
WHERE EXISTS (SELECT 1 FROM "PlatformSettings" WHERE "id" = 'singleton' AND "routineConfirm" = 'off');

-- The configurable StepUpService actions that stepUpActions had turned off.
INSERT INTO "ConfirmPolicy" ("key", "value", "updatedAt")
SELECT k, 'off', CURRENT_TIMESTAMP
FROM unnest(ARRAY[
  'credential.reveal', 'permissions.change', 'technicians.manage', 'sso.configure', 'platform.configure'
]) AS k
WHERE EXISTS (SELECT 1 FROM "PlatformSettings" WHERE "id" = 'singleton' AND NOT (k = ANY ("stepUpActions")))
ON CONFLICT ("key") DO NOTHING;

ALTER TABLE "PlatformSettings" DROP CONSTRAINT "PlatformSettings_routine_confirm";
ALTER TABLE "PlatformSettings" DROP COLUMN "routineConfirm";
ALTER TABLE "PlatformSettings" DROP COLUMN "stepUpActions";
