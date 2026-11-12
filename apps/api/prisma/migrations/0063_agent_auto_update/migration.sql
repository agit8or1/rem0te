-- v0.36: automatic agent self-update. When a computer's agent is older than
-- what this server serves, the heartbeat asks it to re-run its update path —
-- inside the business's policy, paced across the fleet, a bounded number of
-- times. See apps/api/src/agent-auto-update/schedule.ts.

-- Per policy (business, site override or device group): any time (paced),
-- only inside that policy's window, or off. Null inherits from the next
-- policy that applies; a business row's null is the platform default.
CREATE TYPE "AgentAutoUpdateMode" AS ENUM ('ANY_TIME', 'WINDOW', 'OFF');
ALTER TABLE "ClientUpdatePolicy" ADD COLUMN "agentMode" "AgentAutoUpdateMode";

-- Platform-wide: the switch, the pace (attempts started per hour across the
-- whole fleet) and the attempts one computer gets at one target.
ALTER TABLE "PlatformSettings"
    ADD COLUMN "agentAutoUpdateEnabled" BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN "agentAutoUpdatePerHour" INTEGER NOT NULL DEFAULT 120,
    ADD COLUMN "agentAutoUpdateMaxAttempts" INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "PlatformSettings" ADD CONSTRAINT "PlatformSettings_agent_auto_update_bounds" CHECK (
    "agentAutoUpdatePerHour" BETWEEN 1 AND 2000 AND "agentAutoUpdateMaxAttempts" BETWEEN 1 AND 10
);

-- Per computer: the target being pursued, attempts at it, the last one.
ALTER TABLE "RustdeskNode"
    ADD COLUMN "agentAutoTarget" TEXT,
    ADD COLUMN "agentAutoAttempts" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "agentAutoLastAt" TIMESTAMP(3);
ALTER TABLE "RustdeskNode" ADD CONSTRAINT "RustdeskNode_agent_auto_attempts" CHECK ("agentAutoAttempts" BETWEEN 0 AND 10);

-- The system-initiated update history, and the global pacing count.
CREATE TABLE "AgentAutoUpdateAttempt" (
    "id" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "tenantId" TEXT,
    "customerId" TEXT,
    "channel" TEXT NOT NULL,
    "fromVersion" TEXT,
    "targetVersion" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "dispatchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "outcome" TEXT,
    "resolvedAt" TIMESTAMP(3),
    CONSTRAINT "AgentAutoUpdateAttempt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AgentAutoUpdateAttempt_channel" CHECK ("channel" IN ('standard', 'standard_pre015', 'signed')),
    CONSTRAINT "AgentAutoUpdateAttempt_outcome" CHECK ("outcome" IS NULL OR "outcome" IN ('updated', 'superseded')),
    CONSTRAINT "AgentAutoUpdateAttempt_attempt" CHECK ("attempt" BETWEEN 1 AND 10)
);
CREATE INDEX "AgentAutoUpdateAttempt_dispatchedAt_idx" ON "AgentAutoUpdateAttempt"("dispatchedAt");
CREATE INDEX "AgentAutoUpdateAttempt_endpointId_dispatchedAt_idx" ON "AgentAutoUpdateAttempt"("endpointId", "dispatchedAt");
ALTER TABLE "AgentAutoUpdateAttempt" ADD CONSTRAINT "AgentAutoUpdateAttempt_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Changing the platform-wide settings is audited, before and after.
ALTER TYPE "ActivityAction" ADD VALUE 'AGENT_AUTO_UPDATE_SETTINGS_CHANGED';
