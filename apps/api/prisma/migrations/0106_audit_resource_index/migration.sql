-- 0.93 (UX P1-7): background tools link to their own audit rows
-- (GET /audit?resource=terminal_session&resourceId=<id>). The filter is AND-ed
-- with the caller's scope; this index keeps it from scanning the table.
CREATE INDEX "ActivityLog_resource_resourceId_idx" ON "ActivityLog"("resource", "resourceId");
