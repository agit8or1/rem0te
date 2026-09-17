-- Operator-requested agent reinstall.
--
-- The existing RustDesk staging (updateRequestedAt/updateTargetVersion) is
-- driven by a version comparison: requestRustdeskUpdate skips any endpoint
-- already on the latest client. That is correct for its own purpose and wrong
-- as a way to upgrade the *agent*, which only changes when the installer
-- re-runs — so a machine on the current RustDesk client could not be given a
-- newer agent at all, and the only route was running the installer by hand on
-- each box.
--
-- Nullable, no defaults: additive and safe on a live database.
ALTER TABLE "RustdeskNode" ADD COLUMN IF NOT EXISTS "reinstallRequestedAt" TIMESTAMP(3);
ALTER TABLE "RustdeskNode" ADD COLUMN IF NOT EXISTS "reinstallRequestedBy" TEXT;
ALTER TABLE "RustdeskNode" ADD COLUMN IF NOT EXISTS "reinstallDispatchedAt" TIMESTAMP(3);

-- Requesting a reinstall re-runs an installer as SYSTEM on someone's machine,
-- so it is an audited action in its own right.
ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'ENDPOINT_AGENT_REINSTALL_REQUESTED';
