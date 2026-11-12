/**
 * Monitoring (v0.29): the pure half. Everything here is a function of its
 * arguments — no database, no clock unless passed — so unit-monitoring.mjs
 * can test every decision the evaluator makes.
 *
 * Nothing a computer reports is trusted as-is. Service and event reports go
 * through the sanitisers below before they reach a column, exactly like the
 * inventory (EndpointInventoryService).
 */
import { z } from 'zod';

export const MONITOR_KINDS = ['OFFLINE', 'DISK_FREE', 'CPU_HIGH', 'MEMORY_HIGH', 'SERVICE_STOPPED', 'EVENT_MATCH', 'REBOOT_PENDING'] as const;
export type MonitorKind = (typeof MONITOR_KINDS)[number];
export const SEVERITIES = ['INFO', 'WARNING', 'CRITICAL'] as const;
export type Severity = (typeof SEVERITIES)[number];
export const SEVERITY_RANK: Record<Severity, number> = { INFO: 0, WARNING: 1, CRITICAL: 2 };

/** The logs an event monitor may watch — the same list a technician may read. */
export const MONITOR_EVENT_LOGS = ['Application', 'System', 'Security', 'Setup', 'Windows PowerShell'] as const;

/** Windows service names: what `Get-Service -Name` accepts, without wildcards. */
export const SERVICE_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

export const LIMITS = {
  /** Effective rules handed to one computer. */
  services: 32,
  events: 8,
  /** Rules at one scope. */
  rulesPerScope: 64,
  /** Software entries kept from one inventory pass. */
  software: 500,
  /** Change rows written by one inventory pass. */
  changesPerPass: 200,
  /** Characters of an event message kept as the alert's sample. */
  sampleChars: 300,
} as const;

// ── Rule parameters, one schema per kind ────────────────────────────────────

const ints = (min: number, max: number) => z.number().int().min(min).max(max);

export const PARAMS: Record<MonitorKind, z.ZodTypeAny> = {
  OFFLINE: z.object({ minutes: ints(5, 1440).default(15) }).strict(),
  DISK_FREE: z.object({ minFreePercent: ints(1, 90).default(10), minFreeMb: ints(100, 10_000_000).optional() }).strict(),
  CPU_HIGH: z.object({ percent: ints(50, 100).default(95), samples: ints(1, 20).default(5) }).strict(),
  MEMORY_HIGH: z.object({ percent: ints(50, 100).default(95), samples: ints(1, 20).default(5) }).strict(),
  SERVICE_STOPPED: z.object({
    service: z.string().regex(SERVICE_NAME, 'a Windows service name (letters, digits, _ . -)'),
    alertIfMissing: z.boolean().default(false),
    ignoreDisabled: z.boolean().default(true),
  }).strict(),
  EVENT_MATCH: z.object({
    log: z.enum(MONITOR_EVENT_LOGS),
    ids: z.array(ints(0, 65535)).max(16).default([]),
    levels: z.array(ints(0, 5)).max(6).default([]),
    provider: z.string().regex(/^[A-Za-z0-9 _.\-/]{1,128}$/).optional(),
    threshold: ints(1, 100).default(1),
    clearAfterMinutes: ints(15, 10080).default(60),
  }).strict().refine((p) => p.ids.length > 0 || p.levels.length > 0 || !!p.provider, { message: 'name at least one of ids, levels or provider — a monitor on every event in a log is a flood, not a monitor' }),
  REBOOT_PENDING: z.object({ hours: ints(1, 720).default(72) }).strict(),
};

export const RULE_KEY = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export const RuleInput = z.object({
  scope: z.enum(['global', 'business', 'site', 'endpoint']),
  businessId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).optional(),
  siteId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).optional(),
  endpointId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).optional(),
  key: z.string().regex(RULE_KEY, 'lowercase letters, digits, . _ - (64 max)'),
  kind: z.enum(MONITOR_KINDS),
  name: z.string().trim().min(1).max(120),
  enabled: z.boolean().default(true),
  severity: z.enum(SEVERITIES).default('WARNING'),
  params: z.record(z.string(), z.unknown()).default({}),
}).strict();
export const RulePatch = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  enabled: z.boolean().optional(),
  severity: z.enum(SEVERITIES).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
}).strict();

export function parseParams(kind: MonitorKind, raw: unknown): { ok: true; params: Record<string, unknown> } | { ok: false; error: string } {
  const r = PARAMS[kind].safeParse(raw ?? {});
  if (!r.success) return { ok: false, error: r.error.issues.map((i) => `${i.path.join('.') || 'params'}: ${i.message}`).join('; ') };
  return { ok: true, params: r.data as Record<string, unknown> };
}

/** Starter set offered on the Monitoring page — never created without a click. */
export const RECOMMENDED: { key: string; kind: MonitorKind; name: string; severity: Severity; params: Record<string, unknown> }[] = [
  { key: 'offline', kind: 'OFFLINE', name: 'Computer offline', severity: 'WARNING', params: { minutes: 15 } },
  { key: 'disk-free', kind: 'DISK_FREE', name: 'System disk nearly full', severity: 'WARNING', params: { minFreePercent: 10 } },
  { key: 'cpu-high', kind: 'CPU_HIGH', name: 'Processor pinned', severity: 'INFO', params: { percent: 95, samples: 5 } },
  { key: 'memory-high', kind: 'MEMORY_HIGH', name: 'Memory exhausted', severity: 'WARNING', params: { percent: 95, samples: 5 } },
  { key: 'reboot-pending', kind: 'REBOOT_PENDING', name: 'Restart pending for 3 days', severity: 'INFO', params: { hours: 72 } },
  { key: 'disk-errors', kind: 'EVENT_MATCH', name: 'Disk errors in the System log', severity: 'CRITICAL', params: { log: 'System', ids: [7, 11, 51, 153], levels: [], threshold: 1, clearAfterMinutes: 1440 } },
];

// ── Scope and inheritance ───────────────────────────────────────────────────

export type ScopeKey = string; // "global" | "b:<id>" | "s:<id>" | "e:<id>"
export const scopeKeyOf = (s: { scope: 'global' | 'business' | 'site' | 'endpoint'; id?: string | null }): ScopeKey =>
  s.scope === 'global' ? 'global' : `${s.scope === 'business' ? 'b' : s.scope === 'site' ? 's' : 'e'}:${s.id}`;

const SPECIFICITY: Record<string, number> = { global: 0, b: 1, s: 2, e: 3 };
const specificity = (k: ScopeKey) => SPECIFICITY[k === 'global' ? 'global' : k.slice(0, 1)] ?? -1;

/** The scope keys that apply to one computer, broadest first. */
export function scopesFor(ep: { id: string; customerId: string | null; siteId: string | null }): ScopeKey[] {
  return ['global', ...(ep.customerId ? [`b:${ep.customerId}`] : []), ...(ep.siteId ? [`s:${ep.siteId}`] : []), `e:${ep.id}`];
}

export interface RuleLike { id: string; scopeKey: string; key: string; kind: MonitorKind; enabled: boolean; severity: Severity; params: unknown; name: string }

/**
 * Inheritance: for each key, the rule at the most specific scope wins —
 * including a disabled one, which switches the inherited monitor off. A rule
 * whose kind differs from the inherited one with the same key still replaces
 * it; keys are names, not types. Returns enabled rules only, with where each
 * came from.
 */
export function effectiveRules<R extends RuleLike>(rules: R[], scopes: ScopeKey[]): (R & { inheritedFrom: ScopeKey; overrides: ScopeKey[] })[] {
  const allowed = new Set(scopes);
  const byKey = new Map<string, R[]>();
  for (const r of rules) {
    if (!allowed.has(r.scopeKey)) continue;
    const l = byKey.get(r.key) ?? [];
    l.push(r); byKey.set(r.key, l);
  }
  const out: (R & { inheritedFrom: ScopeKey; overrides: ScopeKey[] })[] = [];
  for (const [, l] of byKey) {
    l.sort((a, b) => specificity(b.scopeKey) - specificity(a.scopeKey));
    const win = l[0];
    if (!win.enabled) continue;
    out.push({ ...win, inheritedFrom: win.scopeKey, overrides: l.slice(1).map((r) => r.scopeKey) });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/** What the heartbeat hands the agent: the services to read and the event queries to run. */
export function agentMonitorConfig(rules: RuleLike[], since: Record<string, string | null | undefined>) {
  const services = new Set<string>();
  const events: { key: string; log: string; ids: number[]; levels: number[]; provider: string | null; since: string | null }[] = [];
  for (const r of rules) {
    const p = parseParams(r.kind, r.params);
    if (!p.ok) continue;
    if (r.kind === 'SERVICE_STOPPED' && services.size < LIMITS.services) services.add(String(p.params.service));
    if (r.kind === 'EVENT_MATCH' && events.length < LIMITS.events) {
      events.push({
        key: r.key, log: String(p.params.log), ids: p.params.ids as number[], levels: p.params.levels as number[],
        provider: (p.params.provider as string | undefined) ?? null, since: since[r.key] ?? null,
      });
    }
  }
  if (services.size === 0 && events.length === 0) return null;
  return { v: 1, services: [...services].sort(), events };
}

// ── Sanitising what the computer reports ────────────────────────────────────

// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/g;
const cleanStr = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.replace(CONTROL, ' ').trim();
  return s ? s.slice(0, max) : null;
};
const isoOrNull = (v: unknown): string | null => {
  if (typeof v !== 'string' || v.length > 40) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime()) || d.getUTCFullYear() < 1990 || d.getUTCFullYear() > 2100) return null;
  return d.toISOString();
};
const SERVICE_STATUS = ['Running', 'Stopped', 'StartPending', 'StopPending', 'Paused', 'PausePending', 'ContinuePending', 'Missing'] as const;
const START_TYPES = ['Automatic', 'AutomaticDelayedStart', 'Manual', 'Disabled', 'Boot', 'System', 'Unknown'] as const;

export interface ServiceReport { name: string; status: (typeof SERVICE_STATUS)[number]; startType: string | null }
export interface EventReport { key: string; checkedAt: string; count: number; newestAt: string | null; sample: { eventId: number | null; level: number | null; provider: string | null; message: string | null } | null }

/**
 * A monitor report. Only services and event keys the server asked for are
 * kept: a compromised computer cannot invent monitors, or fill the database
 * with reports for keys nobody configured.
 */
export function sanitizeReport(raw: unknown, asked: { services: string[]; eventKeys: string[] }): { services: ServiceReport[]; events: EventReport[] } {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const wantSvc = new Map(asked.services.map((s) => [s.toLowerCase(), s]));
  const wantEv = new Set(asked.eventKeys);
  const services: ServiceReport[] = [];
  const seen = new Set<string>();
  for (const s of Array.isArray(o.services) ? o.services.slice(0, LIMITS.services * 2) : []) {
    const e = (s ?? {}) as Record<string, unknown>;
    const name = cleanStr(e.name, 64);
    const canon = name ? wantSvc.get(name.toLowerCase()) : undefined;
    if (!canon || seen.has(canon)) continue;
    seen.add(canon);
    const status = (SERVICE_STATUS as readonly string[]).includes(String(e.status)) ? (e.status as ServiceReport['status']) : 'Missing';
    const startType = (START_TYPES as readonly string[]).includes(String(e.startType)) ? String(e.startType) : null;
    services.push({ name: canon, status, startType });
  }
  const events: EventReport[] = [];
  const seenEv = new Set<string>();
  for (const s of Array.isArray(o.events) ? o.events.slice(0, LIMITS.events * 2) : []) {
    const e = (s ?? {}) as Record<string, unknown>;
    const key = typeof e.key === 'string' ? e.key : '';
    if (!wantEv.has(key) || seenEv.has(key)) continue;
    const checkedAt = isoOrNull(e.checkedAt);
    if (!checkedAt) continue;
    seenEv.add(key);
    const count = typeof e.count === 'number' && Number.isFinite(e.count) ? Math.max(0, Math.min(100_000, Math.round(e.count))) : 0;
    const sm = (e.sample && typeof e.sample === 'object' ? e.sample : null) as Record<string, unknown> | null;
    const int = (v: unknown, max: number) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max ? v : null);
    events.push({
      key, checkedAt, count, newestAt: isoOrNull(e.newestAt),
      sample: count > 0 && sm ? { eventId: int(sm.eventId, 4_294_967_295), level: int(sm.level, 5), provider: cleanStr(sm.provider, 128), message: cleanStr(sm.message, LIMITS.sampleChars) } : null,
    });
  }
  return { services, events };
}

// ── Evaluation ──────────────────────────────────────────────────────────────

export interface MonitorStateLike { breachCount: number; okCount: number; breachSince: Date | null; lastMatchAt: Date | null }
export const EMPTY_STATE: MonitorStateLike = { breachCount: 0, okCount: 0, breachSince: null, lastMatchAt: null };

/** What a rule concluded from one observation. `skip` = no fresh evidence, change nothing. */
export type Verdict =
  | { verdict: 'skip'; reason: string }
  | { verdict: 'breach'; title: string; detail: Record<string, unknown>; state: MonitorStateLike }
  | { verdict: 'pending'; state: MonitorStateLike } // breaching, but not for long enough yet
  | { verdict: 'ok'; state: MonitorStateLike; clear: boolean };

/** Live samples older than this are not evidence of anything current (the OFFLINE monitor covers silence). */
export const LIVE_FRESH_MS = 15 * 60_000;
/** Consecutive good samples before a resource alert clears, so a value hovering at the line does not flap. */
export const CLEAR_AFTER_OK = 2;

export interface Live {
  name: string; isOnline: boolean; lastSeenAt: Date | null;
  cpuLoadPercent: number | null; memoryTotalMb: number | null; memoryFreeMb: number | null;
  systemDiskTotalMb: number | null; systemDiskFreeMb: number | null; liveSampledAt: Date | null;
  rebootRequired: boolean | null; updatesCheckedAt: Date | null;
}

function counted(st: MonitorStateLike, breaching: boolean, now: Date, need: number, title: string, detail: Record<string, unknown>): Verdict {
  if (breaching) {
    const s = { ...st, breachCount: st.breachCount + 1, okCount: 0, breachSince: st.breachSince ?? now };
    return s.breachCount >= need ? { verdict: 'breach', title, detail: { ...detail, samples: s.breachCount }, state: s } : { verdict: 'pending', state: s };
  }
  const s = { ...st, breachCount: 0, okCount: st.okCount + 1, breachSince: null };
  return { verdict: 'ok', state: s, clear: s.okCount >= CLEAR_AFTER_OK };
}

/**
 * Resource and offline rules, from the computer's live state. Called on each
 * heartbeat (resource) and by the sweep (offline, reboot). `sampleIsNew`
 * says whether this call is a new live sample — counting the same sample
 * twice would make "5 samples" mean "one sample, seen five times".
 */
export function evaluateLive(rule: RuleLike, live: Live, st: MonitorStateLike, now: Date, sampleIsNew: boolean): Verdict {
  const p = parseParams(rule.kind, rule.params);
  if (!p.ok) return { verdict: 'skip', reason: `invalid params: ${p.error}` };
  const P = p.params as Record<string, number & boolean & string>;
  const fresh = !!live.liveSampledAt && now.getTime() - live.liveSampledAt.getTime() < LIVE_FRESH_MS;
  switch (rule.kind) {
    case 'OFFLINE': {
      const seen = live.lastSeenAt?.getTime() ?? 0;
      const silentMin = (now.getTime() - seen) / 60_000;
      const breaching = !live.isOnline && silentMin >= P.minutes;
      if (breaching) {
        return { verdict: 'breach', title: `${live.name} is offline`, detail: { lastSeenAt: live.lastSeenAt?.toISOString() ?? null, minutes: Math.floor(silentMin) }, state: { ...st, breachCount: 1, okCount: 0, breachSince: st.breachSince ?? now } };
      }
      // Back online clears at once: the heartbeat that says so is the evidence.
      return { verdict: 'ok', state: { ...st, breachCount: 0, okCount: st.okCount + 1, breachSince: null }, clear: live.isOnline };
    }
    case 'DISK_FREE': {
      if (!fresh || !sampleIsNew) return { verdict: 'skip', reason: 'no new live sample' };
      if (!live.systemDiskTotalMb || live.systemDiskFreeMb === null) return { verdict: 'skip', reason: 'disk not reported' };
      const pct = (100 * live.systemDiskFreeMb) / live.systemDiskTotalMb;
      const breaching = pct < P.minFreePercent || (typeof P.minFreeMb === 'number' && live.systemDiskFreeMb < P.minFreeMb);
      return counted(st, breaching, now, 1, `${live.name}: system disk ${pct.toFixed(1)}% free`, { freeMb: live.systemDiskFreeMb, totalMb: live.systemDiskTotalMb, freePercent: Math.round(pct * 10) / 10, minFreePercent: P.minFreePercent, minFreeMb: P.minFreeMb ?? null });
    }
    case 'CPU_HIGH': {
      if (!fresh || !sampleIsNew) return { verdict: 'skip', reason: 'no new live sample' };
      if (live.cpuLoadPercent === null) return { verdict: 'skip', reason: 'processor load not reported' };
      return counted(st, live.cpuLoadPercent >= P.percent, now, P.samples, `${live.name}: processor at ${live.cpuLoadPercent}%`, { percent: live.cpuLoadPercent, threshold: P.percent });
    }
    case 'MEMORY_HIGH': {
      if (!fresh || !sampleIsNew) return { verdict: 'skip', reason: 'no new live sample' };
      if (!live.memoryTotalMb || live.memoryFreeMb === null) return { verdict: 'skip', reason: 'memory not reported' };
      const used = Math.round((100 * (live.memoryTotalMb - live.memoryFreeMb)) / live.memoryTotalMb);
      return counted(st, used >= P.percent, now, P.samples, `${live.name}: memory ${used}% used`, { usedPercent: used, threshold: P.percent, freeMb: live.memoryFreeMb });
    }
    case 'REBOOT_PENDING': {
      if (live.rebootRequired === null || !live.updatesCheckedAt) return { verdict: 'skip', reason: 'restart state not reported' };
      if (!live.rebootRequired) return { verdict: 'ok', state: { ...st, breachCount: 0, okCount: st.okCount + 1, breachSince: null }, clear: true };
      // "Since" is when rem0te first saw it pending, not when Windows started
      // wanting it; the alert says so.
      const since = st.breachSince ?? now;
      const s = { ...st, breachCount: 1, okCount: 0, breachSince: since };
      return now.getTime() - since.getTime() >= P.hours * 3_600_000
        ? { verdict: 'breach', title: `${live.name} has needed a restart for ${Math.floor((now.getTime() - since.getTime()) / 3_600_000)} h`, detail: { pendingSince: since.toISOString(), hours: P.hours, note: 'since rem0te first saw the restart pending' }, state: s }
        : { verdict: 'pending', state: s };
    }
    default:
      return { verdict: 'skip', reason: 'not a live rule' };
  }
}

/** A service rule, from a monitor report. */
export function evaluateService(rule: RuleLike, svc: ServiceReport | undefined, name: string, st: MonitorStateLike, now: Date): Verdict {
  const p = parseParams(rule.kind, rule.params);
  if (!p.ok) return { verdict: 'skip', reason: `invalid params: ${p.error}` };
  if (!svc) return { verdict: 'skip', reason: 'service not in the report' };
  const P = p.params as { service: string; alertIfMissing: boolean; ignoreDisabled: boolean };
  if (svc.status === 'Missing') {
    return P.alertIfMissing
      ? { verdict: 'breach', title: `${name}: service ${P.service} is not installed`, detail: { service: P.service, status: 'Missing' }, state: { ...st, breachCount: st.breachCount + 1, okCount: 0, breachSince: st.breachSince ?? now } }
      : { verdict: 'ok', state: { ...st, breachCount: 0, okCount: st.okCount + 1, breachSince: null }, clear: true };
  }
  if (P.ignoreDisabled && svc.startType === 'Disabled') return { verdict: 'ok', state: { ...st, breachCount: 0, okCount: st.okCount + 1, breachSince: null }, clear: true };
  const running = svc.status === 'Running';
  if (running) return { verdict: 'ok', state: { ...st, breachCount: 0, okCount: st.okCount + 1, breachSince: null }, clear: true };
  // A service mid-transition gets one more report before it counts.
  const need = /Pending$/.test(svc.status) ? 2 : 1;
  return counted(st, true, now, need, `${name}: service ${P.service} is ${svc.status.toLowerCase()}`, { service: P.service, status: svc.status, startType: svc.startType });
}

/**
 * An event rule, from a monitor report. Matches raise (or repeat) the alert;
 * the alert clears after `clearAfterMinutes` with no further matches — the
 * sweep calls this with `ev` undefined to check that.
 */
export function evaluateEvents(rule: RuleLike, ev: EventReport | undefined, name: string, st: MonitorStateLike, now: Date): Verdict {
  const p = parseParams(rule.kind, rule.params);
  if (!p.ok) return { verdict: 'skip', reason: `invalid params: ${p.error}` };
  const P = p.params as { log: string; ids: number[]; threshold: number; clearAfterMinutes: number };
  if (ev && ev.count >= P.threshold) {
    return {
      verdict: 'breach', title: `${name}: ${ev.count} matching event${ev.count === 1 ? '' : 's'} in ${P.log}`,
      detail: { log: P.log, count: ev.count, newestAt: ev.newestAt, sample: ev.sample, threshold: P.threshold },
      state: { ...st, breachCount: st.breachCount + 1, okCount: 0, breachSince: st.breachSince ?? now, lastMatchAt: now },
    };
  }
  const quietFor = st.lastMatchAt ? now.getTime() - st.lastMatchAt.getTime() : Infinity;
  return { verdict: 'ok', state: { ...st, okCount: st.okCount + (ev ? 1 : 0) }, clear: quietFor >= P.clearAfterMinutes * 60_000 };
}

export const dedupKeyOf = (ruleKey: string, endpointId: string) => `${ruleKey}:${endpointId}`;
export const outageKeyOf = (siteId: string) => `site-outage:${siteId}`;

// ── Site outage correlation ─────────────────────────────────────────────────

export const OUTAGE = {
  /** A site needs this many active computers before its outages are correlated. */
  minComputers: 3,
  /** Raise when at least this many are offline… */
  minOffline: 3,
  /** …and they are at least this share of the site. */
  raiseShare: 0.5,
  /** Resolve when fewer than this share remain offline, or fewer than two. */
  clearShare: 0.25,
  /** Offline alerts wait this long before anyone is told, so a site going dark is one alert, not twenty. */
  holdMs: 3 * 60_000,
} as const;

export function outageDecision(site: { active: number; offline: number; open: boolean }): 'raise' | 'clear' | 'hold' | 'none' {
  if (site.active < OUTAGE.minComputers) return site.open ? 'clear' : 'none';
  const share = site.offline / site.active;
  if (!site.open) return site.offline >= OUTAGE.minOffline && share >= OUTAGE.raiseShare ? 'raise' : 'none';
  return site.offline < 2 || share < OUTAGE.clearShare ? 'clear' : 'hold';
}

// ── Suppression ─────────────────────────────────────────────────────────────

export interface SuppressionLike { id: string; scopeKey: string; ruleKeys: string[]; startsAt: Date; endsAt: Date; revokedAt: Date | null }
export interface AlertScope { customerId: string | null; siteId: string | null; endpointId: string | null; ruleKey: string }

export function suppressionFor<S extends SuppressionLike>(alert: AlertScope, sups: S[], now: Date): S | null {
  const scopes = new Set(['global', ...(alert.customerId ? [`b:${alert.customerId}`] : []), ...(alert.siteId ? [`s:${alert.siteId}`] : []), ...(alert.endpointId ? [`e:${alert.endpointId}`] : [])]);
  for (const s of sups) {
    if (s.revokedAt || s.startsAt > now || s.endsAt <= now) continue;
    if (!scopes.has(s.scopeKey)) continue;
    if (s.ruleKeys.length && !s.ruleKeys.includes(alert.ruleKey)) continue;
    return s;
  }
  return null;
}

// ── Notification and escalation ─────────────────────────────────────────────

/**
 * Where a level sends: a webhook (`url`) or, from 0.34, a confirmed email
 * recipient of the policy's own scope (`recipientId` — checked against
 * EmailRecipient when the policy is saved and again when mail is sent).
 */
export const Destination = z.union([
  z.object({ label: z.string().trim().min(1).max(60), url: z.string().url().max(500) }).strict(),
  z.object({ label: z.string().trim().min(1).max(60), recipientId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/) }).strict(),
]);
export type Destination = z.infer<typeof Destination>;
export const isEmailDestination = (d: Destination): d is { label: string; recipientId: string } => 'recipientId' in d;
export const NotifyLevel = z.object({
  afterMinutes: ints(0, 10080),
  minSeverity: z.enum(SEVERITIES).default('WARNING'),
  destinations: z.array(Destination).min(1).max(5),
}).strict();
export const NotifyPolicyInput = z.object({
  scope: z.enum(['global', 'business']),
  businessId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).optional(),
  levels: z.array(NotifyLevel).max(4).default([]),
  ticketing: z.object({ enabled: z.boolean().default(false), minSeverity: z.enum(SEVERITIES).default('CRITICAL') }).strict().default({ enabled: false, minSeverity: 'CRITICAL' }),
}).strict().refine((p) => p.levels.every((l, i) => i === 0 || l.afterMinutes > p.levels[i - 1].afterMinutes), { message: 'levels must be in increasing afterMinutes order' });
export type NotifyLevel = z.infer<typeof NotifyLevel>;

/**
 * Which escalation levels are due now. `done` is how many levels have fired.
 * Levels fire in order; one whose severity floor the alert does not meet is
 * passed over (counted as done) so a later level is not blocked behind it.
 */
export function dueLevels(levels: NotifyLevel[], alert: { severity: Severity; notifyFrom: Date; escalationLevel: number }, now: Date): { index: number; level: NotifyLevel; skip: boolean }[] {
  const out: { index: number; level: NotifyLevel; skip: boolean }[] = [];
  const age = (now.getTime() - alert.notifyFrom.getTime()) / 60_000;
  for (let i = alert.escalationLevel; i < levels.length; i++) {
    const l = levels[i];
    if (age < l.afterMinutes) break;
    out.push({ index: i, level: l, skip: SEVERITY_RANK[alert.severity] < SEVERITY_RANK[l.minSeverity] });
  }
  return out;
}

// ── Inventory change history ────────────────────────────────────────────────

export interface Change { category: 'hardware' | 'os' | 'disk' | 'network' | 'software'; change: 'added' | 'removed' | 'changed'; subject: string; before: string | null; after: string | null }

const HW_FIELDS: [keyof InvSnapshot, Change['category'], string][] = [
  ['manufacturer', 'hardware', 'Manufacturer'], ['model', 'hardware', 'Model'], ['serialNumber', 'hardware', 'Serial number'],
  ['biosVersion', 'hardware', 'BIOS version'], ['cpuModel', 'hardware', 'Processor'], ['cpuCores', 'hardware', 'Processor cores'],
  ['memoryTotalGb', 'hardware', 'Installed memory (GB)'],
  ['osCaption', 'os', 'Operating system'], ['osBuild', 'os', 'OS build'], ['domain', 'os', 'Domain'],
];

export interface InvSnapshot {
  manufacturer?: string | null; model?: string | null; serialNumber?: string | null; biosVersion?: string | null;
  cpuModel?: string | null; cpuCores?: number | null; memoryTotalGb?: number | null;
  osCaption?: string | null; osBuild?: string | null; domain?: string | null;
  disks?: { drive: string; totalBytes: number | null }[] | null;
  networks?: { name: string; mac: string | null }[] | null;
  software?: { name: string; version: string | null; publisher: string | null }[] | null;
}

const s = (v: unknown) => (v === null || v === undefined || v === '' ? null : String(v));
const gb = (b: number | null | undefined) => (typeof b === 'number' ? `${Math.round(b / 1e9)} GB` : null);

/**
 * What changed between two inventory passes. Fields the new pass did not
 * report are not "removed" — an agent that failed one query must not write a
 * history full of disappearances — so a list is compared only when the new
 * pass carried it.
 */
export function diffInventory(before: InvSnapshot | null, after: InvSnapshot): Change[] {
  if (!before) return [];
  const out: Change[] = [];
  for (const [f, cat, label] of HW_FIELDS) {
    const a = s(after[f]), b = s(before[f]);
    if (a === null) continue;
    if (a !== b) out.push({ category: cat, change: b === null ? 'added' : 'changed', subject: label, before: b, after: a });
  }
  if (after.disks && before.disks) {
    const B = new Map(before.disks.map((d) => [d.drive, d])), A = new Map(after.disks.map((d) => [d.drive, d]));
    for (const [k, d] of A) {
      const o = B.get(k);
      if (!o) out.push({ category: 'disk', change: 'added', subject: `Disk ${k}`, before: null, after: gb(d.totalBytes) });
      // Capacity, not free space: free space moves all day and is a monitor, not history.
      else if (gb(o.totalBytes) !== gb(d.totalBytes)) out.push({ category: 'disk', change: 'changed', subject: `Disk ${k} capacity`, before: gb(o.totalBytes), after: gb(d.totalBytes) });
    }
    for (const [k, d] of B) if (!A.has(k)) out.push({ category: 'disk', change: 'removed', subject: `Disk ${k}`, before: gb(d.totalBytes), after: null });
  }
  if (after.networks && before.networks) {
    const id = (n: { name: string; mac: string | null }) => (n.mac || n.name).toLowerCase();
    const B = new Map(before.networks.map((n) => [id(n), n])), A = new Map(after.networks.map((n) => [id(n), n]));
    for (const [k, n] of A) if (!B.has(k)) out.push({ category: 'network', change: 'added', subject: n.name, before: null, after: n.mac });
    for (const [k, n] of B) if (!A.has(k)) out.push({ category: 'network', change: 'removed', subject: n.name, before: n.mac, after: null });
  }
  if (after.software && before.software) {
    const id = (x: { name: string; publisher: string | null }) => `${x.name}\u0000${x.publisher ?? ''}`.toLowerCase();
    const B = new Map(before.software.map((x) => [id(x), x])), A = new Map(after.software.map((x) => [id(x), x]));
    for (const [k, x] of A) {
      const o = B.get(k);
      if (!o) out.push({ category: 'software', change: 'added', subject: x.name, before: null, after: x.version });
      else if ((o.version ?? '') !== (x.version ?? '')) out.push({ category: 'software', change: 'changed', subject: x.name, before: o.version, after: x.version });
    }
    for (const [k, x] of B) if (!A.has(k)) out.push({ category: 'software', change: 'removed', subject: x.name, before: x.version, after: null });
  }
  return out.slice(0, LIMITS.changesPerPass);
}

/** The software list from the inventory pass, clamped. Duplicates (same name and publisher) keep the first. */
export function sanitizeSoftware(v: unknown): { name: string; version: string | null; publisher: string | null; installedOn: string | null }[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: { name: string; version: string | null; publisher: string | null; installedOn: string | null }[] = [];
  const seen = new Set<string>();
  for (const x of v.slice(0, LIMITS.software * 2)) {
    const o = (x ?? {}) as Record<string, unknown>;
    const name = cleanStr(o.name, 200);
    if (!name) continue;
    const publisher = cleanStr(o.publisher, 128);
    const k = `${name}\u0000${publisher ?? ''}`.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    // Windows stores InstallDate as yyyyMMdd; keep it only in that shape.
    const inst = typeof o.installedOn === 'string' && /^\d{8}$/.test(o.installedOn) ? `${o.installedOn.slice(0, 4)}-${o.installedOn.slice(4, 6)}-${o.installedOn.slice(6, 8)}` : null;
    out.push({ name, version: cleanStr(o.version, 64), publisher, installedOn: inst });
    if (out.length >= LIMITS.software) break;
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
