-- ComputerAccess: many-to-many between User and Endpoint (which users can
-- connect to which computers). Plus per-endpoint access mode + token-bound
-- assignment fields so an admin's "Add Computer" flow can pre-authorize
-- specific users at enrollment time.

DO $$ BEGIN
    CREATE TYPE "EndpointAccessMode" AS ENUM ('ASSIGNED_USERS', 'COMPANY_WIDE');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "Endpoint"
    ADD COLUMN IF NOT EXISTS "accessMode" "EndpointAccessMode" NOT NULL DEFAULT 'ASSIGNED_USERS';

ALTER TABLE "DeviceClaimToken"
    ADD COLUMN IF NOT EXISTS "customerId"       TEXT,
    ADD COLUMN IF NOT EXISTS "accessMode"       "EndpointAccessMode" NOT NULL DEFAULT 'ASSIGNED_USERS',
    ADD COLUMN IF NOT EXISTS "assignedUserIds"  TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS "endpointGroupId"  TEXT,
    ADD COLUMN IF NOT EXISTS "createdById"      TEXT;

CREATE TABLE IF NOT EXISTS "ComputerAccess" (
    "id"         TEXT NOT NULL PRIMARY KEY,
    "tenantId"   TEXT NOT NULL REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "endpointId" TEXT NOT NULL REFERENCES "Endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "userId"     TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "grantedBy"  TEXT,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt"  TIMESTAMP(3)
);

CREATE UNIQUE INDEX IF NOT EXISTS "ComputerAccess_userId_endpointId_key"
    ON "ComputerAccess"("userId", "endpointId");
CREATE INDEX IF NOT EXISTS "ComputerAccess_tenantId_idx"   ON "ComputerAccess"("tenantId");
CREATE INDEX IF NOT EXISTS "ComputerAccess_endpointId_idx" ON "ComputerAccess"("endpointId");
CREATE INDEX IF NOT EXISTS "ComputerAccess_userId_idx"     ON "ComputerAccess"("userId");
