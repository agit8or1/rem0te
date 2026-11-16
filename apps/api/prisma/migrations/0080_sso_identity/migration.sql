-- v0.59 "Agit8or Identity P0": the groundwork for trusting a self-hosted
-- Keycloak. Code only: nothing here turns anything on. Every new column
-- defaults to today's behaviour, so an existing provider, business and
-- account sign in exactly as they did under 0.58.

-- ── Provider settings ─────────────────────────────────────────────────────
-- tokenAuth: how Rem0te authenticates to the token endpoint. A
-- client_secret_post provider with no secret is a public client (PKCE only),
-- as before. private_key_jwt signs an assertion with a P-256 key generated
-- here; the private key is sealed (secret-box, rem0te-oidc-client-key-v1) and
-- only its public JWK is ever shown.
ALTER TABLE "OidcProvider" ADD COLUMN "tokenAuth" TEXT NOT NULL DEFAULT 'client_secret_post';
ALTER TABLE "OidcProvider" ADD CONSTRAINT "OidcProvider_tokenAuth_check" CHECK ("tokenAuth" IN ('client_secret_post', 'private_key_jwt'));
ALTER TABLE "OidcProvider" ADD COLUMN "clientKeyEnc" TEXT;
ALTER TABLE "OidcProvider" ADD COLUMN "clientKeyKid" TEXT;
ALTER TABLE "OidcProvider" ADD COLUMN "clientPublicJwk" JSONB;
ALTER TABLE "OidcProvider" ADD CONSTRAINT "OidcProvider_pkjwt_key_check" CHECK ("tokenAuth" <> 'private_key_jwt' OR ("clientKeyEnc" IS NOT NULL AND "clientKeyKid" IS NOT NULL));
-- A Keycloak Organization id that must appear in the `organization` claim.
-- A gate, never a grant.
ALTER TABLE "OidcProvider" ADD COLUMN "bindOrgId" TEXT;
-- The provider's acr values for each level, lowest to highest. Null: that
-- level cannot be recognised, so nothing is trusted at it.
ALTER TABLE "OidcProvider" ADD COLUMN "acrPassword" TEXT;
ALTER TABLE "OidcProvider" ADD COLUMN "acrMfa" TEXT;
ALTER TABLE "OidcProvider" ADD COLUMN "acrPasskey" TEXT;
ALTER TABLE "OidcProvider" ADD COLUMN "trustIdpMfa" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "OidcProvider" ADD COLUMN "trustIdpPasskey" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "OidcProvider" ADD COLUMN "allowPlatformAdmin" BOOLEAN NOT NULL DEFAULT false;
-- What the session safety-net does when it cannot reach the provider.
ALTER TABLE "OidcProvider" ADD COLUMN "sessionCheckFailMode" TEXT NOT NULL DEFAULT 'open';
ALTER TABLE "OidcProvider" ADD CONSTRAINT "OidcProvider_failmode_check" CHECK ("sessionCheckFailMode" IN ('open', 'closed'));
ALTER TABLE "OidcProvider" ADD COLUMN "postLogoutRedirectUri" TEXT;

-- ── The SSO step-up round trip rides on the login state ───────────────────
ALTER TABLE "OidcLoginState" ADD COLUMN "requiredLevel" TEXT;
ALTER TABLE "OidcLoginState" ADD COLUMN "sessionIat" INTEGER;
ALTER TABLE "OidcLoginState" ADD CONSTRAINT "OidcLoginState_purpose_check" CHECK ("purpose" IN ('LOGIN', 'LINK', 'STEP_UP'));
ALTER TABLE "OidcLoginState" ADD CONSTRAINT "OidcLoginState_level_check" CHECK ("requiredLevel" IS NULL OR "requiredLevel" IN ('mfa', 'passkey'));
ALTER TABLE "OidcLoginState" ADD CONSTRAINT "OidcLoginState_stepup_check" CHECK ("purpose" <> 'STEP_UP' OR ("userId" IS NOT NULL AND "requiredLevel" IS NOT NULL AND "sessionIat" IS NOT NULL));

-- ── An SSO-originated sign-in ─────────────────────────────────────────────
CREATE TABLE "SsoSession" (
  "id"              TEXT NOT NULL,
  "userId"          TEXT NOT NULL,
  "providerId"      TEXT NOT NULL,
  "subject"         TEXT NOT NULL,
  "sid"             TEXT,
  "authTime"        TIMESTAMP(3),
  "acr"             TEXT,
  "amr"             TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "level"           TEXT NOT NULL,
  -- The access token's iat this sign-in minted. Null while TOTP is pending.
  "sessionIat"      INTEGER,
  "refreshTokenEnc" TEXT,
  "idTokenEnc"      TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt"       TIMESTAMP(3) NOT NULL,
  "lastCheckedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "endedAt"         TIMESTAMP(3),
  "endReason"       TEXT,
  CONSTRAINT "SsoSession_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SsoSession_level_check" CHECK ("level" IN ('none', 'password', 'mfa', 'passkey')),
  CONSTRAINT "SsoSession_amr_check" CHECK (cardinality("amr") <= 16),
  CONSTRAINT "SsoSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SsoSession_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "OidcProvider"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "SsoSession_userId_idx" ON "SsoSession"("userId");
CREATE INDEX "SsoSession_providerId_sid_idx" ON "SsoSession"("providerId", "sid");
CREATE INDEX "SsoSession_providerId_subject_idx" ON "SsoSession"("providerId", "subject");
CREATE INDEX "SsoSession_endedAt_lastCheckedAt_idx" ON "SsoSession"("endedAt", "lastCheckedAt");

-- A back-channel logout token's jti, used once.
CREATE TABLE "SsoLogoutReplay" (
  "key"       TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SsoLogoutReplay_pkey" PRIMARY KEY ("key")
);
CREATE INDEX "SsoLogoutReplay_expiresAt_idx" ON "SsoLogoutReplay"("expiresAt");

-- An IdP identity with a verified email that matches an unlinked local
-- account. Only a Platform Admin can act on one, one at a time; nothing links
-- by email automatically.
CREATE TABLE "SsoLinkSuggestion" (
  "id"           TEXT NOT NULL,
  "providerId"   TEXT NOT NULL,
  "issuer"       TEXT NOT NULL,
  "subject"      TEXT NOT NULL,
  "email"        TEXT NOT NULL,
  "userId"       TEXT NOT NULL,
  "status"       TEXT NOT NULL DEFAULT 'PENDING',
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decidedById"  TEXT,
  "decidedAt"    TIMESTAMP(3),
  CONSTRAINT "SsoLinkSuggestion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SsoLinkSuggestion_status_check" CHECK ("status" IN ('PENDING', 'LINKED', 'DISMISSED')),
  CONSTRAINT "SsoLinkSuggestion_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SsoLinkSuggestion_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "OidcProvider"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "SsoLinkSuggestion_issuer_subject_userId_key" ON "SsoLinkSuggestion"("issuer", "subject", "userId");
CREATE INDEX "SsoLinkSuggestion_status_lastSeenAt_idx" ON "SsoLinkSuggestion"("status", "lastSeenAt");

-- ── Login lockout, in the database (was a Map in AuthService) ────────────
-- One row per account at most; pruned when it has nothing left to say.
CREATE TABLE "LoginLockout" (
  "userId"      TEXT NOT NULL,
  "count"       INTEGER NOT NULL DEFAULT 0,
  "lockedUntil" TIMESTAMP(3) NOT NULL,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LoginLockout_pkey" PRIMARY KEY ("userId"),
  CONSTRAINT "LoginLockout_count_check" CHECK ("count" >= 0),
  CONSTRAINT "LoginLockout_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "LoginLockout_updatedAt_idx" ON "LoginLockout"("updatedAt");

-- ── Enforcement ───────────────────────────────────────────────────────────
-- off and optional sign in exactly as before; required refuses password and
-- local-passkey sign-in for the scope's linked accounts (break-glass excepted).
ALTER TABLE "Customer" ADD COLUMN "ssoMode" TEXT NOT NULL DEFAULT 'off';
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_ssoMode_check" CHECK ("ssoMode" IN ('off', 'optional', 'required'));
-- The same for staff: Platform Admins and technicians with no business membership.
ALTER TABLE "PlatformSettings" ADD COLUMN "staffSsoMode" TEXT NOT NULL DEFAULT 'off';
ALTER TABLE "PlatformSettings" ADD CONSTRAINT "PlatformSettings_staffSsoMode_check" CHECK ("staffSsoMode" IN ('off', 'optional', 'required'));

-- ── Break-glass ───────────────────────────────────────────────────────────
-- A Platform Admin only, at most two, exempt from ssoMode=required. The
-- service also requires TOTP and a passkey before setting it.
ALTER TABLE "User" ADD COLUMN "breakGlass" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD CONSTRAINT "User_breakGlass_admin_check" CHECK (NOT "breakGlass" OR "isPlatformAdmin");

CREATE OR REPLACE FUNCTION rem0te_break_glass_limit() RETURNS trigger AS $$
BEGIN
  IF NEW."breakGlass" AND (TG_OP = 'INSERT' OR NOT OLD."breakGlass") THEN
    PERFORM pg_advisory_xact_lock(hashtext('rem0te_break_glass'));
    IF (SELECT count(*) FROM "User" WHERE "breakGlass" AND "id" <> NEW."id") >= 2 THEN
      RAISE EXCEPTION 'at most two break-glass accounts' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "User_break_glass_limit" BEFORE INSERT OR UPDATE OF "breakGlass" ON "User"
  FOR EACH ROW EXECUTE FUNCTION rem0te_break_glass_limit();

ALTER TYPE "ActivityAction" ADD VALUE 'SSO_BACKCHANNEL_LOGOUT';
ALTER TYPE "ActivityAction" ADD VALUE 'SSO_SESSION_REVOKED';
ALTER TYPE "ActivityAction" ADD VALUE 'SSO_LOGOUT';
ALTER TYPE "ActivityAction" ADD VALUE 'SSO_STEP_UP';
ALTER TYPE "ActivityAction" ADD VALUE 'SSO_MODE_CHANGED';
ALTER TYPE "ActivityAction" ADD VALUE 'SSO_LINK_SUGGESTION_DISMISSED';
ALTER TYPE "ActivityAction" ADD VALUE 'BREAK_GLASS_CHANGED';
ALTER TYPE "ActivityAction" ADD VALUE 'BREAK_GLASS_LOGIN';
