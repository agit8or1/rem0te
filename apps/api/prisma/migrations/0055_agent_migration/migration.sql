-- v0.34: upgrade a computer's agent from the console. A per-computer request
-- to move a standard (legacy) Windows agent onto the signed agent, and the
-- signed agent's last update check as it reports it.

ALTER TYPE "ActivityAction" ADD VALUE 'AGENT_MIGRATION_REQUESTED';
ALTER TYPE "ActivityAction" ADD VALUE 'AGENT_MIGRATION_CANCELLED';
ALTER TYPE "ActivityAction" ADD VALUE 'AGENT_MIGRATION_COMPLETED';

ALTER TABLE "Endpoint" ADD COLUMN "agentUpdateCheckedAt" TIMESTAMP(3);
ALTER TABLE "Endpoint" ADD COLUMN "agentUpdateResult" TEXT;

CREATE TABLE "AgentMigration" (
    "id" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "tenantId" TEXT,
    "customerId" TEXT,
    "nonce" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "requestedById" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatchedAt" TIMESTAMP(3),
    "lastDispatchedAt" TIMESTAMP(3),
    "dispatchCount" INTEGER NOT NULL DEFAULT 0,
    "fetchedAt" TIMESTAMP(3),
    "holdReason" TEXT,
    "holdAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    CONSTRAINT "AgentMigration_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AgentMigration_nonce_key" ON "AgentMigration"("nonce");
CREATE INDEX "AgentMigration_endpointId_requestedAt_idx" ON "AgentMigration"("endpointId", "requestedAt");
CREATE INDEX "AgentMigration_customerId_requestedAt_idx" ON "AgentMigration"("customerId", "requestedAt");

ALTER TABLE "AgentMigration" ADD CONSTRAINT "AgentMigration_endpointId_fkey"
    FOREIGN KEY ("endpointId") REFERENCES "Endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The nonce is what windows.ps1 matches; anything else is not one of ours.
ALTER TABLE "AgentMigration" ADD CONSTRAINT "AgentMigration_nonce_shape" CHECK ("nonce" ~ '^mig_[A-Za-z0-9_-]{40}$');
ALTER TABLE "AgentMigration" ADD CONSTRAINT "AgentMigration_reason_bounded" CHECK (char_length("reason") BETWEEN 3 AND 400);

-- One open request per computer: a second request while one is open would
-- hand the heartbeat two nonces for one machine.
CREATE UNIQUE INDEX "AgentMigration_one_open" ON "AgentMigration"("endpointId")
    WHERE "completedAt" IS NULL AND "cancelledAt" IS NULL;
