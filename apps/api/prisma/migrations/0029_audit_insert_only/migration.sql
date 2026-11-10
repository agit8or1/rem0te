-- An audit entry's content cannot be changed from the moment it is written.
--
-- 0027's guard only protected an entry once it was sealed. The sealer runs
-- every few seconds, but until it did, a row could be rewritten with nothing
-- to show for it: the chain would seal the rewritten values. Now the content
-- columns are fixed at insert, sealed or not. The only updates allowed are:
--   - the sealer setting chainHash / sealedRefs / chainGap / sealedAt, once,
--     on a row that has none;
--   - deleting a business, a tenant or a user setting customerId, tenantId or
--     actorId to NULL (the chain hashes the values as sealed, in sealedRefs).
-- Deleting a row is still not prevented here; it is detected by the gap it
-- leaves in seq and by the copy exported off the host.
CREATE OR REPLACE FUNCTION rem0te_audit_sealed_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."seq" <> OLD."seq" OR NEW."id" <> OLD."id" OR NEW."createdAt" <> OLD."createdAt" OR NEW."action" <> OLD."action"
     OR NEW."actorIp" IS DISTINCT FROM OLD."actorIp" OR NEW."actorAgent" IS DISTINCT FROM OLD."actorAgent"
     OR NEW."resource" IS DISTINCT FROM OLD."resource" OR NEW."resourceId" IS DISTINCT FROM OLD."resourceId"
     OR NEW."metadata"::text IS DISTINCT FROM OLD."metadata"::text
     OR (NEW."tenantId" IS DISTINCT FROM OLD."tenantId" AND NEW."tenantId" IS NOT NULL)
     OR (NEW."customerId" IS DISTINCT FROM OLD."customerId" AND NEW."customerId" IS NOT NULL)
     OR (NEW."actorId" IS DISTINCT FROM OLD."actorId" AND NEW."actorId" IS NOT NULL)
  THEN
    IF OLD."chainHash" IS NULL THEN
      RAISE EXCEPTION 'rem0te: audit entry % cannot be changed', OLD."seq" USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RAISE EXCEPTION 'rem0te: sealed audit entry % cannot be changed', OLD."seq" USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- Not sealed yet: the sealer may seal it (and refs may be nulled).
  IF OLD."chainHash" IS NULL THEN RETURN NEW; END IF;
  IF NEW."chainHash" IS DISTINCT FROM OLD."chainHash" OR NEW."sealedRefs"::text IS DISTINCT FROM OLD."sealedRefs"::text
     OR NEW."chainGap"::text IS DISTINCT FROM OLD."chainGap"::text OR NEW."sealedAt" IS DISTINCT FROM OLD."sealedAt"
  THEN
    RAISE EXCEPTION 'rem0te: sealed audit entry % cannot be changed', OLD."seq" USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
