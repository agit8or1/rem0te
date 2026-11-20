-- v0.72: Managed Secure Access build step 4 — agent enforcement, the managed
-- test session, cutover and rollback (docs/managed-secure-access.md §3.3,
-- §3.7, §3.11), behind MSA_GRANTS, off.
--
-- MsaManagedComputer is a computer's mode when it is not Legacy (no row is
-- Legacy, the default). A Platform Admin moves ONE computer at a time into
-- `pending`; nothing moves a group, a business or the fleet, and nothing moves
-- a computer by itself.
--
-- MsaGrant gains the agent's outcomes: applied (every setting read back and
-- the one-time password set), failed (refused, or a readback disagreed) and
-- ended (the agent set a password nobody is told and stopped the service).

ALTER TYPE "ActivityAction" ADD VALUE 'MSA_GRANT_KEY_ENSURED';
ALTER TYPE "ActivityAction" ADD VALUE 'MSA_CUTOVER';
ALTER TYPE "ActivityAction" ADD VALUE 'MSA_VERIFIED';
ALTER TYPE "ActivityAction" ADD VALUE 'MSA_ROLLBACK_REQUESTED';
ALTER TYPE "ActivityAction" ADD VALUE 'MSA_ROLLED_BACK';
ALTER TYPE "ActivityAction" ADD VALUE 'MSA_GRANT_APPLIED';
ALTER TYPE "ActivityAction" ADD VALUE 'MSA_GRANT_FAILED';
ALTER TYPE "ActivityAction" ADD VALUE 'MSA_SESSION_CONNECTED';
ALTER TYPE "ActivityAction" ADD VALUE 'MSA_SESSION_ENDED';
ALTER TYPE "ActivityAction" ADD VALUE 'MSA_ENFORCEMENT_FAILURE';
ALTER TYPE "ActivityAction" ADD VALUE 'MSA_LEGACY_SECURED';
ALTER TYPE "ActivityAction" ADD VALUE 'MSA_PASSWORD_REVEALED';

-- ── MsaGrant: the agent's outcomes ─────────────────────────────────────────
ALTER TABLE "MsaGrant" ADD COLUMN "appliedAt" TIMESTAMP(3);
ALTER TABLE "MsaGrant" ADD COLUMN "connectedAt" TIMESTAMP(3);
ALTER TABLE "MsaGrant" ADD COLUMN "endedAt" TIMESTAMP(3);
ALTER TABLE "MsaGrant" ADD COLUMN "outcome" TEXT;
ALTER TABLE "MsaGrant" ADD COLUMN "failedKeys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "MsaGrant" ADD COLUMN "revealedAt" TIMESTAMP(3);
ALTER TABLE "MsaGrant" ADD COLUMN "revealedById" TEXT;

ALTER TABLE "MsaGrant" DROP CONSTRAINT "MsaGrant_state_check";
ALTER TABLE "MsaGrant" ADD CONSTRAINT "MsaGrant_state_check"
  CHECK ("state" IN ('issued', 'delivered', 'expired', 'cancelled', 'applied', 'failed', 'ended'));
-- A grant the agent acted on was delivered to it; one never delivered was not.
ALTER TABLE "MsaGrant" DROP CONSTRAINT "MsaGrant_delivered_check";
ALTER TABLE "MsaGrant" ADD CONSTRAINT "MsaGrant_delivered_check"
  CHECK (("state" IN ('issued', 'expired', 'cancelled')) = ("deliveredAt" IS NULL));
ALTER TABLE "MsaGrant" ADD CONSTRAINT "MsaGrant_applied_check"
  CHECK (("state" <> 'applied' OR "appliedAt" IS NOT NULL) AND ("connectedAt" IS NULL OR "appliedAt" IS NOT NULL));
ALTER TABLE "MsaGrant" ADD CONSTRAINT "MsaGrant_ended_check" CHECK (("state" = 'ended') = ("endedAt" IS NOT NULL));
ALTER TABLE "MsaGrant" ADD CONSTRAINT "MsaGrant_failed_check" CHECK ("state" <> 'failed' OR "outcome" IS NOT NULL);
-- msa/managed.ts OUTCOMES: closed codes, never text from the computer.
ALTER TABLE "MsaGrant" ADD CONSTRAINT "MsaGrant_outcome_check" CHECK ("outcome" IS NULL OR "outcome" ~ '^[a-z_]{1,40}$');
-- msa/preflight.ts PREFLIGHT_KEYS plus the password: nothing else is a key.
ALTER TABLE "MsaGrant" ADD CONSTRAINT "MsaGrant_failedKeys_check" CHECK (
  cardinality("failedKeys") <= 12 AND "failedKeys" <@ ARRAY['access-mode', 'enable-keyboard', 'enable-clipboard', 'enable-file-transfer',
  'enable-audio', 'enable-tunnel', 'enable-remote-restart', 'approve-mode', 'verification-method', 'allow-auto-disconnect',
  'auto-disconnect-timeout', 'password']::TEXT[]);
-- Revealed only once the agent applied it, and to someone.
ALTER TABLE "MsaGrant" ADD CONSTRAINT "MsaGrant_revealed_check"
  CHECK (("revealedAt" IS NULL) = ("revealedById" IS NULL) AND ("revealedAt" IS NULL OR "appliedAt" IS NOT NULL));

-- ── MsaManagedComputer ─────────────────────────────────────────────────────
CREATE TABLE "MsaManagedComputer" (
    "endpointId" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedAt" TIMESTAMP(3),
    "verifiedById" TEXT,
    "legacySecuredAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "failReason" TEXT,
    "failedKeys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "rollbackRequestedAt" TIMESTAMP(3),
    "rollbackRequestedById" TEXT,
    "readbackOkAt" TIMESTAMP(3),
    "lastReportAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MsaManagedComputer_pkey" PRIMARY KEY ("endpointId"),
    CONSTRAINT "MsaManagedComputer_state_check" CHECK ("state" IN ('pending', 'verified', 'enforcement_failure', 'rollback_pending')),
    -- Verified means a Platform Admin confirmed it after a managed test session.
    CONSTRAINT "MsaManagedComputer_verified_check"
      CHECK (("state" <> 'verified' OR "verifiedAt" IS NOT NULL) AND ("verifiedAt" IS NULL) = ("verifiedById" IS NULL)),
    CONSTRAINT "MsaManagedComputer_failure_check"
      CHECK ("state" <> 'enforcement_failure' OR ("failedAt" IS NOT NULL AND "failReason" IS NOT NULL)),
    CONSTRAINT "MsaManagedComputer_rollback_check"
      CHECK (("state" = 'rollback_pending') = ("rollbackRequestedAt" IS NOT NULL) AND ("rollbackRequestedAt" IS NULL) = ("rollbackRequestedById" IS NULL)),
    CONSTRAINT "MsaManagedComputer_failReason_check" CHECK ("failReason" IS NULL OR "failReason" ~ '^[a-z_]{1,40}$'),
    CONSTRAINT "MsaManagedComputer_failedKeys_check" CHECK (
      cardinality("failedKeys") <= 12 AND "failedKeys" <@ ARRAY['access-mode', 'enable-keyboard', 'enable-clipboard', 'enable-file-transfer',
      'enable-audio', 'enable-tunnel', 'enable-remote-restart', 'approve-mode', 'verification-method', 'allow-auto-disconnect',
      'auto-disconnect-timeout', 'password']::TEXT[]),
    CONSTRAINT "MsaManagedComputer_secured_check" CHECK ("legacySecuredAt" IS NULL OR "verifiedAt" IS NOT NULL)
);
ALTER TABLE "MsaManagedComputer" ADD CONSTRAINT "MsaManagedComputer_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Only a computer assigned to a business can be managed (§70: the pool is
-- never reached). The service checks it first; this is the backstop.
CREATE FUNCTION "MsaManagedComputer_assigned"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "Endpoint" e WHERE e."id" = NEW."endpointId" AND e."tenantId" IS NOT NULL AND e."customerId" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'MsaManagedComputer: % is not assigned to a business', NEW."endpointId";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "MsaManagedComputer_assigned" BEFORE INSERT ON "MsaManagedComputer" FOR EACH ROW EXECUTE FUNCTION "MsaManagedComputer_assigned"();
