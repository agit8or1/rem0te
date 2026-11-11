-- v0.33: process list, full service list and network adapter details, as
-- three more read-only catalog keys shown on the device workspace's
-- Processes, Services and Network tabs. Same request → heartbeat → result
-- path as every other diagnostic; no new table and no new channel.

-- The catalog stays closed in the database: the three new keys are added to
-- the list, and nothing else is.
ALTER TABLE "DiagnosticRun" DROP CONSTRAINT "DiagnosticRun_key_catalog";
ALTER TABLE "DiagnosticRun" ADD CONSTRAINT "DiagnosticRun_key_catalog" CHECK ("key" IN (
    'refresh_inventory', 'disk_space', 'service_health', 'recent_system_errors',
    'top_processes', 'network_connectivity', 'dns_resolution', 'pending_updates', 'reboot_status',
    'process_list', 'service_list', 'network_adapters'
));

-- A full process or service list does not fit the 32 KB a top-ten does. The
-- service caps snapshot keys at 128 KB (MAX_SNAPSHOT_BYTES = 131072); this is
-- their backstop, at twice that because jsonb's text form adds spacing. Every
-- other key keeps the 64 KB backstop from migration 0031.
ALTER TABLE "DiagnosticRun" DROP CONSTRAINT "DiagnosticRun_result_bounded";
ALTER TABLE "DiagnosticRun" ADD CONSTRAINT "DiagnosticRun_result_bounded" CHECK (
    "result" IS NULL OR octet_length("result"::text) <= (CASE WHEN "key" IN ('process_list', 'service_list', 'network_adapters') THEN 262144 ELSE 65536 END)
);

-- The workspace tabs read the newest completed run of one key.
CREATE INDEX "DiagnosticRun_endpointId_key_completedAt_idx" ON "DiagnosticRun"("endpointId", "key", "completedAt");
