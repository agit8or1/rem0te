-- v0.56: hardware warranty status, vendor warranty lookups and the
-- WARRANTY_EXPIRING monitor.
--
-- Numbered 0077: 0076 is the parallel 0.55 alerts branch. Nothing here
-- depends on it; the two enum additions below are independent of its own.
--
-- Endpoint gains its warranty dates. warrantySource says where they came
-- from: 'manual' (a person, on the device page — the vendor sweep never
-- overwrites it) or the vendor whose API answered. Coverage is the vendor's
-- service-level text reduced to an inert charset (warranty/vendors.ts
-- COVERAGE_RE), 200 characters at most.

ALTER TYPE "MonitorKind" ADD VALUE 'WARRANTY_EXPIRING';
ALTER TYPE "ActivityAction" ADD VALUE 'WARRANTY_SET';
ALTER TYPE "ActivityAction" ADD VALUE 'WARRANTY_SETTINGS_CHANGED';
ALTER TYPE "ActivityAction" ADD VALUE 'WARRANTY_LOOKUP_REQUESTED';

ALTER TABLE "Endpoint"
  ADD COLUMN "warrantyStartsAt" TIMESTAMP(3),
  ADD COLUMN "warrantyEndsAt" TIMESTAMP(3),
  ADD COLUMN "warrantySource" TEXT,
  ADD COLUMN "warrantyCheckedAt" TIMESTAMP(3),
  ADD COLUMN "warrantyCoverage" TEXT,
  ADD COLUMN "warrantyLookupAt" TIMESTAMP(3),
  ADD COLUMN "warrantyLookupResult" TEXT;

ALTER TABLE "Endpoint" ADD CONSTRAINT "Endpoint_warrantySource_check"
  CHECK ("warrantySource" IS NULL OR "warrantySource" IN ('manual', 'dell', 'lenovo'));
-- Dates only with a source, and an end date whenever there is a source.
ALTER TABLE "Endpoint" ADD CONSTRAINT "Endpoint_warranty_dates_check"
  CHECK (("warrantySource" IS NULL AND "warrantyEndsAt" IS NULL AND "warrantyStartsAt" IS NULL AND "warrantyCoverage" IS NULL)
      OR ("warrantySource" IS NOT NULL AND "warrantyEndsAt" IS NOT NULL
          AND ("warrantyStartsAt" IS NULL OR "warrantyStartsAt" <= "warrantyEndsAt")));
ALTER TABLE "Endpoint" ADD CONSTRAINT "Endpoint_warrantyCoverage_check"
  CHECK ("warrantyCoverage" IS NULL OR (char_length("warrantyCoverage") <= 200
      AND "warrantyCoverage" ~ '^[A-Za-z0-9\u00C0-\u024F .,:;()/&+''#-]*$'));
ALTER TABLE "Endpoint" ADD CONSTRAINT "Endpoint_warrantyLookupResult_check"
  CHECK ("warrantyLookupResult" IS NULL OR "warrantyLookupResult" ~ '^[A-Z0-9_]{1,40}$');

-- The device list's Warranty filter and sort, the report and the dashboard tile.
CREATE INDEX "Endpoint_warrantyEndsAt_idx" ON "Endpoint"("warrantyEndsAt");

CREATE TABLE "WarrantyVendor" (
    "vendor" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "clientId" TEXT,
    "secretEnc" TEXT,
    "secretLast4" TEXT,
    "updatedById" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastResultAt" TIMESTAMP(3),
    "lastResult" TEXT,

    CONSTRAINT "WarrantyVendor_pkey" PRIMARY KEY ("vendor"),
    -- Only vendors whose lookup is implemented (warranty/client.ts LOOKUP_VENDORS).
    CONSTRAINT "WarrantyVendor_vendor_check" CHECK ("vendor" IN ('dell', 'lenovo')),
    -- Enabled needs a credential.
    CONSTRAINT "WarrantyVendor_enabled_check" CHECK (NOT "enabled" OR "secretEnc" IS NOT NULL),
    CONSTRAINT "WarrantyVendor_lastResult_check" CHECK ("lastResult" IS NULL OR "lastResult" ~ '^[A-Z0-9_]{1,40}$')
);
