-- CreateEnum
CREATE TYPE "ContainmentScope" AS ENUM ('GLOBAL', 'BUSINESS');

-- AlterEnum
ALTER TYPE "ActivityAction" ADD VALUE 'CONTAINMENT_PAUSED';
ALTER TYPE "ActivityAction" ADD VALUE 'CONTAINMENT_CLEARED';
ALTER TYPE "ActivityAction" ADD VALUE 'AUDIT_CHAIN_ALERT';

-- AlterTable
ALTER TABLE "ActivityLog" ADD COLUMN     "chainGap" JSONB,
ADD COLUMN     "chainHash" TEXT,
ADD COLUMN     "sealedAt" TIMESTAMP(3),
ADD COLUMN     "sealedRefs" JSONB,
ADD COLUMN     "seq" BIGINT;

-- Existing entries join the chain in the order they were written (a plain
-- BIGSERIAL would number them in physical order). The sealer hashes them
-- from seq 1 on its first pass.
UPDATE "ActivityLog" a SET "seq" = n.rn
FROM (SELECT "id", row_number() OVER (ORDER BY "createdAt", "id") AS rn FROM "ActivityLog") n
WHERE a."id" = n."id";
CREATE SEQUENCE "ActivityLog_seq_seq" OWNED BY "ActivityLog"."seq";
SELECT setval('"ActivityLog_seq_seq"', COALESCE((SELECT MAX("seq") FROM "ActivityLog"), 0) + 1, false);
ALTER TABLE "ActivityLog" ALTER COLUMN "seq" SET DEFAULT nextval('"ActivityLog_seq_seq"'), ALTER COLUMN "seq" SET NOT NULL;

-- CreateTable
CREATE TABLE "ContainmentPause" (
    "id" TEXT NOT NULL,
    "scope" "ContainmentScope" NOT NULL,
    "customerId" TEXT,
    "kinds" TEXT[],
    "reason" TEXT NOT NULL,
    "setById" TEXT NOT NULL,
    "setBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "signerRequestedAt" TIMESTAMP(3),
    "signerResult" TEXT,
    "clearedAt" TIMESTAMP(3),
    "clearedById" TEXT,
    "clearReason" TEXT,

    CONSTRAINT "ContainmentPause_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditChainState" (
    "id" TEXT NOT NULL,
    "headSeq" BIGINT NOT NULL DEFAULT 0,
    "headHash" TEXT NOT NULL DEFAULT '0000000000000000000000000000000000000000000000000000000000000000',
    "sealedAt" TIMESTAMP(3),
    "exportedThroughSeq" BIGINT NOT NULL DEFAULT 0,
    "exportedAt" TIMESTAMP(3),
    "exportError" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "verifiedThroughSeq" BIGINT NOT NULL DEFAULT 0,
    "verifyResult" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuditChainState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditCheckpoint" (
    "id" TEXT NOT NULL,
    "seq" BIGINT NOT NULL,
    "hash" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "keyId" TEXT,
    "signature" TEXT,

    CONSTRAINT "AuditCheckpoint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContainmentPause_scope_clearedAt_idx" ON "ContainmentPause"("scope", "clearedAt");

-- CreateIndex
CREATE INDEX "ContainmentPause_customerId_clearedAt_idx" ON "ContainmentPause"("customerId", "clearedAt");

-- CreateIndex
CREATE INDEX "AuditCheckpoint_seq_idx" ON "AuditCheckpoint"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "ActivityLog_seq_key" ON "ActivityLog"("seq");

-- AddForeignKey
ALTER TABLE "ContainmentPause" ADD CONSTRAINT "ContainmentPause_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- A sealed audit entry cannot be changed. The only changes allowed are the
-- ones deleting a business or a user already make (setting customerId,
-- actorId or tenantId to NULL); the chain hashes the values as sealed, kept
-- in sealedRefs. Deleting a row is not prevented here — it is detected, by
-- the gap it leaves in seq and by the copy exported off the host.
CREATE OR REPLACE FUNCTION rem0te_audit_sealed_guard() RETURNS trigger AS $$
BEGIN
  IF OLD."chainHash" IS NULL THEN RETURN NEW; END IF;
  IF NEW."chainHash" IS DISTINCT FROM OLD."chainHash" OR NEW."sealedRefs"::text IS DISTINCT FROM OLD."sealedRefs"::text
     OR NEW."chainGap"::text IS DISTINCT FROM OLD."chainGap"::text OR NEW."sealedAt" IS DISTINCT FROM OLD."sealedAt"
     OR NEW."seq" <> OLD."seq" OR NEW."id" <> OLD."id" OR NEW."createdAt" <> OLD."createdAt" OR NEW."action" <> OLD."action"
     OR NEW."actorIp" IS DISTINCT FROM OLD."actorIp" OR NEW."actorAgent" IS DISTINCT FROM OLD."actorAgent"
     OR NEW."resource" IS DISTINCT FROM OLD."resource" OR NEW."resourceId" IS DISTINCT FROM OLD."resourceId"
     OR NEW."metadata"::text IS DISTINCT FROM OLD."metadata"::text
     OR (NEW."tenantId" IS DISTINCT FROM OLD."tenantId" AND NEW."tenantId" IS NOT NULL)
     OR (NEW."customerId" IS DISTINCT FROM OLD."customerId" AND NEW."customerId" IS NOT NULL)
     OR (NEW."actorId" IS DISTINCT FROM OLD."actorId" AND NEW."actorId" IS NOT NULL)
  THEN
    RAISE EXCEPTION 'rem0te: sealed audit entry % cannot be changed', OLD."seq" USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER "ActivityLog_sealed_guard" BEFORE UPDATE ON "ActivityLog"
  FOR EACH ROW EXECUTE FUNCTION rem0te_audit_sealed_guard();

INSERT INTO "AuditChainState" ("id", "updatedAt") VALUES ('chain', CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING;
