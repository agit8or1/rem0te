-- v0.66: alert classification and event fingerprints (monitoring/classify.ts).
--
-- MonitorAlert carries the classifier's decision and version, and the
-- deciding event's fingerprint (indexed: "similar alerts"). The new table
-- keeps one row per computer, event monitor and fingerprint, including the
-- events classified harmless that never became an alert, with the newest raw
-- event, so nothing the agent reported is lost when an alert is not raised.
--
-- The stored disk-errors monitor is corrected on API start, not here
-- (AlertQualityService), so the change is written to the sealed audit log.
ALTER TYPE "ActivityAction" ADD VALUE 'MONITOR_ALERT_RECLASSIFIED';

ALTER TABLE "MonitorAlert" ADD COLUMN "classification" JSONB;
ALTER TABLE "MonitorAlert" ADD COLUMN "classifierVersion" INTEGER;
ALTER TABLE "MonitorAlert" ADD COLUMN "fingerprint" TEXT;
CREATE INDEX "MonitorAlert_fingerprint_lastSeenAt_idx" ON "MonitorAlert"("fingerprint", "lastSeenAt");
ALTER TABLE "MonitorAlert" ADD CONSTRAINT "MonitorAlert_fingerprint_check" CHECK ("fingerprint" IS NULL OR "fingerprint" ~ '^[0-9a-f]{32}$');

CREATE TABLE "MonitorEventFingerprint" (
    "id" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "customerId" TEXT,
    "tenantId" TEXT,
    "ruleKey" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "log" TEXT NOT NULL,
    "provider" TEXT,
    "eventId" INTEGER,
    "level" INTEGER,
    "statusCode" TEXT,
    "component" TEXT,
    "class" TEXT NOT NULL,
    "basis" TEXT NOT NULL,
    "matched" TEXT,
    "classifierVersion" INTEGER NOT NULL,
    "sample" JSONB NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "seen" INTEGER NOT NULL DEFAULT 1,
    "lastAlertId" TEXT,

    CONSTRAINT "MonitorEventFingerprint_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MonitorEventFingerprint_fingerprint_check" CHECK ("fingerprint" ~ '^[0-9a-f]{32}$'),
    -- classify.ts ALERT_CLASSES and BASES.
    CONSTRAINT "MonitorEventFingerprint_class_check" CHECK ("class" IN ('CRITICAL', 'WARNING', 'INFORMATIONAL', 'BENIGN', 'UNKNOWN')),
    CONSTRAINT "MonitorEventFingerprint_basis_check" CHECK ("basis" IN ('known_benign', 'known_event', 'level', 'rule', 'partial', 'threshold')),
    CONSTRAINT "MonitorEventFingerprint_status_check" CHECK ("statusCode" IS NULL OR "statusCode" ~ '^0x[0-9A-F]{8}$'),
    CONSTRAINT "MonitorEventFingerprint_seen_check" CHECK ("seen" >= 1)
);

CREATE UNIQUE INDEX "MonitorEventFingerprint_endpointId_ruleKey_fingerprint_key" ON "MonitorEventFingerprint"("endpointId", "ruleKey", "fingerprint");
CREATE INDEX "MonitorEventFingerprint_fingerprint_lastSeenAt_idx" ON "MonitorEventFingerprint"("fingerprint", "lastSeenAt");
CREATE INDEX "MonitorEventFingerprint_customerId_lastSeenAt_idx" ON "MonitorEventFingerprint"("customerId", "lastSeenAt");
ALTER TABLE "MonitorEventFingerprint" ADD CONSTRAINT "MonitorEventFingerprint_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;
