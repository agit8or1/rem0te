-- Multi-group membership for computers (0.34).
--
-- 0.33 kept membership in Endpoint."endpointGroupId", so a computer was in
-- one group at a time and adding it to a second was refused
-- (IN_OTHER_GROUP). Membership moves to a join table: a computer may be in
-- any number of its own business's groups.
--
-- Endpoint."endpointGroupId" is dropped, not kept beside the table: two
-- records of membership drift, and a filter or count that read the old one
-- would silently disagree with the new one. DeviceClaimToken."endpointGroupId"
-- stays — it is the group a new device joins when it claims the token, and
-- the claim now writes a membership row instead of the column.
--
-- The business rule is held here, not only in the services, so no code path
-- can break it:
--
--   * endpoint_group_member_same_business (BEFORE INSERT OR UPDATE on the
--     join table) refuses a row whose computer is not in the group's
--     business — or, for a pre-0.33 group with no business, not in the
--     group's tenant. SQLSTATE 23514 (check_violation).
--   * endpoint_leaves_foreign_groups (AFTER UPDATE OF customerId, tenantId on
--     Endpoint) deletes every membership of a computer that changed business
--     or tenant whose group is not its new business's own. Before 0.34 each
--     code path that moved a computer had to remember to clear the column
--     (two did; Unassigned → business did not need to).
--
-- Existing memberships are copied across only where they satisfy that rule.
-- One that does not (a pre-0.33 row whose group belongs to another business,
-- which 0.33 never cleaned up) is dropped; the NOTICE says how many.

-- CreateTable
CREATE TABLE "EndpointGroupMember" (
    "endpointGroupId" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "addedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EndpointGroupMember_pkey" PRIMARY KEY ("endpointGroupId","endpointId")
);

CREATE INDEX "EndpointGroupMember_endpointId_idx" ON "EndpointGroupMember"("endpointId");

ALTER TABLE "EndpointGroupMember" ADD CONSTRAINT "EndpointGroupMember_endpointGroupId_fkey" FOREIGN KEY ("endpointGroupId") REFERENCES "EndpointGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EndpointGroupMember" ADD CONSTRAINT "EndpointGroupMember_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── The business rule ────────────────────────────────────────────────────────
CREATE FUNCTION endpoint_group_member_same_business() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  g_customer TEXT; g_tenant TEXT; e_customer TEXT; e_tenant TEXT;
BEGIN
  SELECT "customerId", "tenantId" INTO g_customer, g_tenant FROM "EndpointGroup" WHERE id = NEW."endpointGroupId";
  SELECT "customerId", "tenantId" INTO e_customer, e_tenant FROM "Endpoint" WHERE id = NEW."endpointId";
  IF g_customer IS NOT NULL THEN
    IF e_customer IS DISTINCT FROM g_customer THEN
      RAISE EXCEPTION 'device group membership: computer % is not in the group''s business', NEW."endpointId"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF e_tenant IS DISTINCT FROM g_tenant THEN
    RAISE EXCEPTION 'device group membership: computer % is not in the group''s tenant', NEW."endpointId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER endpoint_group_member_same_business
  BEFORE INSERT OR UPDATE ON "EndpointGroupMember"
  FOR EACH ROW EXECUTE FUNCTION endpoint_group_member_same_business();

CREATE FUNCTION endpoint_leaves_foreign_groups() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM "EndpointGroupMember" m
   USING "EndpointGroup" g
   WHERE m."endpointId" = NEW.id AND g.id = m."endpointGroupId"
     AND (g."customerId" IS NULL OR g."customerId" IS DISTINCT FROM NEW."customerId");
  RETURN NULL;
END $$;

CREATE TRIGGER endpoint_leaves_foreign_groups
  AFTER UPDATE OF "customerId", "tenantId" ON "Endpoint"
  FOR EACH ROW
  WHEN (OLD."customerId" IS DISTINCT FROM NEW."customerId" OR OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
  EXECUTE FUNCTION endpoint_leaves_foreign_groups();

-- ── Copy 0.33's memberships ─────────────────────────────────────────────────
DO $$
DECLARE total INT; kept INT;
BEGIN
  SELECT count(*) INTO total FROM "Endpoint" WHERE "endpointGroupId" IS NOT NULL;
  INSERT INTO "EndpointGroupMember" ("endpointGroupId", "endpointId", "createdAt")
  SELECT e."endpointGroupId", e.id, e."updatedAt"
    FROM "Endpoint" e JOIN "EndpointGroup" g ON g.id = e."endpointGroupId"
   WHERE (g."customerId" IS NOT NULL AND e."customerId" = g."customerId")
      OR (g."customerId" IS NULL AND e."tenantId" = g."tenantId");
  GET DIAGNOSTICS kept = ROW_COUNT;
  RAISE NOTICE 'device group memberships: % copied, % dropped (computer not in the group''s business)', kept, total - kept;
END $$;

-- ── Drop the single-group column ────────────────────────────────────────────
ALTER TABLE "Endpoint" DROP CONSTRAINT "Endpoint_endpointGroupId_fkey";
DROP INDEX "Endpoint_endpointGroupId_idx";
ALTER TABLE "Endpoint" DROP COLUMN "endpointGroupId";
