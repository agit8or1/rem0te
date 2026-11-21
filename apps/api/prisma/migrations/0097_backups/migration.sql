-- 0.81.0 Vault: backup data model, provider connections and backup monitor
-- kinds (roadmap 4.1), docs/backups.md, invariant §91.
--
-- Numbered 0097: 0096 is the parallel 0.80 MDM branch. Nothing here depends
-- on it.
--
-- Rem0te keeps its OWN copy of what a backup provider reports. Nothing here
-- reaches a provider, and nothing restores, drills or fails over (4.5 and
-- 4.6, later). Three facts about a backup job are kept apart and never
-- merged into one "status":
--
--   completion    did the job finish, and how (the provider says)
--   integrity     did the provider verify the stored data (the provider says)
--   restoreTest   was a restore from this job's recovery point tested and
--                 validated in an isolated drill (Rem0te decides, from drills)
--
-- A job that succeeded is never "verified" by succeeding: restoreTest is
-- 'verified' only with a drill that passed, was not simulated, and restored
-- this job's own recovery point (CHECK + trigger below).

ALTER TYPE "MonitorKind" ADD VALUE 'BACKUP_STALE';
ALTER TYPE "MonitorKind" ADD VALUE 'BACKUP_FAILED';
ALTER TYPE "MonitorKind" ADD VALUE 'DRILL_FAILED';
ALTER TYPE "MonitorKind" ADD VALUE 'RPO_EXCEEDED';
ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'BACKUP_CONNECTION_CREATED';
ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'BACKUP_CONNECTION_REVOKED';
ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'BACKUP_OBJECTIVE_SET';

-- ── Provider connections ────────────────────────────────────────────────────
-- One live connection per business and provider. Decision 17: St0r pushes to
-- Rem0te (push: a per-connection token, stored only as its SHA-256); Comet is
-- read by Rem0te (pull, public DNS and TLS only; 4.4, not built). The
-- stand-in is the e2e suites' loopback provider: pull, NODE_ENV=test only.
CREATE TABLE "BackupConnection" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "transport" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "credentialEnc" TEXT,
    "credentialLast4" TEXT,
    "pushTokenHash" TEXT,
    "pushTokenLast4" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "lastResult" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,

    CONSTRAINT "BackupConnection_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BackupConnection_kind_check" CHECK ("kind" IN ('standin', 'st0r', 'comet')),
    CONSTRAINT "BackupConnection_transport_check" CHECK ("transport" IN ('pull', 'push')),
    -- Decision 17: St0r pushes; Comet and the stand-in are read.
    CONSTRAINT "BackupConnection_kind_transport_check" CHECK (
        ("kind" = 'st0r' AND "transport" = 'push') OR ("kind" IN ('standin', 'comet') AND "transport" = 'pull')),
    -- A pull connection never has a push token; a live push connection always has one.
    CONSTRAINT "BackupConnection_push_token_check" CHECK (
        ("transport" = 'pull' AND "pushTokenHash" IS NULL AND "pushTokenLast4" IS NULL)
        OR ("transport" = 'push' AND ("pushTokenHash" IS NOT NULL OR "revokedAt" IS NOT NULL))),
    CONSTRAINT "BackupConnection_pushTokenHash_check" CHECK ("pushTokenHash" IS NULL OR "pushTokenHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "BackupConnection_last4_check" CHECK (("pushTokenLast4" IS NULL OR "pushTokenLast4" ~ '^[0-9a-f]{4}$')
        AND ("credentialLast4" IS NULL OR char_length("credentialLast4") <= 4)),
    CONSTRAINT "BackupConnection_lastResult_check" CHECK ("lastResult" IS NULL OR "lastResult" ~ '^[A-Z0-9_]{1,40}$'),
    -- Revoked is final: not enabled, no token, no credential.
    CONSTRAINT "BackupConnection_revoked_check" CHECK ("revokedAt" IS NULL OR (NOT "enabled" AND "pushTokenHash" IS NULL AND "credentialEnc" IS NULL))
);
CREATE UNIQUE INDEX "BackupConnection_live_key" ON "BackupConnection"("customerId", "kind") WHERE "revokedAt" IS NULL;
CREATE INDEX "BackupConnection_customerId_idx" ON "BackupConnection"("customerId");
ALTER TABLE "BackupConnection" ADD CONSTRAINT "BackupConnection_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── What is protected ───────────────────────────────────────────────────────
CREATE TABLE "BackupProtectedAsset" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "assetType" TEXT NOT NULL,
    "endpointId" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BackupProtectedAsset_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BackupProtectedAsset_externalId_check" CHECK ("externalId" ~ '^[A-Za-z0-9._:-]{1,128}$'),
    CONSTRAINT "BackupProtectedAsset_name_check" CHECK (char_length("name") BETWEEN 1 AND 200 AND "name" ~ '^[A-Za-z0-9À-ɏ .,:;()/&+''#_@-]+$'),
    CONSTRAINT "BackupProtectedAsset_assetType_check" CHECK ("assetType" IN ('computer', 'server', 'virtual_machine', 'database', 'files', 'mailbox', 'other'))
);
CREATE UNIQUE INDEX "BackupProtectedAsset_connectionId_externalId_key" ON "BackupProtectedAsset"("connectionId", "externalId");
CREATE INDEX "BackupProtectedAsset_customerId_idx" ON "BackupProtectedAsset"("customerId");
CREATE INDEX "BackupProtectedAsset_endpointId_idx" ON "BackupProtectedAsset"("endpointId");
ALTER TABLE "BackupProtectedAsset" ADD CONSTRAINT "BackupProtectedAsset_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BackupProtectedAsset" ADD CONSTRAINT "BackupProtectedAsset_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "BackupConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BackupProtectedAsset" ADD CONSTRAINT "BackupProtectedAsset_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── RPO / RTO targets: a business default (assetId NULL) or one asset ──────
CREATE TABLE "BackupObjective" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "assetId" TEXT,
    "rpoMinutes" INTEGER,
    "rtoMinutes" INTEGER,
    "updatedById" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BackupObjective_pkey" PRIMARY KEY ("id"),
    -- Five minutes to a year.
    CONSTRAINT "BackupObjective_rpo_check" CHECK ("rpoMinutes" IS NULL OR "rpoMinutes" BETWEEN 5 AND 525600),
    CONSTRAINT "BackupObjective_rto_check" CHECK ("rtoMinutes" IS NULL OR "rtoMinutes" BETWEEN 5 AND 525600),
    CONSTRAINT "BackupObjective_some_check" CHECK ("rpoMinutes" IS NOT NULL OR "rtoMinutes" IS NOT NULL)
);
CREATE UNIQUE INDEX "BackupObjective_business_key" ON "BackupObjective"("customerId") WHERE "assetId" IS NULL;
CREATE UNIQUE INDEX "BackupObjective_assetId_key" ON "BackupObjective"("assetId");
ALTER TABLE "BackupObjective" ADD CONSTRAINT "BackupObjective_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BackupObjective" ADD CONSTRAINT "BackupObjective_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "BackupProtectedAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Restore drills, as the provider ran them (Rem0te starts none in 0.81) ──
CREATE TABLE "RestoreDrill" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "recoveryPointId" TEXT,
    "recoveryPointAt" TIMESTAMP(3),
    "target" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "simulated" BOOLEAN NOT NULL,
    "validation" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),
    "elapsedSeconds" INTEGER,
    "failureCode" TEXT,

    CONSTRAINT "RestoreDrill_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RestoreDrill_externalId_check" CHECK ("externalId" ~ '^[A-Za-z0-9._:-]{1,128}$'),
    CONSTRAINT "RestoreDrill_target_check" CHECK ("target" IN ('isolated_vm', 'isolated_path', 'sandbox', 'other')),
    CONSTRAINT "RestoreDrill_scope_check" CHECK ("scope" IN ('file', 'volume', 'full_image', 'application')),
    CONSTRAINT "RestoreDrill_result_check" CHECK ("result" IN ('running', 'passed', 'failed', 'partial', 'unknown')),
    CONSTRAINT "RestoreDrill_validation_check" CHECK ("validation" IN ('sha256', 'file_compare', 'service_running', 'boot', 'manual', 'none')),
    -- A pass that validated nothing is not a pass.
    CONSTRAINT "RestoreDrill_pass_validated_check" CHECK ("result" <> 'passed' OR "validation" <> 'none'),
    CONSTRAINT "RestoreDrill_finished_check" CHECK ("result" IN ('running', 'unknown') OR "finishedAt" IS NOT NULL),
    CONSTRAINT "RestoreDrill_elapsed_check" CHECK ("elapsedSeconds" IS NULL OR "elapsedSeconds" BETWEEN 0 AND 2592000),
    CONSTRAINT "RestoreDrill_failureCode_check" CHECK ("failureCode" IS NULL OR "failureCode" ~ '^[A-Za-z0-9_.-]{1,64}$')
);
CREATE UNIQUE INDEX "RestoreDrill_assetId_externalId_key" ON "RestoreDrill"("assetId", "externalId");
CREATE INDEX "RestoreDrill_customerId_idx" ON "RestoreDrill"("customerId");
ALTER TABLE "RestoreDrill" ADD CONSTRAINT "RestoreDrill_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RestoreDrill" ADD CONSTRAINT "RestoreDrill_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "BackupProtectedAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Jobs ────────────────────────────────────────────────────────────────────
CREATE TABLE "BackupJob" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),
    "completion" TEXT NOT NULL,
    "integrity" TEXT NOT NULL DEFAULT 'not_checked',
    "integrityCheckedAt" TIMESTAMP(3),
    "restoreTest" TEXT NOT NULL DEFAULT 'not_tested',
    "restoreDrillId" TEXT,
    "bytes" BIGINT,
    "errorCode" TEXT,

    CONSTRAINT "BackupJob_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BackupJob_externalId_check" CHECK ("externalId" ~ '^[A-Za-z0-9._:-]{1,128}$'),
    CONSTRAINT "BackupJob_completion_check" CHECK ("completion" IN ('running', 'succeeded', 'partial', 'failed', 'cancelled', 'unknown')),
    CONSTRAINT "BackupJob_integrity_check" CHECK ("integrity" IN ('not_checked', 'passed', 'failed')),
    CONSTRAINT "BackupJob_restoreTest_check" CHECK ("restoreTest" IN ('not_tested', 'verified', 'failed')),
    -- Verified (or failed) only with the drill that says so.
    CONSTRAINT "BackupJob_restoreTest_drill_check" CHECK (("restoreTest" = 'not_tested') = ("restoreDrillId" IS NULL)),
    CONSTRAINT "BackupJob_running_check" CHECK ("completion" <> 'running' OR "finishedAt" IS NULL),
    CONSTRAINT "BackupJob_bytes_check" CHECK ("bytes" IS NULL OR "bytes" >= 0),
    CONSTRAINT "BackupJob_errorCode_check" CHECK ("errorCode" IS NULL OR "errorCode" ~ '^[A-Za-z0-9_.-]{1,64}$')
);
CREATE UNIQUE INDEX "BackupJob_assetId_externalId_key" ON "BackupJob"("assetId", "externalId");
CREATE INDEX "BackupJob_assetId_startedAt_idx" ON "BackupJob"("assetId", "startedAt");
CREATE INDEX "BackupJob_customerId_idx" ON "BackupJob"("customerId");
ALTER TABLE "BackupJob" ADD CONSTRAINT "BackupJob_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BackupJob" ADD CONSTRAINT "BackupJob_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "BackupProtectedAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BackupJob" ADD CONSTRAINT "BackupJob_restoreDrillId_fkey" FOREIGN KEY ("restoreDrillId") REFERENCES "RestoreDrill"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- ── Recovery points ─────────────────────────────────────────────────────────
CREATE TABLE "BackupRecoveryPoint" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "jobId" TEXT,
    "pointAt" TIMESTAMP(3) NOT NULL,
    "location" TEXT NOT NULL,

    CONSTRAINT "BackupRecoveryPoint_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BackupRecoveryPoint_externalId_check" CHECK ("externalId" ~ '^[A-Za-z0-9._:-]{1,128}$'),
    CONSTRAINT "BackupRecoveryPoint_location_check" CHECK ("location" IN ('local', 'offsite', 'cloud', 'unknown'))
);
CREATE UNIQUE INDEX "BackupRecoveryPoint_assetId_externalId_key" ON "BackupRecoveryPoint"("assetId", "externalId");
CREATE INDEX "BackupRecoveryPoint_assetId_pointAt_idx" ON "BackupRecoveryPoint"("assetId", "pointAt");
CREATE INDEX "BackupRecoveryPoint_customerId_idx" ON "BackupRecoveryPoint"("customerId");
ALTER TABLE "BackupRecoveryPoint" ADD CONSTRAINT "BackupRecoveryPoint_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BackupRecoveryPoint" ADD CONSTRAINT "BackupRecoveryPoint_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "BackupProtectedAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BackupRecoveryPoint" ADD CONSTRAINT "BackupRecoveryPoint_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "BackupJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RestoreDrill" ADD CONSTRAINT "RestoreDrill_recoveryPointId_fkey" FOREIGN KEY ("recoveryPointId") REFERENCES "BackupRecoveryPoint"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── One business, all the way down ──────────────────────────────────────────
-- Every backup row names its business, and everything it points at must be
-- that business's: an asset's connection and computer; a job's, point's,
-- drill's and objective's asset; a point's job; a drill's point.
CREATE FUNCTION backup_same_business() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'BackupProtectedAsset' THEN
    IF NOT EXISTS (SELECT 1 FROM "BackupConnection" c WHERE c.id = NEW."connectionId" AND c."customerId" = NEW."customerId") THEN
      RAISE EXCEPTION 'BackupProtectedAsset: connection % is not a connection of business %', NEW."connectionId", NEW."customerId" USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."endpointId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Endpoint" e WHERE e.id = NEW."endpointId" AND e."customerId" = NEW."customerId") THEN
      RAISE EXCEPTION 'BackupProtectedAsset: computer % is not a computer of business %', NEW."endpointId", NEW."customerId" USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."assetId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "BackupProtectedAsset" a WHERE a.id = NEW."assetId" AND a."customerId" = NEW."customerId") THEN
    RAISE EXCEPTION '%: asset % is not an asset of business %', TG_TABLE_NAME, NEW."assetId", NEW."customerId" USING ERRCODE = 'check_violation';
  END IF;
  IF TG_TABLE_NAME = 'BackupRecoveryPoint' THEN
    IF NEW."jobId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "BackupJob" j WHERE j.id = NEW."jobId" AND j."assetId" = NEW."assetId") THEN
      RAISE EXCEPTION 'BackupRecoveryPoint: job % is not a job of asset %', NEW."jobId", NEW."assetId" USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'RestoreDrill' THEN
    IF NEW."recoveryPointId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "BackupRecoveryPoint" p WHERE p.id = NEW."recoveryPointId" AND p."assetId" = NEW."assetId") THEN
      RAISE EXCEPTION 'RestoreDrill: recovery point % is not a point of asset %', NEW."recoveryPointId", NEW."assetId" USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER backup_asset_same_business BEFORE INSERT OR UPDATE OF "customerId", "connectionId", "endpointId" ON "BackupProtectedAsset"
  FOR EACH ROW EXECUTE FUNCTION backup_same_business();
CREATE TRIGGER backup_job_same_business BEFORE INSERT OR UPDATE OF "customerId", "assetId" ON "BackupJob"
  FOR EACH ROW EXECUTE FUNCTION backup_same_business();
CREATE TRIGGER backup_point_same_business BEFORE INSERT OR UPDATE OF "customerId", "assetId", "jobId" ON "BackupRecoveryPoint"
  FOR EACH ROW EXECUTE FUNCTION backup_same_business();
CREATE TRIGGER backup_drill_same_business BEFORE INSERT OR UPDATE OF "customerId", "assetId", "recoveryPointId" ON "RestoreDrill"
  FOR EACH ROW EXECUTE FUNCTION backup_same_business();
CREATE TRIGGER backup_objective_same_business BEFORE INSERT OR UPDATE OF "customerId", "assetId" ON "BackupObjective"
  FOR EACH ROW EXECUTE FUNCTION backup_same_business();

-- A successful job is never verified by succeeding. restoreTest 'verified'
-- needs a drill that passed, was not simulated and restored a recovery point
-- of THIS job; 'failed' needs a non-simulated drill of this job's point that
-- failed. A simulated drill can never be named.
CREATE FUNCTION backup_job_restore_test() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."restoreDrillId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "RestoreDrill" d JOIN "BackupRecoveryPoint" p ON p.id = d."recoveryPointId"
    WHERE d.id = NEW."restoreDrillId" AND p."jobId" = NEW.id AND d."assetId" = NEW."assetId" AND NOT d."simulated"
      AND ((NEW."restoreTest" = 'verified' AND d."result" = 'passed') OR (NEW."restoreTest" = 'failed' AND d."result" IN ('failed', 'partial')))
  ) THEN
    RAISE EXCEPTION 'BackupJob: restoreTest % needs a non-simulated drill of this job''s recovery point with that result', NEW."restoreTest" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER backup_job_restore_test BEFORE INSERT OR UPDATE OF "restoreTest", "restoreDrillId" ON "BackupJob"
  FOR EACH ROW EXECUTE FUNCTION backup_job_restore_test();

-- A computer that changes business leaves the backup assets linked to it unlinked.
CREATE FUNCTION backup_asset_unlink_on_move() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."customerId" IS DISTINCT FROM OLD."customerId" THEN
    UPDATE "BackupProtectedAsset" SET "endpointId" = NULL WHERE "endpointId" = NEW.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER endpoint_backup_asset_unlink AFTER UPDATE OF "customerId" ON "Endpoint"
  FOR EACH ROW EXECUTE FUNCTION backup_asset_unlink_on_move();

-- 0.55's automatic-ticket rule lists the kinds a rule may name. The backup
-- kinds are computer alerts like the others (raised on the computer an asset
-- is linked to), so a rule may name them.
ALTER TABLE "MonitorTicketPolicy" DROP CONSTRAINT "MonitorTicketPolicy_kinds";
ALTER TABLE "MonitorTicketPolicy" ADD CONSTRAINT "MonitorTicketPolicy_kinds" CHECK (
    "kinds" IS NULL OR "kinds" <@ ARRAY['OFFLINE', 'DISK_FREE', 'CPU_HIGH', 'MEMORY_HIGH', 'SERVICE_STOPPED', 'EVENT_MATCH', 'REBOOT_PENDING', 'AGENT_SILENT', 'DRIVE_FREE', 'UPTIME_LONG', 'UPDATES_MISSING', 'UPDATE_FAILED', 'WARRANTY_EXPIRING', 'BACKUP_STALE', 'BACKUP_FAILED', 'DRILL_FAILED', 'RPO_EXCEEDED']::TEXT[]
);
