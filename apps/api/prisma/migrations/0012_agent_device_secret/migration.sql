-- Per-device agent secret for the enrollment heartbeat.
--
-- Before this, /enrollment/heartbeat authenticated a machine by its RustDesk ID
-- and nothing else. Nullable on purpose: every machine already enrolled has no
-- secret yet and binds one the next time its installer runs.
ALTER TABLE "RustdeskNode" ADD COLUMN "agentSecretHash" TEXT;
ALTER TABLE "RustdeskNode" ADD COLUMN "agentSecretSetAt" TIMESTAMP(3);

-- A heartbeat that fails the device-secret check is worth seeing in the audit
-- trail: it means someone is talking to us as a machine they are not.
ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'ENDPOINT_HEARTBEAT_REJECTED';
