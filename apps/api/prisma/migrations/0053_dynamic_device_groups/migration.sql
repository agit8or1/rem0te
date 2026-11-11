-- Rule-based (dynamic) device groups (0.34).
--
-- A group is STATIC (0.33: members are EndpointGroupMember rows, added and
-- removed by hand) or RULE: a closed filter over the device list's own
-- parameters, stored as the same validated JSON a saved view stores. A rule
-- group's members are never stored. They are computed on every read — the
-- rule AND-ed with the group's business AND-ed with the reader's visibility —
-- so they are correct the moment a computer goes offline, changes site or
-- reports a new version, with no sweep to fall behind.
--
-- The database holds three rules so no code path can break them:
--
--   * EndpointGroup_rule_matches_kind (CHECK): a RULE group has a rule and a
--     STATIC group has none.
--   * endpoint_group_kind_fixed (BEFORE UPDATE OF kind): a group's kind never
--     changes. Turning a static group into a rule group would leave its
--     stored members behind; turning a rule group static would invent an
--     empty membership the owner never chose.
--   * endpoint_group_member_static_only (BEFORE INSERT OR UPDATE on
--     EndpointGroupMember): a rule group cannot be "added to" by hand — or
--     by a claim token, or by anything else. SQLSTATE 23514.

-- CreateEnum
CREATE TYPE "EndpointGroupKind" AS ENUM ('STATIC', 'RULE');

-- AlterTable
ALTER TABLE "EndpointGroup" ADD COLUMN "kind" "EndpointGroupKind" NOT NULL DEFAULT 'STATIC',
ADD COLUMN "rule" JSONB;

ALTER TABLE "EndpointGroup" ADD CONSTRAINT "EndpointGroup_rule_matches_kind"
  CHECK (("kind" = 'RULE' AND "rule" IS NOT NULL AND jsonb_typeof("rule") = 'object')
      OR ("kind" = 'STATIC' AND "rule" IS NULL));

CREATE INDEX "EndpointGroup_customerId_kind_idx" ON "EndpointGroup"("customerId", "kind");

CREATE FUNCTION endpoint_group_kind_fixed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."kind" IS DISTINCT FROM OLD."kind" THEN
    RAISE EXCEPTION 'device group %: kind is fixed at creation', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER endpoint_group_kind_fixed
  BEFORE UPDATE OF "kind" ON "EndpointGroup"
  FOR EACH ROW EXECUTE FUNCTION endpoint_group_kind_fixed();

CREATE FUNCTION endpoint_group_member_static_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "EndpointGroup" WHERE id = NEW."endpointGroupId" AND "kind" = 'RULE') THEN
    RAISE EXCEPTION 'device group membership: group % is a rule group; its members follow its rule', NEW."endpointGroupId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER endpoint_group_member_static_only
  BEFORE INSERT OR UPDATE ON "EndpointGroupMember"
  FOR EACH ROW EXECUTE FUNCTION endpoint_group_member_static_only();
