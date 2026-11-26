/**
 * Monitor templates for backup agents on Windows (0.81, roadmap 4.2).
 *
 * Opt-in: a template is created only when someone presses its button on the
 * Monitoring page, as ordinary audited rules through createRule — exactly
 * like "Add recommended", and never by a migration, seed or start-up. None is
 * in RECOMMENDED. They use the existing SERVICE_STOPPED machinery, so nothing
 * changes on the agent.
 *
 * Every service name below was checked against the vendor's own material on
 * 2026-11-21 (`source`). `alertIfMissing` is false, so a computer that does
 * not have the backup agent installed raises nothing: a template can safely
 * be set for a whole business.
 *
 * Left out, and why (docs/backups.md "Templates"):
 *   - Comet's `backup.elevator` service: Comet's documentation names it (it
 *     takes VSS snapshots and installs updates) but does not say it is meant
 *     to run at all times, so a "stopped" alert could be wrong.
 *   - Any EVENT_MATCH template: neither UrBackup's Windows installer
 *     (urbackup.nsi registers no event source) nor Comet's documentation
 *     names a Windows event source or event id for a failed backup. A
 *     template on an event nobody documented would be a guess.
 */
import type { MonitorKind, Severity } from './engine';

export interface MonitorTemplate {
  id: string;
  vendor: string;
  label: string;
  description: string;
  source: string;
  rules: { key: string; kind: MonitorKind; name: string; severity: Severity; params: Record<string, unknown> }[];
}

export const BACKUP_AGENT_TEMPLATES: MonitorTemplate[] = [
  {
    id: 'urbackup-client',
    vendor: 'UrBackup',
    label: 'UrBackup client (Windows)',
    description: 'Alerts when the UrBackup client service is installed but not running. Devices without the UrBackup client raise nothing.',
    // The Windows client installer creates the service: SERVICE create "UrBackupClientBackend" … autostart=1;
    // display=UrBackup Client Service for Backups.
    source: 'https://github.com/uroni/urbackup_frontend_wx/blob/dev/urbackup.nsi',
    rules: [
      { key: 'backup-urbackup-client', kind: 'SERVICE_STOPPED', name: 'UrBackup client service stopped', severity: 'WARNING', params: { service: 'UrBackupClientBackend', alertIfMissing: false, ignoreDisabled: true } },
    ],
  },
  {
    id: 'comet-backup',
    vendor: 'Comet Backup',
    label: 'Comet Backup agent (Windows)',
    description: 'Alerts when Comet\'s delegate service, which runs scheduled backup jobs, is installed but not running. Devices without Comet raise nothing.',
    // "NT SERVICE\backup.delegate" (installation); "The commands are started by the backup.delegate service" (troubleshooting).
    source: 'https://docs.cometbackup.com/latest/installation/comet-backup-installation',
    rules: [
      { key: 'backup-comet-delegate', kind: 'SERVICE_STOPPED', name: 'Comet Backup delegate service stopped', severity: 'WARNING', params: { service: 'backup.delegate', alertIfMissing: false, ignoreDisabled: true } },
    ],
  },
];

export const TEMPLATE_IDS = BACKUP_AGENT_TEMPLATES.map((t) => t.id) as [string, ...string[]];
