import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GroupMembershipService } from '../group-policy/membership.service';
import type { Classification, SampleAdjust } from './classify';
import {
  adjustSamples, adjustThreshold, osFamilyOf, RuleBehaviour, RuleMatch,
  type OsFamily, type QualityRuleLike, type RuleContext, type RuleHit, type ScopeKind,
} from './quality-rules';

type Sev = 'INFO' | 'WARNING' | 'CRITICAL';
/** The computer an alert is about. platform / osVersion are read when an OS rule needs them. */
export type QualityEp = { id: string; customerId: string | null; platform?: string | null; osVersion?: string | null };

/** How long a process trusts its copy of the rules. A change made here refreshes it at once. */
const CACHE_MS = 30_000;
/** More rules than this in force or pending is not a configuration anyone can review. */
const MAX_RULES = 5_000;

/**
 * Alert quality rules (0.67), the evaluating half: which rules apply to an
 * event report or a threshold alert, what they do to it, and the counters.
 * MonitoringService calls it on the ingest path, before evaluateEvents and
 * before raise — so before any notification or ticket. It reads only rules
 * that are active (applied) or pending (shadow: counted, never applied), from
 * a copy refreshed every 30 seconds, and costs nothing for a monitor that no
 * rule names. It writes only the counters.
 */
@Injectable()
export class QualityEngineService {
  private readonly logger = new Logger('AlertQualityRules');
  private cache: { at: number; rules: QualityRuleLike[] } | null = null;
  private loading: Promise<QualityRuleLike[]> | null = null;

  constructor(private readonly prisma: PrismaService, private readonly groups: GroupMembershipService) {}

  /** Forget the copy (after an approval, rollback or expiry in this process). */
  invalidate() { this.cache = null; }

  async rules(now = new Date()): Promise<QualityRuleLike[]> {
    if (this.cache && now.getTime() - this.cache.at < CACHE_MS) return this.cache.rules;
    this.loading ??= (async () => {
      try {
        const rows = await this.prisma.alertQualityRule.findMany({
          where: { status: { in: ['active', 'pending'] } }, take: MAX_RULES, orderBy: { createdAt: 'asc' },
          select: { id: true, status: true, scopeKind: true, customerId: true, endpointId: true, groupId: true, monitorRuleId: true, osFamily: true, ruleKey: true, match: true, behaviour: true, temporary: true, expiresAt: true },
        });
        const rules: QualityRuleLike[] = [];
        for (const r of rows) {
          // A row that does not parse is never applied (it cannot be: the API wrote it). Fail closed — leave it out.
          const m = RuleMatch.safeParse(r.match), b = RuleBehaviour.safeParse(r.behaviour);
          if (!m.success || !b.success) { this.logger.warn(`rule ${r.id} does not parse; ignored`); continue; }
          rules.push({ ...r, scopeKind: r.scopeKind as ScopeKind, match: m.data, behaviour: b.data });
        }
        this.cache = { at: Date.now(), rules };
        return rules;
      } finally { this.loading = null; }
    })();
    return this.loading;
  }

  /** The context of one computer and monitor, reading group membership and the OS only when a rule needs them. */
  async contextFor(ep: QualityEp, ruleKey: string, monitorRuleId: string | null, candidates: QualityRuleLike[]): Promise<RuleContext> {
    const groupIds = [...new Set(candidates.filter((r) => r.scopeKind === 'group' && r.groupId && r.customerId === ep.customerId).map((r) => r.groupId!))];
    const membership = groupIds.length ? (await this.groups.snapshot(groupIds, [ep.id])).groupsOf(ep.id) : new Set<string>();
    let osFamily: OsFamily | null = null;
    if (candidates.some((r) => r.scopeKind === 'os')) {
      let platform = ep.platform, osVersion = ep.osVersion;
      if (platform === undefined) ({ platform, osVersion } = (await this.prisma.endpoint.findUnique({ where: { id: ep.id }, select: { platform: true, osVersion: true } })) ?? { platform: null, osVersion: null });
      osFamily = osFamilyOf(platform, osVersion);
    }
    return { endpointId: ep.id, customerId: ep.customerId, groupIds: membership, osFamily, ruleKey, monitorRuleId };
  }

  /** Rules that could apply: this monitor key, this business or none. Cheap: an in-memory filter. */
  private candidates(all: QualityRuleLike[], ep: QualityEp, ruleKey: string) {
    return all.filter((r) => r.ruleKey === ruleKey && (r.customerId === null || r.customerId === ep.customerId));
  }

  /**
   * An event monitor's report, after the classifier's first pass: each
   * sample's rule verdict (for classifyEvents' `adjust`), or null when no rule
   * names this monitor here. `record` false is a dry run (reclassification).
   */
  async forEvents(ep: QualityEp, monitor: { key: string; id: string }, cls: Classification, now: Date, record = true): Promise<{ adjust: (SampleAdjust | null)[]; hits: RuleHit[] } | null> {
    const cand = this.candidates(await this.rules(now), ep, monitor.key);
    if (!cand.length || !cls.samples.length) return null;
    const ctx = await this.contextFor(ep, monitor.key, monitor.id, cand);
    const fps = [...new Set(cls.samples.map((d) => d.fingerprint))];
    const needSeen = cand.some((r) => r.behaviour.kind === 'require_repeats');
    const seen = needSeen
      ? new Map((await this.prisma.monitorEventFingerprint.findMany({ where: { endpointId: ep.id, ruleKey: monitor.key, fingerprint: { in: fps } }, select: { fingerprint: true, seen: true } })).map((r) => [r.fingerprint, r.seen]))
      : new Map<string, number>();
    const out = adjustSamples(cand, ctx, cls, (fp) => seen.get(fp) ?? 1, now);
    if (record) await this.count(out.hits, now);
    return out.adjust.some(Boolean) || out.hits.length ? { adjust: out.adjust, hits: out.hits } : null;
  }

  /** A threshold monitor's alert: the severity to raise at, null to raise nothing, and the rule that decided. */
  async forThreshold(ep: QualityEp, monitor: { key: string; id: string }, severity: Sev, now: Date, record = true): Promise<{ severity: Sev | null; ruleId: string | null }> {
    const cand = this.candidates(await this.rules(now), ep, monitor.key);
    if (!cand.length) return { severity, ruleId: null };
    const ctx = await this.contextFor(ep, monitor.key, monitor.id, cand);
    const t = adjustThreshold(cand, ctx, severity, now);
    if (record && t.ruleId) await this.count([{ ruleId: t.ruleId, shadow: false, events: 1, dangerous: 0 }], now);
    return t;
  }

  /** Match counters: one conditional write per rule that matched. Never more than the rules this report touched. */
  private async count(hits: RuleHit[], now: Date) {
    for (const h of hits) {
      try {
        if (h.shadow) {
          await this.prisma.alertQualityRule.updateMany({ where: { id: h.ruleId, status: 'pending' }, data: { shadowMatchCount: { increment: h.events }, shadowLastMatchedAt: now } });
        } else {
          await this.prisma.alertQualityRule.updateMany({ where: { id: h.ruleId, status: 'active' }, data: { matchCount: { increment: h.events }, lastMatchedAt: now, ...(h.dangerous ? { dangerousMatchCount: { increment: h.dangerous } } : {}) } });
        }
      } catch (e) {
        // A counter is never worth failing an agent's report for.
        this.logger.warn(`rule ${h.ruleId} counter: ${(e as Error).message}`);
      }
    }
  }
}
