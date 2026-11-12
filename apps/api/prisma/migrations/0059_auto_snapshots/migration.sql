-- v0.35: automatic snapshots. The server asks a checking-in computer for its
-- process list, service list and network adapters on a schedule, as an
-- ordinary DiagnosticRun with no requester. See
-- apps/api/src/diagnostics-catalog/snapshot-schedule.ts.

-- A run without a requester is the server asking on its own (the same
-- convention as EndpointCommand.requestedById).
ALTER TABLE "DiagnosticRun" ALTER COLUMN "requestedById" DROP NOT NULL;

-- ...and only ever for a snapshot key. Event-log text (recent_system_errors)
-- or a full inventory pass is asked for by a person, or not at all.
ALTER TABLE "DiagnosticRun" ADD CONSTRAINT "DiagnosticRun_automatic_snapshot_only" CHECK (
    "requestedById" IS NOT NULL OR "key" IN ('process_list', 'service_list', 'network_adapters')
);

-- One open automatic run per key per computer: two heartbeats racing cannot
-- stage the same snapshot twice.
CREATE UNIQUE INDEX "DiagnosticRun_one_open_automatic" ON "DiagnosticRun"("endpointId", "key")
    WHERE "requestedById" IS NULL AND "status" IN ('REQUESTED', 'DELIVERED', 'RUNNING');

-- The schedule, platform-wide. Minutes; 0 is off.
ALTER TABLE "PlatformSettings"
    ADD COLUMN "snapshotAutoEnabled" BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN "snapshotProcessMinutes" INTEGER NOT NULL DEFAULT 360,
    ADD COLUMN "snapshotServiceMinutes" INTEGER NOT NULL DEFAULT 360,
    ADD COLUMN "snapshotNetworkMinutes" INTEGER NOT NULL DEFAULT 360,
    ADD COLUMN "snapshotWatchMinutes" INTEGER NOT NULL DEFAULT 5;

ALTER TABLE "PlatformSettings" ADD CONSTRAINT "PlatformSettings_snapshot_intervals" CHECK (
    ("snapshotProcessMinutes" = 0 OR "snapshotProcessMinutes" BETWEEN 60 AND 10080) AND
    ("snapshotServiceMinutes" = 0 OR "snapshotServiceMinutes" BETWEEN 60 AND 10080) AND
    ("snapshotNetworkMinutes" = 0 OR "snapshotNetworkMinutes" BETWEEN 60 AND 10080) AND
    ("snapshotWatchMinutes" = 0 OR "snapshotWatchMinutes" BETWEEN 3 AND 60)
);

-- Changing the schedule is audited, before and after. The runs it causes are
-- not (one entry per computer per key every few hours would bury the log).
ALTER TYPE "ActivityAction" ADD VALUE 'SNAPSHOT_SCHEDULE_CHANGED';
