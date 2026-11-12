/**
 * Data retention (0.34): what ages out, after how long, and what never does.
 *
 * Pure: no database, no Nest. The sweep (retention.service.ts) only moves rows
 * by the cutoffs computed here; the System status card reads the same table
 * list, so what the page says is what the sweep does.
 *
 * Every window is configurable through the environment and clamped: a typo
 * cannot make the sweep delete last week's alerts (floors) or keep a table
 * growing for a century (ceilings). Anything missing or unparsable takes the
 * default. The floors are set by what reads the data:
 *
 *   alerts             reports read up to 365 days (alert frequency, offline
 *                      time). The default, 400, covers the longest report
 *                      period plus a month; below 365 the report pages say
 *                      how far back they can see (reportCoverage).
 *   privileged activity the abuse guard and the bulk-action budget read the
 *                      last `windowMinutes` (at most 1,440): the floor of 2
 *                      days keeps every row they could read.
 *   commands, diagnostics the newest of each type per computer (and the newest
 *                      that succeeded) is never deleted at any age: the
 *                      Event Log tab and the diagnostic panels show "the last
 *                      result", and an old one is still the last.
 */

export const DAY_MS = 86_400_000;

export interface RetentionConfig {
  /** Finished EndpointCommand rows (inventory, update scan, event-log query). */
  commandDays: number;
  /** Finished DiagnosticRun rows (catalog results, system snapshots). */
  diagnosticDays: number;
  /** EndpointChange rows (the inventory change history). */
  changeDays: number;
  /** RESOLVED MonitorAlert rows and their MonitorAlertEvent rows. */
  alertDays: number;
  /** SupportSessionEvent.metadata on finished sessions is cleared after this; the rows stay. */
  sessionDetailDays: number;
  /** Launcher tokens and connection grants that were never used, this long after they expired. */
  tokenDays: number;
  /** PrivilegedActivity (the abuse guard's sliding window). */
  privilegedDays: number;
  /** Sweep cadence. */
  sweepSeconds: number;
  /** Rows per statement, and statements per table per pass. */
  batch: number;
  batches: number;
}

export const RETENTION_LIMITS = {
  commandDays: { def: 90, min: 7, max: 3650, env: 'RETENTION_COMMAND_DAYS' },
  diagnosticDays: { def: 90, min: 7, max: 3650, env: 'RETENTION_DIAGNOSTIC_DAYS' },
  changeDays: { def: 400, min: 30, max: 3650, env: 'RETENTION_CHANGE_DAYS' },
  alertDays: { def: 400, min: 30, max: 3650, env: 'RETENTION_ALERT_DAYS' },
  sessionDetailDays: { def: 400, min: 30, max: 3650, env: 'RETENTION_SESSION_DETAIL_DAYS' },
  tokenDays: { def: 30, min: 1, max: 365, env: 'RETENTION_TOKEN_DAYS' },
  privilegedDays: { def: 30, min: 2, max: 365, env: 'RETENTION_PRIVILEGED_ACTIVITY_DAYS' },
  sweepSeconds: { def: 3600, min: 2, max: 86_400, env: 'RETENTION_SWEEP_SECONDS' },
  batch: { def: 2000, min: 1, max: 50_000, env: 'RETENTION_BATCH' },
  batches: { def: 10, min: 1, max: 100, env: 'RETENTION_BATCHES' },
} as const satisfies Record<keyof RetentionConfig, { def: number; min: number; max: number; env: string }>;

export function bounded(raw: string | undefined, lim: { def: number; min: number; max: number }): number {
  if (raw === undefined || raw.trim() === '') return lim.def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return lim.def;
  return Math.min(lim.max, Math.max(lim.min, Math.round(n)));
}

/** Read from the environment; missing or unparsable → default, out of range → clamped. */
export function retentionConfig(env: Record<string, string | undefined>): RetentionConfig {
  const out = {} as RetentionConfig;
  for (const k of Object.keys(RETENTION_LIMITS) as (keyof RetentionConfig)[]) out[k] = bounded(env[RETENTION_LIMITS[k].env], RETENTION_LIMITS[k]);
  return out;
}

/** Whether the sweep runs in this process. Anything but the exact word "off" leaves it on. */
export const sweepEnabled = (env: Record<string, string | undefined>) => env.RETENTION_SWEEP !== 'off';

export interface Cutoffs {
  commands: number; diagnostics: number; changes: number; alerts: number;
  sessionDetail: number; tokens: number; privileged: number;
}

/** Rows older than these (epoch ms) are past their window. */
export function cutoffs(now: number, c: RetentionConfig): Cutoffs {
  return {
    commands: now - c.commandDays * DAY_MS,
    diagnostics: now - c.diagnosticDays * DAY_MS,
    changes: now - c.changeDays * DAY_MS,
    alerts: now - c.alertDays * DAY_MS,
    sessionDetail: now - c.sessionDetailDays * DAY_MS,
    tokens: now - c.tokenDays * DAY_MS,
    privileged: now - c.privilegedDays * DAY_MS,
  };
}

/** The most rows one pass removes from one table. */
export const perPassCap = (c: RetentionConfig) => c.batch * c.batches;

/**
 * Run `one` (a single bounded statement returning how many rows it touched)
 * until it touches fewer than a batch, at most `batches` times.
 */
export async function drain(one: () => Promise<number>, batch: number, batches: number): Promise<number> {
  let total = 0;
  for (let i = 0; i < batches; i++) {
    const k = await one();
    total += k;
    if (k < batch) break;
  }
  return total;
}

/**
 * How far back an alert report can see under this retention. A report period
 * is complete when every alert it could count is still stored: alerts are
 * deleted only once resolved for alertDays, so any alert first raised within
 * the last alertDays is still there.
 */
export function reportCoverage(alertDays: number, periodDays: number) {
  return { alertDays, periodDays, complete: periodDays <= alertDays, coversDays: Math.min(periodDays, alertDays) };
}

// ── The inventory ────────────────────────────────────────────────────────────

export type RetentionClass = 'evidence' | 'history' | 'transient';

export interface TableEntry {
  /** Stable key, used by the status card and the sweep's counts. */
  key: string;
  /** The Prisma model / SQL table. */
  table: string;
  label: string;
  class: RetentionClass;
  /** Who removes rows: this sweep, another one, or nobody. */
  sweep: 'retention' | 'metrics' | 'support-requests' | 'own-expiry' | 'none';
  /** Column the status card reads the oldest row from. */
  timeColumn: string;
  /** The config key holding this table's window, when the retention sweep prunes it. */
  windowKey?: keyof RetentionConfig;
  /** What the window means, in a sentence. */
  rule: string;
}

/**
 * Every table that grows with time, and what happens to it. Tables that hold
 * one row per computer, business or user (Endpoint, RustdeskNode,
 * EndpointInventory, …) do not grow with time and are not listed.
 */
export const RETENTION_TABLES: readonly TableEntry[] = [
  // Evidence: never pruned, never modified by retention.
  { key: 'audit', table: 'ActivityLog', label: 'Audit log', class: 'evidence', sweep: 'none', timeColumn: 'createdAt',
    rule: 'Kept for ever. Sealed into a hash chain; a trigger refuses changes and a deleted row is detected as tampering.' },
  { key: 'checkpoints', table: 'AuditCheckpoint', label: 'Audit checkpoints', class: 'evidence', sweep: 'none', timeColumn: 'at',
    rule: 'Kept for ever. Signed statements of the chain head that the verifier checks.' },
  { key: 'actionJobs', table: 'ActionJob', label: 'Approved actions', class: 'evidence', sweep: 'none', timeColumn: 'createdAt',
    rule: 'Kept for ever. Each is a signed plan with its approvals; its targets and results go with it.' },
  { key: 'patchDeployments', table: 'PatchDeployment', label: 'Patch deployments', class: 'evidence', sweep: 'none', timeColumn: 'createdAt',
    rule: 'Kept for ever. Staged patching history tied to signed plans.' },
  { key: 'sessions', table: 'SupportSession', label: 'Remote sessions', class: 'evidence', sweep: 'none', timeColumn: 'createdAt',
    rule: 'Kept. Measured session times and who connected to what; offboarding and session reports read them.' },
  { key: 'securityAlerts', table: 'SecurityAlert', label: 'Security alerts', class: 'evidence', sweep: 'none', timeColumn: 'createdAt',
    rule: 'Kept. Abuse-guard trips and other security findings.' },
  // Operational history: ages out.
  { key: 'commands', table: 'EndpointCommand', label: 'Agent commands', class: 'history', sweep: 'retention', timeColumn: 'createdAt', windowKey: 'commandDays',
    rule: 'Finished commands older than the window are deleted, except the newest of each type per computer and the newest that succeeded. Pending and dispatched ones are never touched.' },
  { key: 'diagnostics', table: 'DiagnosticRun', label: 'Diagnostic runs', class: 'history', sweep: 'retention', timeColumn: 'requestedAt', windowKey: 'diagnosticDays',
    rule: 'Finished runs older than the window are deleted, except the newest run of each diagnostic per computer and the newest that completed. Open runs are never touched.' },
  { key: 'changes', table: 'EndpointChange', label: 'Inventory change history', class: 'history', sweep: 'retention', timeColumn: 'detectedAt', windowKey: 'changeDays',
    rule: 'Changes detected longer ago than the window are deleted.' },
  { key: 'alerts', table: 'MonitorAlert', label: 'Monitor alerts (and their events)', class: 'history', sweep: 'retention', timeColumn: 'firstSeenAt', windowKey: 'alertDays',
    rule: 'Alerts resolved longer ago than the window are deleted with their events. Open and acknowledged alerts are never touched, nor an outage alert with an unresolved child. The alert reports can see back this far.' },
  { key: 'sessionEvents', table: 'SupportSessionEvent', label: 'Session event detail', class: 'history', sweep: 'retention', timeColumn: 'timestamp', windowKey: 'sessionDetailDays',
    rule: 'The rows are kept; on finished sessions, the free-form detail of events older than the window is cleared. Live sessions are never touched.' },
  { key: 'metricRaw', table: 'EndpointMetricSample', label: 'Metric samples (raw)', class: 'history', sweep: 'metrics', timeColumn: 'at',
    rule: 'Pruned by the metric sweep after METRIC_RAW_HOURS, once rolled up.' },
  { key: 'metricHourly', table: 'EndpointMetricHourly', label: 'Metric roll-ups (hourly)', class: 'history', sweep: 'metrics', timeColumn: 'hour',
    rule: 'Pruned by the metric sweep after METRIC_HOURLY_DAYS.' },
  { key: 'metricDisk', table: 'EndpointDiskSample', label: 'Per-volume disk samples', class: 'history', sweep: 'metrics', timeColumn: 'at',
    rule: 'Pruned by the metric sweep after METRIC_HOURLY_DAYS.' },
  { key: 'supportRequests', table: 'SupportRequest', label: 'Support requests', class: 'history', sweep: 'support-requests', timeColumn: 'createdAt',
    rule: 'Kept, but contact details and description are erased 30 days after a request closes (the support-request sweep).' },
  { key: 'updateJobs', table: 'UpdateJob', label: 'Client update jobs', class: 'history', sweep: 'none', timeColumn: 'createdAt',
    rule: 'Not pruned: one row per computer per rollout, so it grows with releases, not with time.' },
  { key: 'integrationJobs', table: 'IntegrationJob', label: 'ClientSt0r jobs', class: 'history', sweep: 'none', timeColumn: 'createdAt',
    rule: 'Not pruned in 0.34: its signed event outbox is read by the peer by sequence.' },
  { key: 'integrationAlertEvents', table: 'IntegrationAlertEvent', label: 'ClientSt0r alert events', class: 'history', sweep: 'none', timeColumn: 'createdAt',
    rule: 'Not pruned in 0.34: a signed, sequenced stream the peer may poll from any point.' },
  // Transient: only meaningful until they expire.
  { key: 'launcherTokens', table: 'LauncherToken', label: 'Unused launcher tokens', class: 'transient', sweep: 'retention', timeColumn: 'createdAt', windowKey: 'tokenDays',
    rule: 'Deleted this long after expiry if never used. A used token is kept: offboarding reads it as evidence of access.' },
  { key: 'connectionGrants', table: 'ConnectionGrant', label: 'Unused connection grants', class: 'transient', sweep: 'retention', timeColumn: 'createdAt', windowKey: 'tokenDays',
    rule: 'Deleted this long after expiry if never redeemed. A redeemed grant is kept: offboarding reads it as evidence of access.' },
  { key: 'privileged', table: 'PrivilegedActivity', label: 'Abuse-guard window', class: 'transient', sweep: 'retention', timeColumn: 'at', windowKey: 'privilegedDays',
    rule: 'Deleted after the window. The guard reads at most the last 24 hours.' },
  { key: 'replayGuard', table: 'IntegrationReplayGuard', label: 'Integration replay guard', class: 'transient', sweep: 'own-expiry', timeColumn: 'createdAt',
    rule: 'Removed on expiry by the integration module.' },
  { key: 'webauthn', table: 'WebAuthnChallenge', label: 'Passkey challenges', class: 'transient', sweep: 'own-expiry', timeColumn: 'createdAt',
    rule: 'Removed on expiry by the passkey module.' },
  { key: 'oidcStates', table: 'OidcLoginState', label: 'SSO login states', class: 'transient', sweep: 'own-expiry', timeColumn: 'createdAt',
    rule: 'Removed on expiry by the SSO module.' },
];

/** Tables the retention sweep may delete from or update. Nothing else, and never the audit chain. */
export const SWEPT_TABLES = RETENTION_TABLES.filter((t) => t.sweep === 'retention').map((t) => t.table).concat(['MonitorAlertEvent']);
export const NEVER_SWEPT = ['ActivityLog', 'AuditCheckpoint', 'AuditChainState'] as const;
