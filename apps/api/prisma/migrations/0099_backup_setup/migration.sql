-- 0.82.0 Wharf: Settings → Backups — the St0r push set up from the console,
-- rotation, a dry run, and linking an asset to a computer by hand
-- (docs/backups.md, docs/st0r-push-contract.md, invariant §91).
--
-- Nothing here reaches a provider and nothing restores, drills or fails over.

ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'BACKUP_CONNECTION_ROTATED';
ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'BACKUP_PUSH_DRY_RUN';
ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'BACKUP_ASSET_LINKED';

-- ── Connections: why the last report was refused, and when the token was rotated ──
-- lastError is a parse message Rem0te wrote (paths and rules), never the feed:
-- printable ASCII, at most 300 characters.
ALTER TABLE "BackupConnection" ADD COLUMN "lastErrorAt" TIMESTAMP(3);
ALTER TABLE "BackupConnection" ADD COLUMN "lastError" TEXT;
ALTER TABLE "BackupConnection" ADD COLUMN "tokenRotatedAt" TIMESTAMP(3);
ALTER TABLE "BackupConnection" ADD CONSTRAINT "BackupConnection_lastError_check"
  CHECK ("lastError" IS NULL OR (char_length("lastError") BETWEEN 1 AND 300 AND "lastError" ~ '^[\x20-\x7e]+$'));
-- Only a push connection has a token to rotate.
ALTER TABLE "BackupConnection" ADD CONSTRAINT "BackupConnection_rotated_check"
  CHECK ("tokenRotatedAt" IS NULL OR "transport" = 'push');

-- ── Assets: who decides which computer an asset is ─────────────────────────────
--   auto    the provider's report (rem0teId, else a hostname matching exactly one
--           computer) decides on every report — 0.81's behaviour;
--   manual  a person linked it on the Backups page; reports never change it;
--   none    a person said it is no computer; reports never link it.
-- A manual or 'none' choice names who made it and when. The computer's business
-- is still checked by 0097's backup_same_business trigger.
ALTER TABLE "BackupProtectedAsset" ADD COLUMN "linkSource" TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE "BackupProtectedAsset" ADD COLUMN "linkedById" TEXT;
ALTER TABLE "BackupProtectedAsset" ADD COLUMN "linkedAt" TIMESTAMP(3);
ALTER TABLE "BackupProtectedAsset" ADD CONSTRAINT "BackupProtectedAsset_linkSource_check"
  CHECK ("linkSource" IN ('auto', 'manual', 'none'));
ALTER TABLE "BackupProtectedAsset" ADD CONSTRAINT "BackupProtectedAsset_linkedBy_check"
  CHECK (("linkSource" = 'auto') = ("linkedById" IS NULL AND "linkedAt" IS NULL));
-- 'none' links nothing. (A 'manual' row may lose its computer to ON DELETE SET
-- NULL; the next report then treats it as automatic again.)
ALTER TABLE "BackupProtectedAsset" ADD CONSTRAINT "BackupProtectedAsset_linkNone_check"
  CHECK ("linkSource" <> 'none' OR "endpointId" IS NULL);

-- A computer that changes business leaves its backup assets unlinked, as in
-- 0097, and a person's choice for it no longer applies: back to automatic.
CREATE OR REPLACE FUNCTION backup_asset_unlink_on_move() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."customerId" IS DISTINCT FROM OLD."customerId" THEN
    UPDATE "BackupProtectedAsset" SET "endpointId" = NULL, "linkSource" = 'auto', "linkedById" = NULL, "linkedAt" = NULL
      WHERE "endpointId" = NEW.id;
  END IF;
  RETURN NEW;
END $$;
