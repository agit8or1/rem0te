-- Device groups as a policy scope (0.35).
--
-- A monitor (MonitorRule) and a client-update policy (ClientUpdatePolicy) may
-- now be set for a device group, static or rule-based. Precedence, most
-- specific first: computer, group, site, business (and global, for
-- monitors). A computer in several groups that carry a policy for the same
-- thing is decided by the policy's `priority` — 1 first — never by database
-- order. Rule-group membership is not stored here or anywhere: it is computed
-- at each evaluation (group-policy/membership.service.ts).
--
-- The database holds the rules so no code path can break them:
--
--   * MonitorRule_group_scope / ClientUpdatePolicy_group_scope (CHECK): a
--     group-scoped row names its group and a priority 1–999, nothing else
--     (no site, no computer), and a row without a group has no priority.
--     For a monitor, the scope key is exactly 'g:' || groupId.
--   * MonitorRule_group_priority_key / ClientUpdatePolicy_group_priority_key
--     (partial UNIQUE): two group policies of one business cannot share a
--     priority (for monitors: for the same key). A tie is refused when it is
--     saved, so it never has to be broken when it is evaluated.
--   * group_policy_same_business (BEFORE INSERT OR UPDATE): the group belongs
--     to the policy's own business. SQLSTATE 23514.
--   * The foreign keys are NO ACTION: a group that carries a policy cannot
--     be deleted until the policy is removed. Removing a client-update group
--     policy can hand its computers to an enabled site or business policy,
--     which needs fresh authentication; deleting the group must not be a way
--     round that. NO ACTION (checked at the end of the statement), not
--     RESTRICT, so deleting a business still cascades through both.

-- AlterTable
ALTER TABLE "MonitorRule" ADD COLUMN "groupId" TEXT,
ADD COLUMN "priority" INTEGER;

ALTER TABLE "ClientUpdatePolicy" ADD COLUMN "groupId" TEXT,
ADD COLUMN "priority" INTEGER;

-- CreateIndex
CREATE INDEX "MonitorRule_groupId_idx" ON "MonitorRule"("groupId");
CREATE UNIQUE INDEX "ClientUpdatePolicy_groupId_key" ON "ClientUpdatePolicy"("groupId");

-- AddForeignKey
ALTER TABLE "MonitorRule" ADD CONSTRAINT "MonitorRule_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "EndpointGroup"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "ClientUpdatePolicy" ADD CONSTRAINT "ClientUpdatePolicy_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "EndpointGroup"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "MonitorRule" ADD CONSTRAINT "MonitorRule_group_scope"
  CHECK (("groupId" IS NULL AND "priority" IS NULL AND "scopeKey" NOT LIKE 'g:%')
      OR ("groupId" IS NOT NULL AND "priority" BETWEEN 1 AND 999 AND "scopeKey" = 'g:' || "groupId"
          AND "customerId" IS NOT NULL AND "siteId" IS NULL AND "endpointId" IS NULL));

ALTER TABLE "ClientUpdatePolicy" ADD CONSTRAINT "ClientUpdatePolicy_group_scope"
  CHECK (("groupId" IS NULL AND "priority" IS NULL)
      OR ("groupId" IS NOT NULL AND "siteId" IS NULL AND "priority" BETWEEN 1 AND 999));

-- 0033's "one business row per business" (customerId WHERE siteId IS NULL)
-- would count every group policy as a second business row. It now means
-- what it said: no site and no group.
DROP INDEX "ClientUpdatePolicy_business_row";
CREATE UNIQUE INDEX "ClientUpdatePolicy_business_row" ON "ClientUpdatePolicy"("customerId") WHERE "siteId" IS NULL AND "groupId" IS NULL;

CREATE UNIQUE INDEX "MonitorRule_group_priority_key" ON "MonitorRule"("customerId", "key", "priority") WHERE "groupId" IS NOT NULL;
CREATE UNIQUE INDEX "ClientUpdatePolicy_group_priority_key" ON "ClientUpdatePolicy"("customerId", "priority") WHERE "groupId" IS NOT NULL;

CREATE FUNCTION group_policy_same_business() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."groupId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "EndpointGroup" g WHERE g.id = NEW."groupId" AND g."customerId" IS NOT DISTINCT FROM NEW."customerId" AND g."customerId" IS NOT NULL
  ) THEN
    RAISE EXCEPTION '%: group % is not a group of business %', TG_TABLE_NAME, NEW."groupId", NEW."customerId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER monitor_rule_group_same_business
  BEFORE INSERT OR UPDATE OF "groupId", "customerId" ON "MonitorRule"
  FOR EACH ROW EXECUTE FUNCTION group_policy_same_business();

CREATE TRIGGER client_update_policy_group_same_business
  BEFORE INSERT OR UPDATE OF "groupId", "customerId" ON "ClientUpdatePolicy"
  FOR EACH ROW EXECUTE FUNCTION group_policy_same_business();
