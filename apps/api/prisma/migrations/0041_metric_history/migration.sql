-- Metric history (0.33): CPU, memory and disk over time.
--   EndpointMetricSample  one row per authenticated heartbeat (≤ 1/min), 48 h
--   EndpointMetricHourly  min / mean / max per hour, 90 d
--   EndpointDiskSample    each volume's used % per inventory pass, 90 d
-- Percentages only, stored as REAL. The composite primary keys are the
-- indexes the reads and the roll-up use; the `at`/`hour` indexes serve the
-- pruning sweep (docs/metric-history.md).

-- CreateTable
CREATE TABLE "EndpointMetricSample" (
    "endpointId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cpu" REAL,
    "memory" REAL,
    "disk" REAL,

    CONSTRAINT "EndpointMetricSample_pkey" PRIMARY KEY ("endpointId","at")
);

-- CreateTable
CREATE TABLE "EndpointMetricHourly" (
    "endpointId" TEXT NOT NULL,
    "hour" TIMESTAMP(3) NOT NULL,
    "samples" INTEGER NOT NULL,
    "cpuMin" REAL,
    "cpuAvg" REAL,
    "cpuMax" REAL,
    "memoryMin" REAL,
    "memoryAvg" REAL,
    "memoryMax" REAL,
    "diskMin" REAL,
    "diskAvg" REAL,
    "diskMax" REAL,

    CONSTRAINT "EndpointMetricHourly_pkey" PRIMARY KEY ("endpointId","hour")
);

-- CreateTable
CREATE TABLE "EndpointDiskSample" (
    "endpointId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "drive" TEXT NOT NULL,
    "used" REAL NOT NULL,

    CONSTRAINT "EndpointDiskSample_pkey" PRIMARY KEY ("endpointId","at","drive")
);

-- CreateIndex
CREATE INDEX "EndpointMetricSample_at_idx" ON "EndpointMetricSample"("at");

-- CreateIndex
CREATE INDEX "EndpointMetricHourly_hour_idx" ON "EndpointMetricHourly"("hour");

-- CreateIndex
CREATE INDEX "EndpointDiskSample_at_idx" ON "EndpointDiskSample"("at");

-- AddForeignKey
ALTER TABLE "EndpointMetricSample" ADD CONSTRAINT "EndpointMetricSample_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EndpointMetricHourly" ADD CONSTRAINT "EndpointMetricHourly_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EndpointDiskSample" ADD CONSTRAINT "EndpointDiskSample_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

