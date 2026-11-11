-- Device groups, saved device views and bulk actions (0.33).
--
-- EndpointGroup gains the business it belongs to. Until now a group was
-- tenant-wide and could only be made by an enrolment token's caller; the
-- device list now manages groups per business, and every member must be in
-- the group's business. Names become unique per business instead of per
-- tenant.
--
-- A pre-0.33 group whose members are all in one business (of the group's own
-- tenant) is given that business, so it becomes manageable. Any other
-- pre-0.33 group (empty, or spanning businesses) keeps customerId NULL: it
-- still works as a filter and on enrolment tokens, and the console does not
-- offer to edit it.
--
-- SavedView existed in the schema but nothing wrote it (views lived in the
-- browser). It gains the business a shared view belongs to, a shared flag,
-- density, and a real foreign key to its author (SET NULL: a shared view
-- outlives the person who made it; a personal view with no author is never
-- listed).

ALTER TYPE "ActivityAction" ADD VALUE 'DEVICE_GROUP_CREATED';
ALTER TYPE "ActivityAction" ADD VALUE 'DEVICE_GROUP_UPDATED';
ALTER TYPE "ActivityAction" ADD VALUE 'DEVICE_GROUP_DELETED';
ALTER TYPE "ActivityAction" ADD VALUE 'DEVICE_GROUP_MEMBERS_CHANGED';
ALTER TYPE "ActivityAction" ADD VALUE 'DEVICE_VIEW_SHARED_CHANGED';
ALTER TYPE "ActivityAction" ADD VALUE 'DEVICE_BULK_ACTION';

-- ── EndpointGroup ────────────────────────────────────────────────────────────
DROP INDEX "EndpointGroup_tenantId_name_key";

ALTER TABLE "EndpointGroup" ADD COLUMN "createdById" TEXT,
ADD COLUMN "customerId" TEXT;

UPDATE "EndpointGroup" g
   SET "customerId" = m.cid
  FROM (
    SELECT e."endpointGroupId" AS gid, min(e."customerId") AS cid
      FROM "Endpoint" e
     WHERE e."endpointGroupId" IS NOT NULL
     GROUP BY e."endpointGroupId"
    HAVING count(DISTINCT e."customerId") = 1 AND bool_and(e."customerId" IS NOT NULL)
  ) m, "Customer" c
 WHERE g.id = m.gid AND c.id = m.cid AND c."tenantId" = g."tenantId";

CREATE INDEX "EndpointGroup_tenantId_idx" ON "EndpointGroup"("tenantId");
CREATE UNIQUE INDEX "EndpointGroup_customerId_name_key" ON "EndpointGroup"("customerId", "name");
CREATE INDEX "Endpoint_endpointGroupId_idx" ON "Endpoint"("endpointGroupId");

ALTER TABLE "EndpointGroup" ADD CONSTRAINT "EndpointGroup_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── SavedView ────────────────────────────────────────────────────────────────
ALTER TABLE "SavedView" ADD COLUMN "customerId" TEXT,
ADD COLUMN "density" TEXT,
ADD COLUMN "shared" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "tenantId" DROP NOT NULL;

-- A dangling author would fail the new foreign key.
UPDATE "SavedView" SET "userId" = NULL WHERE "userId" IS NOT NULL AND "userId" NOT IN (SELECT id FROM "User");

CREATE INDEX "SavedView_userId_resource_idx" ON "SavedView"("userId", "resource");
CREATE INDEX "SavedView_customerId_resource_idx" ON "SavedView"("customerId", "resource");

ALTER TABLE "SavedView" ADD CONSTRAINT "SavedView_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SavedView" ADD CONSTRAINT "SavedView_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
