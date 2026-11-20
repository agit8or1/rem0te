-- v0.73: Managed Secure Access build step 5 — Connect through grants,
-- revocation, session evidence and cutover runs (docs/managed-secure-access.md
-- §3.2–§3.5, §3.11), behind MSA_GRANTS, off.
--
-- MsaGrant gains where it came from (a Platform Admin's test, a person's
-- Connect, a cutover run's verification), the launch mode the policy
-- decided, the evidence the agent reports (received) and the portal records
-- (launched), and revocation (revoked, by whom, why).
--
-- MsaRevocation is a signed revocation handed to ONE computer's agent over
-- the long-poll: it can only end sessions. It carries no secret.
--
-- MsaCutoverRun / MsaCutoverMember move a device group or a business into
-- Managed Secure Access a batch at a time, canary first; each computer still
-- goes through the one-computer cutover and its blockers.

ALTER TYPE "ActivityAction" ADD VALUE 'MSA_SESSION_REQUESTED';
ALTER TYPE "ActivityAction" ADD VALUE 'MSA_PASSWORD_RELEASED';
ALTER TYPE "ActivityAction" ADD VALUE 'MSA_SESSION_REVOKED';
ALTER TYPE "ActivityAction" ADD VALUE 'MSA_CUTOVER_RUN_STARTED';
ALTER TYPE "ActivityAction" ADD VALUE 'MSA_CUTOVER_RUN_ADVANCED';
ALTER TYPE "ActivityAction" ADD VALUE 'MSA_CUTOVER_RUN_CONFIRMED';
ALTER TYPE "ActivityAction" ADD VALUE 'MSA_CUTOVER_RUN_HALTED';
ALTER TYPE "ActivityAction" ADD VALUE 'MSA_CUTOVER_RUN_ROLLED_BACK';

-- ── MsaGrant ───────────────────────────────────────────────────────────────
ALTER TABLE "MsaGrant" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'test';
ALTER TABLE "MsaGrant" ADD COLUMN "launchMode" TEXT;
ALTER TABLE "MsaGrant" ADD COLUMN "receivedAt" TIMESTAMP(3);
ALTER TABLE "MsaGrant" ADD COLUMN "launchedAt" TIMESTAMP(3);
ALTER TABLE "MsaGrant" ADD COLUMN "revokedAt" TIMESTAMP(3);
ALTER TABLE "MsaGrant" ADD COLUMN "revokedById" TEXT;
ALTER TABLE "MsaGrant" ADD COLUMN "revokeReason" TEXT;

ALTER TABLE "MsaGrant" ADD CONSTRAINT "MsaGrant_source_check" CHECK ("source" IN ('test', 'connect', 'verify'));
-- The launch mode the policy decided, exactly for a Connect grant.
ALTER TABLE "MsaGrant" ADD CONSTRAINT "MsaGrant_launchMode_check"
  CHECK (("source" = 'connect') = ("launchMode" IS NOT NULL) AND ("launchMode" IS NULL OR "launchMode" IN ('view_only', 'control', 'unattended')));

ALTER TABLE "MsaGrant" DROP CONSTRAINT "MsaGrant_state_check";
ALTER TABLE "MsaGrant" ADD CONSTRAINT "MsaGrant_state_check"
  CHECK ("state" IN ('issued', 'delivered', 'expired', 'cancelled', 'applied', 'failed', 'ended', 'revoked'));
-- A revoked grant may or may not have reached the computer; every other
-- state says exactly whether it did.
ALTER TABLE "MsaGrant" DROP CONSTRAINT "MsaGrant_delivered_check";
ALTER TABLE "MsaGrant" ADD CONSTRAINT "MsaGrant_delivered_check"
  CHECK ("state" = 'revoked' OR (("state" IN ('issued', 'expired', 'cancelled')) = ("deliveredAt" IS NULL)));
-- Ended means the agent ended it; a revoked session the agent ended keeps
-- state revoked and gains endedAt.
ALTER TABLE "MsaGrant" DROP CONSTRAINT "MsaGrant_ended_check";
ALTER TABLE "MsaGrant" ADD CONSTRAINT "MsaGrant_ended_check"
  CHECK (("state" <> 'ended' OR "endedAt" IS NOT NULL) AND ("endedAt" IS NULL OR "state" IN ('ended', 'revoked')));
ALTER TABLE "MsaGrant" ADD CONSTRAINT "MsaGrant_revoked_check"
  CHECK (("state" = 'revoked') = ("revokedAt" IS NOT NULL) AND ("revokedAt" IS NULL) = ("revokeReason" IS NULL)
    AND ("revokeReason" IS NULL OR "revokeReason" IN ('session', 'technician', 'business', 'computer', 'pause', 'timeout')));
-- Launched (the one-time password left the server) only once the agent
-- applied it, and only with the release recorded.
ALTER TABLE "MsaGrant" ADD CONSTRAINT "MsaGrant_launched_check"
  CHECK ("launchedAt" IS NULL OR ("appliedAt" IS NOT NULL AND "revealedAt" IS NOT NULL));

CREATE INDEX "MsaGrant_technicianId_state_idx" ON "MsaGrant" ("technicianId", "state");
CREATE INDEX "MsaGrant_businessId_state_idx" ON "MsaGrant" ("businessId", "state");

-- ── MsaRevocation ──────────────────────────────────────────────────────────
CREATE TABLE "MsaRevocation" (
    "id" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "all" BOOLEAN NOT NULL,
    "grantIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "notAfter" TIMESTAMP(3) NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'issued',
    "envelope" TEXT NOT NULL,
    "deliveredAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MsaRevocation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MsaRevocation_id_check" CHECK ("id" ~ '^[0-9a-f]{32}$'),
    CONSTRAINT "MsaRevocation_state_check" CHECK ("state" IN ('issued', 'delivered', 'expired')),
    CONSTRAINT "MsaRevocation_delivered_check" CHECK (("state" = 'delivered') = ("deliveredAt" IS NOT NULL)),
    CONSTRAINT "MsaRevocation_reason_check" CHECK ("reason" IN ('session', 'technician', 'business', 'computer', 'pause', 'timeout')),
    CONSTRAINT "MsaRevocation_shape_check" CHECK (cardinality("grantIds") <= 20 AND ("all" OR cardinality("grantIds") > 0)),
    CONSTRAINT "MsaRevocation_window_check" CHECK ("notAfter" > "issuedAt" AND "notAfter" - "issuedAt" <= interval '9 hours')
);
ALTER TABLE "MsaRevocation" ADD CONSTRAINT "MsaRevocation_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MsaRevocation" ADD CONSTRAINT "MsaRevocation_keyId_fkey" FOREIGN KEY ("keyId") REFERENCES "MsaGrantKey"("keyId") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "MsaRevocation_endpointId_state_idx" ON "MsaRevocation" ("endpointId", "state");

-- ── MsaManagedComputer ─────────────────────────────────────────────────────
-- The agent's last long-poll (Connect refuses an agent that is not polling),
-- and the cutover run that moved it, if one did.
ALTER TABLE "MsaManagedComputer" ADD COLUMN "lastPollAt" TIMESTAMP(3);
ALTER TABLE "MsaManagedComputer" ADD COLUMN "runId" TEXT;

-- ── Cutover runs ───────────────────────────────────────────────────────────
CREATE TABLE "MsaCutoverRun" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "groupId" TEXT,
    "canaryEndpointId" TEXT NOT NULL,
    "batchSize" INTEGER NOT NULL DEFAULT 5,
    "state" TEXT NOT NULL DEFAULT 'canary',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "canaryVerifiedAt" TIMESTAMP(3),
    "lastBatchAt" TIMESTAMP(3),
    "batches" INTEGER NOT NULL DEFAULT 0,
    "haltedAt" TIMESTAMP(3),
    "haltedById" TEXT,
    "completedAt" TIMESTAMP(3),
    "rolledBackAt" TIMESTAMP(3),
    "rolledBackById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MsaCutoverRun_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MsaCutoverRun_scope_check" CHECK (("scope" = 'group') = ("groupId" IS NOT NULL) AND "scope" IN ('group', 'business')),
    CONSTRAINT "MsaCutoverRun_state_check" CHECK ("state" IN ('canary', 'rolling', 'complete', 'halted', 'rolled_back')),
    CONSTRAINT "MsaCutoverRun_batch_check" CHECK ("batchSize" BETWEEN 1 AND 25),
    -- Nothing rolls before the canary was verified.
    CONSTRAINT "MsaCutoverRun_canary_check" CHECK ("state" IN ('canary', 'halted', 'rolled_back') OR "canaryVerifiedAt" IS NOT NULL),
    CONSTRAINT "MsaCutoverRun_batches_check" CHECK ("batches" = 0 OR "canaryVerifiedAt" IS NOT NULL),
    CONSTRAINT "MsaCutoverRun_halted_check" CHECK (("haltedAt" IS NULL) = ("haltedById" IS NULL)),
    CONSTRAINT "MsaCutoverRun_rolledBack_check" CHECK (("state" = 'rolled_back') = ("rolledBackAt" IS NOT NULL) AND ("rolledBackAt" IS NULL) = ("rolledBackById" IS NULL))
);
ALTER TABLE "MsaCutoverRun" ADD CONSTRAINT "MsaCutoverRun_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MsaCutoverRun" ADD CONSTRAINT "MsaCutoverRun_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "EndpointGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- One open run per business.
CREATE UNIQUE INDEX "MsaCutoverRun_one_open" ON "MsaCutoverRun" ("businessId") WHERE "state" IN ('canary', 'rolling');

CREATE TABLE "MsaCutoverMember" (
    "runId" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'queued',
    "canary" BOOLEAN NOT NULL DEFAULT false,
    "batch" INTEGER,
    "skipReason" TEXT,
    "cutAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MsaCutoverMember_pkey" PRIMARY KEY ("runId", "endpointId"),
    CONSTRAINT "MsaCutoverMember_state_check" CHECK ("state" IN ('queued', 'cut_over', 'verified', 'skipped', 'failed', 'rolled_back')),
    CONSTRAINT "MsaCutoverMember_skip_check" CHECK (("state" = 'skipped') = ("skipReason" IS NOT NULL) AND ("skipReason" IS NULL OR "skipReason" ~ '^[A-Z_]{1,40}$')),
    CONSTRAINT "MsaCutoverMember_cut_check" CHECK ("state" IN ('queued', 'skipped') OR "cutAt" IS NOT NULL),
    CONSTRAINT "MsaCutoverMember_verified_check" CHECK ("state" <> 'verified' OR "verifiedAt" IS NOT NULL)
);
ALTER TABLE "MsaCutoverMember" ADD CONSTRAINT "MsaCutoverMember_runId_fkey" FOREIGN KEY ("runId") REFERENCES "MsaCutoverRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MsaCutoverMember" ADD CONSTRAINT "MsaCutoverMember_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX "MsaCutoverMember_one_canary" ON "MsaCutoverMember" ("runId") WHERE "canary";

-- A run's computers are its business's (the service resolves them that way;
-- this is the backstop).
CREATE FUNCTION "MsaCutoverMember_same_business"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "MsaCutoverRun" r JOIN "Endpoint" e ON e."id" = NEW."endpointId"
    WHERE r."id" = NEW."runId" AND e."customerId" = r."businessId" AND e."tenantId" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'MsaCutoverMember: % is not in the run''s business', NEW."endpointId";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "MsaCutoverMember_same_business" BEFORE INSERT ON "MsaCutoverMember" FOR EACH ROW EXECUTE FUNCTION "MsaCutoverMember_same_business"();

ALTER TABLE "MsaManagedComputer" ADD CONSTRAINT "MsaManagedComputer_runId_fkey" FOREIGN KEY ("runId") REFERENCES "MsaCutoverRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
