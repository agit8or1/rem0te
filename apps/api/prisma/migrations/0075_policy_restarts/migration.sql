-- v0.54: restart windows on patch policies.
--
-- One row per attempt to restart one computer under a policy's restart rule,
-- in one occurrence of the restart window. The policy document itself is
-- unchanged here: its restart rule lives in the signed JSON (PatchPolicy.document),
-- and documents made before 0.54 carry none.

CREATE TABLE "PatchPolicyRestart" (
    "id" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "windowKey" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "jobId" TEXT,
    "code" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PatchPolicyRestart_pkey" PRIMARY KEY ("id"),
    -- The signer allows three plans per computer per occurrence; the portal no more.
    CONSTRAINT "PatchPolicyRestart_attempt_check" CHECK ("attempt" BETWEEN 1 AND 3)
);

CREATE UNIQUE INDEX "PatchPolicyRestart_policyId_endpointId_windowKey_attempt_key" ON "PatchPolicyRestart"("policyId", "endpointId", "windowKey", "attempt");
CREATE INDEX "PatchPolicyRestart_endpointId_createdAt_idx" ON "PatchPolicyRestart"("endpointId", "createdAt");

ALTER TABLE "PatchPolicyRestart" ADD CONSTRAINT "PatchPolicyRestart_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "PatchPolicy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PatchPolicyRestart" ADD CONSTRAINT "PatchPolicyRestart_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;
