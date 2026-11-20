-- v0.71: Managed Secure Access grants and the long-poll channel
-- (docs/managed-secure-access.md, build step 3), behind MSA_GRANTS, off.
--
-- MsaGrantKey holds the portal's Ed25519 grant key: a dedicated key, separate
-- from the approval signer's and from the session secrets, generated lazily on
-- the first issuance while the flag is on. Its private key is sealed
-- (secret-box purpose rem0te-msa-grant-key-v1). At most one is active.
--
-- MsaGrant is one signed session grant. Nothing on a computer acts on one in
-- 0.71: the agent build has no poller. The envelope (which carries the
-- one-time password) and the password are stored only sealed.

ALTER TYPE "ActivityAction" ADD VALUE 'MSA_GRANT_KEY_CREATED';
ALTER TYPE "ActivityAction" ADD VALUE 'MSA_GRANT_ISSUED';

CREATE TABLE "MsaGrantKey" (
    "id" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "privateKeyEnc" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retiredAt" TIMESTAMP(3),

    CONSTRAINT "MsaGrantKey_pkey" PRIMARY KEY ("id"),
    -- msa/grant.ts KEY_ID_RE; a raw 32-byte key is 44 base64 characters.
    CONSTRAINT "MsaGrantKey_keyId_check" CHECK ("keyId" ~ '^[0-9a-f]{16}$'),
    CONSTRAINT "MsaGrantKey_publicKey_check" CHECK ("publicKey" ~ '^[A-Za-z0-9+/]{43}=$'),
    -- secret-box's iv:tag:ciphertext, never a PEM in the clear.
    CONSTRAINT "MsaGrantKey_privateKeyEnc_check" CHECK ("privateKeyEnc" ~ '^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$'),
    CONSTRAINT "MsaGrantKey_retired_check" CHECK ("retiredAt" IS NULL OR "retiredAt" >= "createdAt")
);
CREATE UNIQUE INDEX "MsaGrantKey_keyId_key" ON "MsaGrantKey"("keyId");
-- At most one active key.
CREATE UNIQUE INDEX "MsaGrantKey_one_active" ON "MsaGrantKey" ((true)) WHERE "retiredAt" IS NULL;

CREATE TABLE "MsaGrant" (
    "id" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "technicianId" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "permissions" JSONB NOT NULL,
    "consent" TEXT NOT NULL,
    "notBefore" TIMESTAMP(3) NOT NULL,
    "notAfter" TIMESTAMP(3) NOT NULL,
    "maxMinutes" INTEGER NOT NULL,
    "idleMinutes" INTEGER NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'issued',
    "envelopeEnc" TEXT NOT NULL,
    "passwordEnc" TEXT NOT NULL,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MsaGrant_pkey" PRIMARY KEY ("id"),
    -- msa/grant.ts: GRANT_ID_RE, ENTITY_ID_RE, MODES, CONSENTS, the window and the limits.
    CONSTRAINT "MsaGrant_id_check" CHECK ("id" ~ '^[0-9a-f]{32}$'),
    CONSTRAINT "MsaGrant_businessId_check" CHECK ("businessId" ~ '^[a-z0-9]{20,40}$'),
    CONSTRAINT "MsaGrant_technicianId_check" CHECK ("technicianId" ~ '^[a-z0-9]{20,40}$'),
    CONSTRAINT "MsaGrant_mode_check" CHECK ("mode" IN ('view', 'control')),
    CONSTRAINT "MsaGrant_consent_check" CHECK ("consent" IN ('required', 'not_required')),
    CONSTRAINT "MsaGrant_permissions_check" CHECK (
      jsonb_typeof("permissions") = 'object'
      AND "permissions" ?& ARRAY['clipboard', 'files', 'audio', 'tunnel', 'restart']
      AND "permissions" - ARRAY['clipboard', 'files', 'audio', 'tunnel', 'restart'] = '{}'::jsonb
      AND jsonb_typeof("permissions"->'clipboard') = 'boolean' AND jsonb_typeof("permissions"->'files') = 'boolean'
      AND jsonb_typeof("permissions"->'audio') = 'boolean' AND jsonb_typeof("permissions"->'tunnel') = 'boolean'
      AND jsonb_typeof("permissions"->'restart') = 'boolean'),
    CONSTRAINT "MsaGrant_window_check" CHECK ("notAfter" > "notBefore" AND "notAfter" - "notBefore" <= interval '5 minutes'),
    CONSTRAINT "MsaGrant_maxMinutes_check" CHECK ("maxMinutes" BETWEEN 1 AND 480),
    CONSTRAINT "MsaGrant_idleMinutes_check" CHECK ("idleMinutes" BETWEEN 1 AND 120 AND "idleMinutes" <= "maxMinutes"),
    -- Steps 4 and 5 add applied, failed and revoked; nothing in 0.71 produces them.
    CONSTRAINT "MsaGrant_state_check" CHECK ("state" IN ('issued', 'delivered', 'expired', 'cancelled')),
    CONSTRAINT "MsaGrant_delivered_check" CHECK (("state" = 'delivered') = ("deliveredAt" IS NOT NULL)),
    CONSTRAINT "MsaGrant_envelopeEnc_check" CHECK ("envelopeEnc" ~ '^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$'),
    CONSTRAINT "MsaGrant_passwordEnc_check" CHECK ("passwordEnc" ~ '^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$')
);

CREATE INDEX "MsaGrant_endpointId_state_idx" ON "MsaGrant"("endpointId", "state");
CREATE INDEX "MsaGrant_endpointId_createdAt_idx" ON "MsaGrant"("endpointId", "createdAt");
ALTER TABLE "MsaGrant" ADD CONSTRAINT "MsaGrant_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MsaGrant" ADD CONSTRAINT "MsaGrant_keyId_fkey" FOREIGN KEY ("keyId") REFERENCES "MsaGrantKey"("keyId") ON DELETE RESTRICT ON UPDATE CASCADE;
