-- Device list (0.31): exporting the filtered device list as CSV is audited.
--
-- No index is added. The list's first phase filters Endpoint on customerId
-- (indexed) and status; its second phase joins EndpointInventory on its
-- unique endpointId and MonitorAlert on (endpointId, state), both already
-- indexed. Measured on 5,000 computers in one business before deciding.
ALTER TYPE "ActivityAction" ADD VALUE 'ENDPOINT_LIST_EXPORTED';
