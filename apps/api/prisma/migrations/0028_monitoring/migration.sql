-- v0.29.0 Lighthouse: monitoring, alerts, maintenance windows, notification
-- policy, software inventory and change history, ClientSt0r alert events.

-- AlterEnum
ALTER TYPE "ActivityAction" ADD VALUE 'MONITOR_RULE_CHANGED';
ALTER TYPE "ActivityAction" ADD VALUE 'MONITOR_SUPPRESSION_CHANGED';
ALTER TYPE "ActivityAction" ADD VALUE 'MONITOR_NOTIFY_POLICY_CHANGED';
ALTER TYPE "ActivityAction" ADD VALUE 'MONITOR_ALERT_ACKNOWLEDGED';
ALTER TYPE "ActivityAction" ADD VALUE 'MONITOR_ALERT_RESOLVED';
ALTER TYPE "ActivityAction" ADD VALUE 'MONITOR_ALERT_TICKET_LINKED';

-- CreateEnum
CREATE TYPE "MonitorKind" AS ENUM ('OFFLINE', 'DISK_FREE', 'CPU_HIGH', 'MEMORY_HIGH', 'SERVICE_STOPPED', 'EVENT_MATCH', 'REBOOT_PENDING');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "AlertState" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');

-- AlterTable
ALTER TABLE "EndpointInventory" ADD COLUMN     "monitorReport" JSONB,
ADD COLUMN     "monitorReportedAt" TIMESTAMP(3),
ADD COLUMN     "software" JSONB,
ADD COLUMN     "softwareCount" INTEGER;

-- AlterTable
ALTER TABLE "IntegrationOrgMapping" ADD COLUMN     "lastAlertSequence" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "MonitorRule" (
    "id" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "customerId" TEXT,
    "siteId" TEXT,
    "endpointId" TEXT,
    "key" TEXT NOT NULL,
    "kind" "MonitorKind" NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "severity" "AlertSeverity" NOT NULL DEFAULT 'WARNING',
    "params" JSONB NOT NULL,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MonitorRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonitorAlert" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "customerId" TEXT,
    "siteId" TEXT,
    "endpointId" TEXT,
    "ruleId" TEXT,
    "ruleKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "dedupKey" TEXT NOT NULL,
    "severity" "AlertSeverity" NOT NULL,
    "state" "AlertState" NOT NULL DEFAULT 'OPEN',
    "title" TEXT NOT NULL,
    "detail" JSONB NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "notifyFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "nextCheckAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "escalationLevel" INTEGER NOT NULL DEFAULT 0,
    "lastNotifiedAt" TIMESTAMP(3),
    "suppressed" BOOLEAN NOT NULL DEFAULT false,
    "suppressionId" TEXT,
    "parentId" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "resolveNote" TEXT,
    "ticketPeerId" TEXT,
    "ticketId" TEXT,
    "ticketUrl" TEXT,
    "ticketLinkedAt" TIMESTAMP(3),

    CONSTRAINT "MonitorAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonitorAlertEvent" (
    "id" TEXT NOT NULL,
    "alertId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "actorId" TEXT,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MonitorAlertEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonitorSuppression" (
    "id" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "customerId" TEXT,
    "siteId" TEXT,
    "endpointId" TEXT,
    "ruleKeys" TEXT[],
    "reason" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,

    CONSTRAINT "MonitorSuppression_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonitorNotifyPolicy" (
    "id" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "customerId" TEXT,
    "levels" JSONB NOT NULL,
    "ticketing" JSONB NOT NULL,
    "updatedById" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MonitorNotifyPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EndpointMonitorState" (
    "endpointId" TEXT NOT NULL,
    "ruleKey" TEXT NOT NULL,
    "breachCount" INTEGER NOT NULL DEFAULT 0,
    "okCount" INTEGER NOT NULL DEFAULT 0,
    "breachSince" TIMESTAMP(3),
    "checkedAt" TEXT,
    "lastMatchAt" TIMESTAMP(3),
    "lastValue" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EndpointMonitorState_pkey" PRIMARY KEY ("endpointId","ruleKey")
);

-- CreateTable
CREATE TABLE "EndpointChange" (
    "id" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "customerId" TEXT,
    "category" TEXT NOT NULL,
    "change" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "before" TEXT,
    "after" TEXT,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EndpointChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationAlertEvent" (
    "id" TEXT NOT NULL,
    "peerId" TEXT NOT NULL,
    "externalOrgId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "alertId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "body" JSONB NOT NULL,
    "signature" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveryAttempts" INTEGER NOT NULL DEFAULT 0,
    "nextDeliveryAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ackedAt" TIMESTAMP(3),
    "lastDeliveryError" TEXT,

    CONSTRAINT "IntegrationAlertEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MonitorRule_customerId_idx" ON "MonitorRule"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "MonitorRule_scopeKey_key_key" ON "MonitorRule"("scopeKey", "key");

-- CreateIndex
CREATE INDEX "MonitorAlert_customerId_state_idx" ON "MonitorAlert"("customerId", "state");

-- CreateIndex
CREATE INDEX "MonitorAlert_endpointId_state_idx" ON "MonitorAlert"("endpointId", "state");

-- CreateIndex
CREATE INDEX "MonitorAlert_siteId_kind_state_idx" ON "MonitorAlert"("siteId", "kind", "state");

-- CreateIndex
CREATE INDEX "MonitorAlert_state_nextCheckAt_idx" ON "MonitorAlert"("state", "nextCheckAt");

-- CreateIndex
CREATE INDEX "MonitorAlert_dedupKey_idx" ON "MonitorAlert"("dedupKey");

-- CreateIndex
CREATE INDEX "MonitorAlertEvent_alertId_createdAt_idx" ON "MonitorAlertEvent"("alertId", "createdAt");

-- CreateIndex
CREATE INDEX "MonitorSuppression_customerId_endsAt_idx" ON "MonitorSuppression"("customerId", "endsAt");

-- CreateIndex
CREATE INDEX "MonitorSuppression_endsAt_idx" ON "MonitorSuppression"("endsAt");

-- CreateIndex
CREATE UNIQUE INDEX "MonitorNotifyPolicy_scopeKey_key" ON "MonitorNotifyPolicy"("scopeKey");

-- CreateIndex
CREATE INDEX "EndpointChange_endpointId_detectedAt_idx" ON "EndpointChange"("endpointId", "detectedAt");

-- CreateIndex
CREATE INDEX "EndpointChange_customerId_detectedAt_idx" ON "EndpointChange"("customerId", "detectedAt");

-- CreateIndex
CREATE INDEX "IntegrationAlertEvent_ackedAt_nextDeliveryAt_idx" ON "IntegrationAlertEvent"("ackedAt", "nextDeliveryAt");

-- CreateIndex
CREATE INDEX "IntegrationAlertEvent_alertId_idx" ON "IntegrationAlertEvent"("alertId");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationAlertEvent_peerId_externalOrgId_sequence_key" ON "IntegrationAlertEvent"("peerId", "externalOrgId", "sequence");

-- AddForeignKey
ALTER TABLE "MonitorRule" ADD CONSTRAINT "MonitorRule_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonitorRule" ADD CONSTRAINT "MonitorRule_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonitorRule" ADD CONSTRAINT "MonitorRule_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonitorAlert" ADD CONSTRAINT "MonitorAlert_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonitorAlert" ADD CONSTRAINT "MonitorAlert_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonitorAlert" ADD CONSTRAINT "MonitorAlert_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonitorAlert" ADD CONSTRAINT "MonitorAlert_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "MonitorAlert"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonitorAlertEvent" ADD CONSTRAINT "MonitorAlertEvent_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "MonitorAlert"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonitorSuppression" ADD CONSTRAINT "MonitorSuppression_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonitorSuppression" ADD CONSTRAINT "MonitorSuppression_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EndpointMonitorState" ADD CONSTRAINT "EndpointMonitorState_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EndpointChange" ADD CONSTRAINT "EndpointChange_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Deduplication: at most one alert per dedupKey that is not RESOLVED. A repeat
-- of an open problem bumps `occurrences` on the existing row; two evaluators
-- racing to raise the same alert lose on this index rather than both winning.
CREATE UNIQUE INDEX "MonitorAlert_dedup_open" ON "MonitorAlert"("dedupKey") WHERE "state" <> 'RESOLVED';
