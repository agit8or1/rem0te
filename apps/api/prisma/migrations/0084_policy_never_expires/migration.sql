-- v0.63: approved policies may never expire (the owner: "Policies shouldnt expire").
--
-- A patch policy or automation policy (and so a restart window) document now
-- carries either its `expiresAt` (every document before 0.63, kept as it is)
-- or a signed `expiry: "never"` (actions/patch-policy.ts EXPIRY_NEVER). The
-- portal's mirror column is null exactly for the second kind: there is
-- nothing to stop at. Existing rows keep their dates; nothing is backfilled.
--
-- The CHECKs tie the column to the document, so a row cannot say "never"
-- while its signed document has a date, or the reverse. The signer decides
-- from the document either way; this keeps the portal's own sweeps honest.
ALTER TABLE "PatchPolicy" ALTER COLUMN "expiresAt" DROP NOT NULL;
ALTER TABLE "AutomationPolicy" ALTER COLUMN "expiresAt" DROP NOT NULL;

ALTER TABLE "PatchPolicy" ADD CONSTRAINT "PatchPolicy_expiry_matches_document" CHECK (
  ("expiresAt" IS NULL) = (("document" ->> 'expiry') IS NOT DISTINCT FROM 'never' AND NOT ("document" ? 'expiresAt'))
);
ALTER TABLE "AutomationPolicy" ADD CONSTRAINT "AutomationPolicy_expiry_matches_document" CHECK (
  ("expiresAt" IS NULL) = (("document" ->> 'expiry') IS NOT DISTINCT FROM 'never' AND NOT ("document" ? 'expiresAt'))
);
