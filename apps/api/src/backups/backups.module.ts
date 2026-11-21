import { Module } from '@nestjs/common';
import { BackupConnectionsController, BackupPushController, BackupsController } from './backups.controller';
import { BackupsService } from './backups.service';
import { BackupIngestService } from './backup-ingest.service';
import { BackupSyncService } from './backup-sync.service';

/**
 * Backups (0.81 Vault, roadmap 4.1; docs/backups.md, invariant §91). The
 * only module that names a backup provider or reaches one, and the only
 * writer of the backup tables. The monitoring sweep reads them for the
 * BACKUP_* monitor kinds.
 */
@Module({
  // Connections before the page's controller: `backups/connections` must not be read as an asset route.
  controllers: [BackupConnectionsController, BackupPushController, BackupsController],
  providers: [BackupsService, BackupIngestService, BackupSyncService],
})
export class BackupsModule {}
