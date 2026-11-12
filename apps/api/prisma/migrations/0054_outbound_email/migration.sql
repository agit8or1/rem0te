-- Outbound email (0.34): an SMTP relay, verified recipients, email as an
-- alert destination, and scheduled reports.
--
-- Nothing here sends mail by itself. SmtpSettings has no row until a
-- Platform Admin saves one, and mail is off until it is enabled.

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ActivityAction" ADD VALUE 'SMTP_SETTINGS_CHANGED';
ALTER TYPE "ActivityAction" ADD VALUE 'EMAIL_TEST_SENT';
ALTER TYPE "ActivityAction" ADD VALUE 'EMAIL_RECIPIENT_ADDED';
ALTER TYPE "ActivityAction" ADD VALUE 'EMAIL_RECIPIENT_VERIFIED';
ALTER TYPE "ActivityAction" ADD VALUE 'EMAIL_RECIPIENT_REMOVED';
ALTER TYPE "ActivityAction" ADD VALUE 'REPORT_SCHEDULE_CHANGED';
ALTER TYPE "ActivityAction" ADD VALUE 'REPORT_SCHEDULE_SENT';
ALTER TYPE "ActivityAction" ADD VALUE 'REPORT_SCHEDULE_FAILED';

-- CreateTable
CREATE TABLE "SmtpSettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "tlsMode" TEXT NOT NULL,
    "username" TEXT,
    "passwordEnc" TEXT,
    "fromAddress" TEXT NOT NULL,
    "fromName" TEXT,
    "updatedById" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastTestAt" TIMESTAMP(3),
    "lastTestResult" TEXT,

    CONSTRAINT "SmtpSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailRecipient" (
    "id" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "customerId" TEXT,
    "address" TEXT NOT NULL,
    "label" TEXT,
    "tokenHash" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "lastSentAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "addedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportSchedule" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "customerId" TEXT,
    "siteId" TEXT,
    "report" TEXT NOT NULL,
    "params" JSONB NOT NULL DEFAULT '{}',
    "frequency" TEXT NOT NULL,
    "dayOfWeek" INTEGER,
    "dayOfMonth" INTEGER,
    "time" TEXT NOT NULL,
    "timeZone" TEXT NOT NULL,
    "attachCsv" BOOLEAN NOT NULL DEFAULT false,
    "recipientIds" TEXT[],
    "ownerId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "disabledReason" TEXT,
    "nextRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReportSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportDelivery" (
    "id" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "occurrenceAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "rows" INTEGER,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ReportDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmailRecipient_tokenHash_key" ON "EmailRecipient"("tokenHash");

-- CreateIndex
CREATE INDEX "EmailRecipient_customerId_idx" ON "EmailRecipient"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailRecipient_scopeKey_address_key" ON "EmailRecipient"("scopeKey", "address");

-- CreateIndex
CREATE INDEX "ReportSchedule_enabled_nextRunAt_idx" ON "ReportSchedule"("enabled", "nextRunAt");

-- CreateIndex
CREATE INDEX "ReportSchedule_customerId_idx" ON "ReportSchedule"("customerId");

-- CreateIndex
CREATE INDEX "ReportDelivery_scheduleId_createdAt_idx" ON "ReportDelivery"("scheduleId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReportDelivery_scheduleId_periodKey_key" ON "ReportDelivery"("scheduleId", "periodKey");

-- AddForeignKey
ALTER TABLE "EmailRecipient" ADD CONSTRAINT "EmailRecipient_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportSchedule" ADD CONSTRAINT "ReportSchedule_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportDelivery" ADD CONSTRAINT "ReportDelivery_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "ReportSchedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- One row only, and only the three TLS modes the code knows. "none" is
-- further limited to a loopback relay by the API (email/smtp-host.ts); the
-- database cannot see the address, so it only keeps the vocabulary closed.
ALTER TABLE "SmtpSettings" ADD CONSTRAINT "SmtpSettings_singleton" CHECK ("id" = 'singleton');
ALTER TABLE "SmtpSettings" ADD CONSTRAINT "SmtpSettings_tlsMode" CHECK ("tlsMode" IN ('implicit', 'starttls', 'none'));
ALTER TABLE "SmtpSettings" ADD CONSTRAINT "SmtpSettings_port" CHECK ("port" BETWEEN 1 AND 65535);

-- A recipient's scope is global or one business, and says which.
ALTER TABLE "EmailRecipient" ADD CONSTRAINT "EmailRecipient_scope" CHECK (
    ("scopeKey" = 'global' AND "customerId" IS NULL) OR ("scopeKey" = 'b:' || "customerId")
);

ALTER TABLE "ReportSchedule" ADD CONSTRAINT "ReportSchedule_report" CHECK ("report" IN ('patch-compliance', 'agent-coverage', 'alert-frequency', 'offline-time'));
ALTER TABLE "ReportSchedule" ADD CONSTRAINT "ReportSchedule_when" CHECK (
    ("frequency" = 'weekly' AND "dayOfWeek" BETWEEN 0 AND 6 AND "dayOfMonth" IS NULL)
    OR ("frequency" = 'monthly' AND "dayOfMonth" BETWEEN 1 AND 28 AND "dayOfWeek" IS NULL)
);
ALTER TABLE "ReportSchedule" ADD CONSTRAINT "ReportSchedule_time" CHECK ("time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
ALTER TABLE "ReportSchedule" ADD CONSTRAINT "ReportSchedule_recipients" CHECK (cardinality("recipientIds") BETWEEN 1 AND 10);

ALTER TABLE "ReportDelivery" ADD CONSTRAINT "ReportDelivery_status" CHECK ("status" IN ('sending', 'sent', 'partial', 'failed', 'blocked', 'missed'));
