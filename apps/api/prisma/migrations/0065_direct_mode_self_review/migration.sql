-- 0.40 direct mode: a script-library review by the person who wrote the
-- version, allowed only when the approval signer's operator has set the
-- signer's DEFAULT policy to direct mode (the policy that also governs the
-- signer's script allowlist) — a single operator has nobody else to review
-- it. The portal asks the signer at review time; this column records that the
-- review was one, so it is never mistaken for an independent one.
--
-- The 0035 SAME_PERSON rule is unchanged for every other row: a version
-- whose reviewer wrote or edited it is APPROVED only with "selfReviewed",
-- "selfReviewed" means exactly that, it is set only by the review itself
-- (IN_REVIEW -> APPROVED), and it never changes afterwards.

ALTER TABLE "ScriptVersion" ADD COLUMN "selfReviewed" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "ScriptVersion" DROP CONSTRAINT "ScriptVersion_approver_independent";
ALTER TABLE "ScriptVersion" ADD CONSTRAINT "ScriptVersion_approver_independent" CHECK (
    "status" <> 'APPROVED' OR (
        ("selfReviewed" OR ("decidedById" <> "authorId" AND NOT ("decidedById" = ANY ("contributorIds"))))
        AND "approvedSha256" IS NOT NULL
        AND "approvedSha256" = "contentSha256"
    )
);
-- "selfReviewed" is true only on an approval by the author or a contributor.
ALTER TABLE "ScriptVersion" ADD CONSTRAINT "ScriptVersion_self_reviewed_means_self" CHECK (
    NOT "selfReviewed" OR (
        "status" = 'APPROVED'
        AND ("decidedById" = "authorId" OR "decidedById" = ANY ("contributorIds"))
    )
);

CREATE OR REPLACE FUNCTION rem0te_script_version_self_review_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."selfReviewed" THEN
      RAISE EXCEPTION 'rem0te: a script version is not written as self-reviewed' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."selfReviewed" IS DISTINCT FROM OLD."selfReviewed"
     AND NOT (OLD."status" = 'IN_REVIEW' AND NEW."status" = 'APPROVED' AND NOT OLD."selfReviewed") THEN
    RAISE EXCEPTION 'rem0te: script version % self-review is recorded only by its review', OLD."id" USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER "ScriptVersion_self_review" BEFORE INSERT OR UPDATE ON "ScriptVersion"
  FOR EACH ROW EXECUTE FUNCTION rem0te_script_version_self_review_guard();
