-- ════════════════════════════════════════════════════════════════════════════
-- 0009 — Three-level business access model: schema + data migration
--
-- Depends on 0008 having committed the new RoleType / ActivityAction values.
--
-- Role mapping (see docs/access-control.md):
--
--   PLATFORM_ADMIN                        → PLATFORM_ADMIN   (unchanged)
--   TENANT_OWNER, TENANT_ADMIN            → BUSINESS_OWNER
--   TECHNICIAN, BILLING_ADMIN,
--   READ_ONLY, CUSTOMER                   → BUSINESS_USER + translated caps
--
-- Capability translation preserves least privilege. In particular an old
-- READ_ONLY user becomes a BUSINESS_USER WITHOUT computers:connect, and an
-- old BILLING_ADMIN gets no computer capabilities at all (the legacy role
-- had no endpoints:read).
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. Columns ──────────────────────────────────────────────────────────────

ALTER TABLE "Membership"
  ADD COLUMN IF NOT EXISTS "capabilities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "Customer"
  ADD COLUMN IF NOT EXISTS "quickConnectEnabled" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "SupportSession" ADD COLUMN IF NOT EXISTS "customerId" TEXT;
ALTER TABLE "ActivityLog"    ADD COLUMN IF NOT EXISTS "customerId" TEXT;
ALTER TABLE "ApiKey"         ADD COLUMN IF NOT EXISTS "customerId" TEXT;

-- ── 2. Platform settings singleton ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "PlatformSettings" (
  "id"                  TEXT         NOT NULL DEFAULT 'singleton',
  "quickConnectEnabled" BOOLEAN      NOT NULL DEFAULT false,
  "quickConnectWindows" BOOLEAN      NOT NULL DEFAULT true,
  "quickConnectMacos"   BOOLEAN      NOT NULL DEFAULT false,
  "quickConnectLinux"   BOOLEAN      NOT NULL DEFAULT false,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlatformSettings_pkey" PRIMARY KEY ("id")
);

-- Quick Connect ships OFF. The operator turns it on deliberately.
INSERT INTO "PlatformSettings" ("id") VALUES ('singleton')
  ON CONFLICT ("id") DO NOTHING;

-- ── 3. Foreign keys + indexes ───────────────────────────────────────────────

DO $$ BEGIN
  ALTER TABLE "SupportSession"
    ADD CONSTRAINT "SupportSession_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Customer"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "ActivityLog"
    ADD CONSTRAINT "ActivityLog_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Customer"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "ApiKey"
    ADD CONSTRAINT "ApiKey_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Customer"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "ApiKey_customerId_idx"                    ON "ApiKey"("customerId");
CREATE INDEX IF NOT EXISTS "SupportSession_customerId_idx"           ON "SupportSession"("customerId");
CREATE INDEX IF NOT EXISTS "SupportSession_customerId_createdAt_idx" ON "SupportSession"("customerId", "createdAt");
CREATE INDEX IF NOT EXISTS "ActivityLog_customerId_idx"              ON "ActivityLog"("customerId");
CREATE INDEX IF NOT EXISTS "ActivityLog_customerId_createdAt_idx"    ON "ActivityLog"("customerId", "createdAt");

-- ── 4. Backfill business scope on existing rows ─────────────────────────────
-- Sessions inherit the business of the computer they targeted.

UPDATE "SupportSession" s
   SET "customerId" = e."customerId"
  FROM "Endpoint" e
 WHERE s."endpointId" = e."id"
   AND s."customerId" IS NULL
   AND e."customerId" IS NOT NULL;

-- Audit rows that name an endpoint inherit that endpoint's business.
UPDATE "ActivityLog" a
   SET "customerId" = e."customerId"
  FROM "Endpoint" e
 WHERE a."resource" = 'endpoint'
   AND a."resourceId" = e."id"
   AND a."customerId" IS NULL
   AND e."customerId" IS NOT NULL;

-- Audit rows that name a business directly.
UPDATE "ActivityLog" a
   SET "customerId" = a."resourceId"
 WHERE a."resource" = 'customer'
   AND a."customerId" IS NULL
   AND EXISTS (SELECT 1 FROM "Customer" c WHERE c."id" = a."resourceId");

-- ── 5. Create the two system roles for every tenant ─────────────────────────

INSERT INTO "Role" ("id", "tenantId", "name", "type", "description", "isSystem", "createdAt", "updatedAt")
SELECT
  'role_bo_' || substr(md5(t."id"), 1, 20),
  t."id",
  'Business Owner',
  'BUSINESS_OWNER',
  'Full administrative control of a single business.',
  true,
  NOW(), NOW()
FROM "Tenant" t
WHERE NOT EXISTS (
  SELECT 1 FROM "Role" r WHERE r."tenantId" = t."id" AND r."type" = 'BUSINESS_OWNER'
);

INSERT INTO "Role" ("id", "tenantId", "name", "type", "description", "isSystem", "createdAt", "updatedAt")
SELECT
  'role_bu_' || substr(md5(t."id"), 1, 20),
  t."id",
  'Business User',
  'BUSINESS_USER',
  'Access limited to the capabilities granted by the Business Owner.',
  true,
  NOW(), NOW()
FROM "Tenant" t
WHERE NOT EXISTS (
  SELECT 1 FROM "Role" r WHERE r."tenantId" = t."id" AND r."type" = 'BUSINESS_USER'
);

-- ── 6. Translate legacy capabilities BEFORE repointing the memberships ──────
-- Done first so the mapping can still read the old role type.
--
--   TECHNICIAN     endpoints:read + sessions:read/write
--                    → view, connect, sessions, history
--   BILLING_ADMIN  users:read + audit:read (no endpoint access at all)
--                    → users_view, audit_view          — NO computer access
--   READ_ONLY      endpoints:read + sessions:read (read-only, never launched)
--                    → view, sessions, history, audit  — NO connect
--   CUSTOMER       endpoints:read + sessions:read/write (portal could connect)
--                    → view, connect, sessions, history

UPDATE "Membership" m
   SET "capabilities" = ARRAY[
         'computers:view','computers:connect',
         'support:sessions_view','support:history_view'
       ]::TEXT[]
  FROM "Role" r
 WHERE m."roleId" = r."id" AND r."type" = 'TECHNICIAN';

UPDATE "Membership" m
   SET "capabilities" = ARRAY['users:view','audit:view']::TEXT[]
  FROM "Role" r
 WHERE m."roleId" = r."id" AND r."type" = 'BILLING_ADMIN';

UPDATE "Membership" m
   SET "capabilities" = ARRAY[
         'computers:view',
         'support:sessions_view','support:history_view','audit:view'
       ]::TEXT[]
  FROM "Role" r
 WHERE m."roleId" = r."id" AND r."type" = 'READ_ONLY';

UPDATE "Membership" m
   SET "capabilities" = ARRAY[
         'computers:view','computers:connect',
         'support:sessions_view','support:history_view'
       ]::TEXT[]
  FROM "Role" r
 WHERE m."roleId" = r."id" AND r."type" = 'CUSTOMER';

-- Business Owners hold every business capability implicitly; the column is
-- left empty for them so there is exactly one source of truth.
UPDATE "Membership" m
   SET "capabilities" = ARRAY[]::TEXT[]
  FROM "Role" r
 WHERE m."roleId" = r."id" AND r."type" IN ('TENANT_OWNER','TENANT_ADMIN','PLATFORM_ADMIN');

-- ── 7. Repoint memberships at the new roles ─────────────────────────────────

UPDATE "Membership" m
   SET "roleId" = nr."id"
  FROM "Role" old, "Role" nr
 WHERE m."roleId" = old."id"
   AND old."type" IN ('TENANT_OWNER','TENANT_ADMIN')
   AND nr."tenantId" = m."tenantId"
   AND nr."type" = 'BUSINESS_OWNER';

UPDATE "Membership" m
   SET "roleId" = nr."id"
  FROM "Role" old, "Role" nr
 WHERE m."roleId" = old."id"
   AND old."type" IN ('TECHNICIAN','BILLING_ADMIN','READ_ONLY','CUSTOMER')
   AND nr."tenantId" = m."tenantId"
   AND nr."type" = 'BUSINESS_USER';

-- ── 8. Retire the legacy role rows ──────────────────────────────────────────
-- Kept, not deleted: Invitation.roleId may still reference them and dropping
-- the rows would break historical audit joins. They are marked non-system and
-- renamed so they cannot be picked from any role selector.

UPDATE "Role"
   SET "isSystem" = false,
       "name" = '(retired) ' || "name",
       "description" = 'Retired in v0.8.0 — replaced by Business Owner / Business User.'
 WHERE "type" IN ('TENANT_OWNER','TENANT_ADMIN','TECHNICIAN','BILLING_ADMIN','READ_ONLY','CUSTOMER')
   AND "name" NOT LIKE '(retired)%';

-- Pending invitations that still point at a retired role are repointed to
-- Business User — the least-privileged landing spot.
UPDATE "Invitation" i
   SET "roleId" = nr."id"
  FROM "Role" old, "Role" nr
 WHERE i."roleId" = old."id"
   AND i."acceptedAt" IS NULL
   AND old."type" IN ('TENANT_OWNER','TENANT_ADMIN','TECHNICIAN','BILLING_ADMIN','READ_ONLY','CUSTOMER')
   AND nr."tenantId" = i."tenantId"
   AND nr."type" = 'BUSINESS_USER';

-- ── 9. Pre-existing API keys have no business ───────────────────────────────
-- A key that predates business scoping cannot be safely resolved to one, and
-- authenticating it would grant platform-wide reach. Revoke them; the
-- operator re-issues per business. There is no silent widening of access.

UPDATE "ApiKey"
   SET "revokedAt" = NOW()
 WHERE "customerId" IS NULL
   AND "revokedAt" IS NULL;
