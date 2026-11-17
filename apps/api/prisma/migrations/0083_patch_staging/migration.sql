-- v0.62: a deployment's staging (actions/patch-policy.ts STAGINGS).
--
-- 'canary' is what every deployment before 0.62 was: ring 0 one computer,
-- each later ring requested only after the ring before it passed its gate.
-- 'none' ("all at once", the owner's default from 0.62): every ring may be
-- requested at once and none waits for another. Existing rows keep 'canary'
-- through the default, so nothing already running changes.
ALTER TABLE "PatchDeployment" ADD COLUMN "staging" TEXT NOT NULL DEFAULT 'canary';
ALTER TABLE "PatchDeployment" ADD CONSTRAINT "PatchDeployment_staging_check" CHECK ("staging" IN ('none', 'canary'));
