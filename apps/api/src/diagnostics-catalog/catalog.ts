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
] as const;
export type DiagnosticKey = (typeof DIAGNOSTIC_KEYS)[number];

export type DurationCategory = 'seconds' | 'minute' | 'minutes';

export interface CatalogEntry {
  key: DiagnosticKey;
  label: string;
  description: string;
  /** The capability a requester needs — and the one needed to read the result. */
  capability: 'computers:view' | 'computers:event_logs';
  /** Why that capability, for the docs and the UI tooltip. */
  capabilityReason: string;
  supportedOs: readonly ['windows'];
  duration: DurationCategory;
  risk: 'read_only';
  expectedImpact: 'none';
  approvals: 'none (read-only)';
}

const W = ['windows'] as const;
const RO = { risk: 'read_only', expectedImpact: 'none', approvals: 'none (read-only)', supportedOs: W } as const;
const VIEW = 'computers:view' as const;

export const CATALOG: readonly CatalogEntry[] = [
  {
    key: 'refresh_inventory', label: 'Refresh inventory', ...RO, capability: VIEW, duration: 'minute',
    description: 'Re-collect hardware, operating system, disks, network adapters and installed software, and update the Specs tab.',
    capabilityReason: 'The same data, and the same capability, as the Specs tab and its Refresh button.',
  },
  {
    key: 'disk_space', label: 'Disk space', ...RO, capability: VIEW, duration: 'seconds',
    description: 'Size and free space of every fixed volume, with the percentage free.',
    capabilityReason: 'Already part of the inventory anyone who can see the computer can read.',
  },
  {
    key: 'service_health', label: 'Service health', ...RO, capability: VIEW, duration: 'seconds',
    description: 'Services set to start automatically that are not running, and the state of every service a monitor watches on this computer.',
    capabilityReason: 'Service names and states only — the same as the service monitors report. No paths or accounts.',
  },
  {
    key: 'recent_system_errors', label: 'Recent system errors', ...RO, capability: 'computers:event_logs', duration: 'seconds',
    description: 'Critical and Error events from the System and Application logs in the last 24 hours, grouped by source and event id with a count, first and last time, and a shortened message.',
    capabilityReason: 'It returns event-log message text, which is what computers:event_logs gates on the Event Log tab.',
  },
  {
    key: 'top_processes', label: 'Top processes', ...RO, capability: VIEW, duration: 'seconds',
    description: 'The ten processes using the most processor time and the ten using the most memory: name, process id, CPU seconds and working set. No command lines, paths or users.',
    capabilityReason: 'Process names are no more than the installed-software list already shows.',
  },
  {
    key: 'network_connectivity', label: 'Network connectivity', ...RO, capability: VIEW, duration: 'seconds',
    description: 'Whether this computer can open a TCP connection to the rem0te server it already reports to, and which network adapters are up or down with their addresses.',
    capabilityReason: 'Adapters and addresses are already in the inventory; the reach test is to this server only.',
  },
  {
    key: 'dns_resolution', label: 'DNS resolution', ...RO, capability: VIEW, duration: 'seconds',
    description: 'Resolve the rem0te server name and one fixed public name (dns.msftncsi.com), reporting the DNS servers in use, the answers and how long each took.',
    capabilityReason: 'Names are fixed by the agent, not chosen by the requester; nothing about the user is read.',
  },
  {
    key: 'pending_updates', label: 'Pending updates', ...RO, capability: VIEW, duration: 'minutes',
    description: 'Ask Windows Update which updates are available but not installed (the existing update scan), and update the Patches tab. Installs nothing.',
    capabilityReason: 'The same scan, and the same capability, as the inventory Refresh button.',
  },
  {
    key: 'reboot_status', label: 'Reboot status', ...RO, capability: VIEW, duration: 'seconds',
    description: 'Whether Windows is waiting for a restart, and which of the standard signals say so (component servicing, Windows Update, pending file renames, the update agent), with the last boot time.',
    capabilityReason: 'Flags and the boot time only; the rename list itself (which holds paths) is never read.',
  },
];

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
const LOGS = ['System', 'Application'] as const;
export const REBOOT_SOURCES = ['component_servicing', 'windows_update', 'pending_file_rename', 'update_agent'] as const;
const STATES = ['Running', 'Stopped', 'Paused', 'StartPending', 'StopPending', 'ContinuePending', 'PausePending', 'Missing', 'Unknown'] as const;
const START = ['Automatic', 'AutomaticDelayedStart', 'Manual', 'Disabled', 'Boot', 'System', 'Unknown'] as const;
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], dflt: T): T =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : dflt;

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
