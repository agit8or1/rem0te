-- 0.24.0 "Keystone": signed update chain.
-- Additive only. Every existing endpoint reads as legacy (NULL channel) until
-- its agent reports otherwise; the platform starts in legacy_allowed, so no
-- update path that works today stops working on upgrade.
ALTER TABLE "Endpoint" ADD COLUMN "updateChannel" TEXT;
ALTER TABLE "Endpoint" ADD COLUMN "trustRootVersion" INTEGER;
ALTER TABLE "Endpoint" ADD COLUMN "targetsVersion" INTEGER;
ALTER TABLE "Endpoint" ADD COLUMN "trustReportedAt" TIMESTAMP(3);

ALTER TABLE "PlatformSettings" ADD COLUMN "updateTrustMode" TEXT NOT NULL DEFAULT 'legacy_allowed';
ALTER TABLE "PlatformSettings" ADD COLUMN "legacyPortalMigration" BOOLEAN NOT NULL DEFAULT false;
