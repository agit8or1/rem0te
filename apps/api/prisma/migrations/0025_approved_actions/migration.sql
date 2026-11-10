-- CreateEnum
CREATE TYPE "ActionJobStatus" AS ENUM ('AWAITING_APPROVAL', 'APPROVED', 'REJECTED', 'CANCELED', 'EXPIRED', 'DISPATCHED', 'SUCCEEDED', 'FAILED', 'REFUSED_BY_ENDPOINT', 'NOT_EXECUTED', 'UNKNOWN');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ActivityAction" ADD VALUE 'ACTION_REQUESTED';
ALTER TYPE "ActivityAction" ADD VALUE 'ACTION_APPROVAL_UPDATED';
ALTER TYPE "ActivityAction" ADD VALUE 'ACTION_DISPATCHED';
ALTER TYPE "ActivityAction" ADD VALUE 'ACTION_DISPATCH_BLOCKED';
ALTER TYPE "ActivityAction" ADD VALUE 'ACTION_RESULT';
ALTER TYPE "ActivityAction" ADD VALUE 'ACTION_CANCELED';
ALTER TYPE "ActivityAction" ADD VALUE 'ACTION_RECONCILED';

-- AlterTable
ALTER TABLE "Endpoint" ADD COLUMN     "agentActions" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "agentSha256" TEXT;

-- CreateTable
CREATE TABLE "ActionJob" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "customerId" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "actionId" TEXT NOT NULL,
    "actionVersion" INTEGER NOT NULL,
    "params" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "via" TEXT NOT NULL,
    "ticketRef" TEXT,
    "requestedById" TEXT NOT NULL,
    "status" "ActionJobStatus" NOT NULL DEFAULT 'AWAITING_APPROVAL',
    "statusReason" TEXT,
    "risk" TEXT NOT NULL,
    "approvalsRequired" INTEGER NOT NULL,
    "customerSignoff" BOOLEAN NOT NULL,
    "notBefore" TIMESTAMP(3) NOT NULL,
    "notAfter" TIMESTAMP(3) NOT NULL,
    "plan" JSONB NOT NULL,
    "digest" TEXT NOT NULL,
    "approvalUrl" TEXT NOT NULL,
    "envelope" JSONB,
    "approvers" JSONB,
    "dispatchedAt" TIMESTAMP(3),
    "deliveries" INTEGER NOT NULL DEFAULT 0,
    "lastDeliveredAt" TIMESTAMP(3),
    "outcome" TEXT,
    "result" JSONB,
    "resultAt" TIMESTAMP(3),
    "reconciledById" TEXT,
    "reconciledAt" TIMESTAMP(3),
    "reconcileNote" TEXT,
    "integrationPeer" TEXT,
    "integrationKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActionJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ActionJob_endpointId_status_idx" ON "ActionJob"("endpointId", "status");

-- CreateIndex
CREATE INDEX "ActionJob_customerId_createdAt_idx" ON "ActionJob"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "ActionJob_status_idx" ON "ActionJob"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ActionJob_integrationPeer_integrationKey_key" ON "ActionJob"("integrationPeer", "integrationKey");

-- AddForeignKey
ALTER TABLE "ActionJob" ADD CONSTRAINT "ActionJob_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionJob" ADD CONSTRAINT "ActionJob_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

