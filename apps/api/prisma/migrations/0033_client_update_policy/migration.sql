-- 0.32: scheduled RustDesk client updates outside working hours.
--
-- A business (and optionally a site) gets a policy: off by default, an update
-- window in a stated IANA time zone, and whether to skip a computer with an
-- open session or a logged-on user. A sweep queues outdated online computers
-- inside the window through the existing RustdeskNode.updateRequestedAt path,
-- marked POLICY; the heartbeat hands a POLICY request out only inside the
-- window. A MANUAL request (someone clicked Update) goes on the next heartbeat
-- as it always has.

-- CreateEnum
CREATE TYPE "UpdateRequestSource" AS ENUM ('MANUAL', 'POLICY');

-- AlterEnum
ALTER TYPE "ActivityAction" ADD VALUE 'CLIENT_UPDATE_POLICY_CHANGED';
ALTER TYPE "ActivityAction" ADD VALUE 'CLIENT_UPDATE_AUTO_QUEUED';

-- AlterTable
ALTER TABLE "RustdeskNode" ADD COLUMN     "updateHoldAt" TIMESTAMP(3),
ADD COLUMN     "updateHoldReason" TEXT,
ADD COLUMN     "updateRequestSource" "UpdateRequestSource",
ADD COLUMN     "updateRequestedById" TEXT;

-- Every request staged before this migration was made by hand. Say so, rather
-- than leaving the console to guess what a null source means.
UPDATE "RustdeskNode" SET "updateRequestSource" = 'MANUAL' WHERE "updateRequestedAt" IS NOT NULL;

-- CreateTable
CREATE TABLE "ClientUpdatePolicy" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "siteId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "timeZone" TEXT NOT NULL,
    "windows" JSONB NOT NULL,
    "skipActiveSession" BOOLEAN NOT NULL DEFAULT true,
    "skipLoggedOnUser" BOOLEAN NOT NULL DEFAULT false,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientUpdatePolicy_pkey" PRIMARY KEY ("id"),
    -- The service validates the zone against the tz database and every window
    -- (client-updates/update-window.ts); these are the backstops.
    CONSTRAINT "ClientUpdatePolicy_timeZone_len" CHECK (char_length("timeZone") BETWEEN 1 AND 64),
    CONSTRAINT "ClientUpdatePolicy_windows_shape" CHECK (jsonb_typeof("windows") = 'array' AND jsonb_array_length("windows") BETWEEN 1 AND 7)
);

-- CreateIndex
CREATE UNIQUE INDEX "ClientUpdatePolicy_siteId_key" ON "ClientUpdatePolicy"("siteId");

-- One business-level row per business. Not expressible in the Prisma schema
-- (a unique over a nullable column admits many NULLs), so it lives here, like
-- MonitorAlert_dedup_open in 0028.
CREATE UNIQUE INDEX "ClientUpdatePolicy_business_row" ON "ClientUpdatePolicy"("customerId") WHERE "siteId" IS NULL;

-- CreateIndex
CREATE INDEX "ClientUpdatePolicy_customerId_idx" ON "ClientUpdatePolicy"("customerId");

-- CreateIndex
CREATE INDEX "ClientUpdatePolicy_enabled_idx" ON "ClientUpdatePolicy"("enabled");

-- AddForeignKey
ALTER TABLE "ClientUpdatePolicy" ADD CONSTRAINT "ClientUpdatePolicy_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientUpdatePolicy" ADD CONSTRAINT "ClientUpdatePolicy_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
