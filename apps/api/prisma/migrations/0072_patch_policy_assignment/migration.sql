-- v0.50: company-wide patch policies and a Patch policy setting per computer.
--
-- A PatchPolicySeries is a policy that revises itself: scope 'business'
-- covers every computer of the business whose setting is Inherit, scope
-- 'assigned' covers the computers set to use it. Each revision is an
-- ordinary PatchPolicy — a closed, signed list of named computers, proposed
-- through the same path as a policy made by hand. The signer's guarantee is
-- unchanged: it signs ring plans only inside the document it holds.
--
-- The database holds the rules so no code path can break them:
--
--   * Endpoint_patch_policy_mode (CHECK): the setting is exactly 'inherit',
--     'exclude' or 'policy', and names a series exactly when it is 'policy'.
--   * endpoint_patch_policy_series (BEFORE INSERT OR UPDATE): the named series
--     is an active 'assigned' series of the computer's own business when the
--     setting is written. A computer that changes business goes back to
--     Inherit first. SQLSTATE 23514.
--   * PatchPolicySeries_scope / _status (CHECK), and
--     PatchPolicySeries_one_business (partial UNIQUE): one active company-wide
--     policy per business.
--   * PatchPolicyComputer_one_live (partial UNIQUE): a computer is in at most
--     one live policy — the one the sweep may patch it under.
--   * patch_policy_computer_live (BEFORE INSERT OR UPDATE): a live row only
--     for an ACTIVE policy; patch_policy_release (AFTER UPDATE OF status):
--     a policy that stops being ACTIVE releases every live row it held.
--   * The series foreign keys are NO ACTION, so deleting a business still
--     cascades through policies and series, but nothing else deletes a series
--     with revisions or computers pointing at it.
--
-- Backfill: every existing policy's computers get rows; an ACTIVE policy's
-- are live, oldest policy first. Where two existing active policies named the
-- same computer (possible before 0.50), the older keeps it and the newer's
-- sweep leaves it out ("in another active policy").

-- AlterEnum
ALTER TYPE "ActivityAction" ADD VALUE 'PATCH_POLICY_SUPERSEDED';
ALTER TYPE "ActivityAction" ADD VALUE 'PATCH_POLICY_SERIES_CREATED';
ALTER TYPE "ActivityAction" ADD VALUE 'PATCH_POLICY_SERIES_RETIRED';
ALTER TYPE "ActivityAction" ADD VALUE 'PATCH_POLICY_OVERRIDE_SET';

-- AlterTable
ALTER TABLE "Endpoint" ADD COLUMN     "patchPolicyMode" TEXT NOT NULL DEFAULT 'inherit',
ADD COLUMN     "patchPolicySeriesId" TEXT;

-- AlterTable
ALTER TABLE "PatchPolicy" ADD COLUMN     "revision" INTEGER,
ADD COLUMN     "seriesId" TEXT,
ADD COLUMN     "supersededAt" TIMESTAMP(3),
ADD COLUMN     "supersedesId" TEXT;

-- CreateTable
CREATE TABLE "PatchPolicySeries" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "customerId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "settings" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdById" TEXT NOT NULL,
    "currentPolicyId" TEXT,
    "lastRevision" INTEGER NOT NULL DEFAULT 0,
    "settleFingerprint" TEXT,
    "settleSince" TIMESTAMP(3),
    "lastCheck" JSONB,
    "retiredAt" TIMESTAMP(3),
    "retiredById" TEXT,
    "retireReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PatchPolicySeries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PatchPolicyComputer" (
    "policyId" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "ring" INTEGER NOT NULL,
    "live" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PatchPolicyComputer_pkey" PRIMARY KEY ("policyId","endpointId")
);

-- CreateTable
CREATE TABLE "PatchPolicyRevisionClaim" (
    "customerId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PatchPolicyRevisionClaim_pkey" PRIMARY KEY ("customerId")
);

-- CreateIndex
CREATE UNIQUE INDEX "PatchPolicySeries_currentPolicyId_key" ON "PatchPolicySeries"("currentPolicyId");
CREATE INDEX "PatchPolicySeries_customerId_status_idx" ON "PatchPolicySeries"("customerId", "status");
CREATE INDEX "PatchPolicyComputer_endpointId_idx" ON "PatchPolicyComputer"("endpointId");
CREATE UNIQUE INDEX "PatchPolicy_seriesId_revision_key" ON "PatchPolicy"("seriesId", "revision");

-- AddForeignKey
ALTER TABLE "Endpoint" ADD CONSTRAINT "Endpoint_patchPolicySeriesId_fkey" FOREIGN KEY ("patchPolicySeriesId") REFERENCES "PatchPolicySeries"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "PatchPolicy" ADD CONSTRAINT "PatchPolicy_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "PatchPolicySeries"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "PatchPolicySeries" ADD CONSTRAINT "PatchPolicySeries_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PatchPolicyComputer" ADD CONSTRAINT "PatchPolicyComputer_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "PatchPolicy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PatchPolicyComputer" ADD CONSTRAINT "PatchPolicyComputer_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The rules.
ALTER TABLE "Endpoint" ADD CONSTRAINT "Endpoint_patch_policy_mode"
  CHECK ("patchPolicyMode" IN ('inherit', 'exclude', 'policy')
     AND (("patchPolicyMode" = 'policy') = ("patchPolicySeriesId" IS NOT NULL)));

ALTER TABLE "PatchPolicySeries" ADD CONSTRAINT "PatchPolicySeries_scope" CHECK ("scope" IN ('business', 'assigned'));
ALTER TABLE "PatchPolicySeries" ADD CONSTRAINT "PatchPolicySeries_status" CHECK ("status" IN ('active', 'retired'));
CREATE UNIQUE INDEX "PatchPolicySeries_one_business" ON "PatchPolicySeries"("customerId") WHERE "scope" = 'business' AND "status" = 'active';

ALTER TABLE "PatchPolicy" ADD CONSTRAINT "PatchPolicy_series_revision"
  CHECK (("seriesId" IS NULL) = ("revision" IS NULL) AND ("revision" IS NULL OR "revision" >= 1));

CREATE UNIQUE INDEX "PatchPolicyComputer_one_live" ON "PatchPolicyComputer"("endpointId") WHERE "live";

CREATE OR REPLACE FUNCTION endpoint_patch_policy_series() RETURNS trigger AS $$
DECLARE s RECORD;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."customerId" IS DISTINCT FROM OLD."customerId" THEN
    NEW."patchPolicyMode" := 'inherit';
    NEW."patchPolicySeriesId" := NULL;
  END IF;
  -- Checked when the setting is written; a series retired later leaves the
  -- setting in place (the computer then has no automatic patching).
  IF NEW."patchPolicySeriesId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."patchPolicySeriesId" IS DISTINCT FROM OLD."patchPolicySeriesId") THEN
    SELECT "customerId", "scope", "status" INTO s FROM "PatchPolicySeries" WHERE "id" = NEW."patchPolicySeriesId";
    IF NOT FOUND OR s."customerId" IS DISTINCT FROM NEW."customerId" OR s."scope" <> 'assigned' OR s."status" <> 'active' THEN
      RAISE EXCEPTION 'a computer may use only an active assignable patch policy of its own business' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER endpoint_patch_policy_series BEFORE INSERT OR UPDATE OF "patchPolicySeriesId", "patchPolicyMode", "customerId" ON "Endpoint"
  FOR EACH ROW EXECUTE FUNCTION endpoint_patch_policy_series();

CREATE OR REPLACE FUNCTION patch_policy_computer_live() RETURNS trigger AS $$
BEGIN
  IF NEW."live" AND NOT EXISTS (SELECT 1 FROM "PatchPolicy" WHERE "id" = NEW."policyId" AND "status" = 'ACTIVE') THEN
    RAISE EXCEPTION 'a computer is live only in an ACTIVE patch policy' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER patch_policy_computer_live BEFORE INSERT OR UPDATE ON "PatchPolicyComputer"
  FOR EACH ROW EXECUTE FUNCTION patch_policy_computer_live();

CREATE OR REPLACE FUNCTION patch_policy_release() RETURNS trigger AS $$
BEGIN
  IF NEW."status" <> 'ACTIVE' THEN
    UPDATE "PatchPolicyComputer" SET "live" = false WHERE "policyId" = NEW."id" AND "live";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER patch_policy_release AFTER UPDATE OF "status" ON "PatchPolicy"
  FOR EACH ROW WHEN (NEW."status" IS DISTINCT FROM OLD."status") EXECUTE FUNCTION patch_policy_release();

-- Backfill, oldest policy first.
INSERT INTO "PatchPolicyComputer" ("policyId", "endpointId", "customerId", "ring", "live")
SELECT p."id", c->>'endpointId', p."customerId", (r.ord - 1)::int, p."status" = 'ACTIVE'
FROM "PatchPolicy" p
CROSS JOIN LATERAL jsonb_array_elements(p."document"->'rings') WITH ORDINALITY AS r(ring, ord)
CROSS JOIN LATERAL jsonb_array_elements(r.ring) AS c
WHERE EXISTS (SELECT 1 FROM "Endpoint" e WHERE e."id" = c->>'endpointId')
ORDER BY p."createdAt" ASC
ON CONFLICT ("endpointId") WHERE "live" DO NOTHING;
