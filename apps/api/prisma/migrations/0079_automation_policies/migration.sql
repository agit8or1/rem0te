-- v0.58: automation policies (recurring script runs and software installs).
--
-- The approval signer holds each signed document and decides every
-- occurrence's plan (actions/automation-policy.ts). These two tables are the
-- portal's mirror and its history: what it asked for, and which plan (an
-- ordinary ActionJob with its ActionTargets) each occurrence became.

ALTER TYPE "ActivityAction" ADD VALUE 'AUTOMATION_POLICY_CREATED';
ALTER TYPE "ActivityAction" ADD VALUE 'AUTOMATION_POLICY_UPDATED';
ALTER TYPE "ActivityAction" ADD VALUE 'AUTOMATION_POLICY_PAUSED';
ALTER TYPE "ActivityAction" ADD VALUE 'AUTOMATION_POLICY_RESUMED';
ALTER TYPE "ActivityAction" ADD VALUE 'AUTOMATION_POLICY_REVOKED';
ALTER TYPE "ActivityAction" ADD VALUE 'AUTOMATION_POLICY_SUPERSEDED';
ALTER TYPE "ActivityAction" ADD VALUE 'AUTOMATION_RUN_PROPOSED';
ALTER TYPE "ActivityAction" ADD VALUE 'AUTOMATION_RUN_REFUSED';

CREATE TABLE "AutomationPolicy" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "customerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "taskKind" TEXT NOT NULL,
    "document" JSONB NOT NULL,
    "digest" TEXT NOT NULL,
    "status" "PatchPolicyStatus" NOT NULL DEFAULT 'AWAITING_APPROVAL',
    "approvalUrl" TEXT NOT NULL,
    "approvals" JSONB,
    "direct" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT NOT NULL,
    "pausedAt" TIMESTAMP(3),
    "pausedById" TEXT,
    "pauseReason" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "revokeReason" TEXT,
    "signerRevokedAt" TIMESTAMP(3),
    "supersedesId" TEXT,
    "supersededAt" TIMESTAMP(3),
    "lastProposal" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomationPolicy_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AutomationPolicy_id_check" CHECK ("id" ~ '^[a-f0-9]{32}$'),
    CONSTRAINT "AutomationPolicy_taskKind_check" CHECK ("taskKind" IN ('script', 'software')),
    -- Revocation is one-way: a REVOKED row always says when.
    CONSTRAINT "AutomationPolicy_revoked_check" CHECK ("status" <> 'REVOKED' OR "revokedAt" IS NOT NULL)
);

CREATE INDEX "AutomationPolicy_customerId_createdAt_idx" ON "AutomationPolicy"("customerId", "createdAt");
CREATE INDEX "AutomationPolicy_status_idx" ON "AutomationPolicy"("status");

-- A revoked policy never leaves REVOKED (nothing un-revokes, here or on the signer).
CREATE FUNCTION "automation_policy_revoked_final"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" = 'REVOKED' AND NEW."status" <> 'REVOKED' THEN
    RAISE EXCEPTION 'a revoked automation policy cannot be reactivated; approve a new one' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "AutomationPolicy_revoked_final" BEFORE UPDATE OF "status" ON "AutomationPolicy"
  FOR EACH ROW EXECUTE FUNCTION "automation_policy_revoked_final"();

CREATE TABLE "AutomationOccurrence" (
    "id" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "occurrenceKey" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "jobId" TEXT,
    "ok" BOOLEAN NOT NULL,
    "code" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "targets" INTEGER NOT NULL DEFAULT 0,
    "skipped" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomationOccurrence_pkey" PRIMARY KEY ("id"),
    -- The signer signs at most three plans per occurrence; the portal asks no
    -- more. Attempt 0 is the occurrence's note when no plan was made.
    CONSTRAINT "AutomationOccurrence_attempt_check" CHECK ("attempt" BETWEEN 0 AND 3),
    -- A plan row names its plan; a note names none.
    CONSTRAINT "AutomationOccurrence_job_check" CHECK (("attempt" = 0) = ("jobId" IS NULL)),
    CONSTRAINT "AutomationOccurrence_targets_check" CHECK ("targets" BETWEEN 0 AND 25)
);

CREATE UNIQUE INDEX "AutomationOccurrence_policyId_occurrenceKey_attempt_key" ON "AutomationOccurrence"("policyId", "occurrenceKey", "attempt");
CREATE INDEX "AutomationOccurrence_policyId_createdAt_idx" ON "AutomationOccurrence"("policyId", "createdAt");
CREATE INDEX "AutomationOccurrence_jobId_idx" ON "AutomationOccurrence"("jobId");

ALTER TABLE "AutomationOccurrence" ADD CONSTRAINT "AutomationOccurrence_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "AutomationPolicy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
