-- v0.23.0: technician access presets and abuse prevention.
--
-- Additive. No existing assignment changes: presetId is NULL on every row, so
-- each one stays a custom assignment evaluated exactly as before. Built-in
-- presets (L1/L2/L3) and the default policy are created by the API on start
-- (src/security-controls/presets.ts, create-if-missing), not here, so the SQL
-- and the definitions cannot drift.

-- CreateEnum
CREATE TYPE "DeviceClass" AS ENUM ('UNKNOWN', 'WORKSTATION', 'SERVER', 'DOMAIN_CONTROLLER', 'HYPERVISOR', 'BACKUP_SERVER', 'RMM_HOST');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ActivityAction" ADD VALUE 'TECHNICIAN_PRESET_CHANGED';
ALTER TYPE "ActivityAction" ADD VALUE 'ACCESS_POLICY_CHANGED';
ALTER TYPE "ActivityAction" ADD VALUE 'TRUST_CHANGE_REQUESTED';
ALTER TYPE "ActivityAction" ADD VALUE 'TRUST_CHANGE_DECIDED';
ALTER TYPE "ActivityAction" ADD VALUE 'TEMPORARY_ACCESS_REQUESTED';
ALTER TYPE "ActivityAction" ADD VALUE 'TEMPORARY_ACCESS_DECIDED';
ALTER TYPE "ActivityAction" ADD VALUE 'TEMPORARY_ACCESS_ACTIVATED';
ALTER TYPE "ActivityAction" ADD VALUE 'PRIVILEGED_WORK_DENIED';
ALTER TYPE "ActivityAction" ADD VALUE 'IDENTITY_PAUSED';
ALTER TYPE "ActivityAction" ADD VALUE 'IDENTITY_PAUSE_CLEARED';
ALTER TYPE "ActivityAction" ADD VALUE 'MAINTENANCE_EXCEPTION_CHANGED';
ALTER TYPE "ActivityAction" ADD VALUE 'ALERT_SUPPRESSION_CHANGED';
ALTER TYPE "ActivityAction" ADD VALUE 'DEVICE_CLASS_CHANGED';
ALTER TYPE "ActivityAction" ADD VALUE 'SECURITY_ALERT_RAISED';

-- AlterTable
ALTER TABLE "Endpoint" ADD COLUMN     "deviceClass" "DeviceClass" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN     "sessionEnforcement" JSONB;

-- AlterTable
ALTER TABLE "TechnicianAssignment" ADD COLUMN     "presetId" TEXT;

-- CreateTable
CREATE TABLE "TechnicianPreset" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "builtIn" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT NOT NULL DEFAULT '',
    "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "policy" JSONB NOT NULL,
    "clonedFromId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TechnicianPreset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccessPolicy" (
    "id" TEXT NOT NULL,
    "customerId" TEXT,
    "controls" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccessPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TemporaryAccessRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "activatedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TemporaryAccessRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrivilegedActivity" (
    "id" TEXT NOT NULL,
    "identity" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "endpointId" TEXT,
    "customerId" TEXT,
    "entryPoint" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PrivilegedActivity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdentityPause" (
    "id" TEXT NOT NULL,
    "identity" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clearedAt" TIMESTAMP(3),
    "clearedById" TEXT,

    CONSTRAINT "IdentityPause_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenanceException" (
    "id" TEXT NOT NULL,
    "identity" TEXT NOT NULL,
    "endpointIds" TEXT[],
    "kinds" TEXT[],
    "reason" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "approvedById" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaintenanceException_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertSuppression" (
    "id" TEXT NOT NULL,
    "identity" TEXT,
    "kind" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "until" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "AlertSuppression_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecurityAlert" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "identity" TEXT,
    "customerId" TEXT,
    "details" JSONB NOT NULL,
    "suppressed" BOOLEAN NOT NULL DEFAULT false,
    "delivered" BOOLEAN NOT NULL DEFAULT false,
    "deliveryError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedById" TEXT,

    CONSTRAINT "SecurityAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrustChangeRequest" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "payload" JSONB NOT NULL,
    "requestedById" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrustChangeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TechnicianPreset_key_key" ON "TechnicianPreset"("key");

-- CreateIndex
CREATE UNIQUE INDEX "AccessPolicy_customerId_key" ON "AccessPolicy"("customerId");

-- CreateIndex
CREATE INDEX "TemporaryAccessRequest_userId_endpointId_status_idx" ON "TemporaryAccessRequest"("userId", "endpointId", "status");

-- CreateIndex
CREATE INDEX "TemporaryAccessRequest_customerId_status_idx" ON "TemporaryAccessRequest"("customerId", "status");

-- CreateIndex
CREATE INDEX "PrivilegedActivity_identity_at_idx" ON "PrivilegedActivity"("identity", "at");

-- CreateIndex
CREATE INDEX "IdentityPause_identity_clearedAt_idx" ON "IdentityPause"("identity", "clearedAt");

-- CreateIndex
CREATE INDEX "MaintenanceException_identity_status_idx" ON "MaintenanceException"("identity", "status");

-- CreateIndex
CREATE INDEX "SecurityAlert_createdAt_idx" ON "SecurityAlert"("createdAt");

-- CreateIndex
CREATE INDEX "TrustChangeRequest_status_createdAt_idx" ON "TrustChangeRequest"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "TechnicianAssignment" ADD CONSTRAINT "TechnicianAssignment_presetId_fkey" FOREIGN KEY ("presetId") REFERENCES "TechnicianPreset"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Device class: classify only what the reported OS caption makes certain.
-- Protected classes (domain controller, hypervisor, backup server, RMM host)
-- are never guessed — an admin sets them.
UPDATE "Endpoint" e SET "deviceClass" = CASE
    WHEN i."osCaption" ILIKE '%server%' THEN 'SERVER'::"DeviceClass"
    ELSE 'WORKSTATION'::"DeviceClass" END
  FROM "EndpointInventory" i
 WHERE i."endpointId" = e."id" AND i."osCaption" IS NOT NULL;

ALTER TABLE "TechnicianDevice" ADD COLUMN "isManagedAdminWorkstation" BOOLEAN NOT NULL DEFAULT false;

-- Launch mode recorded on single-use launch credentials (re-evaluated at redemption).
ALTER TABLE "ConnectionGrant" ADD COLUMN "launchMode" TEXT NOT NULL DEFAULT 'control';
ALTER TABLE "LauncherToken" ADD COLUMN "launchMode" TEXT NOT NULL DEFAULT 'control';
