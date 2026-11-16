-- v0.61: warranty lookups for HP (HP Inc.'s Warranty API) and Apple (the
-- Apple Business Manager API's AppleCare coverage), beside 0.56's Dell and
-- Lenovo.
--
-- Numbered 0082: 0081 is the parallel 0.60 branch. Nothing here depends on it.
--
-- 0077's two vendor-list CHECKs named exactly 'dell' and 'lenovo'. They are
-- rebuilt with the same shape, naming exactly warranty/vendors.ts
-- LOOKUP_VENDORS. No existing row can fail them: they only widen.

ALTER TABLE "Endpoint" DROP CONSTRAINT "Endpoint_warrantySource_check";
ALTER TABLE "Endpoint" ADD CONSTRAINT "Endpoint_warrantySource_check"
  CHECK ("warrantySource" IS NULL OR "warrantySource" IN ('manual', 'dell', 'lenovo', 'hp', 'apple'));

ALTER TABLE "WarrantyVendor" DROP CONSTRAINT "WarrantyVendor_vendor_check";
ALTER TABLE "WarrantyVendor" ADD CONSTRAINT "WarrantyVendor_vendor_check"
  CHECK ("vendor" IN ('dell', 'lenovo', 'hp', 'apple'));

-- Apple's key id (the API account's key, beside its client id). An
-- identifier, not a secret: the private key itself is in "secretEnc".
ALTER TABLE "WarrantyVendor" ADD COLUMN "keyId" TEXT;
ALTER TABLE "WarrantyVendor" ADD CONSTRAINT "WarrantyVendor_keyId_check"
  CHECK ("keyId" IS NULL OR ("vendor" = 'apple' AND "keyId" ~ '^[A-Za-z0-9._-]{4,100}$'));
-- Only Dell (TechDirect client id), HP (API key) and Apple (client id) take a
-- client id; Lenovo's credential is the token alone.
ALTER TABLE "WarrantyVendor" ADD CONSTRAINT "WarrantyVendor_clientId_check"
  CHECK ("clientId" IS NULL OR ("vendor" IN ('dell', 'hp', 'apple') AND "clientId" ~ '^[!-~]{4,200}$'));
