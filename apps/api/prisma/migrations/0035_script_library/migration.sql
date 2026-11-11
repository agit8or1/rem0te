-- The script library: scripts, immutable versions, and review. Nothing here
-- runs a script (docs/script-library.md). The rules that matter most are
-- enforced here as well as in the service, so a bug in the portal, or a
-- careless hand in psql, cannot quietly break them:
--   - a version's content, hashes, definition and authorship never change;
--   - the content hash is the SHA-256 of the stored content;
--   - status moves only DRAFT→IN_REVIEW, IN_REVIEW→DRAFT,
--     IN_REVIEW→APPROVED and IN_REVIEW→REJECTED; APPROVED and REJECTED are final;
--   - an approved version names an approver who contributed none of its
--     content, and the hash they approved is the version's own.
-- Someone who owns the database can still drop the trigger. That is why the
-- library's approval is evidence of a review, never what lets a computer run
-- anything: only the approval signer's envelope does that.

-- CreateEnum
CREATE TYPE "ScriptScope" AS ENUM ('GLOBAL', 'BUSINESS');

-- CreateEnum
CREATE TYPE "ScriptVersionStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'APPROVED', 'REJECTED');

-- AlterEnum
ALTER TYPE "ActivityAction" ADD VALUE 'SCRIPT_CREATED';
ALTER TYPE "ActivityAction" ADD VALUE 'SCRIPT_VERSION_CREATED';
ALTER TYPE "ActivityAction" ADD VALUE 'SCRIPT_VERSION_SUBMITTED';
ALTER TYPE "ActivityAction" ADD VALUE 'SCRIPT_VERSION_WITHDRAWN';
ALTER TYPE "ActivityAction" ADD VALUE 'SCRIPT_VERSION_APPROVED';
ALTER TYPE "ActivityAction" ADD VALUE 'SCRIPT_VERSION_REJECTED';
ALTER TYPE "ActivityAction" ADD VALUE 'SCRIPT_REVIEW_REFUSED';

-- CreateTable
CREATE TABLE "Script" (
    "id" TEXT NOT NULL,
    "scope" "ScriptScope" NOT NULL,
    "tenantId" TEXT,
    "customerId" TEXT,
    "name" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Script_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Script_scope_business" CHECK (("scope" = 'GLOBAL' AND "customerId" IS NULL) OR ("scope" = 'BUSINESS' AND "customerId" IS NOT NULL)),
    CONSTRAINT "Script_name_length" CHECK (char_length("name") BETWEEN 3 AND 120)
);

-- CreateTable
CREATE TABLE "ScriptVersion" (
    "id" TEXT NOT NULL,
    "scriptId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "basedOnId" TEXT,
    "description" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "targetOs" TEXT NOT NULL,
    "risk" TEXT NOT NULL,
    "parameters" JSONB NOT NULL DEFAULT '[]',
    "content" TEXT NOT NULL,
    "contentBytes" INTEGER NOT NULL,
    "contentSha256" TEXT NOT NULL,
    "definitionSha256" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "contributorIds" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "ScriptVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "submittedAt" TIMESTAMP(3),
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "approvedSha256" TEXT,

    CONSTRAINT "ScriptVersion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ScriptVersion_version_positive" CHECK ("version" >= 1),
    -- PowerShell on Windows only, for now. Adding one is a migration on purpose.
    CONSTRAINT "ScriptVersion_language" CHECK ("language" = 'powershell'),
    CONSTRAINT "ScriptVersion_target_os" CHECK ("targetOs" = 'windows'),
    CONSTRAINT "ScriptVersion_risk" CHECK ("risk" IN ('low', 'medium', 'high')),
    CONSTRAINT "ScriptVersion_parameters_array" CHECK (jsonb_typeof("parameters") = 'array'),
    -- MAX_CONTENT_BYTES in definition.ts. The database is UTF-8, so
    -- octet_length is the byte count that was hashed.
    CONSTRAINT "ScriptVersion_content_bounded" CHECK ("contentBytes" = octet_length("content") AND "contentBytes" BETWEEN 1 AND 65536),
    CONSTRAINT "ScriptVersion_hashes_hex" CHECK ("contentSha256" ~ '^[0-9a-f]{64}$' AND "definitionSha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "ScriptVersion_author_contributes" CHECK ("authorId" = ANY ("contributorIds")),
    -- A decision is recorded exactly when there is one.
    CONSTRAINT "ScriptVersion_decided" CHECK (("status" IN ('APPROVED', 'REJECTED')) = ("decidedById" IS NOT NULL AND "decidedAt" IS NOT NULL)),
    -- SAME_PERSON, in the database: nobody approves content they wrote, and
    -- what they approved is this version's own content hash.
    CONSTRAINT "ScriptVersion_approver_independent" CHECK (
        "status" <> 'APPROVED' OR (
            "decidedById" <> "authorId"
            AND NOT ("decidedById" = ANY ("contributorIds"))
            AND "approvedSha256" IS NOT NULL
            AND "approvedSha256" = "contentSha256"
        )
    ),
    CONSTRAINT "ScriptVersion_approved_hash_only_when_approved" CHECK ("approvedSha256" IS NULL OR "status" = 'APPROVED')
);

-- CreateIndex
CREATE UNIQUE INDEX "Script_customerId_name_key" ON "Script"("customerId", "name");

-- One name per scope: NULLs are distinct in a unique index, so global names
-- need their own.
CREATE UNIQUE INDEX "Script_global_name_key" ON "Script"("name") WHERE "customerId" IS NULL;

-- CreateIndex
CREATE INDEX "Script_scope_idx" ON "Script"("scope");

-- CreateIndex
CREATE UNIQUE INDEX "ScriptVersion_scriptId_version_key" ON "ScriptVersion"("scriptId", "version");

-- CreateIndex
CREATE INDEX "ScriptVersion_scriptId_status_idx" ON "ScriptVersion"("scriptId", "status");

-- AddForeignKey
ALTER TABLE "Script" ADD CONSTRAINT "Script_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScriptVersion" ADD CONSTRAINT "ScriptVersion_scriptId_fkey" FOREIGN KEY ("scriptId") REFERENCES "Script"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A script's identity never changes: not its scope, its business or its name.
-- Moving a reviewed script into another business would carry an approval to
-- people who never reviewed it.
CREATE OR REPLACE FUNCTION rem0te_script_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'rem0te: script % cannot be changed', OLD."id" USING ERRCODE = 'integrity_constraint_violation';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER "Script_immutable" BEFORE UPDATE ON "Script"
  FOR EACH ROW EXECUTE FUNCTION rem0te_script_guard();

CREATE OR REPLACE FUNCTION rem0te_script_version_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' OR NEW."submittedAt" IS NOT NULL OR NEW."decidedById" IS NOT NULL OR NEW."decidedAt" IS NOT NULL
       OR NEW."decisionNote" IS NOT NULL OR NEW."approvedSha256" IS NOT NULL THEN
      RAISE EXCEPTION 'rem0te: a script version is written as a draft' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW."contentSha256" <> encode(sha256(convert_to(NEW."content", 'UTF8')), 'hex') THEN
      RAISE EXCEPTION 'rem0te: script version content does not match its SHA-256' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE. What the version is, and who wrote it, never changes.
  IF NEW."id" <> OLD."id" OR NEW."scriptId" <> OLD."scriptId" OR NEW."version" <> OLD."version"
     OR NEW."basedOnId" IS DISTINCT FROM OLD."basedOnId" OR NEW."description" <> OLD."description"
     OR NEW."language" <> OLD."language" OR NEW."targetOs" <> OLD."targetOs" OR NEW."risk" <> OLD."risk"
     OR NEW."parameters" IS DISTINCT FROM OLD."parameters" OR NEW."content" <> OLD."content"
     OR NEW."contentBytes" <> OLD."contentBytes" OR NEW."contentSha256" <> OLD."contentSha256"
     OR NEW."definitionSha256" <> OLD."definitionSha256" OR NEW."authorId" <> OLD."authorId"
     OR NEW."contributorIds" IS DISTINCT FROM OLD."contributorIds" OR NEW."createdAt" <> OLD."createdAt"
  THEN
    RAISE EXCEPTION 'rem0te: script version % is immutable; an edit is a new version', OLD."id" USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW."status" = OLD."status" THEN
    IF NEW."submittedAt" IS DISTINCT FROM OLD."submittedAt" OR NEW."decidedById" IS DISTINCT FROM OLD."decidedById"
       OR NEW."decidedAt" IS DISTINCT FROM OLD."decidedAt" OR NEW."decisionNote" IS DISTINCT FROM OLD."decisionNote"
       OR NEW."approvedSha256" IS DISTINCT FROM OLD."approvedSha256" THEN
      RAISE EXCEPTION 'rem0te: script version % review fields change only with its status', OLD."id" USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF (OLD."status" = 'DRAFT' AND NEW."status" = 'IN_REVIEW') OR (OLD."status" = 'IN_REVIEW' AND NEW."status" = 'DRAFT') THEN
    IF NEW."decidedById" IS NOT NULL OR NEW."decidedAt" IS NOT NULL OR NEW."approvedSha256" IS NOT NULL THEN
      RAISE EXCEPTION 'rem0te: script version % has no decision yet', OLD."id" USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" = 'IN_REVIEW' AND NEW."status" IN ('APPROVED', 'REJECTED') THEN
    IF NEW."status" = 'APPROVED' AND NEW."approvedSha256" IS DISTINCT FROM OLD."contentSha256" THEN
      RAISE EXCEPTION 'rem0te: script version % approved over a different hash', OLD."id" USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'rem0te: script version % cannot go from % to %', OLD."id", OLD."status", NEW."status" USING ERRCODE = 'integrity_constraint_violation';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER "ScriptVersion_immutable" BEFORE INSERT OR UPDATE ON "ScriptVersion"
  FOR EACH ROW EXECUTE FUNCTION rem0te_script_version_guard();
