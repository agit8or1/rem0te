-- 0.84.0 Harbor: Apple enrollment, check-in and inventory — the own MDM's
-- first real driver (docs/own-mdm.md M2, invariant §93).
--
-- Rem0te becomes the MDM server for iPhones and iPads: one-time enrollment
-- links, a signed enrollment profile, the check-in and command endpoints
-- (every message's Mdm-Signature verified before it is read), a queue for
-- five inventory commands, and the APNs push that wakes a device. The
-- device tables below are written only by the Apple services
-- (mdm/apple/), and MobileDevice only by the sync, as before (§90).
--
-- The closed lists are mdm/apple/protocol.ts's, word for word and in order
-- (§93 compares them). What is kept follows 0096: no IMEI, MEID, phone
-- number, MAC address or signed-in user, and no UnlockToken — there is no
-- column for any of them.

ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'MDM_APPLE_LINK_CREATED';
ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'MDM_APPLE_LINK_REVOKED';
ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'MDM_APPLE_LINK_CLAIMED';
ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'MDM_APPLE_DEVICE_AUTHENTICATED';
ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'MDM_APPLE_DEVICE_ENROLLED';
ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'MDM_APPLE_DEVICE_CHECKED_OUT';
ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'MDM_APPLE_COMMAND_RESULT';
ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'MDM_APPLE_PUSHED';

-- `apple` joins the provider lists (model.ts PROVIDERS).
ALTER TABLE "MdmConnector" DROP CONSTRAINT "MdmConnector_provider_check";
ALTER TABLE "MdmConnector" ADD CONSTRAINT "MdmConnector_provider_check" CHECK ("provider" IN ('standin', 'apple'));
ALTER TABLE "MobileDevice" DROP CONSTRAINT "MobileDevice_provider_check";
ALTER TABLE "MobileDevice" ADD CONSTRAINT "MobileDevice_provider_check" CHECK ("provider" IN ('standin', 'apple'));

-- Settings → Mobile devices, step 6: the device CA's public certificates and
-- the profile-signing identity (its key sealed, rem0te-mdm-profile-sign-v1).
ALTER TABLE "MdmPlatformSetup"
  ADD COLUMN "deviceCaRootPem" TEXT,
  ADD COLUMN "deviceCaChainPem" TEXT,
  ADD COLUMN "deviceCaRootSha256" TEXT,
  ADD COLUMN "deviceCaNotAfter" TIMESTAMP(3),
  ADD COLUMN "deviceCaSetAt" TIMESTAMP(3),
  ADD COLUMN "profileSignKeyEnc" TEXT,
  ADD COLUMN "profileSignCertPem" TEXT,
  ADD COLUMN "profileSignChainPem" TEXT,
  ADD COLUMN "profileSignSha256" TEXT,
  ADD COLUMN "profileSignNotAfter" TIMESTAMP(3),
  ADD COLUMN "profileSignSetAt" TIMESTAMP(3);
ALTER TABLE "MdmPlatformSetup" ADD CONSTRAINT "MdmPlatformSetup_deviceCa_check" CHECK (
  ("deviceCaRootPem" IS NULL) = ("deviceCaRootSha256" IS NULL) AND ("deviceCaRootPem" IS NULL) = ("deviceCaNotAfter" IS NULL)
  AND ("deviceCaRootPem" IS NULL) = ("deviceCaSetAt" IS NULL) AND ("deviceCaChainPem" IS NULL OR "deviceCaRootPem" IS NOT NULL)
  AND ("deviceCaRootPem" IS NULL OR "deviceCaRootPem" LIKE '-----BEGIN CERTIFICATE-----%')
  AND ("deviceCaChainPem" IS NULL OR "deviceCaChainPem" LIKE '-----BEGIN CERTIFICATE-----%')
  AND ("deviceCaRootSha256" IS NULL OR "deviceCaRootSha256" ~ '^[0-9a-f]{64}$'));
ALTER TABLE "MdmPlatformSetup" ADD CONSTRAINT "MdmPlatformSetup_profileSign_check" CHECK (
  ("profileSignKeyEnc" IS NULL) = ("profileSignCertPem" IS NULL) AND ("profileSignKeyEnc" IS NULL) = ("profileSignSha256" IS NULL)
  AND ("profileSignKeyEnc" IS NULL) = ("profileSignNotAfter" IS NULL) AND ("profileSignKeyEnc" IS NULL) = ("profileSignSetAt" IS NULL)
  AND ("profileSignChainPem" IS NULL OR "profileSignKeyEnc" IS NOT NULL)
  AND ("profileSignKeyEnc" IS NULL OR "profileSignKeyEnc" ~ '^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$')
  AND ("profileSignCertPem" IS NULL OR "profileSignCertPem" LIKE '-----BEGIN CERTIFICATE-----%')
  AND ("profileSignSha256" IS NULL OR "profileSignSha256" ~ '^[0-9a-f]{64}$'));

-- One-time enrollment links: per business, short-lived (15 minutes to 24
-- hours), stored only as a SHA-256, claimed by one conditional update when
-- the profile is downloaded, used by the one Authenticate that names it.
CREATE TABLE "AppleEnrollmentLink" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "tokenSha256" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'open',
    "ownership" TEXT NOT NULL DEFAULT 'corporate',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "claimedAt" TIMESTAMP(3),
    "usedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppleEnrollmentLink_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AppleEnrollmentLink_state_check" CHECK ("state" IN ('open', 'claimed', 'used', 'expired', 'revoked')),
    -- Profile-based device enrollment is for corporate devices (docs/own-mdm.md "Enrollment types").
    CONSTRAINT "AppleEnrollmentLink_ownership_check" CHECK ("ownership" IN ('corporate')),
    CONSTRAINT "AppleEnrollmentLink_token_check" CHECK ("tokenSha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "AppleEnrollmentLink_life_check" CHECK ("expiresAt" >= "createdAt" + interval '15 minutes' AND "expiresAt" <= "createdAt" + interval '24 hours'),
    CONSTRAINT "AppleEnrollmentLink_shape_check" CHECK (
      ("state" <> 'open' OR ("claimedAt" IS NULL AND "usedAt" IS NULL AND "revokedAt" IS NULL))
      AND ("state" NOT IN ('claimed', 'used') OR "claimedAt" IS NOT NULL)
      AND (("state" = 'used') = ("usedAt" IS NOT NULL))
      AND (("state" = 'revoked') = ("revokedAt" IS NOT NULL)))
);
CREATE UNIQUE INDEX "AppleEnrollmentLink_tokenSha256_key" ON "AppleEnrollmentLink"("tokenSha256");
CREATE INDEX "AppleEnrollmentLink_customerId_createdAt_idx" ON "AppleEnrollmentLink"("customerId", "createdAt");
CREATE INDEX "AppleEnrollmentLink_state_expiresAt_idx" ON "AppleEnrollmentLink"("state", "expiresAt");
ALTER TABLE "AppleEnrollmentLink" ADD CONSTRAINT "AppleEnrollmentLink_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- An enrolled iPhone or iPad. One row per enrollment: a device that enrolls
-- again (a new link) supersedes its old row, which is checked out.
CREATE TABLE "AppleDevice" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "udid" TEXT NOT NULL,
    "certSha256" TEXT NOT NULL,
    "certNotAfter" TIMESTAMP(3) NOT NULL,
    "topic" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'authenticated',
    "pushToken" TEXT,
    "pushMagic" TEXT,
    "pushTokenInvalidAt" TIMESTAMP(3),
    "authenticatedAt" TIMESTAMP(3) NOT NULL,
    "enrolledAt" TIMESTAMP(3),
    "checkedOutAt" TIMESTAMP(3),
    "checkoutReason" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "lastPushAt" TIMESTAMP(3),
    "lastPushOkAt" TIMESTAMP(3),
    "lastPushResult" TEXT,
    "lastInventoryQueuedAt" TIMESTAMP(3),
    "lastInventoryAt" TIMESTAMP(3),
    "deviceName" TEXT,
    "model" TEXT,
    "modelName" TEXT,
    "productName" TEXT,
    "platform" TEXT NOT NULL,
    "osVersion" TEXT,
    "buildVersion" TEXT,
    "serialNumber" TEXT,
    "storageTotalBytes" BIGINT,
    "storageFreeBytes" BIGINT,
    "supervised" BOOLEAN,
    "passcodePresent" BOOLEAN,
    "passcodeCompliant" BOOLEAN,
    "appCount" INTEGER,
    "profileCount" INTEGER,
    "certificateCount" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppleDevice_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AppleDevice_state_check" CHECK ("state" IN ('authenticated', 'enrolled', 'checked_out')),
    CONSTRAINT "AppleDevice_platform_check" CHECK ("platform" IN ('ios', 'ipados')),
    CONSTRAINT "AppleDevice_udid_check" CHECK ("udid" ~ '^[A-Fa-f0-9-]{24,64}$'),
    CONSTRAINT "AppleDevice_cert_check" CHECK ("certSha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "AppleDevice_topic_check" CHECK ("topic" ~ '^com\.apple\.mgmt\.[A-Za-z0-9.-]{1,100}$'),
    CONSTRAINT "AppleDevice_push_check" CHECK (
      ("pushToken" IS NULL) = ("pushMagic" IS NULL)
      AND ("pushToken" IS NULL OR "pushToken" ~ '^[0-9a-f]{8,200}$')
      AND ("pushMagic" IS NULL OR "pushMagic" ~ '^[A-Za-z0-9-]{1,64}$')
      AND ("state" <> 'checked_out' OR "pushToken" IS NULL)),
    CONSTRAINT "AppleDevice_lifecycle_check" CHECK (
      ("state" = 'authenticated' OR "enrolledAt" IS NOT NULL OR "state" = 'checked_out')
      AND (("state" = 'checked_out') = ("checkedOutAt" IS NOT NULL))
      AND (("state" = 'checked_out') = ("checkoutReason" IS NOT NULL))
      AND ("checkoutReason" IS NULL OR "checkoutReason" IN ('checkout', 'superseded'))),
    CONSTRAINT "AppleDevice_pushResult_check" CHECK ("lastPushResult" IS NULL OR "lastPushResult" IN (
      'ok', 'unregistered', 'bad_token', 'topic_refused', 'certificate_refused', 'retry', 'refused', 'unreachable')),
    CONSTRAINT "AppleDevice_serial_check" CHECK ("serialNumber" IS NULL OR "serialNumber" ~ '^[A-Z0-9]{4,40}$'),
    CONSTRAINT "AppleDevice_storage_check" CHECK (
      ("storageTotalBytes" IS NULL OR "storageTotalBytes" >= 0) AND ("storageFreeBytes" IS NULL OR "storageFreeBytes" >= 0)
      AND ("storageTotalBytes" IS NULL OR "storageFreeBytes" IS NULL OR "storageFreeBytes" <= "storageTotalBytes")),
    CONSTRAINT "AppleDevice_counts_check" CHECK (
      ("appCount" IS NULL OR "appCount" >= 0) AND ("profileCount" IS NULL OR "profileCount" >= 0) AND ("certificateCount" IS NULL OR "certificateCount" >= 0)),
    CONSTRAINT "AppleDevice_text_check" CHECK (
      ("deviceName" IS NULL OR char_length("deviceName") <= 100) AND ("model" IS NULL OR char_length("model") <= 64)
      AND ("modelName" IS NULL OR char_length("modelName") <= 64) AND ("productName" IS NULL OR char_length("productName") <= 64)
      AND ("osVersion" IS NULL OR "osVersion" ~ '^[0-9]{1,3}(\.[0-9]{1,4}){0,3}$') AND ("buildVersion" IS NULL OR "buildVersion" ~ '^[A-Za-z0-9]{1,20}$'))
);
CREATE UNIQUE INDEX "AppleDevice_linkId_key" ON "AppleDevice"("linkId");
CREATE UNIQUE INDEX "AppleDevice_certSha256_key" ON "AppleDevice"("certSha256");
-- One live enrollment per device.
CREATE UNIQUE INDEX "AppleDevice_live_udid_key" ON "AppleDevice"("udid") WHERE "state" <> 'checked_out';
CREATE INDEX "AppleDevice_customerId_id_idx" ON "AppleDevice"("customerId", "id");
ALTER TABLE "AppleDevice" ADD CONSTRAINT "AppleDevice_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AppleDevice" ADD CONSTRAINT "AppleDevice_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "AppleEnrollmentLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Rem0te's own command queue. Inventory only (protocol.ts REQUEST_TYPES).
CREATE TABLE "AppleCommand" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "appleDeviceId" TEXT NOT NULL,
    "commandUuid" TEXT NOT NULL,
    "requestType" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'queued',
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pushedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "respondedAt" TIMESTAMP(3),
    "errorCode" TEXT,
    "notNowCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppleCommand_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AppleCommand_requestType_check" CHECK ("requestType" IN ('DeviceInformation', 'SecurityInfo', 'InstalledApplicationList', 'ProfileList', 'CertificateList')),
    CONSTRAINT "AppleCommand_state_check" CHECK ("state" IN ('queued', 'sent', 'acknowledged', 'error', 'cancelled', 'expired')),
    CONSTRAINT "AppleCommand_uuid_check" CHECK ("commandUuid" ~ '^[A-F0-9-]{36}$'),
    CONSTRAINT "AppleCommand_shape_check" CHECK (
      ("state" NOT IN ('sent', 'acknowledged', 'error') OR "sentAt" IS NOT NULL)
      AND (("state" IN ('acknowledged', 'error')) = ("respondedAt" IS NOT NULL))
      AND (("state" = 'error') = ("errorCode" IS NOT NULL))
      AND ("errorCode" IS NULL OR "errorCode" ~ '^[a-z0-9_.:-]{1,64}$')
      AND "notNowCount" >= 0 AND "expiresAt" > "queuedAt")
);
CREATE UNIQUE INDEX "AppleCommand_commandUuid_key" ON "AppleCommand"("commandUuid");
-- At most one open command of each type per device: re-queueing inventory never stacks.
CREATE UNIQUE INDEX "AppleCommand_open_type_key" ON "AppleCommand"("appleDeviceId", "requestType") WHERE "state" IN ('queued', 'sent');
CREATE INDEX "AppleCommand_appleDeviceId_queuedAt_idx" ON "AppleCommand"("appleDeviceId", "queuedAt");
CREATE INDEX "AppleCommand_state_expiresAt_idx" ON "AppleCommand"("state", "expiresAt");
ALTER TABLE "AppleCommand" ADD CONSTRAINT "AppleCommand_appleDeviceId_fkey" FOREIGN KEY ("appleDeviceId") REFERENCES "AppleDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One business all the way down, as 0096: a link's tenant is its business's,
-- a device's business and tenant are its link's, a command's its device's.
CREATE FUNCTION apple_link_business() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Customer" c WHERE c."id" = NEW."customerId" AND c."tenantId" = NEW."tenantId") THEN
    RAISE EXCEPTION 'Apple enrollment link tenant does not match its business' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "AppleEnrollmentLink_business_trg" BEFORE INSERT OR UPDATE ON "AppleEnrollmentLink"
  FOR EACH ROW EXECUTE FUNCTION apple_link_business();

CREATE FUNCTION apple_device_business() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "AppleEnrollmentLink" l WHERE l."id" = NEW."linkId" AND l."customerId" = NEW."customerId" AND l."tenantId" = NEW."tenantId") THEN
    RAISE EXCEPTION 'Apple device business does not match its enrollment link' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "AppleDevice_business_trg" BEFORE INSERT OR UPDATE ON "AppleDevice"
  FOR EACH ROW EXECUTE FUNCTION apple_device_business();

CREATE FUNCTION apple_command_business() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "AppleDevice" d WHERE d."id" = NEW."appleDeviceId" AND d."customerId" = NEW."customerId" AND d."tenantId" = NEW."tenantId") THEN
    RAISE EXCEPTION 'Apple command business does not match its device' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "AppleCommand_business_trg" BEFORE INSERT OR UPDATE ON "AppleCommand"
  FOR EACH ROW EXECUTE FUNCTION apple_command_business();

-- Final stays final: a used, expired or revoked link, a checked-out device,
-- and an acknowledged, failed, cancelled or expired command never move again.
CREATE FUNCTION apple_link_final() RETURNS trigger AS $$
BEGIN
  IF OLD."state" IN ('used', 'expired', 'revoked') AND NEW."state" IS DISTINCT FROM OLD."state" THEN
    RAISE EXCEPTION 'a final enrollment link cannot change state' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."state" <> 'open' AND NEW."state" = 'open' THEN
    RAISE EXCEPTION 'an enrollment link is never reopened' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."tokenSha256" IS DISTINCT FROM OLD."tokenSha256" OR NEW."customerId" IS DISTINCT FROM OLD."customerId" OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt" THEN
    RAISE EXCEPTION 'an enrollment link''s token, business and expiry never change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "AppleEnrollmentLink_final_trg" BEFORE UPDATE ON "AppleEnrollmentLink"
  FOR EACH ROW EXECUTE FUNCTION apple_link_final();

CREATE FUNCTION apple_device_final() RETURNS trigger AS $$
BEGIN
  IF OLD."state" = 'checked_out' AND NEW."state" IS DISTINCT FROM OLD."state" THEN
    RAISE EXCEPTION 'a checked-out Apple device does not come back; it enrolls again' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."udid" IS DISTINCT FROM OLD."udid" OR NEW."certSha256" IS DISTINCT FROM OLD."certSha256" OR NEW."linkId" IS DISTINCT FROM OLD."linkId" OR NEW."customerId" IS DISTINCT FROM OLD."customerId" THEN
    RAISE EXCEPTION 'an Apple device''s identity and business never change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "AppleDevice_final_trg" BEFORE UPDATE ON "AppleDevice"
  FOR EACH ROW EXECUTE FUNCTION apple_device_final();

CREATE FUNCTION apple_command_final() RETURNS trigger AS $$
BEGIN
  IF OLD."state" IN ('acknowledged', 'error', 'cancelled', 'expired') AND NEW."state" IS DISTINCT FROM OLD."state" THEN
    RAISE EXCEPTION 'a final Apple command cannot change state' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."requestType" IS DISTINCT FROM OLD."requestType" OR NEW."commandUuid" IS DISTINCT FROM OLD."commandUuid" OR NEW."appleDeviceId" IS DISTINCT FROM OLD."appleDeviceId" THEN
    RAISE EXCEPTION 'an Apple command''s type, id and device never change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "AppleCommand_final_trg" BEFORE UPDATE ON "AppleCommand"
  FOR EACH ROW EXECUTE FUNCTION apple_command_final();
