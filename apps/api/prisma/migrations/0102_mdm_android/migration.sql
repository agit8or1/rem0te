-- 0.85.0 Mooring: Android enterprise sign-up and read-only inventory — Rem0te
-- as its own EMM on Google's Android Management API (docs/own-mdm.md M3,
-- invariant §94).
--
-- A Platform Admin tests the sealed service-account key against Google,
-- binds a business to its own Android enterprise (sign-up started from inside
-- Rem0te, finished by Google's redirect to a one-time callback), applies the
-- default policy (software and app reports only, never network info) and
-- issues one-time enrollment tokens. The `android` driver then lists the
-- enterprise's devices and their Operations inside the MDM sweep; only the
-- sync writes MobileDevice (§90).
--
-- No real Google API has been called, no enterprise has been created and no
-- device has enrolled: the proof is a loopback stand-in in AMAPI's shape.
--
-- Nothing here is a secret. The sign-up state is kept only as its SHA-256;
-- Google's enterpriseToken is used once in memory and never stored; an
-- enrollment token's value is shown once and never stored; access tokens
-- live in memory only. The closed lists are drivers/android/shape.ts's and
-- setup/setup-model.ts's, word for word and in order (§94 compares them).

ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'MDM_ANDROID_TESTED';
ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'MDM_ANDROID_SIGNUP_STARTED';
ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'MDM_ANDROID_SIGNUP_FAILED';
ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'MDM_ANDROID_ENTERPRISE_BOUND';
ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'MDM_ANDROID_POLICY_SET';
ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'MDM_ANDROID_TOKEN_CREATED';

-- `android` joins the provider lists (model.ts PROVIDERS).
ALTER TABLE "MdmConnector" DROP CONSTRAINT "MdmConnector_provider_check";
ALTER TABLE "MdmConnector" ADD CONSTRAINT "MdmConnector_provider_check" CHECK ("provider" IN ('standin', 'apple', 'android'));
ALTER TABLE "MobileDevice" DROP CONSTRAINT "MobileDevice_provider_check";
ALTER TABLE "MobileDevice" ADD CONSTRAINT "MobileDevice_provider_check" CHECK ("provider" IN ('standin', 'apple', 'android'));

-- Settings → Mobile devices, Android steps 3 and 4: the connection test's
-- last result (reset whenever the key changes) and the quota Google granted,
-- as the Platform Admin recorded it (Rem0te cannot read it from Google).
ALTER TABLE "MdmPlatformSetup"
  ADD COLUMN "androidTestedAt" TIMESTAMP(3),
  ADD COLUMN "androidTestResult" TEXT,
  ADD COLUMN "androidQuotaDevices" INTEGER,
  ADD COLUMN "androidQuotaSetAt" TIMESTAMP(3);
ALTER TABLE "MdmPlatformSetup" ADD CONSTRAINT "MdmPlatformSetup_androidTest_check" CHECK (
  ("androidTestedAt" IS NULL) = ("androidTestResult" IS NULL)
  AND ("androidTestResult" IS NULL OR "androidKeyEnc" IS NOT NULL)
  AND ("androidTestResult" IS NULL OR "androidTestResult" IN ('ok', 'bad_key', 'permission_denied', 'quota', 'unreachable', 'bad_response')));
ALTER TABLE "MdmPlatformSetup" ADD CONSTRAINT "MdmPlatformSetup_androidQuota_check" CHECK (
  ("androidQuotaDevices" IS NULL) = ("androidQuotaSetAt" IS NULL)
  AND ("androidQuotaDevices" IS NULL OR "androidQuotaDevices" BETWEEN 0 AND 1000000));

-- One-time sign-up state: per business, bound to the Platform Admin who
-- started it, short-lived (at most an hour), stored only as a SHA-256, and
-- claimed by ONE conditional update when Google's redirect arrives.
CREATE TABLE "AndroidSignup" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "stateSha256" TEXT NOT NULL,
    "signupUrlName" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'open',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "claimedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "enterpriseId" TEXT,
    "failureCode" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AndroidSignup_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AndroidSignup_state_check" CHECK ("state" IN ('open', 'claimed', 'bound', 'failed', 'expired')),
    CONSTRAINT "AndroidSignup_stateSha256_check" CHECK ("stateSha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "AndroidSignup_signupUrlName_check" CHECK ("signupUrlName" ~ '^signupUrls/[A-Za-z0-9_-]{1,128}$'),
    CONSTRAINT "AndroidSignup_expiresAt_check" CHECK ("expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + interval '1 hour'),
    CONSTRAINT "AndroidSignup_enterpriseId_check" CHECK ("enterpriseId" IS NULL OR "enterpriseId" ~ '^[A-Za-z0-9_-]{1,64}$'),
    CONSTRAINT "AndroidSignup_failureCode_check" CHECK ("failureCode" IS NULL OR "failureCode" ~ '^[a-z0-9_]{1,40}$'),
    -- What each state carries: bound has its enterprise, failed its code, open nothing.
    CONSTRAINT "AndroidSignup_shape_check" CHECK (
        ("state" <> 'open' OR ("claimedAt" IS NULL AND "finishedAt" IS NULL AND "enterpriseId" IS NULL AND "failureCode" IS NULL))
        AND ("state" <> 'claimed' OR ("claimedAt" IS NOT NULL AND "finishedAt" IS NULL AND "enterpriseId" IS NULL))
        AND ("state" <> 'bound' OR ("claimedAt" IS NOT NULL AND "finishedAt" IS NOT NULL AND "enterpriseId" IS NOT NULL AND "failureCode" IS NULL))
        AND ("state" <> 'failed' OR ("finishedAt" IS NOT NULL AND "failureCode" IS NOT NULL AND "enterpriseId" IS NULL)))
);
CREATE UNIQUE INDEX "AndroidSignup_stateSha256_key" ON "AndroidSignup"("stateSha256");
CREATE INDEX "AndroidSignup_customerId_createdAt_idx" ON "AndroidSignup"("customerId", "createdAt");
CREATE INDEX "AndroidSignup_state_expiresAt_idx" ON "AndroidSignup"("state", "expiresAt");
ALTER TABLE "AndroidSignup" ADD CONSTRAINT "AndroidSignup_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One Android enterprise per business (the design's recommendation), and one
-- business per enterprise. The policy is the one default policy.
CREATE TABLE "AndroidEnterprise" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "enterpriseId" TEXT NOT NULL,
    "signupId" TEXT NOT NULL,
    "boundById" TEXT NOT NULL,
    "boundAt" TIMESTAMP(3) NOT NULL,
    "policyId" TEXT NOT NULL DEFAULT 'rem0te-default',
    "policyVersion" TEXT,
    "policySetAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AndroidEnterprise_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AndroidEnterprise_enterpriseId_check" CHECK ("enterpriseId" ~ '^[A-Za-z0-9_-]{1,64}$'),
    CONSTRAINT "AndroidEnterprise_policyId_check" CHECK ("policyId" = 'rem0te-default'),
    CONSTRAINT "AndroidEnterprise_policyVersion_check" CHECK ("policyVersion" IS NULL OR "policyVersion" ~ '^[0-9]{1,19}$'),
    CONSTRAINT "AndroidEnterprise_policy_check" CHECK (("policySetAt" IS NULL) = ("policyVersion" IS NULL))
);
CREATE UNIQUE INDEX "AndroidEnterprise_customerId_key" ON "AndroidEnterprise"("customerId");
CREATE UNIQUE INDEX "AndroidEnterprise_enterpriseId_key" ON "AndroidEnterprise"("enterpriseId");
CREATE UNIQUE INDEX "AndroidEnterprise_signupId_key" ON "AndroidEnterprise"("signupId");
ALTER TABLE "AndroidEnterprise" ADD CONSTRAINT "AndroidEnterprise_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One business all the way down, as 0096 and 0101: a sign-up's tenant is its
-- business's; an enterprise's business and tenant are its sign-up's.
CREATE FUNCTION android_signup_business() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Customer" c WHERE c."id" = NEW."customerId" AND c."tenantId" = NEW."tenantId") THEN
    RAISE EXCEPTION 'Android sign-up tenant does not match its business' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "AndroidSignup_business_trg" BEFORE INSERT OR UPDATE ON "AndroidSignup"
  FOR EACH ROW EXECUTE FUNCTION android_signup_business();

CREATE FUNCTION android_enterprise_business() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "AndroidSignup" s WHERE s."id" = NEW."signupId" AND s."customerId" = NEW."customerId" AND s."tenantId" = NEW."tenantId") THEN
    RAISE EXCEPTION 'Android enterprise business does not match its sign-up' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "AndroidEnterprise_business_trg" BEFORE INSERT OR UPDATE ON "AndroidEnterprise"
  FOR EACH ROW EXECUTE FUNCTION android_enterprise_business();

-- Final stays final, and a sign-up is never reopened; its state token,
-- business, admin, URL and expiry never change. An enterprise never moves to
-- another business and its id never changes.
CREATE FUNCTION android_signup_final() RETURNS trigger AS $$
BEGIN
  IF OLD."state" IN ('bound', 'failed', 'expired') AND NEW."state" IS DISTINCT FROM OLD."state" THEN
    RAISE EXCEPTION 'a finished Android sign-up cannot change state' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."state" <> 'open' AND NEW."state" = 'open' THEN
    RAISE EXCEPTION 'an Android sign-up is never reopened' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."stateSha256" IS DISTINCT FROM OLD."stateSha256" OR NEW."customerId" IS DISTINCT FROM OLD."customerId" OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
     OR NEW."createdById" IS DISTINCT FROM OLD."createdById" OR NEW."signupUrlName" IS DISTINCT FROM OLD."signupUrlName" THEN
    RAISE EXCEPTION 'an Android sign-up''s state token, business, admin, URL and expiry never change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "AndroidSignup_final_trg" BEFORE UPDATE ON "AndroidSignup"
  FOR EACH ROW EXECUTE FUNCTION android_signup_final();

CREATE FUNCTION android_enterprise_fixed() RETURNS trigger AS $$
BEGIN
  IF NEW."enterpriseId" IS DISTINCT FROM OLD."enterpriseId" OR NEW."customerId" IS DISTINCT FROM OLD."customerId" OR NEW."signupId" IS DISTINCT FROM OLD."signupId" THEN
    RAISE EXCEPTION 'an Android enterprise''s id, business and sign-up never change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "AndroidEnterprise_fixed_trg" BEFORE UPDATE ON "AndroidEnterprise"
  FOR EACH ROW EXECUTE FUNCTION android_enterprise_fixed();
