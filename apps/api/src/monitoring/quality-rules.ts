/**
 * Alert quality rules (0.67): the pure half of "False Positives & Rule
 * Improvements". No database, no clock (every function is handed `now`), no
 * network, nothing from Nest — unit-alert-quality-rules.mjs tests it all.
 *
 * A rule changes what ONE monitor raises for ONE narrowly matched event
 * signature in ONE scope:
 *
 *   suppress         nothing is raised or notified; the event is still recorded
 *   downgrade        the alert's severity is capped at WARNING or INFO
 *   require_count    raised only with at least N matching events in one report
 *   require_repeats  raised only once the event has been reported N times
 *
 * The rules a person can make are deliberately narrow:
 *
 *   - every rule names its monitor (`ruleKey`);
 *   - an event-monitor rule names the event fingerprint, or the provider AND
 *     event id — never words from a message (there is no substring field);
 *   - a threshold monitor (disk space, CPU, offline…) can only be suppressed
 *     or downgraded, and not across the platform;
 *   - anything broader is refused (`RULE_TOO_BROAD`) unless a Platform Admin
 *     says so explicitly (`allowBroad`), which makes the rule high risk.
 *
 * A rule is HIGH RISK — two different approvers — when it could hide a
 * critical hardware, security or backup failure, or reaches past one
 * business: see riskOf. Nothing here disables a monitor: disabling one is
 * Monitoring → Monitoring policies, as before.
 *
 * Precedence is deterministic: computer > group > business > monitor > OS >
 * platform; then the rule naming more conditions; then, between two rules
 * that still tie, the one that keeps MORE of the alert (a downgrade to
 * WARNING beats a suppression); then the id. The second rule is a conflict,
 * and the quality checks say so.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { RULE_KEY } from './engine';
import {
  classifyEvents, COMPONENTS, FINGERPRINT_RE, KNOWN_EVENTS, samplesOf, STORAGE_CONTROLLER_PROVIDERS,
  type Classification, type EventSample, type SampleAdjust, type SampleDecision,
} from './classify';

export const QUALITY_RULES_VERSION = 1;

type Sev = 'INFO' | 'WARNING' | 'CRITICAL';
const RANK: Record<Sev, number> = { INFO: 0, WARNING: 1, CRITICAL: 2 };

// ── Reports ─────────────────────────────────────────────────────────────────

/** "Reason for reporting". The same list is 0086's CHECK. */
export const FP_REASONS = [
  'known_harmless', 'incorrect_severity', 'duplicate', 'expected_activity', 'incorrect_threshold', 'rule_too_broad', 'incorrect_correlation', 'other',
] as const;
export type FpReason = (typeof FP_REASONS)[number];
export const FP_REASON_LABEL: Record<FpReason, string> = {
  known_harmless: 'Known harmless Windows/system event',
  incorrect_severity: 'Incorrect severity',
  duplicate: 'Duplicate alert',
  expected_activity: 'Expected or authorized activity',
  incorrect_threshold: 'Incorrect threshold',
  rule_too_broad: 'Monitoring rule is too broad',
  incorrect_correlation: 'Incorrect device or event correlation',
  other: 'Other',
};

export const FalsePositiveInput = z.object({
  reason: z.enum(FP_REASONS),
  comment: z.string().trim().max(1000).optional(),
  recommendPrevent: z.boolean().default(false),
  /** Also resolve this alert, as Resolve does. Never the monitor. */
  resolve: z.boolean().default(false),
}).strict().refine((v) => v.reason !== 'other' || (v.comment ?? '').length >= 3, { message: '"Other" needs an explanation', path: ['comment'] });

// ── Rules ───────────────────────────────────────────────────────────────────

export const SCOPE_KINDS = ['endpoint', 'group', 'business', 'monitor', 'os', 'platform'] as const;
export type ScopeKind = (typeof SCOPE_KINDS)[number];
/** Higher wins. */
export const PRECEDENCE: Record<ScopeKind, number> = { endpoint: 6, group: 5, business: 4, monitor: 3, os: 2, platform: 1 };
export const OS_FAMILIES = ['windows', 'windows-client', 'windows-server', 'linux', 'macos'] as const;
export type OsFamily = (typeof OS_FAMILIES)[number];
export const BEHAVIOURS = ['suppress', 'downgrade', 'require_count', 'require_repeats'] as const;
export type BehaviourKind = (typeof BEHAVIOURS)[number];
export const RULE_STATUSES = ['pending', 'active', 'rejected', 'rolled_back', 'expired', 'superseded'] as const;
export type RuleStatus = (typeof RULE_STATUSES)[number];

/** A temporary rule lasts at most this long; a permanent exception is reviewed at least this often. */
export const MAX_TEMPORARY_DAYS = 90;
export const MAX_REVIEW_DAYS = 365;
/** An approval needs a simulation at most this old, of the rule's current text. */
export const SIMULATION_FRESH_MS = 7 * 86_400_000;
/** The history a simulation reads. */
export const SIMULATION_DAYS = 90;

const PROVIDER_RE = /^[A-Za-z0-9 _./-]{1,128}$/;
const STATUS_RE = /^0x[0-9A-F]{8}$/;

export const RuleMatch = z.object({
  ruleKey: z.string().regex(RULE_KEY),
  fingerprint: z.string().regex(FINGERPRINT_RE).optional(),
  provider: z.string().trim().regex(PROVIDER_RE).optional(),
  eventId: z.number().int().min(0).max(65535).optional(),
  levels: z.array(z.number().int().min(0).max(5)).min(1).max(6).optional(),
  statusCode: z.string().regex(STATUS_RE).optional(),
  component: z.enum(COMPONENTS).optional(),
}).strict();
export type RuleMatch = z.infer<typeof RuleMatch>;

export const RuleBehaviour = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('suppress') }).strict(),
  z.object({ kind: z.literal('downgrade'), severity: z.enum(['WARNING', 'INFO']) }).strict(),
  z.object({ kind: z.literal('require_count'), minCount: z.number().int().min(2).max(100) }).strict(),
  z.object({ kind: z.literal('require_repeats'), reports: z.number().int().min(2).max(100) }).strict(),
]);
export type RuleBehaviour = z.infer<typeof RuleBehaviour>;

const ID = /^[A-Za-z0-9_-]{8,64}$/;
export const RuleScopeInput = z.object({
  kind: z.enum(SCOPE_KINDS),
  businessId: z.string().regex(ID).optional(),
  endpointId: z.string().regex(ID).optional(),
  groupId: z.string().regex(ID).optional(),
  monitorRuleId: z.string().regex(ID).optional(),
  osFamily: z.enum(OS_FAMILIES).optional(),
}).strict();
export type RuleScopeInput = z.infer<typeof RuleScopeInput>;

const text = (min: number, max: number) => z.string().trim().min(min).max(max);
export const RuleDraftInput = z.object({
  name: text(3, 120),
  description: text(3, 500),
  justification: text(10, 1000),
  scope: RuleScopeInput,
  match: RuleMatch,
  behaviour: RuleBehaviour,
  /** Temporary: stops applying at expiresAt. Permanent: applies until rolled back, reviewed by reviewAt. */
  temporary: z.boolean(),
  expiresAt: z.string().datetime({ offset: true }).optional(),
  reviewAt: z.string().datetime({ offset: true }).optional(),
  allowBroad: z.boolean().default(false),
  recommendationId: z.string().regex(ID).optional(),
  /** A revision of an active rule: approving this one supersedes it. */
  supersedesId: z.string().regex(ID).optional(),
}).strict();
export type RuleDraftInput = z.infer<typeof RuleDraftInput>;

export const RuleEditInput = RuleDraftInput.omit({ recommendationId: true, supersedesId: true }).partial().extend({ revision: z.number().int().min(1) }).strict();
export const ApproveInput = z.object({ revision: z.number().int().min(1), acceptDangerous: z.boolean().default(false), note: text(0, 300).optional() }).strict();
export const CloseInput = z.object({ note: text(3, 300) }).strict();

/** The scope key a scope is stored under (0086 CHECKs the same shapes). */
export function scopeKeyFor(s: { kind: ScopeKind; customerId: string | null; endpointId?: string | null; groupId?: string | null; monitorRuleId?: string | null; osFamily?: string | null }): string {
  switch (s.kind) {
    case 'endpoint': return `e:${s.endpointId}`;
    case 'group': return `g:${s.groupId}`;
    case 'business': return `b:${s.customerId}`;
    case 'monitor': return `m:${s.monitorRuleId}`;
    case 'os': return `os:${s.customerId ?? '*'}:${s.osFamily}`;
    default: return 'platform';
  }
}

/** The match with its keys sorted and its levels sorted: two rules with the same conditions have the same key. */
export function canonicalMatch(m: RuleMatch): RuleMatch {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(m).sort()) {
    const v = (m as Record<string, unknown>)[k];
    if (v === undefined) continue;
    out[k] = k === 'levels' ? [...new Set(v as number[])].sort((a, b) => a - b) : k === 'provider' ? String(v) : v;
  }
  return out as RuleMatch;
}
export function matchKeyOf(m: RuleMatch): string {
  return createHash('sha256').update(JSON.stringify(['qm1', canonicalMatch(m)])).digest('hex').slice(0, 32);
}
const EVENT_FIELDS = ['fingerprint', 'provider', 'eventId', 'levels', 'statusCode', 'component'] as const;
export const conditionsOf = (m: RuleMatch) => EVENT_FIELDS.filter((k) => m[k] !== undefined).length;

/**
 * Why a rule is too broad or does not fit its monitor, or null. `monitorKind`
 * is the monitor's kind (EVENT_MATCH, DISK_FREE…).
 */
export function narrownessProblem(d: { scope: { kind: ScopeKind }; match: RuleMatch; behaviour: RuleBehaviour; allowBroad: boolean }, monitorKind: string):
  { code: string; message: string } | null {
  const ev = monitorKind === 'EVENT_MATCH';
  if (!ev) {
    if (conditionsOf(d.match) > 0) return { code: 'EVENT_CONDITIONS_ON_THRESHOLD', message: 'Only an event-log monitor has event conditions. For this monitor, name only the monitor and a scope.' };
    if (d.behaviour.kind === 'require_count' || d.behaviour.kind === 'require_repeats') {
      return { code: 'BEHAVIOUR_NEEDS_EVENTS', message: 'Raising only on a count or on repeats is for event-log monitors. Change this monitor\'s threshold under Monitoring → Monitoring policies.' };
    }
    if ((d.scope.kind === 'platform' || d.scope.kind === 'os') && !d.allowBroad) {
      return { code: 'RULE_TOO_BROAD', message: 'A rule that changes a threshold monitor everywhere is too broad. Scope it to a customer, a group or a device.' };
    }
    return null;
  }
  const narrow = !!d.match.fingerprint || (!!d.match.provider && d.match.eventId !== undefined);
  if (!narrow && !d.allowBroad) {
    return { code: 'RULE_TOO_BROAD', message: 'An event-log rule must name the event fingerprint, or both the provider and the event id. A rule on a monitor\'s every event would hide genuine failures.' };
  }
  return null;
}

const STORAGE_PROVIDERS = new Set([...STORAGE_CONTROLLER_PROVIDERS, ...KNOWN_EVENTS.flatMap((k) => k.providers)].map((p) => p.toLowerCase()));

/**
 * High risk: two different approvers. A rule is high risk when it could hide
 * a critical hardware, security or backup failure, or reaches past one
 * business. The monitor's name and key are read only to recognise backup and
 * storage monitors; the event conditions are what decide.
 */
export function riskOf(d: { scope: { kind: ScopeKind; businessId?: string | null }; match: RuleMatch; behaviour: RuleBehaviour; allowBroad: boolean },
  monitor: { kind: string; severity: Sev; key: string; name: string; log?: string | null }, dangerousMatches = 0): { risk: 'normal' | 'high'; reasons: string[] } {
  const reasons: string[] = [];
  const lowersCritical = monitor.severity === 'CRITICAL' && !(d.behaviour.kind === 'downgrade' && d.behaviour.severity === 'WARNING');
  if (lowersCritical) reasons.push('critical_monitor');
  if ((monitor.log ?? '') === 'Security') reasons.push('security_log');
  if (/backup/i.test(monitor.key) || /backup/i.test(monitor.name) || /backup/i.test(d.match.provider ?? '')) reasons.push('backup_monitor');
  if (monitor.key === 'disk-errors' || (d.match.provider && STORAGE_PROVIDERS.has(d.match.provider.toLowerCase()))) reasons.push('storage_events');
  if (d.scope.kind === 'platform' || (d.scope.kind === 'os' && !d.scope.businessId)) reasons.push('platform_wide');
  if (d.allowBroad) reasons.push('broad');
  if (dangerousMatches > 0) reasons.push('dangerous_matches');
  return { risk: reasons.length ? 'high' : 'normal', reasons };
}

/** Temporary rules expire within 90 days; permanent ones are reviewed within a year. */
export function expiryProblem(d: { temporary: boolean; expiresAt?: string | Date | null; reviewAt?: string | Date | null }, now: Date): { code: string; message: string } | null {
  const t = (v: string | Date | null | undefined) => (v ? new Date(v).getTime() : NaN);
  if (d.temporary) {
    const e = t(d.expiresAt);
    if (!Number.isFinite(e) || d.reviewAt) return { code: 'EXPIRY_REQUIRED', message: 'A temporary rule needs an end date, and no review date.' };
    if (e <= now.getTime()) return { code: 'EXPIRY_PAST', message: 'The end date has passed.' };
    if (e - now.getTime() > MAX_TEMPORARY_DAYS * 86_400_000) return { code: 'EXPIRY_TOO_FAR', message: `A temporary rule lasts at most ${MAX_TEMPORARY_DAYS} days. Make it permanent, with a review date, instead.` };
    return null;
  }
  const r = t(d.reviewAt);
  if (!Number.isFinite(r) || d.expiresAt) return { code: 'REVIEW_REQUIRED', message: 'A permanent exception needs a review date, and no end date.' };
  if (r <= now.getTime()) return { code: 'REVIEW_PAST', message: 'The review date has passed.' };
  if (r - now.getTime() > MAX_REVIEW_DAYS * 86_400_000) return { code: 'REVIEW_TOO_FAR', message: `A permanent exception is reviewed at least every ${MAX_REVIEW_DAYS} days.` };
  return null;
}

// ── Evaluation ──────────────────────────────────────────────────────────────

/** What the engine needs of a stored rule. */
export interface QualityRuleLike {
  id: string;
  status: string;
  scopeKind: ScopeKind;
  customerId: string | null;
  endpointId: string | null;
  groupId: string | null;
  monitorRuleId: string | null;
  osFamily: string | null;
  ruleKey: string;
  match: RuleMatch;
  behaviour: RuleBehaviour;
  temporary: boolean;
  expiresAt: Date | null;
}

/** The computer and monitor an alert is about. */
export interface RuleContext {
  endpointId: string;
  customerId: string | null;
  groupIds: ReadonlySet<string>;
  osFamily: OsFamily | null;
  ruleKey: string;
  monitorRuleId: string | null;
}

export function osFamilyOf(platform: string | null | undefined, osVersion: string | null | undefined): OsFamily | null {
  const p = (platform ?? '').toLowerCase();
  if (p.startsWith('win')) return /server/i.test(osVersion ?? '') ? 'windows-server' : 'windows-client';
  if (p.startsWith('linux')) return 'linux';
  if (p.startsWith('mac') || p === 'darwin' || p === 'osx') return 'macos';
  return null;
}
const osCovers = (rule: string | null, ep: OsFamily | null) => !!rule && !!ep && (rule === ep || (rule === 'windows' && ep.startsWith('windows-')));

/** In force at `now`: active and, if temporary, not past its end. */
export const inForce = (r: QualityRuleLike, now: Date) => r.status === 'active' && (!r.temporary || (!!r.expiresAt && r.expiresAt.getTime() > now.getTime()));

/** Does this rule's scope cover this computer and monitor? A rule never crosses a business. */
export function scopeCovers(r: QualityRuleLike, c: RuleContext): boolean {
  if (r.ruleKey !== c.ruleKey) return false;
  switch (r.scopeKind) {
    case 'endpoint': return r.endpointId === c.endpointId && r.customerId === c.customerId;
    case 'group': return !!r.groupId && c.groupIds.has(r.groupId) && r.customerId === c.customerId;
    case 'business': return !!r.customerId && r.customerId === c.customerId;
    case 'monitor': return !!r.monitorRuleId && r.monitorRuleId === c.monitorRuleId && (r.customerId === null || r.customerId === c.customerId);
    case 'os': return (r.customerId === null || r.customerId === c.customerId) && osCovers(r.osFamily, c.osFamily);
    case 'platform': return r.customerId === null;
    default: return false;
  }
}

/** Does this rule's match cover this event? Every named condition must hold. */
export function eventMatches(m: RuleMatch, d: Pick<SampleDecision, 'fingerprint' | 'provider' | 'eventId' | 'level' | 'statusCode' | 'component'>): boolean {
  if (m.fingerprint !== undefined && m.fingerprint !== d.fingerprint) return false;
  if (m.provider !== undefined && (d.provider ?? '').toLowerCase() !== m.provider.toLowerCase()) return false;
  if (m.eventId !== undefined && m.eventId !== d.eventId) return false;
  if (m.levels !== undefined && (d.level === null || !m.levels.includes(d.level))) return false;
  if (m.statusCode !== undefined && m.statusCode !== d.statusCode) return false;
  if (m.component !== undefined && m.component !== d.component) return false;
  return true;
}

/** How much of the alert a behaviour keeps: in a tie, the one that keeps more wins. */
export function keeps(b: RuleBehaviour): number {
  switch (b.kind) {
    case 'downgrade': return b.severity === 'WARNING' ? 4 : 3;
    case 'require_count': return 2;
    case 'require_repeats': return 1;
    default: return 0;
  }
}

/** Precedence order: scope, then conditions, then what it keeps, then id. Sorts best first. */
export function compareRules(a: QualityRuleLike, b: QualityRuleLike): number {
  return PRECEDENCE[b.scopeKind] - PRECEDENCE[a.scopeKind]
    || conditionsOf(b.match) - conditionsOf(a.match)
    || keeps(b.behaviour) - keeps(a.behaviour)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** The winning rule for one event (or a threshold alert, `d` null), and whether another rule at its level disagreed. */
export function pickRule(rules: readonly QualityRuleLike[], c: RuleContext, d: Parameters<typeof eventMatches>[1] | null): { rule: QualityRuleLike; conflict: boolean } | null {
  const hits = rules.filter((r) => scopeCovers(r, c) && (d ? eventMatches(r.match, d) : conditionsOf(r.match) === 0)).sort(compareRules);
  if (!hits.length) return null;
  const [w, ...rest] = hits;
  const conflict = rest.some((r) => PRECEDENCE[r.scopeKind] === PRECEDENCE[w.scopeKind] && conditionsOf(r.match) === conditionsOf(w.match) && JSON.stringify(r.behaviour) !== JSON.stringify(w.behaviour));
  return { rule: w, conflict };
}

export interface RuleHit { ruleId: string; shadow: boolean; events: number; dangerous: number }

/**
 * The verdict of every rule on one classified event report.
 *
 *   rules      every rule in force for this business and the platform, and
 *              every pending one (pending rules are evaluated in the shadow:
 *              counted, never applied)
 *   decisions  the classifier's first pass (classifyEvents without adjust)
 *   seenOf     how many times this computer has reported a fingerprint,
 *              including this report (MonitorEventFingerprint.seen)
 *
 * A known-harmless event is left alone. An event a rule suppresses that the
 * classifier knew as a CRITICAL failure is counted as a dangerous match.
 */
export function adjustSamples(rules: readonly QualityRuleLike[], c: RuleContext, cls: Classification, seenOf: (fp: string) => number, now: Date):
  { adjust: (SampleAdjust | null)[]; hits: RuleHit[]; conflicts: string[] } {
  const live = rules.filter((r) => inForce(r, now));
  const shadow = rules.filter((r) => r.status === 'pending');
  const hits = new Map<string, RuleHit>();
  const hit = (r: QualityRuleLike, isShadow: boolean, dangerous: boolean) => {
    const h = hits.get(r.id) ?? { ruleId: r.id, shadow: isShadow, events: 0, dangerous: 0 };
    h.events++; if (dangerous) h.dangerous++;
    hits.set(r.id, h);
  };
  const conflicts = new Set<string>();
  // require_count: how many events in this report the same rule covers. When
  // it covers every event sent, the unsent ones are counted too — that only
  // makes the count larger, so it can only keep an alert, never hide one.
  const picks = cls.samples.map((d) => (d.class === 'BENIGN' ? null : pickRule(live, c, d)));
  const coveredBy = (id: string) => picks.filter((p) => p?.rule.id === id).length;
  const adjust = cls.samples.map((d, i): SampleAdjust | null => {
    if (d.class === 'BENIGN') return null;
    for (const s of shadow) if (scopeCovers(s, c) && eventMatches(s.match, d)) hit(s, true, d.class === 'CRITICAL');
    const p = picks[i];
    if (!p) return null;
    if (p.conflict) conflicts.add(p.rule.id);
    const b = p.rule.behaviour;
    let a: SampleAdjust | null = null;
    if (b.kind === 'suppress') a = { ruleId: p.rule.id, suppressed: true };
    else if (b.kind === 'downgrade') a = { ruleId: p.rule.id, cap: b.severity };
    else if (b.kind === 'require_count') {
      const n = coveredBy(p.rule.id) + (coveredBy(p.rule.id) === cls.seen ? cls.unseen : 0);
      a = n < b.minCount ? { ruleId: p.rule.id, suppressed: true } : null;
    } else if (b.kind === 'require_repeats') {
      a = seenOf(d.fingerprint) < b.reports ? { ruleId: p.rule.id, suppressed: true } : null;
    }
    hit(p.rule, false, !!a?.suppressed && d.class === 'CRITICAL');
    return a;
  });
  return { adjust, hits: [...hits.values()], conflicts: [...conflicts] };
}

/** A threshold monitor's alert (disk space, CPU, offline…): suppressed (null), capped, or unchanged. */
export function adjustThreshold(rules: readonly QualityRuleLike[], c: RuleContext, severity: Sev, now: Date): { severity: Sev | null; ruleId: string | null } {
  const p = pickRule(rules.filter((r) => inForce(r, now)), c, null);
  if (!p) return { severity, ruleId: null };
  const b = p.rule.behaviour;
  if (b.kind === 'suppress') return { severity: null, ruleId: p.rule.id };
  if (b.kind === 'downgrade') return { severity: RANK[b.severity] < RANK[severity] ? b.severity : severity, ruleId: p.rule.id };
  return { severity, ruleId: null };
}

/** Two active rules in one scope whose conditions overlap and whose behaviours differ. */
export function conflictsAmong(rules: readonly QualityRuleLike[]): { a: string; b: string }[] {
  const out: { a: string; b: string }[] = [];
  const active = rules.filter((r) => r.status === 'active');
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i], b = active[j];
      if (a.ruleKey !== b.ruleKey || a.scopeKind !== b.scopeKind || scopeKeyFor({ ...a, kind: a.scopeKind }) !== scopeKeyFor({ ...b, kind: b.scopeKind })) continue;
      if (JSON.stringify(a.behaviour) === JSON.stringify(b.behaviour)) continue;
      // Overlap: no condition both name with different values.
      const overlap = EVENT_FIELDS.every((k) => a.match[k] === undefined || b.match[k] === undefined || JSON.stringify(a.match[k]) === JSON.stringify(b.match[k])
        || (k === 'levels' && (a.match.levels ?? []).some((l) => (b.match.levels ?? []).includes(l))));
      if (overlap) out.push({ a: a.id, b: b.id });
    }
  }
  return out;
}

// ── Simulation against stored history ───────────────────────────────────────

export interface HistoricAlert {
  id: string; title: string; customerId: string | null; endpointId: string | null; ruleKey: string; ruleId: string | null; kind: string;
  severity: Sev; state: string; firstSeenAt: Date; detail: unknown; classification: unknown; log: string | null; ruleSeverity: Sev; ruleParams: Record<string, unknown>;
  ctx: RuleContext | null;
}
export interface HistoricEvent { endpointId: string; ruleKey: string; fingerprint: string; class: string; seen: number; sample: unknown; log: string; ctx: RuleContext | null }

export interface SimulationResult {
  v: number;
  at: string;
  revision: number;
  days: number;
  considered: number;
  matched: number;
  wouldSuppress: number;
  wouldDowngrade: number;
  unchanged: number;
  /** Matches the classifier knew as genuine failures, or Security-log events: approving needs acceptDangerous. */
  dangerous: { alertId: string; title: string; reason: string }[];
  businesses: { id: string | null; alerts: number }[];
  computers: { id: string | null; alerts: number }[];
  /** Event signatures recorded (MonitorEventFingerprint), including ones that never became an alert. */
  events: { fingerprints: number; occurrences: number };
  /** Before and after, for the first 50 alerts the rule matches. */
  changes: { alertId: string; title: string; before: Sev; after: Sev | null; state: string; at: string }[];
  truncated: boolean;
}

/**
 * What a rule would have done to the stored history, treating it as active.
 * Other rules are left out on purpose: this is the rule on its own.
 */
export function simulateRule(rule: QualityRuleLike, revision: number, alerts: readonly HistoricAlert[], events: readonly HistoricEvent[], now: Date, truncated = false): SimulationResult {
  const asActive: QualityRuleLike = { ...rule, status: 'active', temporary: false, expiresAt: null };
  const res: SimulationResult = {
    v: QUALITY_RULES_VERSION, at: now.toISOString(), revision, days: SIMULATION_DAYS, considered: 0, matched: 0, wouldSuppress: 0, wouldDowngrade: 0, unchanged: 0,
    dangerous: [], businesses: [], computers: [], events: { fingerprints: 0, occurrences: 0 }, changes: [], truncated,
  };
  const biz = new Map<string | null, number>(), eps = new Map<string | null, number>();
  for (const a of alerts) {
    if (a.ruleKey !== rule.ruleKey || !a.ctx || !scopeCovers(asActive, a.ctx)) continue;
    res.considered++;
    let after: Sev | null;
    let danger: string | null = null;
    if (a.kind === 'EVENT_MATCH') {
      const samples = samplesOf(a.detail);
      if (!samples.length) continue;
      const count = Math.max(samples.length, Number((a.detail as { count?: unknown })?.count) || 0);
      const view = { severity: a.ruleSeverity, params: a.ruleParams };
      const first = classifyEvents(view, { count, samples });
      const { adjust } = adjustSamples([asActive], a.ctx, first, () => 1, now);
      if (!adjust.some(Boolean)) continue;
      const second = classifyEvents(view, { count, samples }, adjust);
      after = second.severity;
      const hurt = first.samples.filter((d, i) => adjust[i] && d.class === 'CRITICAL');
      if (hurt.length) danger = `matches ${hurt[0].matched ?? 'a known failure'} (${hurt[0].provider ?? '?'} ${hurt[0].eventId ?? '?'})`;
      if (a.log === 'Security') danger = danger ?? 'a Security-log event';
    } else {
      if (conditionsOf(rule.match) > 0) continue;
      const t = adjustThreshold([asActive], a.ctx, a.severity, now);
      if (!t.ruleId) continue;
      after = t.severity;
      if (a.severity === 'CRITICAL' && after === null) danger = 'a critical alert would not be raised';
    }
    res.matched++;
    if (after === null) res.wouldSuppress++;
    else if (RANK[after] < RANK[a.severity]) res.wouldDowngrade++;
    else res.unchanged++;
    if (danger) res.dangerous.push({ alertId: a.id, title: a.title.slice(0, 200), reason: danger });
    biz.set(a.customerId, (biz.get(a.customerId) ?? 0) + 1);
    eps.set(a.endpointId, (eps.get(a.endpointId) ?? 0) + 1);
    if (res.changes.length < 50) res.changes.push({ alertId: a.id, title: a.title.slice(0, 200), before: a.severity, after, state: a.state, at: a.firstSeenAt.toISOString() });
  }
  for (const e of events) {
    if (e.ruleKey !== rule.ruleKey || !e.ctx || !scopeCovers(asActive, e.ctx)) continue;
    const s = (e.sample && typeof e.sample === 'object' ? e.sample : {}) as EventSample;
    const first = classifyEvents({ severity: 'CRITICAL', params: { log: e.log } }, { count: 1, samples: [s] });
    const d = first.samples[0];
    if (!d || d.fingerprint !== e.fingerprint || d.class === 'BENIGN' || !eventMatches(rule.match, d)) continue;
    res.events.fingerprints++;
    res.events.occurrences += e.seen;
  }
  res.businesses = [...biz.entries()].sort((x, y) => y[1] - x[1]).map(([id, n]) => ({ id, alerts: n }));
  res.computers = [...eps.entries()].sort((x, y) => y[1] - x[1]).slice(0, 50).map(([id, n]) => ({ id, alerts: n }));
  return res;
}

// ── Recommendations ─────────────────────────────────────────────────────────

export interface RecFacts {
  kind: string; monitorName: string; monitorSeverity: Sev; log: string | null;
  provider: string | null; eventId: number | null; level: number | null; statusCode: string | null; component: string | null; className: string | null;
}

const LEVEL_NAME: Record<number, string> = { 0: 'LogAlways', 1: 'Critical', 2: 'Error', 3: 'Warning', 4: 'Information', 5: 'Verbose' };

/** The top reason, by count, then by FP_REASONS order. */
export function topReason(reasons: Record<string, number>): FpReason {
  let best: FpReason = 'other', n = -1;
  for (const r of FP_REASONS) { const c = reasons[r] ?? 0; if (c > n) { best = r; n = c; } }
  return best;
}

/**
 * A recommendation in plain language, and the rule it would start from.
 * It never says a rule is safe: it says what a simulation must show.
 * `draft` is null when the fix is a monitor change, not a rule.
 */
export function recommendationText(o: { ruleKey: string; fingerprint: string | null; facts: RecFacts; reasons: Record<string, number>; reportCount: number; computers: number; businessId: string | null }): {
  title: string; monitor: string; issue: string; recommendation: string; impact: string; caution: string;
  draft: { scope: RuleScopeInput; match: RuleMatch; behaviour: RuleBehaviour } | null;
} {
  const f = o.facts;
  const ev = f.kind === 'EVENT_MATCH';
  const why = topReason(o.reasons);
  const level = f.level !== null && f.level !== undefined ? LEVEL_NAME[f.level] ?? `level ${f.level}` : null;
  const sig = ev
    ? [level ? `${level}-level` : null, f.provider ?? 'unknown provider', f.eventId !== null ? `event ${f.eventId}` : null, f.statusCode ? `(status ${f.statusCode})` : null, f.component ? `on a ${f.component.replace(/-/g, ' ')}` : null]
      .filter(Boolean).join(' ')
    : `this monitor's alert`;
  const people = `${o.reportCount} report${o.reportCount === 1 ? '' : 's'}`;
  const tally = FP_REASONS.filter((r) => o.reasons[r]).map((r) => `${FP_REASON_LABEL[r].toLowerCase()} ×${o.reasons[r]}`).join(', ');
  const issue = `${sig} is raising ${f.monitorSeverity.toLowerCase()} "${f.monitorName}" alerts on ${o.computers} computer${o.computers === 1 ? '' : 's'}; ${people} call${o.reportCount === 1 ? 's' : ''} it a false positive (${tally || 'no reason given'}).`;
  const scope: RuleScopeInput = o.businessId ? { kind: 'business', businessId: o.businessId } : { kind: 'platform' };
  const match: RuleMatch = ev
    ? canonicalMatch({ ruleKey: o.ruleKey, ...(o.fingerprint ? { fingerprint: o.fingerprint } : {}), ...(f.provider && PROVIDER_RE.test(f.provider) ? { provider: f.provider } : {}), ...(f.eventId !== null && f.eventId >= 0 && f.eventId <= 65535 ? { eventId: f.eventId } : {}),
      ...(f.level !== null && f.level >= 0 && f.level <= 5 ? { levels: [f.level] } : {}), ...(f.statusCode && STATUS_RE.test(f.statusCode) ? { statusCode: f.statusCode } : {}), ...((COMPONENTS as readonly string[]).includes(f.component ?? '') ? { component: f.component as RuleMatch['component'] } : {}) })
    : { ruleKey: o.ruleKey };
  const caution = 'Not validated yet: test the rule against stored history before anyone approves it. A description is not proof that a rule is safe.';
  const monitorFix = (r: string) => ({ title: 'Proposed Monitor Correction', monitor: f.monitorName, issue, recommendation: r, impact: 'No rule is proposed: the monitor itself needs changing, and that is done under Monitoring → Monitoring policies by someone who configures monitoring.', caution, draft: null });
  if (why === 'incorrect_correlation') return monitorFix('Check that this monitor applies to the right computers and that its event conditions describe the problem it is for.');
  if (!ev && (why === 'incorrect_threshold' || why === 'rule_too_broad')) return monitorFix('Change this monitor\'s threshold or scope under Monitoring → Monitoring policies.');
  if (why === 'incorrect_severity') {
    return { title: 'Proposed Rule Improvement', monitor: f.monitorName, issue,
      recommendation: `Lower this narrowly defined ${ev ? 'event signature' : 'alert'} to warning${o.businessId ? ' for this business' : ''}, instead of ${f.monitorSeverity.toLowerCase()}.`,
      impact: 'Similar alerts are still raised and notified, at warning. Unrelated events from this monitor are unchanged.', caution, draft: { scope, match, behaviour: { kind: 'downgrade', severity: 'WARNING' } } };
  }
  if (ev && (why === 'incorrect_threshold' || why === 'duplicate')) {
    return { title: 'Proposed Rule Improvement', monitor: f.monitorName, issue,
      recommendation: why === 'duplicate' ? 'Raise this event signature only once it has been reported three times by the same computer.' : 'Raise this event signature only when at least three of it arrive in one report.',
      impact: 'A single occurrence is recorded but not raised; a recurring one still alerts.', caution,
      draft: { scope, match, behaviour: why === 'duplicate' ? { kind: 'require_repeats', reports: 3 } : { kind: 'require_count', minCount: 3 } } };
  }
  return { title: 'Proposed Rule Improvement', monitor: f.monitorName, issue,
    recommendation: ev ? `Exclude this narrowly defined event signature (${sig}) from "${f.monitorName}" alerts.` : `Do not raise "${f.monitorName}" alerts${o.businessId ? ' for this business' : ''}.`,
    impact: ev ? 'Prevents similar nuisance alerts without excluding unrelated storage, security or other failures this monitor watches for. Each event is still recorded.' : 'This monitor raises nothing in the rule\'s scope. Prefer a narrower scope.',
    caution, draft: { scope, match, behaviour: { kind: 'suppress' } } };
}

/** How urgent a recommendation is: reports, distinct reporters, computers. Never an authorisation. */
export function priorityOf(r: { reportCount: number; reporters: number; computers: number; lastReportedAt: Date }, now: Date): number {
  const ageDays = Math.max(0, (now.getTime() - r.lastReportedAt.getTime()) / 86_400_000);
  return Math.round((r.reportCount + 2 * r.reporters + r.computers) * (ageDays > 30 ? 0.5 : 1));
}

// ── Monitoring quality checks ───────────────────────────────────────────────

export const QUALITY = {
  highVolume7d: 50,
  highVolumePerComputer7d: 10,
  flappingMinutes: 10,
  flapping7d: 5,
  fpReported30d: 3,
  sensitiveAlerts30d: 20,
  neverTriggersDays: 90,
  agentSkewShare: 0.8,
  agentSkewMin7d: 10,
} as const;

export interface MonitorStats {
  ruleId: string; key: string; name: string; kind: string; severity: Sev; enabled: boolean; params: Record<string, unknown>; createdAt: Date; businessId: string | null;
  alerts7d: number; alertsPrev7d: number; alerts30d: number; alerts90d: number; computers7d: number; quickResolves7d: number; resolves7d: number;
  fpReports30d: number; informational30d: number;
  /** Alerts in the last 7 days by the computer's current agent version, and how many reporting computers run each. */
  byAgentVersion: { version: string; alerts: number; computers: number }[];
}
export interface QualityCheck {
  code: 'high_volume' | 'false_positives' | 'flapping' | 'duplicate_monitors' | 'sensitive_threshold' | 'conflicting_rules' | 'escalates_informational' | 'never_triggers' | 'rule_hides_failures' | 'after_agent_update' | 'review_overdue';
  level: 'high' | 'medium' | 'low';
  monitor: { id: string | null; key: string; name: string } | null;
  ruleIds: string[];
  message: string;
  recommendation: string;
  evidence: Record<string, unknown>;
}

/**
 * Recommendations only: nothing here, or anywhere, disables a monitor
 * because of how often it fires.
 */
export function qualityChecks(o: {
  monitors: readonly MonitorStats[];
  duplicates: readonly { endpointId: string; fingerprint: string; keys: string[] }[];
  rules: readonly (QualityRuleLike & { name: string; dangerousMatchCount: number; risk: string; reviewAt: Date | null; matchCount: number })[];
}, now: Date): QualityCheck[] {
  const out: QualityCheck[] = [];
  const mon = (m: MonitorStats) => ({ id: m.ruleId, key: m.key, name: m.name });
  for (const m of o.monitors) {
    if (!m.enabled) continue;
    if (m.alerts7d >= QUALITY.highVolume7d || (m.computers7d > 0 && m.alerts7d / m.computers7d >= QUALITY.highVolumePerComputer7d)) {
      out.push({ code: 'high_volume', level: 'medium', monitor: mon(m), ruleIds: [], message: `"${m.name}" raised ${m.alerts7d} alerts in 7 days on ${m.computers7d} device${m.computers7d === 1 ? '' : 's'}.`,
        recommendation: 'Look at what it matches (View similar alerts) before changing it. Narrow its conditions or threshold if most of these are not actionable.', evidence: { alerts7d: m.alerts7d, computers7d: m.computers7d } });
    }
    if (m.fpReports30d >= QUALITY.fpReported30d) {
      out.push({ code: 'false_positives', level: 'high', monitor: mon(m), ruleIds: [], message: `"${m.name}" alerts were reported as false positives ${m.fpReports30d} times in 30 days.`,
        recommendation: 'Review its recommendations below; test a narrow rule before approving it.', evidence: { fpReports30d: m.fpReports30d } });
    }
    if (m.quickResolves7d >= QUALITY.flapping7d && m.resolves7d > 0 && m.quickResolves7d / m.resolves7d >= 0.5) {
      out.push({ code: 'flapping', level: 'medium', monitor: mon(m), ruleIds: [], message: `"${m.name}" alerts cleared themselves within ${QUALITY.flappingMinutes} minutes ${m.quickResolves7d} times in 7 days.`,
        recommendation: 'Require it to hold for longer (consecutive checks or minutes) before alerting, so a brief blip is not an alert.', evidence: { quickResolves7d: m.quickResolves7d, resolves7d: m.resolves7d } });
    }
    if (m.kind === 'EVENT_MATCH') {
      const levels = Array.isArray(m.params.levels) ? (m.params.levels as unknown[]).filter((x): x is number => typeof x === 'number') : [];
      const quiet = levels.length === 0 || levels.some((l) => l === 4 || l === 5);
      if (quiet && m.severity !== 'INFO' && m.params.log !== 'Security') {
        out.push({ code: 'escalates_informational', level: m.informational30d > 0 ? 'high' : 'low', monitor: mon(m), ruleIds: [],
          message: `"${m.name}" is ${m.severity.toLowerCase()} and ${levels.length ? 'asks for Information or Verbose events' : 'names no event level'}${m.informational30d ? `; ${m.informational30d} alerts in 30 days were informational events` : ''}.`,
          recommendation: 'Ask only for levels Critical, Error and Warning unless an informational event really is the failure you are watching for.', evidence: { levels, informational30d: m.informational30d } });
      }
      if (Number(m.params.threshold) === 1 && m.alerts30d >= QUALITY.sensitiveAlerts30d) {
        out.push({ code: 'sensitive_threshold', level: 'low', monitor: mon(m), ruleIds: [], message: `"${m.name}" alerts on a single event and raised ${m.alerts30d} alerts in 30 days.`,
          recommendation: 'If one occurrence is not actionable, raise the threshold or add a rule that requires a count.', evidence: { alerts30d: m.alerts30d } });
      }
    }
    if (m.alerts90d === 0 && now.getTime() - m.createdAt.getTime() > QUALITY.neverTriggersDays * 86_400_000) {
      out.push({ code: 'never_triggers', level: 'low', monitor: mon(m), ruleIds: [], message: `"${m.name}" has not raised an alert in ${QUALITY.neverTriggersDays} days.`,
        recommendation: 'That may be good news. Check it still watches what you intend (a service name, an event id) — do not remove it for being quiet.', evidence: {} });
    }
    const top = [...m.byAgentVersion].sort((a, b) => b.alerts - a.alerts)[0];
    const fleet = m.byAgentVersion.reduce((n, v) => n + v.computers, 0);
    if (top && m.alerts7d >= QUALITY.agentSkewMin7d && m.alerts7d >= 2 * Math.max(1, m.alertsPrev7d) && top.alerts / m.alerts7d >= QUALITY.agentSkewShare && fleet > 0 && top.computers / fleet <= 0.5) {
      out.push({ code: 'after_agent_update', level: 'medium', monitor: mon(m), ruleIds: [],
        message: `"${m.name}" alerts doubled this week, and ${Math.round((100 * top.alerts) / m.alerts7d)}% come from devices on agent ${top.version} (${top.computers} of ${fleet}).`,
        recommendation: 'Compare the events before and after that agent version. Rem0te records each computer\'s current agent version, not when it changed.', evidence: { version: top.version, alerts7d: m.alerts7d, alertsPrev7d: m.alertsPrev7d } });
    }
  }
  for (const d of o.duplicates) {
    out.push({ code: 'duplicate_monitors', level: 'low', monitor: null, ruleIds: [], message: `One event is raising alerts from ${d.keys.length} monitors on the same device (${d.keys.join(', ')}).`,
      recommendation: 'Keep the monitor that describes the problem best, or narrow the others so each event belongs to one.', evidence: { endpointId: d.endpointId, fingerprint: d.fingerprint, monitors: d.keys } });
  }
  for (const c of conflictsAmong(o.rules)) {
    const a = o.rules.find((r) => r.id === c.a)!, b = o.rules.find((r) => r.id === c.b)!;
    out.push({ code: 'conflicting_rules', level: 'medium', monitor: { id: null, key: a.ruleKey, name: a.ruleKey }, ruleIds: [a.id, b.id],
      message: `"${a.name}" and "${b.name}" cover the same events in the same scope and do different things.`,
      recommendation: `The one that keeps more of the alert applies (${keeps(a.behaviour) >= keeps(b.behaviour) ? a.name : b.name}). Roll back the one you do not want.`, evidence: {} });
  }
  for (const r of o.rules) {
    if (r.status !== 'active') continue;
    if (r.dangerousMatchCount > 0) {
      out.push({ code: 'rule_hides_failures', level: 'high', monitor: { id: null, key: r.ruleKey, name: r.ruleKey }, ruleIds: [r.id],
        message: `"${r.name}" has taken ${r.dangerousMatchCount} event${r.dangerousMatchCount === 1 ? '' : 's'} the classifier knows as a genuine failure out of alerting.`,
        recommendation: 'Look at those events now. If they are real, roll the rule back; if not, narrow its conditions.', evidence: { dangerousMatchCount: r.dangerousMatchCount } });
    }
    if (!r.temporary && r.reviewAt && r.reviewAt.getTime() <= now.getTime()) {
      out.push({ code: 'review_overdue', level: 'medium', monitor: { id: null, key: r.ruleKey, name: r.ruleKey }, ruleIds: [r.id],
        message: `"${r.name}" was due for review on ${r.reviewAt.toISOString().slice(0, 10)} and still applies.`, recommendation: 'Review it: revise it with a new review date, or roll it back.', evidence: { matchCount: r.matchCount } });
    }
  }
  const order = { high: 0, medium: 1, low: 2 } as const;
  return out.sort((a, b) => order[a.level] - order[b.level]);
}

export type { SampleDecision };
