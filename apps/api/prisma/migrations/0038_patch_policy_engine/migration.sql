-- CreateEnum
CREATE TYPE "PatchDeploymentOrigin" AS ENUM ('DEPLOYMENT', 'MANUAL', 'POLICY');

-- CreateEnum
CREATE TYPE "PatchPolicyStatus" AS ENUM ('AWAITING_APPROVAL', 'ACTIVE', 'REJECTED', 'REVOKED', 'EXPIRED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ActivityAction" ADD VALUE 'PATCH_POLICY_CREATED';
ALTER TYPE "ActivityAction" ADD VALUE 'PATCH_POLICY_UPDATED';
ALTER TYPE "ActivityAction" ADD VALUE 'PATCH_POLICY_REVOKED';
ALTER TYPE "ActivityAction" ADD VALUE 'PATCH_POLICY_PROPOSED';
ALTER TYPE "ActivityAction" ADD VALUE 'PATCH_POLICY_REFUSED';
ALTER TYPE "ActivityAction" ADD VALUE 'PATCH_INSTALL_REQUESTED';

-- AlterTable
ALTER TABLE "PatchDeployment" ADD COLUMN     "origin" "PatchDeploymentOrigin" NOT NULL DEFAULT 'DEPLOYMENT',
ADD COLUMN     "policyId" TEXT,
ADD COLUMN     "windowKey" TEXT;

-- CreateTable
CREATE TABLE "PatchPolicy" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "customerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "document" JSONB NOT NULL,
    "digest" TEXT NOT NULL,
    "status" "PatchPolicyStatus" NOT NULL DEFAULT 'AWAITING_APPROVAL',
    "approvalUrl" TEXT NOT NULL,
    "approvals" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "revokeReason" TEXT,
    "signerRevokedAt" TIMESTAMP(3),
    "lastProposal" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PatchPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PatchPolicy_customerId_createdAt_idx" ON "PatchPolicy"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "PatchPolicy_status_idx" ON "PatchPolicy"("status");

-- CreateIndex
CREATE UNIQUE INDEX "PatchDeployment_policyId_windowKey_key" ON "PatchDeployment"("policyId", "windowKey");

-- AddForeignKey
ALTER TABLE "PatchDeployment" ADD CONSTRAINT "PatchDeployment_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "PatchPolicy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatchPolicy" ADD CONSTRAINT "PatchPolicy_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

