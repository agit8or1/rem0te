-- v0.37: automatic migration to the signed agent, canary first. Once a signed
-- agent is published, standard Windows agents are moved to it by the portal's
-- own sweep: one computer first (the canary), the rest only after it has
-- reported the published build for the soak. Every move is an ordinary 0.34
-- per-computer AgentMigration (the same nonce flow and script), made with no
-- requester. See apps/api/src/agent-auto-migration/rollout.ts.

-- Platform-wide: the mode and the soak.
ALTER TABLE "PlatformSettings"
    ADD COLUMN "agentAutoMigrationMode" TEXT NOT NULL DEFAULT 'canary_then_all',
    ADD COLUMN "agentAutoMigrationSoakMinutes" INTEGER NOT NULL DEFAULT 60;
ALTER TABLE "PlatformSettings" ADD CONSTRAINT "PlatformSettings_agent_auto_migration" CHECK (
    "agentAutoMigrationMode" IN ('off', 'canary_then_all') AND "agentAutoMigrationSoakMinutes" BETWEEN 15 AND 1440
);

-- Which per-computer requests the automatic migration made. A person's
-- request is never automatic; an automatic one names no person and belongs to
-- a rollout.
ALTER TABLE "AgentMigration"
    ADD COLUMN "automatic" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "rolloutId" TEXT;
ALTER TABLE "AgentMigration" ADD CONSTRAINT "AgentMigration_automatic_shape" CHECK (
    ("automatic" AND "requestedById" IS NULL AND "rolloutId" IS NOT NULL) OR (NOT "automatic" AND "rolloutId" IS NULL)
);
CREATE INDEX "AgentMigration_rolloutId_requestedAt_idx" ON "AgentMigration"("rolloutId", "requestedAt");

-- One rollout per published signed agent build.
CREATE TABLE "AgentAutoMigration" (
    "id" TEXT NOT NULL,
    "targetSha256" TEXT NOT NULL,
    "targetVersion" TEXT,
    "targetCommit" TEXT,
    "state" TEXT NOT NULL DEFAULT 'choosing_canary',
    "canaryEndpointId" TEXT,
    "canaryMigrationId" TEXT,
    "canaryRequestedAt" TIMESTAMP(3),
    "canaryConfirmedAt" TIMESTAMP(3),
    "rejectedCanaryIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "rollingAt" TIMESTAMP(3),
    "haltedAt" TIMESTAMP(3),
    "haltCode" TEXT,
    "haltReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AgentAutoMigration_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AgentAutoMigration_sha" CHECK ("targetSha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "AgentAutoMigration_state" CHECK ("state" IN ('choosing_canary', 'canary', 'soaking', 'rolling', 'halted')),
    -- Rolling only ever follows a canary that was confirmed.
    CONSTRAINT "AgentAutoMigration_rolling_needs_canary" CHECK ("state" <> 'rolling' OR ("canaryConfirmedAt" IS NOT NULL AND "rollingAt" IS NOT NULL)),
    CONSTRAINT "AgentAutoMigration_halted_has_reason" CHECK ("state" <> 'halted' OR ("haltCode" IS NOT NULL AND "haltReason" IS NOT NULL))
);
CREATE UNIQUE INDEX "AgentAutoMigration_targetSha256_key" ON "AgentAutoMigration"("targetSha256");

-- The rollout's own steps are audited (system actor); the per-computer
-- requests are history rows (AgentMigration.automatic), not audit entries.
ALTER TYPE "ActivityAction" ADD VALUE 'AGENT_AUTO_MIGRATION_SETTINGS_CHANGED';
ALTER TYPE "ActivityAction" ADD VALUE 'AGENT_AUTO_MIGRATION_CANARY_CHOSEN';
ALTER TYPE "ActivityAction" ADD VALUE 'AGENT_AUTO_MIGRATION_CANARY_CONFIRMED';
ALTER TYPE "ActivityAction" ADD VALUE 'AGENT_AUTO_MIGRATION_ROLLING';
ALTER TYPE "ActivityAction" ADD VALUE 'AGENT_AUTO_MIGRATION_HALTED';
ALTER TYPE "ActivityAction" ADD VALUE 'AGENT_AUTO_MIGRATION_RESUMED';
ALTER TYPE "ActivityAction" ADD VALUE 'AGENT_AUTO_MIGRATION_RESTARTED';
