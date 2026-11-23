-- 0.83.0 Beacon: Settings → Mobile devices — the own MDM's setup wizard and
-- the Apple push certificate (docs/own-mdm.md M1, invariant §92).
--
-- One row for the whole install (decision 23: one APNs push certificate per
-- install). Nothing here calls Apple or Google. Every secret is sealed by the
-- API under its own secret-box purpose before it reaches this table, and only
-- MdmSetupService writes it. The closed lists are mdm/setup/setup-model.ts's,
-- word for word (§92 compares them).

ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'MDM_SETUP_CHANGED';
ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'MDM_SETUP_CREDENTIAL_SET';
ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'MDM_SETUP_CREDENTIAL_DELETED';
ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'MDM_PUSH_REQUEST_SIGNED';
ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'MDM_PUSH_CERT_INSTALLED';
ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'MDM_PUSH_CERT_DELETED';

CREATE TABLE "MdmPlatformSetup" (
    "id" TEXT NOT NULL DEFAULT 'platform',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "appleChecklist" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "androidChecklist" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "signingRoute" TEXT,
    "pushKeyEnc" TEXT,
    "pushCsrPem" TEXT,
    "pushKeySpkiSha256" TEXT,
    "pushKeyCreatedAt" TIMESTAMP(3),
    "vendorKeyEnc" TEXT,
    "vendorCertPem" TEXT,
    "vendorChainPem" TEXT,
    "vendorNotAfter" TIMESTAMP(3),
    "vendorSetAt" TIMESTAMP(3),
    "pushCertEnc" TEXT,
    "pushCertSerial" TEXT,
    "pushCertSha256" TEXT,
    "pushCertIssuer" TEXT,
    "pushCertNotBefore" TIMESTAMP(3),
    "pushCertNotAfter" TIMESTAMP(3),
    "pushCertInstalledAt" TIMESTAMP(3),
    "pushCertRenewedAt" TIMESTAMP(3),
    "apnsTopic" TEXT,
    "appleAccount" TEXT,
    "pushRemindedDays" INTEGER,
    "androidKeyEnc" TEXT,
    "androidProjectId" TEXT,
    "androidClientEmail" TEXT,
    "androidKeyIdLast4" TEXT,
    "androidKeySetAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MdmPlatformSetup_pkey" PRIMARY KEY ("id"),
    -- Platform-wide: exactly one row (decision 23).
    CONSTRAINT "MdmPlatformSetup_one_row_check" CHECK ("id" = 'platform'),
    CONSTRAINT "MdmPlatformSetup_revision_check" CHECK ("revision" >= 0),
    -- The owner's ticks: only the known items (setup-model.ts).
    CONSTRAINT "MdmPlatformSetup_appleChecklist_check" CHECK ("appleChecklist" <@ ARRAY['duns', 'developer_org', 'mdm_csr_permission', 'company_apple_account']::TEXT[]),
    CONSTRAINT "MdmPlatformSetup_androidChecklist_check" CHECK ("androidChecklist" <@ ARRAY['google_account', 'cloud_project', 'service_account', 'quota_request', 'permitted_use']::TEXT[]),
    CONSTRAINT "MdmPlatformSetup_signingRoute_check" CHECK ("signingRoute" IS NULL OR "signingRoute" IN ('own_vendor', 'mdmcert', 'other_vendor')),
    -- A sealed value is secret-box's iv:tag:ciphertext, hex — never a PEM.
    CONSTRAINT "MdmPlatformSetup_sealed_check" CHECK (
      ("pushKeyEnc" IS NULL OR "pushKeyEnc" ~ '^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$')
      AND ("vendorKeyEnc" IS NULL OR "vendorKeyEnc" ~ '^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$')
      AND ("pushCertEnc" IS NULL OR "pushCertEnc" ~ '^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$')
      AND ("androidKeyEnc" IS NULL OR "androidKeyEnc" ~ '^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$')),
    -- The push key and its CSR come and go together.
    CONSTRAINT "MdmPlatformSetup_pushKey_check" CHECK (
      ("pushKeyEnc" IS NULL) = ("pushCsrPem" IS NULL) AND ("pushKeyEnc" IS NULL) = ("pushKeySpkiSha256" IS NULL) AND ("pushKeyEnc" IS NULL) = ("pushKeyCreatedAt" IS NULL)
      AND ("pushCsrPem" IS NULL OR "pushCsrPem" LIKE '-----BEGIN CERTIFICATE REQUEST-----%')
      AND ("pushKeySpkiSha256" IS NULL OR "pushKeySpkiSha256" ~ '^[0-9a-f]{64}$')),
    -- The vendor key, its certificate and its chain come and go together.
    CONSTRAINT "MdmPlatformSetup_vendor_check" CHECK (
      ("vendorKeyEnc" IS NULL) = ("vendorCertPem" IS NULL) AND ("vendorKeyEnc" IS NULL) = ("vendorChainPem" IS NULL)
      AND ("vendorKeyEnc" IS NULL) = ("vendorNotAfter" IS NULL) AND ("vendorKeyEnc" IS NULL) = ("vendorSetAt" IS NULL)
      AND ("vendorCertPem" IS NULL OR "vendorCertPem" LIKE '-----BEGIN CERTIFICATE-----%')),
    -- A push certificate needs the push key it was issued for, a topic and its facts.
    CONSTRAINT "MdmPlatformSetup_pushCert_check" CHECK (
      ("pushCertEnc" IS NULL OR ("pushKeyEnc" IS NOT NULL AND "apnsTopic" IS NOT NULL))
      AND ("pushCertEnc" IS NULL) = ("pushCertSerial" IS NULL) AND ("pushCertEnc" IS NULL) = ("pushCertSha256" IS NULL)
      AND ("pushCertEnc" IS NULL) = ("pushCertNotBefore" IS NULL) AND ("pushCertEnc" IS NULL) = ("pushCertNotAfter" IS NULL)
      AND ("pushCertEnc" IS NULL) = ("pushCertInstalledAt" IS NULL) AND ("pushCertEnc" IS NULL) = ("pushCertIssuer" IS NULL)
      AND ("pushCertRenewedAt" IS NULL OR "pushCertEnc" IS NOT NULL)
      AND ("pushCertNotAfter" IS NULL OR "pushCertNotAfter" > "pushCertNotBefore")
      AND ("pushCertSha256" IS NULL OR "pushCertSha256" ~ '^[0-9a-f]{64}$')
      AND ("pushCertSerial" IS NULL OR "pushCertSerial" ~ '^[0-9A-F]{1,64}$')
      AND ("pushCertIssuer" IS NULL OR char_length("pushCertIssuer") <= 300)),
    CONSTRAINT "MdmPlatformSetup_topic_check" CHECK ("apnsTopic" IS NULL OR "apnsTopic" ~ '^com\.apple\.mgmt\.External\.[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$'),
    CONSTRAINT "MdmPlatformSetup_appleAccount_check" CHECK ("appleAccount" IS NULL OR (char_length("appleAccount") <= 254 AND "appleAccount" ~ '^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}$')),
    -- Renewal reminders (30, 14, 3 days; 0 = expired), only for an installed certificate.
    CONSTRAINT "MdmPlatformSetup_reminded_check" CHECK ("pushRemindedDays" IS NULL OR ("pushRemindedDays" IN (30, 14, 3, 0) AND "pushCertEnc" IS NOT NULL)),
    -- The Google service-account key and its public facts come and go together.
    CONSTRAINT "MdmPlatformSetup_android_check" CHECK (
      ("androidKeyEnc" IS NULL) = ("androidProjectId" IS NULL) AND ("androidKeyEnc" IS NULL) = ("androidClientEmail" IS NULL)
      AND ("androidKeyEnc" IS NULL) = ("androidKeyIdLast4" IS NULL) AND ("androidKeyEnc" IS NULL) = ("androidKeySetAt" IS NULL)
      AND ("androidProjectId" IS NULL OR "androidProjectId" ~ '^[a-z][a-z0-9-]{4,28}[a-z0-9]$')
      AND ("androidClientEmail" IS NULL OR "androidClientEmail" ~ '^[a-z0-9][a-z0-9-]{4,29}@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$')
      AND ("androidKeyIdLast4" IS NULL OR "androidKeyIdLast4" ~ '^[0-9a-f]{4}$'))
);

-- The one row exists from the start, so every write is a conditional update.
INSERT INTO "MdmPlatformSetup" ("id", "updatedAt") VALUES ('platform', CURRENT_TIMESTAMP);

-- It is never deleted: deleting a credential nulls its columns.
CREATE FUNCTION mdm_platform_setup_no_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'MdmPlatformSetup is never deleted; clear the columns instead';
END $$;
CREATE TRIGGER "MdmPlatformSetup_no_delete_trg" BEFORE DELETE ON "MdmPlatformSetup"
  FOR EACH ROW EXECUTE FUNCTION mdm_platform_setup_no_delete();
