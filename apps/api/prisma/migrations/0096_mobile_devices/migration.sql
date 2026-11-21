-- 0.80.0 Tablet: mobile devices, read from an MDM provider (roadmap 3.1;
-- mdm/, docs/mobile-devices.md, check-security-invariants §90).
--
-- iOS, iPadOS and Android are managed by an external provider; Rem0te reads
-- what it reports. Nothing in 0.80 can be sent to a device. The only
-- connector is the loopback stand-in the test suites run, and nothing in the
-- API creates a connector row yet.
--
-- Every closed list below is mdm/model.ts's, word for word (§90 compares
-- them). Provider acceptance and device completion are separate columns
-- (providerAcceptedAt, deviceCompletedAt), and the command CHECKs hold the
-- state machine's shape (mdm/command-state.ts): a completed command has
-- both, an acknowledged one only the first, and no command has a device
-- completion without a provider acceptance.

CREATE TABLE "MdmConnector" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalTenantId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "syncStartedAt" TIMESTAMP(3),
    "lastSyncAt" TIMESTAMP(3),
    "lastSyncResult" TEXT,
    "lastSyncDevices" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MdmConnector_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MdmConnector_provider_check" CHECK ("provider" IN ('standin')),
    CONSTRAINT "MdmConnector_externalTenantId_check" CHECK ("externalTenantId" ~ '^[A-Za-z0-9._-]{1,64}$'),
    CONSTRAINT "MdmConnector_lastSyncResult_check" CHECK ("lastSyncResult" IS NULL OR "lastSyncResult" IN (
        'ok', 'partial', 'not_ready', 'paused', 'unreachable', 'bad_response', 'refused')),
    CONSTRAINT "MdmConnector_lastSyncDevices_check" CHECK ("lastSyncDevices" IS NULL OR "lastSyncDevices" >= 0)
);

CREATE TABLE "MobileDevice" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "connectorId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerDeviceId" TEXT NOT NULL,
    "name" TEXT,
    "platform" TEXT NOT NULL,
    "ownership" TEXT NOT NULL,
    "managementScope" TEXT NOT NULL,
    "enrollmentState" TEXT NOT NULL,
    "enrolledAt" TIMESTAMP(3),
    "complianceState" TEXT NOT NULL,
    "complianceReason" TEXT,
    "model" TEXT,
    "manufacturer" TEXT,
    "osVersion" TEXT,
    "serialNumber" TEXT,
    "storageTotalBytes" BIGINT,
    "storageFreeBytes" BIGINT,
    "lastCheckInAt" TIMESTAMP(3),
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notReportedSince" TIMESTAMP(3),

    CONSTRAINT "MobileDevice_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MobileDevice_provider_check" CHECK ("provider" IN ('standin')),
    CONSTRAINT "MobileDevice_providerDeviceId_check" CHECK ("providerDeviceId" ~ '^[A-Za-z0-9._:-]{1,128}$'),
    CONSTRAINT "MobileDevice_platform_check" CHECK ("platform" IN ('ios', 'ipados', 'android')),
    CONSTRAINT "MobileDevice_ownership_check" CHECK ("ownership" IN ('corporate', 'byod')),
    CONSTRAINT "MobileDevice_managementScope_check" CHECK ("managementScope" IN ('device', 'work_profile', 'user_enrollment')
        -- A work profile is Android's; User Enrollment is Apple's.
        AND ("managementScope" <> 'work_profile' OR "platform" = 'android')
        AND ("managementScope" <> 'user_enrollment' OR "platform" IN ('ios', 'ipados'))),
    CONSTRAINT "MobileDevice_enrollmentState_check" CHECK ("enrollmentState" IN ('pending', 'enrolled', 'unenrolled', 'not_reported')
        AND (("enrollmentState" = 'not_reported') = ("notReportedSince" IS NOT NULL))),
    CONSTRAINT "MobileDevice_complianceState_check" CHECK ("complianceState" IN ('compliant', 'noncompliant', 'in_grace_period', 'not_evaluated', 'unknown')),
    CONSTRAINT "MobileDevice_text_check" CHECK (
        ("name" IS NULL OR char_length("name") <= 100)
        AND ("complianceReason" IS NULL OR char_length("complianceReason") <= 200)
        AND ("model" IS NULL OR char_length("model") <= 100)
        AND ("manufacturer" IS NULL OR char_length("manufacturer") <= 60)
        AND ("osVersion" IS NULL OR "osVersion" ~ '^[A-Za-z0-9 ._()-]{1,40}$')),
    -- A personal device's serial is never kept (mdm/schemas.ts).
    CONSTRAINT "MobileDevice_serial_check" CHECK ("serialNumber" IS NULL OR ("ownership" = 'corporate' AND "serialNumber" ~ '^[A-Z0-9-]{4,40}$')),
    CONSTRAINT "MobileDevice_storage_check" CHECK (
        ("storageTotalBytes" IS NULL OR "storageTotalBytes" >= 0)
        AND ("storageFreeBytes" IS NULL OR "storageFreeBytes" >= 0)
        AND ("storageTotalBytes" IS NULL OR "storageFreeBytes" IS NULL OR "storageFreeBytes" <= "storageTotalBytes"))
);

CREATE TABLE "MdmCommand" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "mobileDeviceId" TEXT NOT NULL,
    "connectorId" TEXT NOT NULL,
    "providerCommandId" TEXT,
    "kind" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "requestedById" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "providerAcceptedAt" TIMESTAMP(3),
    "deviceCompletedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "failureCode" TEXT,
    "expiresAt" TIMESTAMP(3),
    "expiredAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MdmCommand_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MdmCommand_kind_check" CHECK ("kind" IN (
        'sync', 'lock', 'locate', 'lost_mode_start', 'lost_mode_stop', 'retire', 'remove_managed_data', 'wipe')),
    CONSTRAINT "MdmCommand_origin_check" CHECK ("origin" IN ('portal', 'provider')
        -- A provider-reported command has the provider's id and no Rem0te requester.
        AND ("origin" <> 'provider' OR ("providerCommandId" IS NOT NULL AND "requestedById" IS NULL))),
    CONSTRAINT "MdmCommand_providerCommandId_check" CHECK ("providerCommandId" IS NULL OR "providerCommandId" ~ '^[A-Za-z0-9._:-]{1,128}$'),
    CONSTRAINT "MdmCommand_state_check" CHECK ("state" IN ('queued', 'sent', 'acknowledged', 'completed', 'failed', 'expired')),
    -- The state machine's shape (mdm/command-state.ts).
    CONSTRAINT "MdmCommand_lifecycle_check" CHECK (
        -- Nothing is sent, accepted or done while queued.
        ("state" <> 'queued' OR ("sentAt" IS NULL AND "providerAcceptedAt" IS NULL AND "deviceCompletedAt" IS NULL))
        -- Sent, accepted and completed commands were sent.
        AND ("state" NOT IN ('sent', 'acknowledged', 'completed') OR "sentAt" IS NOT NULL)
        AND ("state" <> 'sent' OR ("providerAcceptedAt" IS NULL AND "deviceCompletedAt" IS NULL))
        -- Acknowledged: the provider accepted; the device has not reported.
        AND ("state" <> 'acknowledged' OR ("providerAcceptedAt" IS NOT NULL AND "deviceCompletedAt" IS NULL))
        -- Completed: both, separately.
        AND ("state" <> 'completed' OR ("providerAcceptedAt" IS NOT NULL AND "deviceCompletedAt" IS NOT NULL))
        -- No device completion without a provider acceptance, and only a completed command has one.
        AND ("deviceCompletedAt" IS NULL OR ("providerAcceptedAt" IS NOT NULL AND "state" = 'completed'))
        AND (("state" = 'failed') = ("failedAt" IS NOT NULL))
        AND (("state" = 'failed') = ("failureCode" IS NOT NULL))
        AND (("state" = 'expired') = ("expiredAt" IS NOT NULL))
        AND ("expiredAt" IS NULL OR "expiresAt" IS NOT NULL)),
    CONSTRAINT "MdmCommand_failureCode_check" CHECK ("failureCode" IS NULL OR "failureCode" ~ '^(provider_rejected|device):[a-z0-9_.:-]{1,64}$')
);

CREATE UNIQUE INDEX "MdmConnector_customerId_provider_key" ON "MdmConnector"("customerId", "provider");
CREATE UNIQUE INDEX "MobileDevice_connectorId_providerDeviceId_key" ON "MobileDevice"("connectorId", "providerDeviceId");
CREATE INDEX "MobileDevice_customerId_platform_idx" ON "MobileDevice"("customerId", "platform");
CREATE UNIQUE INDEX "MdmCommand_connectorId_providerCommandId_key" ON "MdmCommand"("connectorId", "providerCommandId");
CREATE INDEX "MdmCommand_mobileDeviceId_requestedAt_idx" ON "MdmCommand"("mobileDeviceId", "requestedAt");
CREATE INDEX "MdmCommand_state_expiresAt_idx" ON "MdmCommand"("state", "expiresAt");

ALTER TABLE "MdmConnector" ADD CONSTRAINT "MdmConnector_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MobileDevice" ADD CONSTRAINT "MobileDevice_connectorId_fkey" FOREIGN KEY ("connectorId") REFERENCES "MdmConnector"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MdmCommand" ADD CONSTRAINT "MdmCommand_mobileDeviceId_fkey" FOREIGN KEY ("mobileDeviceId") REFERENCES "MobileDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One business, all the way down: a connector's tenant is its business's,
-- a device's business, tenant and provider are its connector's, and a
-- command's business, tenant and connector are its device's. Checked on
-- every insert and update, so no writer can move a row across businesses.
CREATE FUNCTION mdm_connector_business() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Customer" c WHERE c."id" = NEW."customerId" AND c."tenantId" = NEW."tenantId") THEN
    RAISE EXCEPTION 'MDM connector tenant does not match its business' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "MdmConnector_business_trg" BEFORE INSERT OR UPDATE ON "MdmConnector"
  FOR EACH ROW EXECUTE FUNCTION mdm_connector_business();

CREATE FUNCTION mobile_device_business() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "MdmConnector" k WHERE k."id" = NEW."connectorId"
      AND k."customerId" = NEW."customerId" AND k."tenantId" = NEW."tenantId" AND k."provider" = NEW."provider") THEN
    RAISE EXCEPTION 'mobile device business does not match its connector' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "MobileDevice_business_trg" BEFORE INSERT OR UPDATE ON "MobileDevice"
  FOR EACH ROW EXECUTE FUNCTION mobile_device_business();

CREATE FUNCTION mdm_command_business() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "MobileDevice" d WHERE d."id" = NEW."mobileDeviceId"
      AND d."customerId" = NEW."customerId" AND d."tenantId" = NEW."tenantId" AND d."connectorId" = NEW."connectorId") THEN
    RAISE EXCEPTION 'MDM command business does not match its device' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "MdmCommand_business_trg" BEFORE INSERT OR UPDATE ON "MdmCommand"
  FOR EACH ROW EXECUTE FUNCTION mdm_command_business();

-- A final command stays final: completed, failed and expired never move
-- (command-state.ts TERMINAL_STATES).
CREATE FUNCTION mdm_command_final() RETURNS trigger AS $$
BEGIN
  IF OLD."state" IN ('completed', 'failed', 'expired') AND NEW."state" IS DISTINCT FROM OLD."state" THEN
    RAISE EXCEPTION 'a final MDM command cannot change state' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "MdmCommand_final_trg" BEFORE UPDATE ON "MdmCommand"
  FOR EACH ROW EXECUTE FUNCTION mdm_command_final();
