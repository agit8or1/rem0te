-- v0.55: alert conditions and automatic PSA tickets.
--
-- Four monitor kinds read from what the server already stores (no agent
-- change): every fixed drive's free space from the inventory pass, uptime
-- from the live sample, security/critical updates outstanding from the signed
-- agent's patch scan, and failed update installs from Windows Update's
-- history and Rem0te's own deployment results
-- (apps/api/src/monitoring/engine.ts).
ALTER TYPE "MonitorKind" ADD VALUE 'DRIVE_FREE';
ALTER TYPE "MonitorKind" ADD VALUE 'UPTIME_LONG';
ALTER TYPE "MonitorKind" ADD VALUE 'UPDATES_MISSING';
ALTER TYPE "MonitorKind" ADD VALUE 'UPDATE_FAILED';

ALTER TYPE "ActivityAction" ADD VALUE 'PSA_AUTO_TICKET_REQUESTED';
ALTER TYPE "ActivityAction" ADD VALUE 'MONITOR_TICKET_POLICY_CHANGED';

-- "Create a ticket in the PSA when an alert of at least this severity opens."
-- One row per scope: the platform default ('global') or one business's.
CREATE TABLE "MonitorTicketPolicy" (
    "id" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "customerId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "minSeverity" "AlertSeverity" NOT NULL DEFAULT 'CRITICAL',
    "kinds" TEXT[],
    "enabledAt" TIMESTAMP(3),
    "updatedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MonitorTicketPolicy_pkey" PRIMARY KEY ("id"),
    -- The two scopes only, and the business column agrees with the key.
    CONSTRAINT "MonitorTicketPolicy_scope" CHECK (
        ("scopeKey" = 'global' AND "customerId" IS NULL)
        OR ("customerId" IS NOT NULL AND "scopeKey" = 'b:' || "customerId")
    ),
    -- A switched-on rule always says since when, so the backlog is never ticketed.
    CONSTRAINT "MonitorTicketPolicy_enabledAt" CHECK (NOT "enabled" OR "enabledAt" IS NOT NULL),
    -- Only monitor kinds a computer alert can have (a site outage has no computer to ticket).
    CONSTRAINT "MonitorTicketPolicy_kinds" CHECK (
        "kinds" IS NULL OR "kinds" <@ ARRAY['OFFLINE', 'DISK_FREE', 'CPU_HIGH', 'MEMORY_HIGH', 'SERVICE_STOPPED', 'EVENT_MATCH', 'REBOOT_PENDING', 'AGENT_SILENT', 'DRIVE_FREE', 'UPTIME_LONG', 'UPDATES_MISSING', 'UPDATE_FAILED']::TEXT[]
    )
);

CREATE UNIQUE INDEX "MonitorTicketPolicy_scopeKey_key" ON "MonitorTicketPolicy"("scopeKey");
ALTER TABLE "MonitorTicketPolicy" ADD CONSTRAINT "MonitorTicketPolicy_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One automatic ticket per alert, at most: the unique alertId is the claim.
CREATE TABLE "MonitorAlertTicket" (
    "id" TEXT NOT NULL,
    "alertId" TEXT NOT NULL,
    "customerId" TEXT,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL,
    "lastAttemptAt" TIMESTAMP(3) NOT NULL,
    "nextAttemptAt" TIMESTAMP(3),
    "lastStatus" TEXT,
    "connectorKind" TEXT,
    "connectorScope" TEXT,
    "psaTicketId" TEXT,
    "ref" TEXT,
    "url" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MonitorAlertTicket_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MonitorAlertTicket_status" CHECK ("status" IN ('sending', 'sent', 'failed', 'gave_up')),
    -- AUTO_TICKET.maxAttempts is 4; the database refuses a fifth whatever the code says.
    CONSTRAINT "MonitorAlertTicket_attempts" CHECK ("attempts" BETWEEN 1 AND 4),
    -- A retry time only on a failed row.
    CONSTRAINT "MonitorAlertTicket_retry" CHECK ("nextAttemptAt" IS NULL OR "status" = 'failed')
);

CREATE UNIQUE INDEX "MonitorAlertTicket_alertId_key" ON "MonitorAlertTicket"("alertId");
CREATE INDEX "MonitorAlertTicket_status_nextAttemptAt_idx" ON "MonitorAlertTicket"("status", "nextAttemptAt");
CREATE INDEX "MonitorAlertTicket_customerId_lastAttemptAt_idx" ON "MonitorAlertTicket"("customerId", "lastAttemptAt");
ALTER TABLE "MonitorAlertTicket" ADD CONSTRAINT "MonitorAlertTicket_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "MonitorAlert"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MonitorAlertTicket" ADD CONSTRAINT "MonitorAlertTicket_psaTicketId_fkey" FOREIGN KEY ("psaTicketId") REFERENCES "PsaTicket"("id") ON DELETE SET NULL ON UPDATE CASCADE;
