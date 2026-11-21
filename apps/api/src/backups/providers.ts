/**
 * Backups (0.81): what each provider is, how it reaches Rem0te, and what it
 * cannot do. Plain data, no imports but ./model; the Backups page shows it
 * as it is. The facts are the ones in docs/session-maintenance-mdm-backup-audit.md
 * (Phase 4), read from St0r's public repository and Comet's public API
 * reference on 2026-11-21. Neither provider has been called from this server.
 */
import type { ConnectionKind, Transport } from './model';

export type ProviderState = 'available' | 'requires_setup' | 'planned' | 'test_only';

export interface ProviderInfo {
  kind: ConnectionKind;
  label: string;
  transport: Transport;
  /** What Rem0te can do with it in this release. */
  state: ProviderState;
  stateNote: string;
  prerequisites: string[];
  limitations: string[];
}

export const PROVIDERS: Record<ConnectionKind, ProviderInfo> = {
  st0r: {
    kind: 'st0r', label: 'St0r (UrBackup)', transport: 'push',
    state: 'requires_setup',
    stateNote: 'Rem0te accepts a St0r push with a per-business token. St0r does not send one yet: that needs a St0r-side change.',
    prerequisites: [
      'A Platform Admin creates a St0r connection for the business here, and copies the push token (shown once).',
      'St0r 3.2.140 or later with the Rem0te push added (not yet written on the St0r side), configured with that token and this portal\'s address.',
      'Rem0te must be reachable from the St0r host over HTTPS. St0r pushes; Rem0te never connects to a St0r host (decision 17).',
    ],
    limitations: [
      'One St0r manages one UrBackup server. A business with several needs one St0r each, and only one St0r connection per business is possible today.',
      'Restore drills, and whether a run was simulated, are St0r\'s. Rem0te shows them and starts none in this release.',
      'Simulated drills are recorded as simulated and never count as verified, in St0r and here.',
      'Standby is readiness only: neither St0r nor UrBackup fails a workload over (decision 20).',
    ],
  },
  comet: {
    kind: 'comet', label: 'Comet Backup', transport: 'pull',
    state: 'planned',
    stateNote: 'Planned (roadmap 4.4): read-only, with a Comet API token, on a public DNS name with valid TLS only.',
    prerequisites: [
      'A Comet Server on a public DNS name with a valid certificate (decision 17: private addresses are refused).',
      'A Comet admin with a personal API token (AuthType Token), limited to the tenant that matches the business.',
    ],
    limitations: [
      'Comet has no test-restore or dry-run method, so Comet never reports a verified restore: its assets show "restore never tested".',
      'Listing recovery points (vault snapshots) goes through a live, connected device.',
      'Many write and configuration methods refuse token authentication; Rem0te would only read.',
      'Standby is readiness only: Comet does not fail a workload over (decision 20).',
    ],
  },
  standin: {
    kind: 'standin', label: 'Test stand-in', transport: 'pull',
    state: 'test_only',
    stateNote: 'The e2e suites\' loopback provider. It works only under NODE_ENV=test with BACKUP_TEST_BASE_URL on 127.0.0.1.',
    prerequisites: ['NODE_ENV=test and BACKUP_TEST_BASE_URL=http://127.0.0.1:<port>.'],
    limitations: ['Not a backup provider. Never configured on a production server.'],
  },
};

/** Shown in the page's provider panel, in this order. The stand-in is listed only where it can work. */
export const PROVIDER_ORDER: ConnectionKind[] = ['st0r', 'comet', 'standin'];
