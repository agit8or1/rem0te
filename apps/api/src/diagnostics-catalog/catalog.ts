/**
 * The one-click read-only diagnostics catalog (0.31).
 *
 * Plain module — no Nest, no Prisma — so the unit test and the static
 * invariant check read exactly what the API runs.
 *
 * **The catalog is closed.** A request names a key from this list and
 * nothing else: no parameters, no free text. The standard agent maps the key
 * to a fixed, read-only script block compiled into heartbeat.ps1
 * (public/windows-script.ts, "Diagnostics catalog (0.31)") and refuses any
 * key it does not know. The server refuses unknown keys at the request, at
 * delivery, at the result, and the database refuses them with a CHECK
 * constraint (migration 0031). Adding a diagnostic therefore means changing
 * all four, which is the point: nothing a console user types can reach a
 * SYSTEM shell.
 *
 * **Results are evidence, not trust.** Everything the agent reports is
 * re-shaped here field by field (unknown fields dropped, strings clamped and
 * redacted, numbers range-checked, lists cut) and then capped at
 * MAX_RESULT_BYTES before it is stored. The keys are snake_case and stable,
 * because INTEGRATION_COORDINATION.md §5 P1/P2 proposes advertising this
 * catalog to ClientSt0r as `diagnostics_readonly`.
 */

export const DIAGNOSTIC_KEYS = [
  'refresh_inventory',
  'disk_space',
  'service_health',
  'recent_system_errors',
  'top_processes',
  'network_connectivity',
  'dns_resolution',
  'pending_updates',
  'reboot_status',
  // 0.33: full snapshots, shown on the device workspace's Processes, Services
  // and Network tabs rather than in the Diagnostics list (see SNAPSHOT_KEYS).
  'process_list',
  'service_list',
  'network_adapters',
  // 0.76: the read-only palette — security posture, networking, maintenance.
  'defender_status',
  'firewall_status',
  'bitlocker_status',
  'secure_boot_tpm',
  'local_admins',
  'dns_lookup',
  'tcp_port',
  'route_table',
  'time_sync',
  'windows_activation',
  'unexpected_shutdowns',
  'scheduled_tasks',
  'signed_in_sessions',
] as const;
export type DiagnosticKey = (typeof DIAGNOSTIC_KEYS)[number];

export type DurationCategory = 'seconds' | 'minute' | 'minutes';

export interface CatalogEntry {
  key: DiagnosticKey;
  label: string;
  description: string;
  /**
   * The capability a requester needs — and the one needed to read the result.
   * 0.76: dns_lookup and tcp_port need computers:connect, because they make
   * the computer reach a host the requester names, on its own network: what
   * a remote session already gives, and View computers alone does not.
   */
  capability: 'computers:view' | 'computers:event_logs' | 'computers:connect';
  /** Why that capability, for the docs and the UI tooltip. */
  capabilityReason: string;
  supportedOs: readonly ['windows'];
  duration: DurationCategory;
  risk: 'read_only';
  expectedImpact: 'none';
  approvals: 'none (read-only)';
  /**
   * 0.33: the device workspace tab that shows this key's latest result as a
   * snapshot (with its age and a Refresh). Snapshot keys are left out of the
   * Diagnostics list, which would only repeat the tab.
   */
  tab?: 'processes' | 'services' | 'network';
  /** 0.76: the Diagnostics tab's group. Snapshot keys have their tab instead. */
  group: DiagnosticGroup;
  /**
   * 0.76: the oldest agent that carries this key's block. The standard agent
   * reports the portal release it was installed from; the signed agent its
   * own release, so a signed computer has the palette after the first signed
   * publish at or after 0.76.0. An older agent is refused at the request
   * (DIAGNOSTIC_NEEDS_NEWER_AGENT) rather than handed a key it would refuse.
   */
  minAgent?: string;
  /** 0.76: the closed parameter schema, for the two keys that take one (PARAM_SCHEMAS). */
  params?: 'dns_lookup' | 'tcp_port';
  /** 0.76: where it has run for real. Every palette key: GitHub's Windows Server runner only, until fleet evidence exists. */
  evidence?: 'lab_windows_server';
}

export type DiagnosticGroup = 'general' | 'security' | 'networking' | 'maintenance';
export const DIAGNOSTIC_GROUPS: readonly { id: DiagnosticGroup; label: string }[] = [
  { id: 'security', label: 'Security' },
  { id: 'networking', label: 'Networking' },
  { id: 'maintenance', label: 'Maintenance' },
  { id: 'general', label: 'General' },
];
/** The release that added the palette keys. */
export const PALETTE_MIN_AGENT = '0.76.0';
/** "Run all security checks" runs exactly these, in this order. */
export const SECURITY_KEYS = ['defender_status', 'firewall_status', 'bitlocker_status', 'secure_boot_tpm', 'local_admins'] as const;

const W = ['windows'] as const;
const RO = { risk: 'read_only', expectedImpact: 'none', approvals: 'none (read-only)', supportedOs: W } as const;
const VIEW = 'computers:view' as const;
const PAL = { minAgent: PALETTE_MIN_AGENT, evidence: 'lab_windows_server' } as const;

export const CATALOG: readonly CatalogEntry[] = [
  {
    key: 'refresh_inventory', label: 'Refresh inventory', ...RO, group: 'general', capability: VIEW, duration: 'minute',
    description: 'Re-collect hardware, operating system, disks, network adapters and installed software, and update the Specs tab.',
    capabilityReason: 'The same data, and the same capability, as the Specs tab and its Refresh button.',
  },
  {
    key: 'disk_space', label: 'Disk space', ...RO, group: 'general', capability: VIEW, duration: 'seconds',
    description: 'Size and free space of every fixed volume, with the percentage free.',
    capabilityReason: 'Already part of the inventory anyone who can see the device can read.',
  },
  {
    key: 'service_health', label: 'Service health', ...RO, group: 'general', capability: VIEW, duration: 'seconds',
    description: 'Services set to start automatically that are not running, and the state of every service a monitor watches on this device.',
    capabilityReason: 'Service names and states only — the same as the service monitors report. No paths or accounts.',
  },
  {
    key: 'recent_system_errors', label: 'Recent system errors', ...RO, group: 'general', capability: 'computers:event_logs', duration: 'seconds',
    description: 'Critical and Error events from the System and Application logs in the last 24 hours, grouped by source and event id with a count, first and last time, and a shortened message.',
    capabilityReason: 'It returns event-log message text, which is what computers:event_logs gates on the Event Log tab.',
  },
  {
    key: 'top_processes', label: 'Top processes', ...RO, group: 'general', capability: VIEW, duration: 'seconds',
    description: 'The ten processes using the most processor time and the ten using the most memory: name, process id, CPU seconds and working set. No command lines, paths or users.',
    capabilityReason: 'Process names are no more than the installed-software list already shows.',
  },
  {
    key: 'network_connectivity', label: 'Network connectivity', ...RO, group: 'networking', capability: VIEW, duration: 'seconds',
    description: 'Whether this device can open a TCP connection to the rem0te server it already reports to, and which network adapters are up or down with their addresses.',
    capabilityReason: 'Adapters and addresses are already in the inventory; the reach test is to this server only.',
  },
  {
    key: 'dns_resolution', label: 'DNS resolution', ...RO, group: 'networking', capability: VIEW, duration: 'seconds',
    description: 'Resolve the rem0te server name and one fixed public name (dns.msftncsi.com), reporting the DNS servers in use, the answers and how long each took.',
    capabilityReason: 'Names are fixed by the agent, not chosen by the requester; nothing about the user is read.',
  },
  {
    key: 'pending_updates', label: 'Pending updates', ...RO, group: 'maintenance', capability: VIEW, duration: 'minutes',
    description: 'Ask Windows Update which updates are available but not installed (the existing update scan), and update the Patches tab. Installs nothing.',
    capabilityReason: 'The same scan, and the same capability, as the inventory Refresh button.',
  },
  {
    key: 'reboot_status', label: 'Reboot status', ...RO, group: 'maintenance', capability: VIEW, duration: 'seconds',
    description: 'Whether Windows is waiting for a restart, and which of the standard signals say so (component servicing, Windows Update, pending file renames, the update agent), with the last boot time.',
    capabilityReason: 'Flags and the boot time only; the rename list itself (which holds paths) is never read.',
  },
  {
    key: 'process_list', label: 'Processes', ...RO, group: 'general', capability: VIEW, duration: 'seconds', tab: 'processes',
    description: 'Every running process: name, process id, processor time, working set, the user it runs as where Windows lets the agent read it, and when it started. No command lines, paths, modules or environment.',
    capabilityReason: 'Process names and owners are no more than the console already shows (installed software, the signed-in user). Command lines, which can carry secrets, are never collected.',
  },
  {
    key: 'service_list', label: 'Services', ...RO, group: 'general', capability: VIEW, duration: 'seconds', tab: 'services',
    description: 'Every installed Windows service: name, display name, state, start mode and the account it runs as. No binary paths or arguments.',
    capabilityReason: 'The same service names and states the monitors read, plus the run-as account name. Binary paths and arguments are never collected.',
  },
  {
    key: 'network_adapters', label: 'Network adapters', ...RO, group: 'networking', capability: VIEW, duration: 'seconds', tab: 'network',
    description: 'Every network connection Windows lists: status, speed, MAC address, IPv4 and IPv6 addresses, gateways, DNS servers and suffix, and DHCP (server and lease).',
    capabilityReason: 'Adapters, MAC and addresses are already in the inventory on the Specs tab; this adds gateways, DNS and DHCP detail.',
  },

  // ── 0.76: the read-only palette ──
  {
    key: 'defender_status', label: 'Microsoft Defender', ...RO, ...PAL, group: 'security', capability: VIEW, duration: 'seconds',
    description: 'Real-time protection, tamper protection, signature age and the last quick and full scan (Get-MpComputerStatus), and any antivirus registered with Security Center. Starts no scan and updates nothing.',
    capabilityReason: 'Protection states and dates only; no detections, file names or exclusions are read.',
  },
  {
    key: 'firewall_status', label: 'Windows Firewall', ...RO, ...PAL, group: 'security', capability: VIEW, duration: 'seconds',
    description: 'Each firewall profile (Domain, Private, Public) as Windows applies it: on or off and the default inbound and outbound action, the categories of the networks connected now, and the firewall service.',
    capabilityReason: 'Profile states only; no rules, ports or programs are listed.',
  },
  {
    key: 'bitlocker_status', label: 'BitLocker', ...RO, ...PAL, group: 'security', capability: VIEW, duration: 'seconds',
    description: 'Every volume BitLocker knows: protection on or off, encryption status and percentage, the method, and which kinds of protector it has (TPM, recovery password…). Recovery keys and protector ids are never read.',
    capabilityReason: 'States and protector kinds only. A recovery key would unlock the disk, so the agent never reads one and the server keeps only a closed list of protector kinds.',
  },
  {
    key: 'secure_boot_tpm', label: 'Secure Boot and TPM', ...RO, ...PAL, group: 'security', capability: VIEW, duration: 'seconds',
    description: 'Whether Secure Boot is on (or the firmware is legacy BIOS, which cannot say), and whether a TPM is present, enabled, activated and ready, with its manufacturer and specification version.',
    capabilityReason: 'Firmware and TPM states only; nothing is cleared, provisioned or changed.',
  },
  {
    key: 'local_admins', label: 'Local administrators', ...RO, ...PAL, group: 'security', capability: VIEW, duration: 'seconds',
    description: 'Who is in the local Administrators group (found by its well-known SID): each member’s account name, whether it is a user or a group, where it comes from (local, Active Directory, Entra ID, Microsoft account) and which one is the built-in Administrator.',
    capabilityReason: 'Account names, as the Processes tab already shows its owners. No SIDs, passwords, profile paths or group policy are read.',
  },
  {
    key: 'dns_lookup', label: 'DNS lookup', ...RO, ...PAL, group: 'networking', capability: 'computers:connect', duration: 'seconds', params: 'dns_lookup',
    description: 'Resolve a host name you give through this device’s own resolver (hosts file, cache, then DNS), with the addresses, how long it took and the DNS servers in use. Waits at most ten seconds.',
    capabilityReason: 'You choose the name, and the device asks its own network about it — what a remote session already lets you do. A name is checked against one strict rule on the portal, in the database and on the device.',
  },
  {
    key: 'tcp_port', label: 'TCP port test', ...RO, ...PAL, group: 'networking', capability: 'computers:connect', duration: 'seconds', params: 'tcp_port',
    description: 'Whether this device can open a TCP connection to a host and port you give, within a timeout you pick (1–10 seconds): open, refused, no answer, or the name did not resolve. It connects and closes; no data is sent.',
    capabilityReason: 'You choose where the device connects, on its own network — what a remote session already lets you do. The host, port and timeout are checked against closed rules on the portal, in the database and on the device.',
  },
  {
    key: 'route_table', label: 'Routes', ...RO, ...PAL, group: 'networking', capability: VIEW, duration: 'seconds',
    description: 'The IPv4 and IPv6 routing table: destination, next hop, interface and metric, leaving out the multicast and broadcast routes every device has. Up to 200 routes.',
    capabilityReason: 'Addresses and gateways the Network tab already shows, in routing-table form.',
  },
  {
    key: 'time_sync', label: 'Time sync', ...RO, ...PAL, group: 'maintenance', capability: VIEW, duration: 'seconds',
    description: 'The Windows Time service: its state, where it gets the time (domain or NTP server), and its own report of the last successful sync, source and stratum (w32tm /query /status). Asks for no resync.',
    capabilityReason: 'Time-service settings and status only.',
  },
  {
    key: 'windows_activation', label: 'Windows activation', ...RO, ...PAL, group: 'maintenance', capability: VIEW, duration: 'minute',
    description: 'Whether Windows is activated, in a grace period or unlicensed, with the licence channel and the grace time left. The product key is never read.',
    capabilityReason: 'The licence status Windows shows in Settings → Activation; no key, not even its last five characters.',
  },
  {
    key: 'unexpected_shutdowns', label: 'Unexpected shutdowns', ...RO, ...PAL, group: 'maintenance', capability: VIEW, duration: 'seconds',
    description: 'Restarts without a clean shutdown (Kernel-Power 41, EventLog 6008) and blue screens (BugCheck 1001) in the last 30 days, with the time and the bugcheck code. No message text.',
    capabilityReason: 'Event times, ids and the bugcheck code only — not event-log text, so View devices is enough.',
  },
  {
    key: 'scheduled_tasks', label: 'Scheduled tasks', ...RO, ...PAL, group: 'maintenance', capability: VIEW, duration: 'minute',
    description: 'The scheduled tasks outside Windows’ own \\Microsoft\\ folder: name, folder, state, author, the account it runs as, and its last and next run with the last result. What a task runs, and its arguments, are never read.',
    capabilityReason: 'Names, states and times. A task’s command line can carry secrets, so its actions are never collected.',
  },
  {
    key: 'signed_in_sessions', label: 'Signed-in users', ...RO, ...PAL, group: 'maintenance', capability: VIEW, duration: 'seconds',
    description: 'Who is signed in to Windows now: one row per session with a desktop (the owner of its Explorer), with the session number and since when.',
    capabilityReason: 'The signed-in account names the Processes tab already shows as process owners.',
  },
];

// ── Typed parameters (0.76) ─────────────────────────────────────────────────
//
// Two keys take parameters, and only these. The schema is closed: exactly the
// listed fields, each checked here at the request, again in migration 0092's
// CHECK, and again by the agent's own copy of the rule (Test-Rem0tePalHost,
// Test-Rem0tePalKeys) before anything is resolved or dialled. Every other key
// takes none, and a request that sends any is refused.

/**
 * A host name or an IPv4 address: labels of letters, digits and hyphens, not
 * starting or ending with a hyphen, at most 63 characters each, joined by
 * single dots, at most 253 in all. No scheme, port, path, user, wildcard,
 * space, underscore or trailing dot. The same source text is the agent's
 * (windows-script.ts PALETTE_HOSTNAME_RE) and the database's (0092).
 */
export const HOSTNAME_RE_SOURCE = '^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$';
const HOSTNAME_RE = new RegExp(HOSTNAME_RE_SOURCE);
export const HOSTNAME_MAX = 253;
/** The closed list of TCP test timeouts, seconds. */
export const TCP_TIMEOUTS = [1, 2, 3, 5, 10] as const;
export const DEFAULT_TCP_TIMEOUT = 5;
/** The fields each schema has, exactly. */
export const PARAM_FIELDS = { dns_lookup: ['name'], tcp_port: ['host', 'port', 'timeoutSeconds'] } as const;

export function isHostName(v: unknown): v is string {
  return typeof v === 'string' && v.length >= 1 && v.length <= HOSTNAME_MAX && !/[\r\n]/.test(v) && HOSTNAME_RE.test(v);
}

export type DiagnosticParams = { name: string } | { host: string; port: number; timeoutSeconds: number };
export type ParamsResult = { ok: true; params: DiagnosticParams | null } | { ok: false; error: string };

/**
 * The one parameter check. For a key without a schema, anything but
 * undefined or null is refused. For dns_lookup and tcp_port, a plain object
 * with exactly the schema's fields (tcp_port's timeoutSeconds may be left out
 * and is then the default), each valid; the canonical object is returned and
 * is what is stored, delivered and audited.
 */
export function parseDiagnosticParams(key: string, raw: unknown): ParamsResult {
  const entry = BY_KEY.get(key);
  if (!entry) return { ok: false, error: 'Not a catalog diagnostic.' };
  if (!entry.params) return raw === undefined || raw === null ? { ok: true, params: null } : { ok: false, error: `${entry.label} takes no parameters.` };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) return { ok: false, error: `${entry.label} needs its parameters.` };
  const r = raw as Record<string, unknown>;
  const fields: readonly string[] = PARAM_FIELDS[entry.params];
  const extra = Object.keys(r).filter((k) => !fields.includes(k));
  if (extra.length) return { ok: false, error: `Unknown parameter: ${extra.slice(0, 3).join(', ').slice(0, 80)}.` };
  if (entry.params === 'dns_lookup') {
    if (!isHostName(r.name)) return { ok: false, error: 'The name must be a host name or IPv4 address: letters, digits, hyphens and dots, at most 253 characters.' };
    return { ok: true, params: { name: r.name } };
  }
  if (!isHostName(r.host)) return { ok: false, error: 'The host must be a host name or IPv4 address: letters, digits, hyphens and dots, at most 253 characters.' };
  if (typeof r.port !== 'number' || !Number.isInteger(r.port) || r.port < 1 || r.port > 65535) return { ok: false, error: 'The port must be a whole number from 1 to 65535.' };
  const to = r.timeoutSeconds === undefined ? DEFAULT_TCP_TIMEOUT : r.timeoutSeconds;
  if (typeof to !== 'number' || !(TCP_TIMEOUTS as readonly number[]).includes(to)) return { ok: false, error: `The timeout must be one of ${TCP_TIMEOUTS.join(', ')} seconds.` };
  return { ok: true, params: { host: r.host, port: r.port, timeoutSeconds: to } };
}

/** a.b.c compared as numbers; null when either is not a version. */
export function compareVersions(a: string, b: string): number | null {
  const p = (v: string) => (/^\d+\.\d+\.\d+/.test(v) ? v.split(/[.+-]/).slice(0, 3).map(Number) : null);
  const x = p(a), y = p(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/** Whether an agent that reports `agentVersion` is known to be too old for `entry`. Unknown versions are not refused. */
export function agentTooOld(entry: { minAgent?: string }, agentVersion: string | null | undefined): boolean {
  if (!entry.minAgent || !agentVersion) return false;
  const c = compareVersions(agentVersion, entry.minAgent);
  return c !== null && c < 0;
}

/** The keys shown as workspace snapshots (0.33), and the tab each belongs to. */
export const SNAPSHOT_KEYS = ['process_list', 'service_list', 'network_adapters'] as const;
export type SnapshotKey = (typeof SNAPSHOT_KEYS)[number];
export function isSnapshotKey(k: unknown): k is SnapshotKey {
  return typeof k === 'string' && (SNAPSHOT_KEYS as readonly string[]).includes(k);
}

const BY_KEY = new Map<string, CatalogEntry>(CATALOG.map((e) => [e.key, e]));

export function isCatalogKey(k: unknown): k is DiagnosticKey {
  return typeof k === 'string' && BY_KEY.has(k);
}
export function catalogEntry(k: string): CatalogEntry | undefined {
  return BY_KEY.get(k);
}

// ── Lifecycle timing ─────────────────────────────────────────────────────────

/** A run not handed to the computer by then is EXPIRED: it did not check in. */
export const PICKUP_TTL_MINUTES = 15;
/** Delivered, but the agent never said it started: it predates the catalog. */
export const START_TTL_MINUTES = 10;
/** Started, and no result by then. Per duration category. */
export const RUN_TTL_MINUTES: Record<DurationCategory, number> = { seconds: 5, minute: 10, minutes: 30 };
/** Runs handed out per heartbeat. */
export const RUNS_PER_HEARTBEAT = 3;

// ── Rate limits ──────────────────────────────────────────────────────────────

export const RATE_WINDOW_MINUTES = 10;
export const MAX_RUNS_PER_DEVICE = 20;
export const MAX_RUNS_PER_USER = 40;

// ── Result bounds ────────────────────────────────────────────────────────────

/** Stored result size cap, bytes of JSON. The database CHECK is the backstop at 64 KB. */
export const MAX_RESULT_BYTES = 32_768;
/**
 * Snapshot keys (0.33) list everything rather than a top ten, so they get a
 * larger cap: 1,000 processes at ~140 bytes each would not fit in 32 KB. The
 * database backstop for them is 256 KB (migration 0042).
 */
export const MAX_SNAPSHOT_BYTES = 131_072;
/** Rows a snapshot may hold, on the agent and again here. */
export const SNAPSHOT_ROWS = { process_list: 1000, service_list: 1000, network_adapters: 32 } as const;
/** The stored cap for one key. */
export function resultCapFor(key: string): number {
  return isSnapshotKey(key) ? MAX_SNAPSHOT_BYTES : MAX_RESULT_BYTES;
}
/** What the agent may post for one result (refresh_inventory carries the whole inventory). */
export const MAX_AGENT_RESULT_CHARS = 600_000;
export const MAX_MESSAGE_CHARS = 300;

// ── Sanitising ───────────────────────────────────────────────────────────────

// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g;
// A Windows user-profile path names a person. Inventory never reports one,
// so neither may a diagnostic: C:\Users\alice\… → %USERPROFILE%\…
const PROFILE = /[A-Za-z]:\\(?:Users|Documents and Settings)\\[^\\\s"'<>|]+/gi;
// Long opaque tokens (hex, base64, base64url): keys, hashes, bearer tokens.
const TOKEN = /\b[A-Za-z0-9+/_-]{40,}={0,2}/g;

/** Clamp, strip control characters, and redact profile paths and long tokens. */
export function redact(s: string): string {
  return s.replace(CONTROL, ' ').replace(PROFILE, '%USERPROFILE%').replace(TOKEN, '[redacted]');
}

function str(v: unknown, max: number): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = redact(String(v)).trim();
  return s ? s.slice(0, max) : null;
}
function num(v: unknown, min: number, max: number): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}
function int(v: unknown, min: number, max: number): number | null {
  const n = num(v, min, max);
  return n === null ? null : Math.round(n);
}
function bool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : null;
}
function iso(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  return y < 1990 || y > 2100 ? null : d.toISOString();
}
function list(v: unknown, max: number): Record<string, unknown>[] {
  return (Array.isArray(v) ? v.slice(0, max) : []).filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x));
}
const IP_RE = /^[0-9a-fA-F:.%]{2,64}$/;
function ips(v: unknown, max: number): string[] {
  return (Array.isArray(v) ? v : []).filter((x): x is string => typeof x === 'string' && IP_RE.test(x)).slice(0, max);
}
const HOST_RE = /^[A-Za-z0-9.-]{1,253}$/;
const SVC_RE = /^[A-Za-z0-9_.$ -]{1,128}$/;
// A Windows account as a service or process reports it: LocalSystem,
// NT AUTHORITY\LocalService, .\backup, CORP\svc-sql, svc@corp.example.
const ACCOUNT_RE = /^[A-Za-z0-9 _.$@\\-]{1,128}$/;
// Six to eight hex pairs split by ':' or '-' (EUI-48, or EUI-64 on some virtual adapters).
const isMac = (m: string) => /^[0-9A-Fa-f:-]{17,23}$/.test(m) && /^(6|7|8)$/.test(String(m.split(/[:-]/).length)) && m.split(/[:-]/).every((p) => /^[0-9A-Fa-f]{2}$/.test(p));
const LOGS = ['System', 'Application'] as const;
export const REBOOT_SOURCES = ['component_servicing', 'windows_update', 'pending_file_rename', 'update_agent'] as const;
const STATES = ['Running', 'Stopped', 'Paused', 'StartPending', 'StopPending', 'ContinuePending', 'PausePending', 'Missing', 'Unknown'] as const;
const START = ['Automatic', 'AutomaticDelayedStart', 'Manual', 'Disabled', 'Boot', 'System', 'Unknown'] as const;
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], dflt: T): T =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : dflt;

/** A dual-mode socket names an IPv4 peer ::ffff:a.b.c.d; keep the IPv4 form. */
function unmapV4(v: string): string {
  const rest = v.slice(7);
  return v.slice(0, 7).toLowerCase() === '::ffff:' && /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(rest) ? rest : v;
}
const oneOfOrNull = <T extends string>(v: unknown, allowed: readonly T[]): T | null =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : null;
const matchOrNull = (v: unknown, re: RegExp): string | null => {
  const s = str(v, 256);
  return s && re.test(s) ? s : null;
};
// 0.76 palette: every enumerated field is one of a closed list, or null.
const DEFENDER_MODES = ['Normal', 'Passive Mode', 'SxS Passive Mode', 'EDR Block Mode', 'Not running'] as const;
const FIREWALL_PROFILES = ['Domain', 'Private', 'Public'] as const;
const FIREWALL_ACTIONS = ['Allow', 'Block', 'NotConfigured'] as const;
export const NETWORK_CATEGORIES = ['Public', 'Private', 'DomainAuthenticated'] as const;
const MOUNT_RE = /^([A-Za-z]:|\\\\\?\\Volume\{[0-9A-Fa-f-]{36}\}\\)$/;
const BL_VOLUME_TYPES = ['OperatingSystem', 'Data', 'FixedData', 'Removable'] as const;
const BL_PROTECTION = ['On', 'Off', 'Unknown'] as const;
const BL_VOLUME_STATUS = ['FullyDecrypted', 'FullyEncrypted', 'EncryptionInProgress', 'DecryptionInProgress', 'EncryptionSuspended', 'DecryptionSuspended', 'FullyEncryptedWipeInProgress', 'FullyEncryptedWipeSuspended'] as const;
const BL_METHODS = ['None', 'Aes128', 'Aes256', 'Aes128Diffuser', 'Aes256Diffuser', 'XtsAes128', 'XtsAes256', 'Hardware', 'Unknown'] as const;
/** Protector KINDS. A protector's id and its recovery password are never collected; only one of these names is kept. */
export const BL_PROTECTORS = ['Tpm', 'RecoveryPassword', 'ExternalKey', 'NumericPassword', 'TpmPin', 'TpmStartupKey', 'TpmPinStartupKey', 'PublicKey', 'Password', 'TpmNetworkKey', 'AdAccountOrGroup', 'Unknown'] as const;
const PRINCIPAL_SOURCES = ['Local', 'ActiveDirectory', 'AzureAD', 'MicrosoftAccount', 'Unknown'] as const;
export const TCP_OUTCOMES = ['open', 'refused', 'timeout', 'not_resolved', 'unreachable', 'error'] as const;
const CIDR_RE = /^[0-9a-fA-F:.%]{2,64}\/[0-9]{1,3}$/;
const W32TIME_TYPES = ['NT5DS', 'NTP', 'NoSync', 'AllSync'] as const;
export const SHUTDOWN_KINDS = ['kernel_power', 'unexpected_shutdown', 'bugcheck'] as const;
const SHUTDOWN_IDS: Record<(typeof SHUTDOWN_KINDS)[number], number> = { kernel_power: 41, unexpected_shutdown: 6008, bugcheck: 1001 };
const TASK_STATES = ['Ready', 'Running', 'Disabled', 'Queued', 'Unknown'] as const;

const procRow = (p: Record<string, unknown>) => {
  // Process names, not paths: anything after a separator is dropped.
  const raw = str(p.name, 128);
  const name = raw ? raw.split(/[\\/]/).pop()!.slice(0, 64) : null;
  return name ? { name, pid: int(p.pid, 0, 4_294_967_295), cpuSeconds: num(p.cpuSeconds, 0, 1e9), workingSetBytes: int(p.workingSetBytes, 0, Number.MAX_SAFE_INTEGER) } : null;
};

/**
 * Shape what the agent reported for `key` into what is stored.
 * Returns null when the key is unknown — the caller refuses the result.
 * refresh_inventory and pending_updates are handled by the caller (they feed
 * the inventory service) and arrive here as their stored summaries.
 */
export function sanitizeResult(key: string, raw: unknown): Record<string, unknown> | null {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  switch (key) {
    case 'disk_space':
      return {
        disks: list(r.disks, 32).map((d) => {
          const total = int(d.totalBytes, 0, Number.MAX_SAFE_INTEGER), free = int(d.freeBytes, 0, Number.MAX_SAFE_INTEGER);
          return {
            drive: str(d.drive, 8), label: str(d.label, 64), fsType: str(d.fsType, 16), totalBytes: total, freeBytes: free,
            // Computed here rather than trusted, so a badge cannot read 90 % free over a full disk.
            percentFree: total && free !== null && free <= total ? Math.round((free / total) * 1000) / 10 : null,
          };
        }).filter((d) => d.drive),
      };
    case 'service_health': {
      const svc = (s: Record<string, unknown>) => {
        const name = str(s.name, 128);
        if (!name || !SVC_RE.test(name)) return null;
        return { name, displayName: str(s.displayName, 128), status: oneOf(s.status, STATES, 'Unknown'), startType: oneOf(s.startType, START, 'Unknown') };
      };
      return {
        totalServices: int(r.totalServices, 0, 100_000),
        stoppedAutomatic: list(r.stoppedAutomatic, 100).map(svc).filter(Boolean),
        monitored: list(r.monitored, 32).map(svc).filter(Boolean),
      };
    }
    case 'recent_system_errors':
      return {
        windowHours: 24,
        scanned: int(r.scanned, 0, 1_000_000),
        capped: bool(r.capped) ?? false,
        groups: list(r.groups, 50).map((g) => ({
          log: oneOf(g.log, LOGS, 'System'),
          provider: str(g.provider, 128),
          eventId: int(g.eventId, 0, 4_294_967_295),
          level: int(g.level, 1, 2),
          count: int(g.count, 1, 1_000_000),
          firstAt: iso(g.firstAt),
          lastAt: iso(g.lastAt),
          message: str(g.message, MAX_MESSAGE_CHARS),
        })).filter((g) => g.eventId !== null && g.count !== null),
      };
    case 'top_processes':
      return {
        processCount: int(r.processCount, 0, 1_000_000),
        byCpu: list(r.byCpu, 10).map(procRow).filter(Boolean),
        byMemory: list(r.byMemory, 10).map(procRow).filter(Boolean),
      };
    case 'network_connectivity': {
      const t = (r.target && typeof r.target === 'object' ? r.target : {}) as Record<string, unknown>;
      const host = str(t.host, 253);
      return {
        target: {
          host: host && HOST_RE.test(host) ? host : null,
          port: int(t.port, 1, 65535),
          reachable: bool(t.reachable) ?? false,
          latencyMs: int(t.latencyMs, 0, 600_000),
          error: str(t.error, 200),
        },
        adapters: list(r.adapters, 16).map((a) => ({
          name: str(a.name, 128),
          connectionId: str(a.connectionId, 128),
          up: bool(a.up) ?? false,
          status: str(a.status, 32),
          mac: str(a.mac, 32),
          ipv4: ips(a.ipv4, 8),
          ipv6: ips(a.ipv6, 8),
          gateway: ips(a.gateway, 4),
        })).filter((a) => a.name),
      };
    }
    case 'dns_resolution':
      return {
        resolvers: ips(r.resolvers, 8),
        lookups: list(r.lookups, 2).map((l) => {
          const name = str(l.name, 253);
          return { name: name && HOST_RE.test(name) ? name : null, ok: bool(l.ok) ?? false, addresses: ips(l.addresses, 8), latencyMs: int(l.latencyMs, 0, 600_000), error: str(l.error, 200) };
        }).filter((l) => l.name),
      };
    case 'reboot_status': {
      const sources = (Array.isArray(r.sources) ? r.sources : []).filter((s): s is string => typeof s === 'string' && (REBOOT_SOURCES as readonly string[]).includes(s));
      const uniq = [...new Set(sources)].sort();
      return {
        // Derived from the signals, not trusted from a separate flag.
        pending: uniq.length > 0,
        // 0.76: whether a signal list came back at all (an empty one is "none pending").
        read: Array.isArray(r.sources),
        sources: uniq,
        lastBootAt: iso(r.lastBootAt),
        uptimeSeconds: int(r.uptimeSeconds, 0, 60 * 60 * 24 * 3650),
      };
    }
    case 'refresh_inventory':
      return {
        collected: bool(r.collected) ?? false,
        osCaption: str(r.osCaption, 128), osBuild: str(r.osBuild, 64),
        disks: int(r.disks, 0, 1000), networks: int(r.networks, 0, 1000), software: int(r.software, 0, 100_000),
      };
    case 'pending_updates':
      return {
        rebootRequired: bool(r.rebootRequired),
        count: int(r.count, 0, 1000),
        pending: list(r.pending, 100).map((u) => ({ title: str(u.title, 300), kb: str(u.kb, 32), severity: str(u.severity, 32), sizeBytes: int(u.sizeBytes, 0, Number.MAX_SAFE_INTEGER) })).filter((u) => u.title),
      };
    case 'process_list': {
      const rows = list(r.processes, SNAPSHOT_ROWS.process_list).map((p) => {
        const base = procRow(p);
        if (!base) return null;
        // A user name only if it looks like one (DOMAIN\\user, NT AUTHORITY\\SYSTEM, user@domain).
        const u = str(p.user, 128);
        return { ...base, user: u && ACCOUNT_RE.test(u) ? u : null, startedAt: iso(p.startedAt) };
      }).filter(Boolean);
      return {
        processCount: int(r.processCount, 0, 1_000_000),
        userNamesRead: bool(r.userNamesRead) ?? false,
        processes: rows,
      };
    }
    case 'service_list': {
      const rows = list(r.services, SNAPSHOT_ROWS.service_list).map((v) => {
        const name = str(v.name, 128);
        if (!name || !SVC_RE.test(name)) return null;
        const acct = str(v.account, 128);
        return {
          name, displayName: str(v.displayName, 256),
          state: oneOf(v.state, STATES, 'Unknown'), startMode: oneOf(v.startMode, START, 'Unknown'),
          account: acct && ACCOUNT_RE.test(acct) ? acct : null,
        };
      }).filter(Boolean);
      return { serviceCount: int(r.serviceCount, 0, 100_000), services: rows };
    }
    case 'network_adapters':
      return {
        adapters: list(r.adapters, SNAPSHOT_ROWS.network_adapters).map((a) => {
          const mac = str(a.mac, 32);
          const dhcpServer = str(a.dhcpServer, 64);
          const suffix = str(a.dnsSuffix, 253);
          return {
            name: str(a.name, 128),
            connectionId: str(a.connectionId, 128),
            status: str(a.status, 32),
            up: bool(a.up) ?? false,
            mac: mac && isMac(mac) ? mac.toUpperCase().replace(/-/g, ':') : null,
            speedBps: int(a.speedBps, 0, 1e13),
            ipv4: ips(a.ipv4, 16),
            ipv6: ips(a.ipv6, 16),
            gateway: ips(a.gateway, 8),
            dnsServers: ips(a.dnsServers, 8),
            dnsSuffix: suffix && HOST_RE.test(suffix) ? suffix : null,
            dhcpEnabled: bool(a.dhcpEnabled),
            dhcpServer: dhcpServer && IP_RE.test(dhcpServer) ? dhcpServer : null,
            dhcpLeaseObtainedAt: iso(a.dhcpLeaseObtainedAt),
            dhcpLeaseExpiresAt: iso(a.dhcpLeaseExpiresAt),
          };
        }).filter((a) => a.name),
      };
    // ── 0.76: the read-only palette ──
    case 'defender_status': {
      if (bool(r.supported) !== true) return { supported: false, reason: oneOf(r.reason, ['not_installed', 'not_running'] as const, 'not_installed'), error: str(r.error, 200) };
      return {
        supported: true,
        amServiceEnabled: bool(r.amServiceEnabled), antivirusEnabled: bool(r.antivirusEnabled),
        realTimeProtectionEnabled: bool(r.realTimeProtectionEnabled), behaviorMonitorEnabled: bool(r.behaviorMonitorEnabled),
        isTamperProtected: bool(r.isTamperProtected),
        runningMode: oneOfOrNull(r.runningMode, DEFENDER_MODES),
        signatureVersion: matchOrNull(r.signatureVersion, /^[0-9.]{1,32}$/),
        signatureLastUpdated: iso(r.signatureLastUpdated),
        signatureAgeDays: int(r.signatureAgeDays, 0, 65535),
        quickScanEndAt: iso(r.quickScanEndAt), fullScanEndAt: iso(r.fullScanEndAt),
        securityCenterRead: bool(r.securityCenterRead) ?? false,
        registeredAntivirus: list(r.registeredAntivirus, 8).map((a) => ({ name: str(a.name, 128), productState: int(a.productState, 0, 0xFFFFFF) })).filter((a) => a.name),
      };
    }
    case 'firewall_status':
      return {
        profiles: list(r.profiles, 3).map((p) => ({
          name: oneOfOrNull(p.name, FIREWALL_PROFILES),
          enabled: bool(p.enabled),
          defaultInbound: oneOfOrNull(p.defaultInbound, FIREWALL_ACTIONS),
          defaultOutbound: oneOfOrNull(p.defaultOutbound, FIREWALL_ACTIONS),
        })).filter((p) => p.name),
        activeCategories: [...new Set((Array.isArray(r.activeCategories) ? r.activeCategories : []).filter((c): c is string => typeof c === 'string' && (NETWORK_CATEGORIES as readonly string[]).includes(c)))],
        serviceState: oneOfOrNull(r.serviceState, STATES),
      };
    case 'bitlocker_status': {
      if (bool(r.supported) !== true) return { supported: false, reason: oneOf(r.reason, ['not_installed', 'not_available'] as const, 'not_installed'), error: str(r.error, 200) };
      return {
        supported: true,
        volumes: list(r.volumes, 26).map((v) => {
          const mp = str(v.mountPoint, 64);
          return {
            mountPoint: mp && MOUNT_RE.test(mp) ? mp : null,
            volumeType: oneOfOrNull(v.volumeType, BL_VOLUME_TYPES),
            protectionStatus: oneOfOrNull(v.protectionStatus, BL_PROTECTION),
            volumeStatus: oneOfOrNull(v.volumeStatus, BL_VOLUME_STATUS),
            lockStatus: oneOfOrNull(v.lockStatus, ['Locked', 'Unlocked'] as const),
            encryptionMethod: oneOfOrNull(v.encryptionMethod, BL_METHODS),
            encryptionPercentage: int(v.encryptionPercentage, 0, 100),
            // Kinds only, from a closed list: never a protector's id or secret.
            protectorTypes: [...new Set((Array.isArray(v.protectorTypes) ? v.protectorTypes : []).filter((t): t is string => typeof t === 'string' && (BL_PROTECTORS as readonly string[]).includes(t)))].sort(),
          };
        }).filter((v) => v.mountPoint),
      };
    }
    case 'secure_boot_tpm': {
      const t = (r.tpm && typeof r.tpm === 'object' && !Array.isArray(r.tpm) ? r.tpm : {}) as Record<string, unknown>;
      return {
        secureBoot: oneOf(r.secureBoot, ['on', 'off', 'unsupported', 'unknown'] as const, 'unknown'),
        secureBootError: str(r.secureBootError, 200),
        tpm: {
          read: bool(t.read) ?? false,
          present: bool(t.present), ready: bool(t.ready), enabled: bool(t.enabled), activated: bool(t.activated),
          manufacturer: matchOrNull(t.manufacturer, /^[A-Za-z0-9 ._-]{1,32}$/),
          specVersion: matchOrNull(t.specVersion, /^[0-9., ]{1,32}$/),
          error: str(t.error, 200),
        },
      };
    }
    case 'local_admins':
      return {
        method: oneOf(r.method, ['localaccounts', 'cim', 'none'] as const, 'none'),
        error: str(r.error, 200),
        members: list(r.members, 100).map((m) => {
          const name = str(m.name, 128);
          return {
            name: name && ACCOUNT_RE.test(name) ? name : null,
            kind: oneOf(m.kind, ['User', 'Group', 'Unknown'] as const, 'Unknown'),
            source: oneOfOrNull(m.source, PRINCIPAL_SOURCES),
            builtinAdministrator: bool(m.builtinAdministrator) ?? false,
          };
        }),
      };
    case 'dns_lookup': {
      const l = (r.lookup && typeof r.lookup === 'object' && !Array.isArray(r.lookup) ? r.lookup : {}) as Record<string, unknown>;
      return {
        resolvers: ips(r.resolvers, 8),
        lookup: {
          name: isHostName(l.name) ? l.name : null,
          ok: bool(l.ok) ?? false,
          addresses: ips(l.addresses, 16),
          latencyMs: int(l.latencyMs, 0, 600_000),
          timedOut: bool(l.timedOut) ?? false,
          error: str(l.error, 200),
        },
      };
    }
    case 'tcp_port':
      return {
        host: isHostName(r.host) ? r.host : null,
        port: int(r.port, 1, 65535),
        timeoutSeconds: int(r.timeoutSeconds, 1, 10),
        outcome: oneOf(r.outcome, TCP_OUTCOMES, 'error'),
        latencyMs: int(r.latencyMs, 0, 600_000),
        // A dual-mode socket reports an IPv4 peer as ::ffff:a.b.c.d; keep the IPv4 form.
        remoteAddress: typeof r.remoteAddress === 'string' && IP_RE.test(r.remoteAddress) ? unmapV4(r.remoteAddress) : null,
        socketError: int(r.socketError, 0, 100_000),
        error: str(r.error, 200),
      };
    case 'route_table':
      return {
        read: Array.isArray(r.routes),
        routeCount: int(r.routeCount, 0, 100_000),
        routes: list(r.routes, 200).map((x) => {
          const d = str(x.destination, 70), hop = str(x.nextHop, 64), alias = str(x.interfaceAlias, 128);
          return {
            destination: d && CIDR_RE.test(d) ? d : null,
            nextHop: hop && IP_RE.test(hop) ? hop : null,
            interfaceAlias: alias,
            routeMetric: int(x.routeMetric, 0, 10_000_000),
            addressFamily: oneOfOrNull(x.addressFamily, ['IPv4', 'IPv6'] as const),
          };
        }).filter((x) => x.destination),
      };
    case 'time_sync': {
      const q = (r.status && typeof r.status === 'object' && !Array.isArray(r.status) ? r.status : {}) as Record<string, unknown>;
      return {
        type: oneOfOrNull(r.type, W32TIME_TYPES),
        ntpServer: matchOrNull(r.ntpServer, /^[A-Za-z0-9.,: -]{1,256}$/),
        serviceState: oneOfOrNull(r.serviceState, STATES),
        serviceStart: oneOfOrNull(r.serviceStart, START),
        status: {
          ran: bool(q.ran) ?? false,
          exitCode: int(q.exitCode, -2_147_483_648, 4_294_967_295),
          leapIndicator: int(q.leapIndicator, 0, 3),
          stratum: int(q.stratum, 0, 16),
          lastSyncAt: iso(q.lastSyncAt),
          source: matchOrNull(q.source, /^[A-Za-z0-9 .,:()_-]{1,128}$/),
          pollSeconds: int(q.pollSeconds, 0, 10_000_000),
        },
      };
    }
    case 'windows_activation':
      return {
        products: list(r.products, 4).map((p) => ({
          name: str(p.name, 128),
          channel: matchOrNull(p.channel, /^[A-Za-z0-9_:. -]{1,32}$/),
          licenseStatus: int(p.licenseStatus, 0, 6),
          graceMinutes: int(p.graceMinutes, 0, 10_000_000),
        })).filter((p) => p.name),
      };
    case 'unexpected_shutdowns':
      return {
        windowDays: 30,
        // Whether the agent sent a list at all: an empty one is "none", a missing one is "not read".
        read: Array.isArray(r.events),
        events: list(r.events, 50).map((e) => ({
          at: iso(e.at),
          kind: oneOfOrNull(e.kind, SHUTDOWN_KINDS),
          eventId: int(e.eventId, 0, 65535),
          bugcheckCode: matchOrNull(e.bugcheckCode, /^0x[0-9A-F]{8}$/),
        })).filter((e) => e.kind && e.at && SHUTDOWN_IDS[e.kind] === e.eventId),
      };
    case 'scheduled_tasks':
      return {
        read: Array.isArray(r.tasks),
        taskCount: int(r.taskCount, 0, 100_000),
        microsoftTasks: int(r.microsoftTasks, 0, 100_000),
        tasks: list(r.tasks, 300).map((t) => {
          const runAs = str(t.runAs, 128);
          const last = iso(t.lastRunAt), next = iso(t.nextRunAt);
          return {
            path: str(t.path, 256),
            name: str(t.name, 256),
            state: oneOf(t.state, TASK_STATES, 'Unknown'),
            author: str(t.author, 128),
            runAs: runAs && ACCOUNT_RE.test(runAs) ? runAs : null,
            // Task Scheduler's "never" is 1999-11-30; anything before 2000 is no date.
            lastRunAt: last && last >= '2000' ? last : null,
            lastResult: int(t.lastResult, -2_147_483_648, 4_294_967_295),
            nextRunAt: next && next >= '2000' ? next : null,
          };
        }).filter((t) => t.name),
      };
    case 'signed_in_sessions':
      return {
        method: 'explorer',
        read: Array.isArray(r.sessions),
        userNamesRead: bool(r.userNamesRead) ?? false,
        sessions: list(r.sessions, 64).map((x) => {
          const u = str(x.user, 128);
          return { sessionId: int(x.sessionId, 0, 65535), user: u && ACCOUNT_RE.test(u) ? u : null, since: iso(x.since) };
        }).filter((x) => x.sessionId !== null),
      };
    default:
      return null;
  }
}

const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), 'utf8');

/**
 * Fit a sanitised result under MAX_RESULT_BYTES by halving its longest list
 * until it fits. `truncated` says lists were cut. A result that still does
 * not fit (it cannot, after sanitising, but the cap must not depend on that)
 * is replaced by a marker rather than stored.
 */
export function capResult(result: Record<string, unknown>, cap = MAX_RESULT_BYTES): { result: Record<string, unknown>; bytes: number; truncated: boolean } {
  const out = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
  let truncated = false;
  for (let i = 0; i < 64 && bytes(out) > cap; i++) {
    let longest: unknown[] | null = null;
    const visit = (o: unknown) => {
      if (Array.isArray(o)) { if (!longest || o.length > longest.length) longest = o; o.forEach(visit); }
      else if (o && typeof o === 'object') Object.values(o).forEach(visit);
    };
    visit(out);
    const l = longest as unknown[] | null;
    if (!l || l.length === 0) break;
    l.splice(Math.max(0, Math.floor(l.length / 2)));
    truncated = true;
  }
  if (bytes(out) > cap) return { result: { tooLarge: true }, bytes: bytes({ tooLarge: true }), truncated: true };
  return { result: out, bytes: bytes(out), truncated };
}

/** The catalog as served to the console (and, later, to ClientSt0r under P1). */
export function publicCatalog() {
  return CATALOG.map((e) => ({ ...e, supportedOs: [...e.supportedOs] }));
}
