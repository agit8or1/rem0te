-- ConnectionGrant: short-lived, single-use authorization the browser hands
-- to the launcher instead of the RustDesk password.
CREATE TABLE IF NOT EXISTS "ConnectionGrant" (
    "id"          TEXT PRIMARY KEY,
    "tokenHash"   TEXT NOT NULL UNIQUE,
    "tenantId"    TEXT NOT NULL REFERENCES "Tenant"("id")   ON DELETE CASCADE,
    "userId"      TEXT NOT NULL REFERENCES "User"("id")     ON DELETE CASCADE,
    "endpointId"  TEXT NOT NULL REFERENCES "Endpoint"("id") ON DELETE CASCADE,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt"   TIMESTAMP(3) NOT NULL,
    "usedAt"      TIMESTAMP(3),
    "usedByIp"    TEXT,
    "createdByIp" TEXT,
    "purpose"     TEXT NOT NULL DEFAULT 'REMOTE_ACCESS'
);

CREATE INDEX IF NOT EXISTS "ConnectionGrant_tenantId_idx"   ON "ConnectionGrant"("tenantId");
CREATE INDEX IF NOT EXISTS "ConnectionGrant_endpointId_idx" ON "ConnectionGrant"("endpointId");
CREATE INDEX IF NOT EXISTS "ConnectionGrant_userId_idx"     ON "ConnectionGrant"("userId");
CREATE INDEX IF NOT EXISTS "ConnectionGrant_expiresAt_idx"  ON "ConnectionGrant"("expiresAt");

-- Credential-rotation staging on RustdeskNode. pendingPassword holds the
-- AES-GCM ciphertext of the new candidate credential until the endpoint
-- confirms it has applied it.
ALTER TABLE "RustdeskNode"
    ADD COLUMN IF NOT EXISTS "pendingPassword"   TEXT,
    ADD COLUMN IF NOT EXISTS "pendingPasswordAt" TIMESTAMP(3);
