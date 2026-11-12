-- Data retention (0.34): one sweep ages out operational history and
-- transient rows (docs/data-retention.md). The audit chain (ActivityLog,
-- AuditCheckpoint, AuditChainState) is never pruned; each pass that removed
-- anything adds one RETENTION_PRUNED entry to it.
--
-- The indexes serve the sweep's cutoffs, so a pass is an index range scan
-- over the rows past the window rather than a scan of the whole table.

ALTER TYPE "ActivityAction" ADD VALUE 'RETENTION_PRUNED';

CREATE INDEX "EndpointCommand_createdAt_idx" ON "EndpointCommand"("createdAt");
-- "Is there a newer command of this type for this computer?" — the newest of
-- each type (and the newest that succeeded) is always kept.
CREATE INDEX "EndpointCommand_endpointId_type_createdAt_idx" ON "EndpointCommand"("endpointId", "type", "createdAt");
CREATE INDEX "DiagnosticRun_requestedAt_idx" ON "DiagnosticRun"("requestedAt");
CREATE INDEX "EndpointChange_detectedAt_idx" ON "EndpointChange"("detectedAt");
CREATE INDEX "MonitorAlert_state_resolvedAt_idx" ON "MonitorAlert"("state", "resolvedAt");
CREATE INDEX "LauncherToken_expiresAt_idx" ON "LauncherToken"("expiresAt");
CREATE INDEX "PrivilegedActivity_at_idx" ON "PrivilegedActivity"("at");
-- Session events whose detail has not been trimmed yet. Partial, so the
-- trimmed ones (the bulk, over time) are not scanned again on every pass.
CREATE INDEX "SupportSessionEvent_untrimmed_timestamp_idx" ON "SupportSessionEvent"("timestamp") WHERE "metadata" IS NOT NULL;
