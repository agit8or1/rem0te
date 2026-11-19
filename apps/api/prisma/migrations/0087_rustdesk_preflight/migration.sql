-- v0.69: Managed Secure Access readiness (docs/managed-secure-access.md, build step 2).
--
-- The signed agent's last read-only RustDesk preflight, one row per computer.
-- It is written only from an authenticated heartbeat on the signed channel
-- that may act (EnrollmentService → MsaService.recordPreflight), after the
-- block passed msa/preflight.ts. It holds facts, never a RustDesk setting's
-- value and never a path: whether the installed rustdesk.exe exists where
-- the installer puts it, its file version, a build flavour (a heuristic),
-- the service state, and whether each of the eleven `--option <key>` reads
-- answered. Nothing reads this to change anything on a computer: it feeds
-- msa/readiness.ts, which decides a readiness state for display only.
CREATE TABLE "RustdeskPreflight" (
    "endpointId" TEXT NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "schema" TEXT NOT NULL,
    "installed" BOOLEAN NOT NULL,
    "expectedPath" BOOLEAN NOT NULL,
    "version" TEXT,
    "build" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "cli" TEXT NOT NULL,
    "keys" JSONB NOT NULL,
    "keysOk" INTEGER NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "agentVersion" TEXT,

    CONSTRAINT "RustdeskPreflight_pkey" PRIMARY KEY ("endpointId"),
    -- msa/preflight.ts PREFLIGHT_SCHEMA, VERSION_RE, BUILDS, SERVICE_STATES, CLI_RESULTS.
    CONSTRAINT "RustdeskPreflight_schema_check" CHECK ("schema" = 'rem0te-rustdesk-preflight/1'),
    CONSTRAINT "RustdeskPreflight_version_check" CHECK ("version" IS NULL OR "version" ~ '^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}([.+][0-9]{1,6})?$'),
    CONSTRAINT "RustdeskPreflight_build_check" CHECK ("build" IN ('flutter', 'sciter', 'unknown')),
    CONSTRAINT "RustdeskPreflight_service_check" CHECK ("service" IN ('running', 'stopped', 'missing', 'other')),
    CONSTRAINT "RustdeskPreflight_cli_check" CHECK ("cli" IN ('ok', 'partial', 'failed', 'not_run')),
    CONSTRAINT "RustdeskPreflight_keys_check" CHECK (jsonb_typeof("keys") = 'object'),
    CONSTRAINT "RustdeskPreflight_keysOk_check" CHECK ("keysOk" BETWEEN 0 AND 11),
    CONSTRAINT "RustdeskPreflight_durationMs_check" CHECK ("durationMs" BETWEEN 0 AND 600000),
    -- not_run means nothing was asked, so nothing answered.
    CONSTRAINT "RustdeskPreflight_not_run_check" CHECK ("cli" <> 'not_run' OR "keysOk" = 0),
    CONSTRAINT "RustdeskPreflight_agentVersion_check" CHECK ("agentVersion" IS NULL OR "agentVersion" ~ '^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$')
);

CREATE INDEX "RustdeskPreflight_checkedAt_idx" ON "RustdeskPreflight"("checkedAt");
ALTER TABLE "RustdeskPreflight" ADD CONSTRAINT "RustdeskPreflight_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;
