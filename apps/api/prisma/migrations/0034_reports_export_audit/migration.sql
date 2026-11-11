-- Reports (0.32): exporting a report as CSV is audited.
--
-- No index is added. Every report starts from the same scoped Endpoint query
-- as the device list (customerId and status, both indexed); the alert reports
-- read MonitorAlert by customerId (indexed with state) and a firstSeenAt /
-- resolvedAt window, which over one business's alerts is a small range scan.
ALTER TYPE "ActivityAction" ADD VALUE 'REPORT_EXPORTED';
