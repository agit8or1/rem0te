-- v0.51: which agent a computer runs is sticky to signed.
--
-- Two production computers (DS-HOME1, DEWEY-WKS2022) flipped between
-- updateChannel 'signed' and 'legacy' within seconds: the signed install
-- script's own check-ins (Register and the Test-Registered loop) carry the
-- device secret but no updateChannel, so the heartbeat recorded the computer
-- as a standard agent, handed it standard installs and auto-updates, and the
-- tray's identify refused the signed tray host (TRAY_KEY_REQUIRED).
--
-- signedSeenAt is the last authenticated signed heartbeat. Backfilled from
-- what is on record: a computer that reports signed now, or reported a
-- signed build's digest, was last seen on the signed channel at its last
-- trust report.
ALTER TABLE "Endpoint" ADD COLUMN "signedSeenAt" TIMESTAMP(3);
ALTER TABLE "Endpoint" ADD COLUMN "legacySeenAt" TIMESTAMP(3);
ALTER TABLE "Endpoint" ADD COLUMN "legacySeenVersion" TEXT;

UPDATE "Endpoint"
   SET "signedSeenAt" = COALESCE("trustReportedAt", "lastSeenAt", now())
 WHERE "updateChannel" = 'signed' OR "agentSha256" IS NOT NULL;

-- A standard heartbeat still reporting beside the signed agent (audited at
-- most once a day per computer).
ALTER TYPE "ActivityAction" ADD VALUE 'AGENT_DUAL_REPORT';
