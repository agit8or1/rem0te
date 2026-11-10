-- CreateEnum
CREATE TYPE "ActionTargetStatus" AS ENUM ('PENDING', 'DISPATCHED', 'SUCCEEDED', 'FAILED', 'REFUSED_BY_ENDPOINT', 'NOT_EXECUTED', 'UNKNOWN', 'CANCELED');

-- CreateEnum
CREATE TYPE "PatchDeploymentStatus" AS ENUM ('ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ActivityAction" ADD VALUE 'PATCH_DEPLOYMENT_CREATED';
ALTER TYPE "ActivityAction" ADD VALUE 'PATCH_DEPLOYMENT_UPDATED';
ALTER TYPE "ActivityAction" ADD VALUE 'PATCH_RING_REQUESTED';
ALTER TYPE "ActivityAction" ADD VALUE 'PATCH_SCAN_REQUESTED';

-- AlterTable
ALTER TABLE "ActionJob" ADD COLUMN     "deploymentId" TEXT,
ADD COLUMN     "ring" INTEGER;

-- AlterTable
ALTER TABLE "Endpoint" ADD COLUMN     "patchScanRequestedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "EndpointInventory" ADD COLUMN     "patchPosture" JSONB,
ADD COLUMN     "patchScannedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ActionTarget" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "status" "ActionTargetStatus" NOT NULL DEFAULT 'PENDING',
    "statusReason" TEXT,
    "dispatchedAt" TIMESTAMP(3),
    "deliveries" INTEGER NOT NULL DEFAULT 0,
    "lastDeliveredAt" TIMESTAMP(3),
    "outcome" TEXT,
    "result" JSONB,
    "resultAt" TIMESTAMP(3),
    "reconciledById" TEXT,
    "reconciledAt" TIMESTAMP(3),
    "reconcileNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActionTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PatchDeployment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "customerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "updates" JSONB NOT NULL,
    "rings" JSONB NOT NULL,
    "soakHours" INTEGER NOT NULL DEFAULT 24,
    "failureThreshold" INTEGER NOT NULL DEFAULT 0,
    "windowHours" INTEGER NOT NULL DEFAULT 8,
    "status" "PatchDeploymentStatus" NOT NULL DEFAULT 'ACTIVE',
    "pausedReason" TEXT,
    "resumedOverJobId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PatchDeployment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ActionTarget_endpointId_status_idx" ON "ActionTarget"("endpointId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ActionTarget_jobId_endpointId_key" ON "ActionTarget"("jobId", "endpointId");

-- CreateIndex
CREATE INDEX "PatchDeployment_customerId_createdAt_idx" ON "PatchDeployment"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "ActionJob_deploymentId_idx" ON "ActionJob"("deploymentId");

-- AddForeignKey
ALTER TABLE "ActionJob" ADD CONSTRAINT "ActionJob_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "PatchDeployment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionTarget" ADD CONSTRAINT "ActionTarget_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ActionJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionTarget" ADD CONSTRAINT "ActionTarget_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatchDeployment" ADD CONSTRAINT "PatchDeployment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Every existing job named exactly one computer: give it its target row,
-- carrying its delivery, result and reconciliation, so the per-computer code
-- reads the same history the per-job code wrote.
INSERT INTO "ActionTarget" ("id", "jobId", "endpointId", "status", "statusReason", "dispatchedAt", "deliveries", "lastDeliveredAt",
                            "outcome", "result", "resultAt", "reconciledById", "reconciledAt", "reconcileNote", "createdAt", "updatedAt")
SELECT 'at_' || j."id", j."id", j."endpointId",
       (CASE j."status"::text
          WHEN 'AWAITING_APPROVAL' THEN 'PENDING' WHEN 'APPROVED' THEN 'PENDING'
          WHEN 'REJECTED' THEN 'CANCELED' WHEN 'CANCELED' THEN 'CANCELED' WHEN 'EXPIRED' THEN 'CANCELED'
          ELSE j."status"::text END)::"ActionTargetStatus",
       j."statusReason", j."dispatchedAt", j."deliveries", j."lastDeliveredAt", j."outcome", j."result", j."resultAt",
       j."reconciledById", j."reconciledAt", j."reconcileNote", j."createdAt", j."updatedAt"
FROM "ActionJob" j;
