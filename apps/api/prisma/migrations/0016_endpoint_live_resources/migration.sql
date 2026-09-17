-- Live resource sample on the endpoint inventory.
--
-- The Overview tab showed memory and disk from the six-hourly inventory pass,
-- which is fine as a spec ("16 GB installed") and wrong as a gauge: a needle
-- pointing at a six-hour-old reading looks current and is not. CPU load was
-- not collected at all — only the processor's model and clock.
--
-- These come in on every heartbeat instead, alongside the signed-in user, and
-- carry their own timestamp: `liveSampledAt` moves every ~3 minutes while
-- `collectedAt` moves every ~6 hours, and sharing one column between them
-- would let the UI claim a freshness it does not have.
--
-- Additive: all nullable, no defaults, no table rewrite.
ALTER TABLE "EndpointInventory" ADD COLUMN IF NOT EXISTS "cpuLoadPercent" INTEGER;
ALTER TABLE "EndpointInventory" ADD COLUMN IF NOT EXISTS "systemDiskTotalMb" INTEGER;
ALTER TABLE "EndpointInventory" ADD COLUMN IF NOT EXISTS "systemDiskFreeMb" INTEGER;
ALTER TABLE "EndpointInventory" ADD COLUMN IF NOT EXISTS "liveSampledAt" TIMESTAMP(3);
