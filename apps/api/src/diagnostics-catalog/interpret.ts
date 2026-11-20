/**
 * What a palette result means (0.76): one state per item, with the evidence
 * time, from a result catalog.ts has already sanitised.
 *
 * Pure — no Nest, no Prisma, no clock of its own (`now` is passed in) and no
 * imports — so unit-diagnostics-palette.mjs runs exactly what the API runs,
 * and so does the Windows lab against real results.
 *
 * The states are Healthy, Warning, Critical, Unknown and Unsupported, and the
 * one rule that matters most: **nothing that was not read is Healthy.** A
 * field the agent could not read is Unknown; a feature this Windows does not
 * have (BitLocker on a Server without the feature, Secure Boot on legacy
 * BIOS) is Unsupported; and the overall state is the worst item, with
 * Unknown and Unsupported ranked above Healthy, so a check that read nothing
 * never rolls up to green.
 *
 * Thresholds are constants here, named, and tested. They are deliberately
 * conservative and explainable; each finding says why it is what it is.
 */

export type HealthState = 'healthy' | 'warning' | 'critical' | 'unknown' | 'unsupported';
export const HEALTH_STATES: readonly HealthState[] = ['healthy', 'warning', 'critical', 'unknown', 'unsupported'];
/** Worst first. Unknown and Unsupported outrank Healthy: not knowing is never green. */
const RANK: Record<HealthState, number> = { critical: 4, warning: 3, unknown: 2, unsupported: 1, healthy: 0 };

export interface Finding {
  id: string;
  label: string;
  state: HealthState;
  detail: string;
  /** When the computer read it: the run's completion time. */
  evidenceAt: string | null;
}
export interface Interpretation {
  version: number;
  overall: HealthState;
  findings: Finding[];
}

/** Bumped when a rule or threshold changes, so a stored reading can say which rules judged it. */
export const INTERPRET_VERSION = 1;

export const THRESHOLDS = {
  /** Defender signatures older than this many days: Warning; older than the second: Critical. */
  defenderSignatureWarnDays: 3,
  defenderSignatureCriticalDays: 7,
  /** No quick or full scan finished in this many days: Warning. */
  defenderScanWarnDays: 14,
  /** More individual user accounts than this in local Administrators (the built-in one aside): Warning. */
  adminUsersWarn: 3,
  /** Last successful time sync older than this many days: Warning; older than the second: Critical. */
  timeSyncWarnDays: 8,
  timeSyncCriticalDays: 30,
  /** A DNS answer slower than this: Warning (it still resolved). */
  dnsSlowMs: 1000,
  /** Unexpected restarts in the 30-day window that make it Critical (any bugcheck does too). */
  shutdownsCritical: 3,
  /** Up longer than this many days: Warning (restart overdue). */
  uptimeWarnDays: 30,
  /** OS support ending within this many days: Warning. */
  osEndingSoonDays: 90,
} as const;

const DAY = 86_400_000;
type R = Record<string, unknown>;
const obj = (v: unknown): R => (v && typeof v === 'object' && !Array.isArray(v) ? (v as R) : {});
const arr = (v: unknown): R[] => (Array.isArray(v) ? v.filter((x): x is R => !!x && typeof x === 'object' && !Array.isArray(x)) : []);
const days = (from: string | null | undefined, to: number) => {
  if (typeof from !== 'string' || !Number.isFinite(to)) return null;
  const t = new Date(from).getTime();
  return Number.isNaN(t) ? null : Math.floor((to - t) / DAY);
};
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

export function worst(states: HealthState[]): HealthState {
  if (!states.length) return 'unknown';
  return states.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'healthy' as HealthState);
}

function build(findings: Omit<Finding, 'evidenceAt'>[], evidenceAt: string | null): Interpretation {
  const f = findings.map((x) => ({ ...x, evidenceAt }));
  return { version: INTERPRET_VERSION, overall: worst(f.map((x) => x.state)), findings: f };
}

// ── Security ────────────────────────────────────────────────────────────────

/** Security Center's productState: bits 12–15 say on (1) or off, bits 0–7 say up to date (0) or not. */
export function avProductState(state: number | null | undefined): { enabled: boolean | null; upToDate: boolean | null } {
  if (typeof state !== 'number' || !Number.isInteger(state) || state < 0) return { enabled: null, upToDate: null };
  const on = (state >> 12) & 0xf;
  return { enabled: on === 1, upToDate: (state & 0xff) === 0 };
}

function defender(r: R, at: number): Omit<Finding, 'evidenceAt'>[] {
  const thirdParty = arr(r.registeredAntivirus).filter((a) => typeof a.name === 'string' && !/defender/i.test(a.name as string));
  const thirdOn = thirdParty.filter((a) => avProductState(a.productState as number).enabled === true).map((a) => a.name as string);
  if (r.supported !== true) {
    if (thirdOn.length) return [{ id: 'antivirus', label: 'Antivirus', state: 'healthy', detail: `Defender is not running here; ${thirdOn.join(', ')} is registered and on.` }];
    return [{
      id: 'antivirus', label: 'Antivirus', state: 'unsupported',
      detail: r.reason === 'not_running' ? 'Microsoft Defender is installed but did not answer (it may be turned off for another antivirus).' : 'Microsoft Defender is not installed on this Windows, and no other antivirus could be read.',
    }];
  }
  const out: Omit<Finding, 'evidenceAt'>[] = [];
  const passive = typeof r.runningMode === 'string' && /passive/i.test(r.runningMode);
  if (r.realTimeProtectionEnabled === true) out.push({ id: 'antivirus', label: 'Real-time protection', state: 'healthy', detail: `On${r.runningMode ? ` (${r.runningMode})` : ''}.` });
  else if (r.realTimeProtectionEnabled === false && passive && thirdOn.length) out.push({ id: 'antivirus', label: 'Real-time protection', state: 'healthy', detail: `Defender is passive; ${thirdOn.join(', ')} provides real-time protection.` });
  else if (r.realTimeProtectionEnabled === false) out.push({ id: 'antivirus', label: 'Real-time protection', state: 'critical', detail: passive ? 'Defender is passive and no other antivirus is registered as on.' : 'Off.' });
  else out.push({ id: 'antivirus', label: 'Real-time protection', state: 'unknown', detail: 'Not reported.' });

  if (r.isTamperProtected === true) out.push({ id: 'tamper', label: 'Tamper protection', state: 'healthy', detail: 'On.' });
  else if (r.isTamperProtected === false) out.push({ id: 'tamper', label: 'Tamper protection', state: 'warning', detail: 'Off: malware with administrator rights can turn Defender off.' });
  else out.push({ id: 'tamper', label: 'Tamper protection', state: 'unknown', detail: 'Not reported by this Defender version.' });

  // Age from the date, measured at the evidence time; the agent's own age figure only if there is no date.
  const age = days(r.signatureLastUpdated as string, at) ?? (Number.isFinite(at) && typeof r.signatureAgeDays === 'number' && r.signatureAgeDays < 65535 ? r.signatureAgeDays : null);
  if (age === null) out.push({ id: 'signatures', label: 'Signatures', state: 'unknown', detail: 'No signature date reported.' });
  else if (age > THRESHOLDS.defenderSignatureCriticalDays) out.push({ id: 'signatures', label: 'Signatures', state: 'critical', detail: `${plural(age, 'day')} old (more than ${THRESHOLDS.defenderSignatureCriticalDays}).` });
  else if (age > THRESHOLDS.defenderSignatureWarnDays) out.push({ id: 'signatures', label: 'Signatures', state: 'warning', detail: `${plural(age, 'day')} old (more than ${THRESHOLDS.defenderSignatureWarnDays}).` });
  else out.push({ id: 'signatures', label: 'Signatures', state: 'healthy', detail: age <= 0 ? 'Updated today.' : `${plural(age, 'day')} old.` });

  const scans = [r.quickScanEndAt, r.fullScanEndAt].map((d) => days(d as string, at)).filter((d): d is number => d !== null);
  const last = scans.length ? Math.min(...scans) : null;
  if (last === null) out.push({ id: 'scan', label: 'Last scan', state: 'unknown', detail: 'No finished scan reported.' });
  else if (last > THRESHOLDS.defenderScanWarnDays) out.push({ id: 'scan', label: 'Last scan', state: 'warning', detail: `${plural(last, 'day')} ago (more than ${THRESHOLDS.defenderScanWarnDays}).` });
  else out.push({ id: 'scan', label: 'Last scan', state: 'healthy', detail: last <= 0 ? 'Today.' : `${plural(last, 'day')} ago.` });
  return out;
}

function firewall(r: R): Omit<Finding, 'evidenceAt'>[] {
  const active = Array.isArray(r.activeCategories) ? (r.activeCategories as string[]) : [];
  const inUse = (name: string) => (name === 'Domain' ? active.includes('DomainAuthenticated') : active.includes(name));
  const profiles = arr(r.profiles);
  const out: Omit<Finding, 'evidenceAt'>[] = [];
  if (r.serviceState && r.serviceState !== 'Running') out.push({ id: 'service', label: 'Firewall service', state: 'critical', detail: `The Windows Defender Firewall service is ${String(r.serviceState).toLowerCase()}.` });
  for (const name of ['Domain', 'Private', 'Public']) {
    const p = profiles.find((x) => x.name === name);
    const label = `${name} profile`;
    const used = inUse(name) ? ' (a connected network uses it)' : '';
    if (!p || typeof p.enabled !== 'boolean') { out.push({ id: name.toLowerCase(), label, state: 'unknown', detail: 'Not reported.' }); continue; }
    if (!p.enabled) {
      out.push({ id: name.toLowerCase(), label, state: name === 'Public' || inUse(name) ? 'critical' : 'warning', detail: `Off${used}.` });
      continue;
    }
    if (p.defaultInbound === 'Allow') out.push({ id: name.toLowerCase(), label, state: 'warning', detail: `On, but inbound connections are allowed by default${used}.` });
    else out.push({ id: name.toLowerCase(), label, state: 'healthy', detail: `On; inbound ${p.defaultInbound === 'Block' ? 'blocked' : 'not configured (Windows blocks)'} by default${used}.` });
  }
  return out;
}

function bitlocker(r: R): Omit<Finding, 'evidenceAt'>[] {
  if (r.supported !== true) {
    return [{ id: 'bitlocker', label: 'BitLocker', state: 'unsupported', detail: r.reason === 'not_available' ? 'BitLocker did not answer here (the feature may not be installed, as on Windows Server by default).' : 'BitLocker is not available on this Windows (Home edition, or Server without the feature).' }];
  }
  const vols = arr(r.volumes);
  if (!vols.length) return [{ id: 'bitlocker', label: 'BitLocker', state: 'unknown', detail: 'No volumes reported.' }];
  const out: Omit<Finding, 'evidenceAt'>[] = [];
  if (!vols.some((v) => v.volumeType === 'OperatingSystem')) out.push({ id: 'os-volume', label: 'Windows volume', state: 'unknown', detail: 'No operating-system volume was reported.' });
  for (const v of vols) {
    const os = v.volumeType === 'OperatingSystem';
    const label = `${v.mountPoint}${os ? ' (Windows)' : ''}`;
    const id = `volume-${String(v.mountPoint).replace(/[^A-Za-z0-9]/g, '').slice(0, 40).toLowerCase()}`;
    const pct = typeof v.encryptionPercentage === 'number' ? ` ${v.encryptionPercentage}%` : '';
    const how = v.encryptionMethod && v.encryptionMethod !== 'None' ? `, ${v.encryptionMethod}` : '';
    if (v.protectionStatus === 'On' && v.volumeStatus === 'FullyEncrypted') out.push({ id, label, state: 'healthy', detail: `Protected; fully encrypted${how}.` });
    else if (v.volumeStatus === 'EncryptionInProgress') out.push({ id, label, state: 'warning', detail: `Encrypting:${pct} done.` });
    else if (v.volumeStatus === 'FullyEncrypted' && v.protectionStatus === 'Off') out.push({ id, label, state: 'warning', detail: 'Encrypted, but protection is suspended: the key is stored in the clear until it is resumed.' });
    else if (v.volumeStatus === 'FullyDecrypted') out.push({ id, label, state: 'warning', detail: 'Not encrypted.' });
    else if (v.volumeStatus === 'DecryptionInProgress') out.push({ id, label, state: 'warning', detail: `Being decrypted:${pct} still encrypted.` });
    else if (typeof v.volumeStatus === 'string') out.push({ id, label, state: 'warning', detail: `${v.volumeStatus}; protection ${String(v.protectionStatus ?? 'unknown').toLowerCase()}.` });
    else out.push({ id, label, state: 'unknown', detail: 'Status not reported.' });
  }
  return out;
}

function secureBootTpm(r: R): Omit<Finding, 'evidenceAt'>[] {
  const out: Omit<Finding, 'evidenceAt'>[] = [];
  const sb = r.secureBoot;
  if (sb === 'on') out.push({ id: 'secure-boot', label: 'Secure Boot', state: 'healthy', detail: 'On.' });
  else if (sb === 'off') out.push({ id: 'secure-boot', label: 'Secure Boot', state: 'warning', detail: 'Off: the firmware supports it, but it is not enabled.' });
  else if (sb === 'unsupported') out.push({ id: 'secure-boot', label: 'Secure Boot', state: 'unsupported', detail: 'This computer boots in legacy BIOS mode, which has no Secure Boot.' });
  else out.push({ id: 'secure-boot', label: 'Secure Boot', state: 'unknown', detail: r.secureBootError ? `Could not be read: ${r.secureBootError}` : 'Could not be read.' });
  const t = obj(r.tpm);
  if (t.read !== true) out.push({ id: 'tpm', label: 'TPM', state: 'unknown', detail: t.error ? `Could not be read: ${t.error}` : 'Could not be read.' });
  else if (t.present === false) out.push({ id: 'tpm', label: 'TPM', state: 'warning', detail: 'No TPM found (Windows 11 and BitLocker with TPM need one).' });
  else if (t.present === true && t.ready === true) out.push({ id: 'tpm', label: 'TPM', state: 'healthy', detail: `Present and ready${t.specVersion ? `; version ${String(t.specVersion).split(',')[0].trim()}` : ''}${t.manufacturer ? `; ${t.manufacturer}` : ''}.` });
  else if (t.present === true) out.push({ id: 'tpm', label: 'TPM', state: 'warning', detail: `Present but not ready (enabled ${t.enabled ?? 'unknown'}, activated ${t.activated ?? 'unknown'}).` });
  else out.push({ id: 'tpm', label: 'TPM', state: 'unknown', detail: 'Presence not reported.' });
  return out;
}

function admins(r: R): Omit<Finding, 'evidenceAt'>[] {
  if (r.method === 'none') return [{ id: 'members', label: 'Administrators group', state: 'unknown', detail: r.error ? `Could not be read: ${r.error}` : 'Could not be read.' }];
  const m = arr(r.members);
  const users = m.filter((x) => x.kind === 'User' && x.builtinAdministrator !== true);
  const unresolved = m.filter((x) => !x.name);
  const out: Omit<Finding, 'evidenceAt'>[] = [];
  out.push(users.length > THRESHOLDS.adminUsersWarn
    ? { id: 'members', label: 'Administrators group', state: 'warning', detail: `${plural(users.length, 'user account')} besides the built-in Administrator (more than ${THRESHOLDS.adminUsersWarn}); ${plural(m.length, 'member')} in all.` }
    : { id: 'members', label: 'Administrators group', state: 'healthy', detail: `${plural(m.length, 'member')}: ${plural(users.length, 'user account')} besides the built-in Administrator.` });
  if (unresolved.length) out.push({ id: 'unresolved', label: 'Unresolved members', state: 'warning', detail: `${plural(unresolved.length, 'member')} could not be named (an orphaned or unreadable account).` });
  return out;
}

// ── Networking ──────────────────────────────────────────────────────────────

function dnsLookup(r: R): Omit<Finding, 'evidenceAt'>[] {
  const l = obj(r.lookup);
  const name = typeof l.name === 'string' ? l.name : 'the name';
  if (l.ok === true) {
    const n = Array.isArray(l.addresses) ? l.addresses.length : 0;
    const slow = typeof l.latencyMs === 'number' && l.latencyMs > THRESHOLDS.dnsSlowMs;
    return [{ id: 'lookup', label: name, state: slow ? 'warning' : 'healthy', detail: `Resolved to ${plural(n, 'address')} in ${l.latencyMs ?? '?'} ms${slow ? ` (slower than ${THRESHOLDS.dnsSlowMs} ms)` : ''}.` }];
  }
  if (l.timedOut === true) return [{ id: 'lookup', label: name, state: 'critical', detail: 'No answer within 10 seconds.' }];
  return [{ id: 'lookup', label: name, state: 'critical', detail: `Did not resolve${l.error ? `: ${l.error}` : '.'}` }];
}

const OUTCOME: Record<string, string> = {
  refused: 'Refused: the host answered, but nothing is listening on that port (or a firewall rejected it).',
  timeout: 'No answer within the timeout: a firewall dropping it, or the host is down.',
  not_resolved: 'The host name did not resolve.',
  unreachable: 'No route to that host or network.',
  error: 'The connection failed.',
};
function tcpPort(r: R): Omit<Finding, 'evidenceAt'>[] {
  const label = `${r.host ?? '?'}:${r.port ?? '?'}`;
  if (r.outcome === 'open') return [{ id: 'port', label, state: 'healthy', detail: `Open: connected in ${r.latencyMs ?? '?'} ms${r.remoteAddress ? ` to ${r.remoteAddress}` : ''}, then closed.` }];
  const why = OUTCOME[String(r.outcome)] ?? OUTCOME.error;
  return [{ id: 'port', label, state: 'critical', detail: r.error && r.outcome === 'error' ? `${why} ${r.error}` : why }];
}

function routes(r: R): Omit<Finding, 'evidenceAt'>[] {
  const rs = arr(r.routes);
  if (!rs.length) return [{ id: 'default-route', label: 'Default route', state: 'unknown', detail: 'No routes reported.' }];
  const v4 = rs.filter((x) => x.destination === '0.0.0.0/0');
  const v6 = rs.filter((x) => x.destination === '::/0');
  if (!v4.length && !v6.length) return [{ id: 'default-route', label: 'Default route', state: 'critical', detail: 'No default route: this computer can reach only its own networks.' }];
  const gw = [...v4, ...v6].map((x) => x.nextHop).filter((x) => typeof x === 'string' && x !== '0.0.0.0' && x !== '::');
  return [{ id: 'default-route', label: 'Default route', state: 'healthy', detail: `${v4.length ? 'IPv4' : ''}${v4.length && v6.length ? ' and ' : ''}${v6.length ? 'IPv6' : ''}${gw.length ? ` via ${[...new Set(gw)].slice(0, 3).join(', ')}` : ''}.` }];
}

// ── Maintenance ─────────────────────────────────────────────────────────────

function timeSync(r: R, at: number): Omit<Finding, 'evidenceAt'>[] {
  const q = obj(r.status);
  const out: Omit<Finding, 'evidenceAt'>[] = [];
  if (r.type === 'NoSync') out.push({ id: 'config', label: 'Time source', state: 'warning', detail: 'The time service is set not to synchronize (NoSync).' });
  else if (r.type) out.push({ id: 'config', label: 'Time source', state: 'healthy', detail: r.type === 'NT5DS' ? 'The domain hierarchy.' : `${r.type}${r.ntpServer ? `: ${r.ntpServer}` : ''}.` });
  if (q.ran !== true) { out.push({ id: 'sync', label: 'Last sync', state: 'unknown', detail: 'w32tm.exe was not found.' }); return out; }
  if (q.exitCode !== 0) {
    out.push({ id: 'sync', label: 'Last sync', state: r.serviceState && r.serviceState !== 'Running' ? 'warning' : 'unknown', detail: r.serviceState && r.serviceState !== 'Running' ? `The Windows Time service is ${String(r.serviceState).toLowerCase()} (${String(r.serviceStart ?? 'unknown start').toLowerCase()}), so it has no status to report. On a computer outside a domain it starts on its own now and then.` : `w32tm could not report (exit ${q.exitCode}).` });
    return out;
  }
  const free = typeof q.source === 'string' && /Local CMOS Clock|Free-running/i.test(q.source);
  if (q.leapIndicator === 3 || free) out.push({ id: 'sync', label: 'Last sync', state: 'warning', detail: free ? `Running on its own clock (${q.source}); not synchronized to any time source.` : 'Not synchronized (leap indicator 3).' });
  else {
    const d = days(q.lastSyncAt as string, at);
    if (d === null) out.push({ id: 'sync', label: 'Last sync', state: 'unknown', detail: 'No last successful sync time could be read.' });
    else if (d > THRESHOLDS.timeSyncCriticalDays) out.push({ id: 'sync', label: 'Last sync', state: 'critical', detail: `${plural(d, 'day')} ago (more than ${THRESHOLDS.timeSyncCriticalDays}).` });
    else if (d > THRESHOLDS.timeSyncWarnDays) out.push({ id: 'sync', label: 'Last sync', state: 'warning', detail: `${plural(d, 'day')} ago (more than ${THRESHOLDS.timeSyncWarnDays}).` });
    else out.push({ id: 'sync', label: 'Last sync', state: 'healthy', detail: `${d <= 0 ? 'Today' : `${plural(d, 'day')} ago`}${q.source ? ` from ${q.source}` : ''}${typeof q.stratum === 'number' ? `, stratum ${q.stratum}` : ''}.` });
  }
  return out;
}

const LICENSE: Record<number, string> = {
  0: 'Unlicensed', 1: 'Licensed', 2: 'Initial grace period', 3: 'Additional grace period (hardware changed)',
  4: 'Non-genuine grace period', 5: 'Notification mode: not activated', 6: 'Extended grace period',
};
function activation(r: R): Omit<Finding, 'evidenceAt'>[] {
  const p = arr(r.products);
  if (!p.length) return [{ id: 'activation', label: 'Activation', state: 'unknown', detail: 'No Windows licence was reported.' }];
  return p.slice(0, 4).map((x, i) => {
    const s = typeof x.licenseStatus === 'number' ? x.licenseStatus : null;
    const grace = typeof x.graceMinutes === 'number' && x.graceMinutes > 0 ? `; ${plural(Math.floor(x.graceMinutes / 1440), 'day')} of grace left` : '';
    const what = `${s === null ? 'Status not reported' : LICENSE[s] ?? `Status ${s}`}${x.channel ? ` (${x.channel})` : ''}${grace}.`;
    return { id: `activation-${i}`, label: String(x.name ?? 'Windows'), state: s === null ? 'unknown' : s === 1 ? 'healthy' : s === 0 || s === 5 ? 'critical' : 'warning', detail: what };
  });
}

function shutdowns(r: R): Omit<Finding, 'evidenceAt'>[] {
  if (r.read !== true) return [{ id: 'shutdowns', label: 'Last 30 days', state: 'unknown', detail: 'The System log was not read.' }];
  const e = arr(r.events);
  const bug = e.filter((x) => x.kind === 'bugcheck');
  // 41 and 6008 usually describe the same restart; count restarts by the larger of the two.
  const restarts = Math.max(e.filter((x) => x.kind === 'kernel_power').length, e.filter((x) => x.kind === 'unexpected_shutdown').length);
  if (!e.length) return [{ id: 'shutdowns', label: 'Last 30 days', state: 'healthy', detail: 'No unexpected restarts or blue screens.' }];
  const codes = [...new Set(bug.map((x) => x.bugcheckCode).filter(Boolean))].slice(0, 3);
  const state: HealthState = bug.length || restarts >= THRESHOLDS.shutdownsCritical ? 'critical' : 'warning';
  return [{ id: 'shutdowns', label: 'Last 30 days', state, detail: `${plural(restarts, 'unexpected restart')}${bug.length ? `, ${plural(bug.length, 'blue screen')}${codes.length ? ` (${codes.join(', ')})` : ''}` : ''}.` }];
}

/** Task Scheduler results that are not a failure: success, running, never run, queued, disabled, no more runs. */
export const TASK_OK_RESULTS = [0, 0x41300, 0x41301, 0x41302, 0x41303, 0x41304, 0x41305, 0x41325] as const;
export function taskResultState(result: number | null | undefined, state: string | null | undefined): HealthState {
  if (state === 'Disabled') return 'healthy';
  if (typeof result !== 'number') return 'unknown';
  return (TASK_OK_RESULTS as readonly number[]).includes(result) ? 'healthy' : 'warning';
}
function tasks(r: R): Omit<Finding, 'evidenceAt'>[] {
  if (r.read !== true) return [{ id: 'tasks', label: 'Scheduled tasks', state: 'unknown', detail: 'The task list was not read.' }];
  const t = arr(r.tasks);
  const failed = t.filter((x) => taskResultState(x.lastResult as number, x.state as string) === 'warning');
  if (!t.length) return [{ id: 'tasks', label: 'Scheduled tasks', state: 'healthy', detail: `No tasks outside \\Microsoft\\ (${r.microsoftTasks ?? 0} of Windows' own were not listed).` }];
  return [{
    id: 'tasks', label: 'Scheduled tasks', state: failed.length ? 'warning' : 'healthy',
    detail: failed.length ? `${plural(failed.length, 'task')} of ${t.length} report a failed last run.` : `${plural(t.length, 'task')}, none reporting a failed last run.`,
  }];
}

function sessions(r: R): Omit<Finding, 'evidenceAt'>[] {
  if (r.read !== true) return [{ id: 'sessions', label: 'Signed in', state: 'unknown', detail: 'The sessions were not read.' }];
  const s = arr(r.sessions);
  if (r.userNamesRead !== true && s.length) return [{ id: 'sessions', label: 'Signed in', state: 'unknown', detail: `${plural(s.length, 'session')} with a desktop; the agent could not read who.` }];
  return [{ id: 'sessions', label: 'Signed in', state: 'healthy', detail: s.length ? `${plural(s.length, 'user')} signed in.` : 'Nobody is signed in with a desktop.' }];
}

function reboot(r: R): Omit<Finding, 'evidenceAt'>[] {
  const out: Omit<Finding, 'evidenceAt'>[] = [];
  const src = Array.isArray(r.sources) ? r.sources : [];
  if (r.read === false) out.push({ id: 'pending', label: 'Restart', state: 'unknown', detail: 'The restart signals were not read.' });
  else out.push(r.pending === true ? { id: 'pending', label: 'Restart', state: 'warning', detail: `Pending (${src.length} signal${src.length === 1 ? '' : 's'}).` } : { id: 'pending', label: 'Restart', state: 'healthy', detail: 'None pending.' });
  if (typeof r.uptimeSeconds === 'number') {
    const d = Math.floor(r.uptimeSeconds / 86400);
    out.push({ id: 'uptime', label: 'Uptime', state: d > THRESHOLDS.uptimeWarnDays ? 'warning' : 'healthy', detail: `${plural(d, 'day')}${d > THRESHOLDS.uptimeWarnDays ? ` (more than ${THRESHOLDS.uptimeWarnDays})` : ''}.` });
  } else out.push({ id: 'uptime', label: 'Uptime', state: 'unknown', detail: 'Last boot time not reported.' });
  return out;
}

/** The keys this module interprets. */
export const INTERPRETED_KEYS = [
  'defender_status', 'firewall_status', 'bitlocker_status', 'secure_boot_tpm', 'local_admins',
  'dns_lookup', 'tcp_port', 'route_table', 'time_sync', 'windows_activation', 'unexpected_shutdowns',
  'scheduled_tasks', 'signed_in_sessions', 'reboot_status',
] as const;

/**
 * Interpret one stored result. `evidenceAt` is the run's completion time (when
 * the computer read it) and is what ages are measured from, so a reading looks
 * the same whenever it is opened. Null for a key this module does not cover or
 * a result that is not an object; `{ tooLarge: true }` is Unknown.
 */
export function interpret(key: string, result: unknown, evidenceAt: string | null): Interpretation | null {
  if (!(INTERPRETED_KEYS as readonly string[]).includes(key)) return null;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const r = result as R;
  if (r.tooLarge === true) return build([{ id: 'result', label: 'Result', state: 'unknown', detail: 'The result was too large to keep.' }], evidenceAt);
  const at = evidenceAt && !Number.isNaN(new Date(evidenceAt).getTime()) ? new Date(evidenceAt).getTime() : NaN;
  switch (key) {
    case 'defender_status': return build(defender(r, at), evidenceAt);
    case 'firewall_status': return build(firewall(r), evidenceAt);
    case 'bitlocker_status': return build(bitlocker(r), evidenceAt);
    case 'secure_boot_tpm': return build(secureBootTpm(r), evidenceAt);
    case 'local_admins': return build(admins(r), evidenceAt);
    case 'dns_lookup': return build(dnsLookup(r), evidenceAt);
    case 'tcp_port': return build(tcpPort(r), evidenceAt);
    case 'route_table': return build(routes(r), evidenceAt);
    case 'time_sync': return build(timeSync(r, at), evidenceAt);
    case 'windows_activation': return build(activation(r), evidenceAt);
    case 'unexpected_shutdowns': return build(shutdowns(r), evidenceAt);
    case 'scheduled_tasks': return build(tasks(r), evidenceAt);
    case 'signed_in_sessions': return build(sessions(r), evidenceAt);
    case 'reboot_status': return build(reboot(r), evidenceAt);
    default: return null;
  }
}

// ── OS support (server side, from the inventory) ────────────────────────────
//
// A static table, not a network lookup: the end of servicing (security
// updates) for each Windows build, from Microsoft's lifecycle pages as they
// stood on OS_TABLE_REVIEWED. Client builds have two dates — Home and Pro,
// and Enterprise and Education — and LTSC and Server builds their own. A
// build the table does not know is Unknown; a table older than a year is
// Unknown too, because its "still supported" can no longer be trusted.
// Extended Security Updates are bought per computer and cannot be seen from
// here, so an ended build is Critical with a note saying so.

export const OS_TABLE_REVIEWED = '2026-11-20';
type Dates = { consumer?: string; enterprise?: string; ltsc?: string; server?: string; name: string; serverName?: string; ltscName?: string };
export const OS_SUPPORT: Readonly<Record<string, Dates>> = {
  '7601': { name: 'Windows 7 SP1', serverName: 'Windows Server 2008 R2', consumer: '2020-01-14', enterprise: '2020-01-14', server: '2020-01-14' },
  '9200': { name: 'Windows 8', serverName: 'Windows Server 2012', consumer: '2016-01-12', enterprise: '2016-01-12', server: '2023-10-10' },
  '9600': { name: 'Windows 8.1', serverName: 'Windows Server 2012 R2', consumer: '2023-01-10', enterprise: '2023-01-10', server: '2023-10-10' },
  '10240': { name: 'Windows 10 1507', ltscName: 'Windows 10 LTSB 2015', consumer: '2017-05-09', enterprise: '2017-05-09', ltsc: '2025-10-14' },
  '10586': { name: 'Windows 10 1511', consumer: '2017-10-10', enterprise: '2018-04-10' },
  '14393': { name: 'Windows 10 1607', ltscName: 'Windows 10 LTSB 2016', serverName: 'Windows Server 2016', consumer: '2018-04-10', enterprise: '2019-04-09', ltsc: '2026-10-13', server: '2027-01-12' },
  '15063': { name: 'Windows 10 1703', consumer: '2018-10-09', enterprise: '2019-10-08' },
  '16299': { name: 'Windows 10 1709', consumer: '2019-04-09', enterprise: '2020-10-13' },
  '17134': { name: 'Windows 10 1803', consumer: '2019-11-12', enterprise: '2021-05-11' },
  '17763': { name: 'Windows 10 1809', ltscName: 'Windows 10 LTSC 2019', serverName: 'Windows Server 2019', consumer: '2020-11-10', enterprise: '2021-05-11', ltsc: '2029-01-09', server: '2029-01-09' },
  '18362': { name: 'Windows 10 1903', consumer: '2020-12-08', enterprise: '2020-12-08' },
  '18363': { name: 'Windows 10 1909', consumer: '2021-05-11', enterprise: '2022-05-10' },
  '19041': { name: 'Windows 10 2004', consumer: '2021-12-14', enterprise: '2021-12-14' },
  '19042': { name: 'Windows 10 20H2', consumer: '2022-05-10', enterprise: '2023-05-09' },
  '19043': { name: 'Windows 10 21H1', consumer: '2022-12-13', enterprise: '2022-12-13' },
  '19044': { name: 'Windows 10 21H2', ltscName: 'Windows 10 LTSC 2021', consumer: '2023-06-13', enterprise: '2024-06-11', ltsc: '2027-01-12' },
  '19045': { name: 'Windows 10 22H2', consumer: '2025-10-14', enterprise: '2025-10-14' },
  '20348': { name: 'Windows Server 2022', serverName: 'Windows Server 2022', server: '2031-10-14' },
  '22000': { name: 'Windows 11 21H2', consumer: '2023-10-10', enterprise: '2024-10-08' },
  '22621': { name: 'Windows 11 22H2', consumer: '2024-10-08', enterprise: '2025-10-14' },
  '22631': { name: 'Windows 11 23H2', consumer: '2025-11-11', enterprise: '2026-11-10' },
  '25398': { name: 'Windows Server 23H2', serverName: 'Windows Server 23H2', server: '2025-10-24' },
  '26100': { name: 'Windows 11 24H2', ltscName: 'Windows 11 LTSC 2024', serverName: 'Windows Server 2025', consumer: '2026-10-13', enterprise: '2027-10-12', ltsc: '2029-10-09', server: '2034-10-10' },
  '26200': { name: 'Windows 11 25H2', consumer: '2027-10-12', enterprise: '2028-10-10' },
};

export type OsChannel = 'consumer' | 'enterprise' | 'ltsc' | 'server';
export function osChannel(caption: string): OsChannel {
  if (/server/i.test(caption)) return 'server';
  if (/\bLTS[BC]\b/i.test(caption)) return 'ltsc';
  if (/enterprise|education|\bIoT\b/i.test(caption)) return 'enterprise';
  return 'consumer';
}

export interface OsSupport extends Finding {
  build: string | null;
  channel: OsChannel | null;
  endsOn: string | null;
  tableReviewed: string;
}

/** One finding for the computer's Windows build, at `now`, from the inventory's caption and build number. */
export function osSupport(osCaption: string | null | undefined, osBuild: string | null | undefined, inventoryAt: string | null, now: number): OsSupport {
  const base = { id: 'os-support', label: 'Windows support', evidenceAt: inventoryAt, tableReviewed: OS_TABLE_REVIEWED };
  const build = typeof osBuild === 'string' && /^\d{4,5}$/.test(osBuild.trim()) ? osBuild.trim() : null;
  if (!build || typeof osCaption !== 'string' || !osCaption.trim()) {
    return { ...base, build, channel: null, endsOn: null, state: 'unknown', detail: 'The inventory has no Windows build yet. Refresh inventory collects it.' };
  }
  const channel = osChannel(osCaption);
  if (now - new Date(OS_TABLE_REVIEWED).getTime() > 365 * DAY) {
    return { ...base, build, channel, endsOn: null, state: 'unknown', detail: `The end-of-servicing table was last reviewed on ${OS_TABLE_REVIEWED}, more than a year ago, so it is not trusted to say this build is still supported.` };
  }
  const row = OS_SUPPORT[build];
  const ends = row?.[channel] ?? null;
  if (!row || !ends) {
    return { ...base, build, channel, endsOn: null, state: 'unknown', detail: `Build ${build} (${osCaption.trim()}) is not in the end-of-servicing table reviewed ${OS_TABLE_REVIEWED}.` };
  }
  const name = (channel === 'server' && row.serverName) || (channel === 'ltsc' && row.ltscName) || row.name;
  const edition = channel === 'consumer' ? 'Home and Pro' : channel === 'enterprise' ? 'Enterprise and Education' : channel === 'ltsc' ? 'LTSC' : 'Server';
  const left = Math.floor((new Date(`${ends}T00:00:00Z`).getTime() - now) / DAY);
  if (left < 0) return { ...base, build, channel, endsOn: ends, state: 'critical', detail: `${name} (${edition}) stopped receiving security updates on ${ends}, unless this computer has Extended Security Updates, which cannot be seen from here.` };
  if (left <= THRESHOLDS.osEndingSoonDays) return { ...base, build, channel, endsOn: ends, state: 'warning', detail: `${name} (${edition}) stops receiving security updates on ${ends}, in ${plural(left, 'day')}.` };
  return { ...base, build, channel, endsOn: ends, state: 'healthy', detail: `${name} (${edition}) receives security updates until ${ends}.` };
}
