-- v0.34: running approved library scripts as the signed catalog action
-- windows.script.run@1. Two tables, and two audit actions.
--
-- ScriptAllowlistEntry mirrors entries the portal proposed to the approval
-- signer's own allowlist. The signer's copy decides; nothing in this table
-- can activate an entry.
--
-- ScriptRunOutput holds what each computer's run printed, bounded and
-- redacted twice, for 90 days (the script-output sweep deletes older rows).

ALTER TYPE "ActivityAction" ADD VALUE 'SCRIPT_ALLOWLIST_PROPOSED';
ALTER TYPE "ActivityAction" ADD VALUE 'SCRIPT_ALLOWLIST_REVOKED';

CREATE TABLE "ScriptAllowlistEntry" (
    "id" TEXT NOT NULL,
    "scriptVersionId" TEXT NOT NULL,
    "customerId" TEXT,
    "contentSha256" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "approvalUrl" TEXT NOT NULL,
    "proposedById" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokeReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ScriptAllowlistEntry_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ScriptAllowlistEntry_id_hex" CHECK ("id" ~ '^[0-9a-f]{32}$'),
    CONSTRAINT "ScriptAllowlistEntry_sha_hex" CHECK ("contentSha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "ScriptAllowlistEntry_status" CHECK ("status" IN ('AWAITING_APPROVAL', 'ACTIVE', 'REJECTED', 'REVOKED'))
);
CREATE INDEX "ScriptAllowlistEntry_scriptVersionId_idx" ON "ScriptAllowlistEntry"("scriptVersionId");
ALTER TABLE "ScriptAllowlistEntry" ADD CONSTRAINT "ScriptAllowlistEntry_scriptVersionId_fkey" FOREIGN KEY ("scriptVersionId") REFERENCES "ScriptVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ScriptRunOutput" (
    "id" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "scriptVersionId" TEXT NOT NULL,
    "contentSha256" TEXT NOT NULL,
    "exitCode" INTEGER,
    "timedOut" BOOLEAN NOT NULL,
    "durationMs" INTEGER,
    "stdout" TEXT NOT NULL,
    "stderr" TEXT NOT NULL,
    "stdoutBytes" INTEGER NOT NULL,
    "stderrBytes" INTEGER NOT NULL,
    "stdoutTruncated" BOOLEAN NOT NULL,
    "stderrTruncated" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ScriptRunOutput_pkey" PRIMARY KEY ("id"),
    -- The service caps each stream at 64 KiB of UTF-8 (MAX_SCRIPT_OUTPUT_BYTES);
    -- this is its backstop.
    CONSTRAINT "ScriptRunOutput_bounded" CHECK (octet_length("stdout") <= 65536 AND octet_length("stderr") <= 65536)
);
CREATE UNIQUE INDEX "ScriptRunOutput_targetId_key" ON "ScriptRunOutput"("targetId");
CREATE INDEX "ScriptRunOutput_createdAt_idx" ON "ScriptRunOutput"("createdAt");
CREATE INDEX "ScriptRunOutput_endpointId_createdAt_idx" ON "ScriptRunOutput"("endpointId", "createdAt");
ALTER TABLE "ScriptRunOutput" ADD CONSTRAINT "ScriptRunOutput_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "ActionTarget"("id") ON DELETE CASCADE ON UPDATE CASCADE;
