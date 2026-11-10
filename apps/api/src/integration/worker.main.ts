/**
 * Standalone integration worker:
 *
 *   node dist/integration/worker.main.js
 *
 * Same environment file as the API (DATABASE_URL, INTEGRATION_PEERS_FILE).
 * Safe to run more than one: jobs are claimed with leases.
 */
import '../common/bigint-json';
import { NestFactory } from '@nestjs/core';
import { IntegrationWorkerModule } from './worker.module';
import { IntegrationWorkerService } from './worker.service';

async function main() {
  const app = await NestFactory.createApplicationContext(IntegrationWorkerModule, { logger: ['error', 'warn', 'log'] });
  app.enableShutdownHooks();
  app.get(IntegrationWorkerService).start(Number(process.env.INTEGRATION_WORKER_INTERVAL_MS ?? 1000));
}
main().catch((e) => { console.error('integration worker failed to start:', e); process.exit(1); });
