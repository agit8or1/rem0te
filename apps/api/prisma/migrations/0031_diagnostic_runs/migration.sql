-- v0.31: the one-click read-only diagnostics catalog. A run is a catalog key
-- staged for one computer, handed out on its authenticated heartbeat, and its
-- bounded, sanitised result.

-- CreateEnum
CREATE TYPE "DiagnosticRunStatus" AS ENUM ('REQUESTED', 'DELIVERED', 'RUNNING', 'COMPLETED', 'FAILED', 'EXPIRED');

-- AlterEnum
ALTER TYPE "ActivityAction" ADD VALUE 'ENDPOINT_DIAGNOSTIC_REQUESTED';
ALTER TYPE "ActivityAction" ADD VALUE 'ENDPOINT_DIAGNOSTIC_COMPLETED';

-- CreateTable
CREATE TABLE "DiagnosticRun" (
    "id" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "tenantId" TEXT,
    "customerId" TEXT,
    "key" TEXT NOT NULL,
    "status" "DiagnosticRunStatus" NOT NULL DEFAULT 'REQUESTED',
    "requestedById" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "dispatchCount" INTEGER NOT NULL DEFAULT 0,
    "result" JSONB,
    "resultBytes" INTEGER,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,

    CONSTRAINT "DiagnosticRun_pkey" PRIMARY KEY ("id"),
    -- The catalog is closed in the database too: a key the code does not know
    -- cannot be stored, whatever path tried to write it. Adding a diagnostic
    -- is a migration on purpose.
    CONSTRAINT "DiagnosticRun_key_catalog" CHECK ("key" IN (
        'refresh_inventory', 'disk_space', 'service_health', 'recent_system_errors',
        'top_processes', 'network_connectivity', 'dns_resolution', 'pending_updates', 'reboot_status'
    )),
    -- Results are capped in the service (MAX_RESULT_BYTES = 32768); this is the backstop.
    CONSTRAINT "DiagnosticRun_result_bounded" CHECK ("result" IS NULL OR octet_length("result"::text) <= 65536)
);

-- CreateIndex
CREATE INDEX "DiagnosticRun_endpointId_status_idx" ON "DiagnosticRun"("endpointId", "status");

-- CreateIndex
CREATE INDEX "DiagnosticRun_endpointId_requestedAt_idx" ON "DiagnosticRun"("endpointId", "requestedAt");

-- CreateIndex
CREATE INDEX "DiagnosticRun_requestedById_requestedAt_idx" ON "DiagnosticRun"("requestedById", "requestedAt");

-- CreateIndex
CREATE INDEX "DiagnosticRun_status_expiresAt_idx" ON "DiagnosticRun"("status", "expiresAt");

-- AddForeignKey
ALTER TABLE "DiagnosticRun" ADD CONSTRAINT "DiagnosticRun_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;
