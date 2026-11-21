/**
 * Settings → Backups (0.82 Wharf): what the setup page says. Pure — no
 * imports but ./model — and unit-tested by apps/api/scripts/unit-backup-setup.mjs.
 *
 *   - the push address St0r is given, built from the public address setting;
 *   - whether a push token may be rotated, and how rotation behaves;
 *   - each capability in the four states docs/capabilities.md uses:
 *     available, requires setup, unsupported, planned.
 */
import { CONTRACT_VERSION, FEED_LIMITS } from './model';

/** Rate limit of POST /backups/push, per source address, per minute (the controller's @RateLimit). */
export const PUSH_PER_MINUTE = 30;

/** The St0r push address on this server, from the API base the public address setting gives (PublicUrlService.api()). */
export function pushEndpoint(apiBase: string): { url: string; dryRunUrl: string; https: boolean } {
  const base = apiBase.replace(/\/+$/, '');
  const url = `${base}/api/v1/backups/push`;
  let https = false;
  try { https = new URL(url).protocol === 'https:'; } catch { /* not a URL: https stays false */ }
  return { url, dryRunUrl: `${url}?dryRun=1`, https };
}

/** What St0r is told: the address, the headers and the limits, in one place for the page and the contract. */
export function pushInstructions(apiBase: string, source: 'setting' | 'environment' | 'default') {
  const e = pushEndpoint(apiBase);
  return {
    ...e, contractVersion: CONTRACT_VERSION, addressSource: source,
    headers: [
      { name: 'Authorization', value: 'Bearer <token>' },
      { name: 'Content-Type', value: 'application/json' },
    ],
    limits: { bytes: FEED_LIMITS.bytes, assets: FEED_LIMITS.assets, jobsPerAsset: FEED_LIMITS.jobs, pointsPerAsset: FEED_LIMITS.points, drillsPerAsset: FEED_LIMITS.drills, perMinute: PUSH_PER_MINUTE },
    /** Why this address may not work for St0r, or null. */
    warning: source === 'default'
      ? 'No public address is set (Settings → General → Public address), so this is the development default. St0r cannot reach it.'
      : !e.https ? 'This address is not HTTPS. St0r must push over HTTPS: set an https public address first.' : null,
  };
}

/**
 * Rotation (0.82): a new token replaces the old one AT ONCE — no overlap.
 *
 * Why no overlap: Rem0te keeps one hash per connection, and the usual reason
 * to rotate is that the old token may be known to someone else; an overlap is
 * a window in which it still works. Nothing is lost by the gap: a push is a
 * delta that St0r re-sends, and re-sending is safe in any order, so the
 * pushes refused between the rotation and St0r's reconfiguration are simply
 * sent again.
 */
export function rotationRefusal(c: { transport: string; revokedAt: Date | null; enabled: boolean; pushTokenHash: string | null }): string | null {
  if (c.revokedAt) return 'BACKUP_CONNECTION_REVOKED';
  if (c.transport !== 'push') return 'BACKUP_NOT_A_PUSH_CONNECTION';
  if (!c.enabled || !c.pushTokenHash) return 'BACKUP_CONNECTION_DISABLED';
  return null;
}

export type CapabilityState = 'available' | 'requires_setup' | 'unsupported' | 'planned';
export interface Capability { key: string; label: string; state: CapabilityState; note: string }

export interface SetupFacts {
  /** The business's live St0r connection, if any. */
  st0r: null | { lastSyncAt: Date | null; lastResult: string | null };
  /** A dry run was answered for that connection. */
  dryRunSeen: boolean;
  assets: number;
  linkedAssets: number;
  /** BACKUP_* monitors that apply to the business (global or its own). */
  backupMonitors: number;
  /** The push address is a usable https public address. */
  addressOk: boolean;
}

/** Every capability on Settings → Backups, in the four states, for one business. */
export function capabilityStates(f: SetupFacts): Capability[] {
  const reported = !!f.st0r?.lastSyncAt;
  return [
    {
      key: 'st0r.push', label: 'St0r reports backup status (push)',
      state: reported ? 'available' : 'requires_setup',
      note: reported ? 'St0r has pushed at least once.'
        : !f.st0r ? 'Create a St0r connection below, then configure St0r with its token and the push address.'
          : !f.addressOk ? 'Set an https public address, so St0r can reach this server.'
            : 'Waiting for St0r\'s first push. The St0r side of the push is still being written.',
    },
    {
      key: 'st0r.dryrun', label: 'Test push (dry run, writes nothing)',
      state: f.st0r ? 'available' : 'requires_setup',
      note: f.st0r ? (f.dryRunSeen ? 'St0r has sent a dry run.' : 'St0r can validate a feed with ?dryRun=1 before sending it.') : 'Needs a St0r connection.',
    },
    {
      key: 'facts.separate', label: 'Completion, integrity and verified restore, shown apart',
      state: reported ? 'available' : 'requires_setup',
      note: 'A successful job is never shown as verified; only a real (not simulated) drill of that job\'s own recovery point verifies it.',
    },
    {
      key: 'link.computers', label: 'Assets linked to computers',
      state: f.assets === 0 ? 'requires_setup' : 'available',
      note: f.assets === 0 ? 'Assets appear after St0r reports.' : `${f.linkedAssets} of ${f.assets} linked. Link the rest on the Backups page.`,
    },
    {
      key: 'alerts', label: 'Backup alerts (stale, failed, drill failed, RPO exceeded)',
      state: f.backupMonitors > 0 ? 'available' : 'requires_setup',
      note: f.backupMonitors > 0 ? `${f.backupMonitors} backup monitor(s) apply.` : 'Add a backup monitor in Settings → Monitoring. An alert is raised only on a linked asset.',
    },
    { key: 'comet', label: 'Comet Backup', state: 'planned', note: 'Roadmap 4.4: read-only, with a Comet API token, on a public DNS name with valid TLS. Creating a Comet connection is refused until then.' },
    { key: 'drill.start', label: 'Start a restore drill from Rem0te', state: 'planned', note: 'Roadmap 4.5. Drills are St0r\'s; Rem0te shows them.' },
    { key: 'failover', label: 'Failover and failback', state: 'unsupported', note: 'Neither St0r nor UrBackup fails a workload over (decision 20). Standby is readiness only.' },
  ];
}
