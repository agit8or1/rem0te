-- Endpoint inventory and the endpoint command queue.
--
-- Both tables are new and every column on them is nullable or defaulted, so
-- this is purely additive: no existing row is touched and no table is
-- rewritten. An endpoint with no row in "EndpointInventory" is one whose
-- installer predates this feature — the UI says so rather than showing zeros.
--
-- Sizes are megabytes, not bytes. Prisma maps BigInt to a JS BigInt and
-- JSON.stringify throws on those, so a byte count in a column would take down
-- whichever response carried it. Byte-precise per-disk figures live inside the
-- JSONB columns, where they are ordinary JSON numbers.

CREATE TABLE "EndpointInventory" (
    "id" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,

    "manufacturer" TEXT,
    "model" TEXT,
    "serialNumber" TEXT,
    "chassisType" TEXT,
    "biosVersion" TEXT,
    "biosDate" TIMESTAMP(3),

    "osCaption" TEXT,
    "osBuild" TEXT,
    "osArch" TEXT,
    "osInstalledAt" TIMESTAMP(3),
    "domain" TEXT,
    "timezone" TEXT,

    "cpuModel" TEXT,
    "cpuCores" INTEGER,
    "cpuThreads" INTEGER,
    "cpuMhz" INTEGER,

    "memoryTotalMb" INTEGER,
    "memoryFreeMb" INTEGER,

    "disks" JSONB,
    "gpus" JSONB,
    "networks" JSONB,

    "loggedOnUser" TEXT,
    "lastBootAt" TIMESTAMP(3),
    "uptimeSeconds" INTEGER,

    "pendingUpdates" JSONB,
    "pendingUpdateCount" INTEGER,
    "rebootRequired" BOOLEAN,
    "updatesCheckedAt" TIMESTAMP(3),

    "collectedAt" TIMESTAMP(3),

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EndpointInventory_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EndpointInventory_endpointId_key" ON "EndpointInventory"("endpointId");

ALTER TABLE "EndpointInventory"
    ADD CONSTRAINT "EndpointInventory_endpointId_fkey"
    FOREIGN KEY ("endpointId") REFERENCES "Endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The command queue. `type` is an enum rather than free text on purpose: an
-- endpoint performs one of a fixed set of read-only collections and nothing
-- else, so a compromise of the console cannot become arbitrary SYSTEM
-- execution across a fleet.
CREATE TYPE "EndpointCommandType" AS ENUM ('INVENTORY_REFRESH', 'UPDATE_SCAN', 'EVENT_LOG_QUERY');
CREATE TYPE "EndpointCommandStatus" AS ENUM ('PENDING', 'DISPATCHED', 'SUCCEEDED', 'FAILED', 'EXPIRED');

CREATE TABLE "EndpointCommand" (
    "id" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "tenantId" TEXT,
    "customerId" TEXT,

    "type" "EndpointCommandType" NOT NULL,
    "params" JSONB,
    "status" "EndpointCommandStatus" NOT NULL DEFAULT 'PENDING',

    "requestedById" TEXT,

    "result" JSONB,
    "error" TEXT,

    "dispatchCount" INTEGER NOT NULL DEFAULT 0,

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatchedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EndpointCommand_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EndpointCommand_endpointId_status_idx" ON "EndpointCommand"("endpointId", "status");
CREATE INDEX "EndpointCommand_status_expiresAt_idx" ON "EndpointCommand"("status", "expiresAt");

ALTER TABLE "EndpointCommand"
    ADD CONSTRAINT "EndpointCommand_endpointId_fkey"
    FOREIGN KEY ("endpointId") REFERENCES "Endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Reading another business's Windows Security log is exactly the kind of thing
-- that has to be answerable after the fact, so both new requests are audited.
ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'ENDPOINT_INVENTORY_REFRESH_REQUESTED';
ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'ENDPOINT_EVENT_LOG_REQUESTED';
