-- v0.46: automatic agent updates per computer. Null inherits the computer's
-- client-update policies (device group > site > business > the platform
-- default, which is on); 'on' or 'off' overrides every policy for this one
-- computer. The platform switch (PlatformSettings.agentAutoUpdateEnabled) and
-- AGENT_AUTO_UPDATE=off still win over both. See
-- apps/api/src/agent-auto-update/schedule.ts, resolveMode.
ALTER TABLE "Endpoint" ADD COLUMN "agentAutoUpdate" TEXT;
ALTER TABLE "Endpoint" ADD CONSTRAINT "Endpoint_agent_auto_update" CHECK ("agentAutoUpdate" IS NULL OR "agentAutoUpdate" IN ('on', 'off'));

-- Changing it is audited, before and after.
ALTER TYPE "ActivityAction" ADD VALUE 'AGENT_AUTO_UPDATE_COMPUTER_SET';
