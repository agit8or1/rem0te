-- v0.76: the read-only diagnostics palette. Thirteen more catalog keys —
-- security posture, networking and maintenance — on the same request →
-- heartbeat → result path as every other diagnostic; no new table, route or
-- channel. Two of them take typed parameters, the first keys that do.

-- The catalog stays closed in the database: the thirteen keys are added to
-- the list, and nothing else is.
ALTER TABLE "DiagnosticRun" DROP CONSTRAINT "DiagnosticRun_key_catalog";
ALTER TABLE "DiagnosticRun" ADD CONSTRAINT "DiagnosticRun_key_catalog" CHECK ("key" IN (
    'refresh_inventory', 'disk_space', 'service_health', 'recent_system_errors',
    'top_processes', 'network_connectivity', 'dns_resolution', 'pending_updates', 'reboot_status',
    'process_list', 'service_list', 'network_adapters',
    'defender_status', 'firewall_status', 'bitlocker_status', 'secure_boot_tpm', 'local_admins',
    'dns_lookup', 'tcp_port', 'route_table', 'time_sync', 'windows_activation',
    'unexpected_shutdowns', 'scheduled_tasks', 'signed_in_sessions'
));

-- The canonical parameters, as diagnostics-catalog/catalog.ts
-- parseDiagnosticParams returns them. The schema is held here too:
--   dns_lookup  exactly {"name"}, a host name
--   tcp_port    exactly {"host", "port", "timeoutSeconds"}: a host name, an
--               integer 1-65535 and one of 1, 2, 3, 5, 10
--   every other key: no parameters at all.
-- The host-name pattern is HOSTNAME_RE_SOURCE (catalog.ts) and the agent's
-- PALETTE_HOSTNAME_RE (windows-script.ts), character for character (§86).
ALTER TABLE "DiagnosticRun" ADD COLUMN "params" JSONB;
ALTER TABLE "DiagnosticRun" ADD CONSTRAINT "DiagnosticRun_params_closed" CHECK (
    CASE "key"
        WHEN 'dns_lookup' THEN
            "params" IS NOT NULL AND jsonb_typeof("params") = 'object'
            AND ("params" - 'name') = '{}'::jsonb
            AND jsonb_typeof("params"->'name') = 'string'
            AND char_length("params"->>'name') BETWEEN 1 AND 253
            AND ("params"->>'name') ~ '^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$'
        WHEN 'tcp_port' THEN
            "params" IS NOT NULL AND jsonb_typeof("params") = 'object'
            AND ("params" - 'host' - 'port' - 'timeoutSeconds') = '{}'::jsonb
            AND jsonb_typeof("params"->'host') = 'string'
            AND char_length("params"->>'host') BETWEEN 1 AND 253
            AND ("params"->>'host') ~ '^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$'
            AND jsonb_typeof("params"->'port') = 'number'
            AND ("params"->>'port') ~ '^[1-9][0-9]{0,4}$'
            AND ("params"->>'port')::integer BETWEEN 1 AND 65535
            AND jsonb_typeof("params"->'timeoutSeconds') = 'number'
            AND ("params"->>'timeoutSeconds') IN ('1', '2', '3', '5', '10')
        ELSE "params" IS NULL
    END
);
