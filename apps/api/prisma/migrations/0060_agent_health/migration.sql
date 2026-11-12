-- v0.36: agent health.

-- An opt-in monitor for a computer RustDesk still reaches whose agent has
-- stopped checking in (apps/api/src/monitoring/engine.ts, AGENT_SILENT).
ALTER TYPE "MonitorKind" ADD VALUE 'AGENT_SILENT';

-- The policy that queued an automatic client update, so the sweep can tell
-- when the computer has moved to another policy or out of every enabled one
-- (left a device group, a site override removed, ...). No foreign key: the
-- record must outlive the policy it names.
ALTER TABLE "RustdeskNode" ADD COLUMN "updatePolicyId" TEXT;

ALTER TYPE "ActivityAction" ADD VALUE 'CLIENT_UPDATE_AUTO_WITHDRAWN';
ALTER TYPE "ActivityAction" ADD VALUE 'CLIENT_UPDATE_AUTO_REPLANNED';
