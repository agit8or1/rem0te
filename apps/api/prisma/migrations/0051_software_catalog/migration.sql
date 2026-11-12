-- Software deployment through a winget allowlist (0.34).
--
-- SoftwareCatalogEntry: a winget package id pinned to one version and one
-- installer SHA-256, with a closed detection rule. Per business, or global
-- (customerId NULL exactly when scope is GLOBAL). One live entry per package
-- per business and per package globally (partial unique indexes below); an
-- archived entry frees its package id.
--
-- SoftwareDeployment: one entry installed or uninstalled ring by ring. Each
-- ring is one signed plan (ActionJob.softwareDeploymentId). params is the
-- exact parameter object every ring signs, copied from the entry when the
-- deployment was made; changing the entry afterwards changes no deployment.
--
-- Nothing here holds a file: there is no upload, and the installer is never
-- on this server.

ALTER TYPE "ActivityAction" ADD VALUE 'SOFTWARE_CATALOG_CREATED';
ALTER TYPE "ActivityAction" ADD VALUE 'SOFTWARE_CATALOG_UPDATED';
ALTER TYPE "ActivityAction" ADD VALUE 'SOFTWARE_CATALOG_ARCHIVED';
ALTER TYPE "ActivityAction" ADD VALUE 'SOFTWARE_DEPLOYMENT_CREATED';
ALTER TYPE "ActivityAction" ADD VALUE 'SOFTWARE_DEPLOYMENT_UPDATED';
ALTER TYPE "ActivityAction" ADD VALUE 'SOFTWARE_RING_REQUESTED';

CREATE TYPE "SoftwareCatalogScope" AS ENUM ('GLOBAL', 'BUSINESS');
CREATE TYPE "SoftwareHashSource" AS ENUM ('WINGET_PKGS', 'ADMIN_PASTED');

ALTER TABLE "ActionJob" ADD COLUMN "softwareDeploymentId" TEXT;

CREATE TABLE "SoftwareCatalogEntry" (
    "id" TEXT NOT NULL,
    "scope" "SoftwareCatalogScope" NOT NULL,
    "tenantId" TEXT,
    "customerId" TEXT,
    "packageId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "publisher" TEXT,
    "version" TEXT NOT NULL,
    "installerSha256" TEXT NOT NULL,
    "hashSource" "SoftwareHashSource" NOT NULL,
    "manifestUrl" TEXT,
    "manifestSha256" TEXT,
    "installerUrl" TEXT,
    "architecture" TEXT,
    "detection" JSONB NOT NULL,
    "notes" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "archivedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SoftwareCatalogEntry_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SoftwareCatalogEntry_scope_check" CHECK (("scope" = 'GLOBAL') = ("customerId" IS NULL)),
    -- The same charsets the portal, the signer and the agent check.
    CONSTRAINT "SoftwareCatalogEntry_package_check" CHECK ("packageId" ~ '^[A-Za-z0-9][A-Za-z0-9+_-]{0,63}(\.[A-Za-z0-9+_-]{1,64}){1,7}$' AND length("packageId") <= 128),
    CONSTRAINT "SoftwareCatalogEntry_version_check" CHECK ("version" ~ '^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$'),
    CONSTRAINT "SoftwareCatalogEntry_sha_check" CHECK ("installerSha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "SoftwareCatalogEntry_manifest_check" CHECK (("hashSource" = 'WINGET_PKGS') = ("manifestSha256" IS NOT NULL))
);

CREATE TABLE "SoftwareDeployment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "customerId" TEXT NOT NULL,
    "entryId" TEXT,
    "entryRevision" INTEGER NOT NULL,
    "operation" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "display" JSONB NOT NULL,
    "name" TEXT NOT NULL,
    "rings" JSONB NOT NULL,
    "soakHours" INTEGER NOT NULL DEFAULT 24,
    "failureThreshold" INTEGER NOT NULL DEFAULT 0,
    "windowHours" INTEGER NOT NULL DEFAULT 8,
    "status" "PatchDeploymentStatus" NOT NULL DEFAULT 'ACTIVE',
    "pausedReason" TEXT,
    "resumedOverJobId" TEXT,
    "single" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SoftwareDeployment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SoftwareDeployment_operation_check" CHECK ("operation" IN ('install', 'uninstall'))
);

CREATE INDEX "SoftwareCatalogEntry_customerId_packageId_idx" ON "SoftwareCatalogEntry"("customerId", "packageId");
CREATE INDEX "SoftwareCatalogEntry_scope_idx" ON "SoftwareCatalogEntry"("scope");
CREATE UNIQUE INDEX "SoftwareCatalogEntry_business_package_live" ON "SoftwareCatalogEntry"("customerId", "packageId") WHERE "customerId" IS NOT NULL AND "archivedAt" IS NULL;
CREATE UNIQUE INDEX "SoftwareCatalogEntry_global_package_live" ON "SoftwareCatalogEntry"("packageId") WHERE "customerId" IS NULL AND "archivedAt" IS NULL;
CREATE INDEX "SoftwareDeployment_customerId_createdAt_idx" ON "SoftwareDeployment"("customerId", "createdAt");
CREATE INDEX "SoftwareDeployment_entryId_idx" ON "SoftwareDeployment"("entryId");
CREATE INDEX "ActionJob_softwareDeploymentId_idx" ON "ActionJob"("softwareDeploymentId");

ALTER TABLE "ActionJob" ADD CONSTRAINT "ActionJob_softwareDeploymentId_fkey" FOREIGN KEY ("softwareDeploymentId") REFERENCES "SoftwareDeployment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SoftwareCatalogEntry" ADD CONSTRAINT "SoftwareCatalogEntry_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SoftwareDeployment" ADD CONSTRAINT "SoftwareDeployment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SoftwareDeployment" ADD CONSTRAINT "SoftwareDeployment_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "SoftwareCatalogEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;
