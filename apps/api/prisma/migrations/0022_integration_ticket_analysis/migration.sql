-- v0.22.0: ticket ↔ RMM integration, contract ticket-rmm-v1 (read-only ticket
-- analysis). Peer keys and URLs are deliberately NOT stored here; see
-- INTEGRATION_PEERS_FILE and docs/integration-clientst0r.md.

ALTER TYPE "ActivityAction" ADD VALUE 'INTEGRATION_JOB_ACCEPTED';
ALTER TYPE "ActivityAction" ADD VALUE 'INTEGRATION_JOB_REJECTED';
ALTER TYPE "ActivityAction" ADD VALUE 'INTEGRATION_JOB_FINISHED';
ALTER TYPE "ActivityAction" ADD VALUE 'INTEGRATION_MAPPING_CHANGED';

CREATE TYPE "IntegrationJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'EXPIRED');

CREATE TABLE "IntegrationOrgMapping" (
    "id" TEXT NOT NULL,
    "peerId" TEXT NOT NULL,
    "externalOrgId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    CONSTRAINT "IntegrationOrgMapping_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "IntegrationOrgMapping_peerId_externalOrgId_key" ON "IntegrationOrgMapping"("peerId", "externalOrgId");
CREATE UNIQUE INDEX "IntegrationOrgMapping_peerId_customerId_key" ON "IntegrationOrgMapping"("peerId", "customerId");
CREATE INDEX "IntegrationOrgMapping_customerId_idx" ON "IntegrationOrgMapping"("customerId");

CREATE TABLE "IntegrationTechnicianMapping" (
    "id" TEXT NOT NULL,
    "peerId" TEXT NOT NULL,
    "externalOrgId" TEXT NOT NULL,
    "externalTechnicianId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    CONSTRAINT "IntegrationTechnicianMapping_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "IntegrationTechnicianMapping_peerId_externalOrgId_externalT_key" ON "IntegrationTechnicianMapping"("peerId", "externalOrgId", "externalTechnicianId");
CREATE INDEX "IntegrationTechnicianMapping_userId_idx" ON "IntegrationTechnicianMapping"("userId");

CREATE TABLE "IntegrationJob" (
    "id" TEXT NOT NULL,
    "peerId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "externalOrgId" TEXT NOT NULL,
    "externalTechnicianId" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "ticketRevision" INTEGER NOT NULL,
    "endpointId" TEXT,
    "modelProfiles" TEXT[],
    "correlationId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "payloadSha256" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "status" "IntegrationJobStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "result" JSONB,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "lastEventSequence" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "IntegrationJob_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "IntegrationJob_peerId_idempotencyKey_key" ON "IntegrationJob"("peerId", "idempotencyKey");
CREATE INDEX "IntegrationJob_status_nextAttemptAt_idx" ON "IntegrationJob"("status", "nextAttemptAt");
CREATE INDEX "IntegrationJob_customerId_createdAt_idx" ON "IntegrationJob"("customerId", "createdAt");

CREATE TABLE "IntegrationJobRun" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "modelProfile" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "requestId" TEXT,
    "resolvedModel" TEXT,
    "output" JSONB,
    "usage" JSONB,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "latencyMs" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "IntegrationJobRun_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "IntegrationJobRun_jobId_modelProfile_key" ON "IntegrationJobRun"("jobId", "modelProfile");
ALTER TABLE "IntegrationJobRun" ADD CONSTRAINT "IntegrationJobRun_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "IntegrationJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "IntegrationEvent" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "peerId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "body" JSONB NOT NULL,
    "signature" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveryAttempts" INTEGER NOT NULL DEFAULT 0,
    "nextDeliveryAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ackedAt" TIMESTAMP(3),
    "lastDeliveryError" TEXT,
    CONSTRAINT "IntegrationEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "IntegrationEvent_jobId_sequence_key" ON "IntegrationEvent"("jobId", "sequence");
CREATE INDEX "IntegrationEvent_ackedAt_nextDeliveryAt_idx" ON "IntegrationEvent"("ackedAt", "nextDeliveryAt");
ALTER TABLE "IntegrationEvent" ADD CONSTRAINT "IntegrationEvent_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "IntegrationJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "IntegrationReplayGuard" (
    "key" TEXT NOT NULL,
    "jobId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "IntegrationReplayGuard_pkey" PRIMARY KEY ("key")
);
CREATE INDEX "IntegrationReplayGuard_expiresAt_idx" ON "IntegrationReplayGuard"("expiresAt");
