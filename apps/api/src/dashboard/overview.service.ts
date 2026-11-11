import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma, type ActionTargetStatus, type ActivityAction, type SessionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';
import { MonitoringAdminService } from '../monitoring/monitoring-admin.service';
import { Posture } from '../patching/posture';
import { buildPatchSummary, STALE_AFTER_MS } from '../patching/summary';
import { catalogEntry } from '../actions/catalog';
import { age, rankQueue, type QueueItem } from './queue';

/** Online by the flag, but the agent itself has not checked in for this long. */
export const AGENT_SILENT_MS = 30 * 60_000;
/** A session row that has not moved for this long is not shown as live. */
export const SESSION_LIVE_MS = 12 * 3_600_000;
/** Failed action targets and rollout failures look back this far. */
export const RECENT_MS = 7 * 24 * 3_600_000;

const LIVE_SESSION: SessionStatus[] = ['PENDING', 'LAUNCH_REQUESTED', 'LAUNCHER_ACKNOWLEDGED', 'CLIENT_OPENED', 'SESSION_STARTED'];
const FAILED_TARGET: ActionTargetStatus[] = ['FAILED', 'REFUSED_BY_ENDPOINT', 'NOT_EXECUTED'];

/** Audit actions that say something about the estate's state or the work on it. */
const RELEVANT_ACTIVITY: ActivityAction[] = [
  'ACTION_REQUESTED', 'ACTION_APPROVAL_UPDATED', 'ACTION_DISPATCHED', 'ACTION_DISPATCH_BLOCKED', 'ACTION_RESULT', 'ACTION_CANCELED', 'ACTION_RECONCILED',
  'PATCH_DEPLOYMENT_CREATED', 'PATCH_DEPLOYMENT_UPDATED', 'PATCH_RING_REQUESTED', 'PATCH_SCAN_REQUESTED',
  'CONTAINMENT_PAUSED', 'CONTAINMENT_CLEARED',
  'MONITOR_ALERT_ACKNOWLEDGED', 'MONITOR_ALERT_RESOLVED', 'MONITOR_ALERT_TICKET_LINKED', 'MONITOR_SUPPRESSION_CHANGED',
  'ENDPOINT_ENROLLED', 'ENDPOINT_CLAIMED', 'ENDPOINT_ARCHIVED', 'ENDPOINT_RESTORED', 'ENDPOINT_AGENT_REINSTALL_REQUESTED', 'ENDPOINT_HEARTBEAT_REJECTED',
  'SESSION_LAUNCHED', 'SESSION_COMPLETED', 'QUICK_CONNECT_INITIATED',
  'SUPPORT_REQUEST_SUBMITTED', 'SUPPORT_REQUEST_CLAIMED', 'SUPPORT_REQUEST_COMPLETED',
  'UPDATE_JOB_FAILED', 'UPDATE_ROLLOUT_PAUSED',
];

const ACTIVITY_LABEL: Partial<Record<ActivityAction, string>> = {
  ACTION_REQUESTED: 'requested an approved action', ACTION_APPROVAL_UPDATED: 'approval updated', ACTION_DISPATCHED: 'action sent to the computer',
  ACTION_DISPATCH_BLOCKED: 'action held back (containment)', ACTION_RESULT: 'action result received', ACTION_CANCELED: 'canceled an action', ACTION_RECONCILED: 'recorded an uncertain action\'s outcome',
  PATCH_DEPLOYMENT_CREATED: 'created a patch deployment', PATCH_DEPLOYMENT_UPDATED: 'changed a patch deployment', PATCH_RING_REQUESTED: 'requested a patch ring', PATCH_SCAN_REQUESTED: 'asked for an update scan',
  CONTAINMENT_PAUSED: 'paused actions (containment)', CONTAINMENT_CLEARED: 'lifted a containment pause',
  MONITOR_ALERT_ACKNOWLEDGED: 'acknowledged an alert', MONITOR_ALERT_RESOLVED: 'resolved an alert', MONITOR_ALERT_TICKET_LINKED: 'linked a ticket to an alert', MONITOR_SUPPRESSION_CHANGED: 'changed a maintenance window',
  ENDPOINT_ENROLLED: 'device enrolled', ENDPOINT_CLAIMED: 'device claimed', ENDPOINT_ARCHIVED: 'archived a device', ENDPOINT_RESTORED: 'restored a device',
  ENDPOINT_AGENT_REINSTALL_REQUESTED: 'asked for an agent reinstall', ENDPOINT_HEARTBEAT_REJECTED: 'heartbeat rejected',
  SESSION_LAUNCHED: 'started a remote session', SESSION_COMPLETED: 'ended a remote session', QUICK_CONNECT_INITIATED: 'started a Quick Connect session',
  SUPPORT_REQUEST_SUBMITTED: 'support request submitted', SUPPORT_REQUEST_CLAIMED: 'claimed a support request', SUPPORT_REQUEST_COMPLETED: 'closed a support request',
  UPDATE_JOB_FAILED: 'client update failed', UPDATE_ROLLOUT_PAUSED: 'client rollout paused',
};

type Biz = { id: string; name: string };
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const clip = (s: string | null | undefined, n = 160) => (s ? (s.length > n ? `${s.slice(0, n - 1)}…` : s) : null);
const person = (u: { firstName: string | null; lastName: string | null; email: string } | null | undefined) =>
  u ? ([u.firstName, u.lastName].filter(Boolean).join(' ') || u.email) : null;
/** A query that only runs when its section is visible; an empty list otherwise, typed like the query. */
const when = <T>(cond: unknown, q: () => Promise<T[]>): Promise<T[]> => (cond ? q() : Promise.resolve([] as T[]));
const actionTitle = (id: string, version: number) => catalogEntry(id, version)?.title ?? id;

/**
 * The technician dashboard (0.31): what is broken, who is affected, which
 * devices need attention, what is being worked on, and what to do next.
 *
 * Scoping is the whole of the security story here, and none of it is new:
 *   devices   endpointVisibilityWhere — the same rule as the device list,
 *             so a Business User sees only computers granted to them (or
 *             company-wide) and a technician only their assignment's;
 *   alerts    MonitoringAdminService.alertWhere — the alerts list's own rule,
 *             called rather than copied so the two cannot drift;
 *   actions   a plan is shown only when EVERY computer it names is visible
 *             (as ActionsService.get requires), inside the caller's business;
 *   sessions  the sessions list's rule, narrowed further for anyone who is
 *             not an owner to sessions on computers they can see, or their own;
 *   activity  audit:view, inside the caller's business — the audit page's rule.
 * A section the caller has no capability for is null, never zero: zero would
 * be a claim.
 */
@Injectable()
export class DashboardOverviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly acl: AccessControlService,
    private readonly monitoring: MonitoringAdminService,
  ) {}

  private alertScope(actor: ActorContext, scope: string | null): Prisma.MonitorAlertWhereInput | null {
    try { return this.monitoring.alertWhere(actor, scope); } catch (e) {
      if (e instanceof ForbiddenException) return null;
      throw e;
    }
  }

  async overview(actor: ActorContext, businessId?: string) {
    // 403 for a business the caller may not address, before anything is read.
    const scope = this.acl.resolveScope(actor, businessId);
    const now = new Date();
    const bizWhere = scope ? { customerId: scope } : {};

    const canDevices = this.acl.can(actor, CAP.COMPUTERS_VIEW);
    const visible: Prisma.EndpointWhereInput | null = canDevices
      ? { AND: [this.acl.endpointVisibilityWhere(actor, scope), { status: 'ACTIVE' }] }
      : null;
    // alertWhere throws Forbidden for someone without monitoring:alerts: no section.
    const alertWhere = this.alertScope(actor, scope);
    const canSessions = this.acl.can(actor, CAP.SESSIONS_VIEW);
    const canAudit = this.acl.can(actor, CAP.AUDIT_VIEW);
    const owner = this.acl.isBusinessOwner(actor);

    // ── Devices, with their stored patch evidence ───────────────────────────
    // One query for the visible estate. The inventory columns are the ones the
    // Patches tab reads, so compliance here uses the same evidence and the
    // same staleness rule (STALE_AFTER_MS) as the device page.
    const endpoints = visible
      ? await this.prisma.endpoint.findMany({
          where: visible,
          select: {
            id: true, name: true, hostname: true, isOnline: true, lastSeenAt: true,
            customer: { select: { id: true, name: true } },
            inventory: { select: { patchPosture: true, patchScannedAt: true, pendingUpdates: true, rebootRequired: true, updatesCheckedAt: true, lastBootAt: true } },
          },
        })
      : [];
    const epById = new Map(endpoints.map((e) => [e.id, e]));
    const label = (e: { name: string; hostname: string | null }) => e.hostname || e.name;

    type Attention = { device: { id: string; name: string }; business: Biz | null; score: number; reasons: string[]; isOnline: boolean; lastSeenAt: string | null };
    const attention = new Map<string, Attention>();
    const flag = (id: string, score: number, reason: string) => {
      const e = epById.get(id);
      if (!e) return; // not a computer this person can see
      let a = attention.get(id);
      if (!a) { a = { device: { id, name: label(e) }, business: e.customer, score: 0, reasons: [], isOnline: e.isOnline, lastSeenAt: iso(e.lastSeenAt) }; attention.set(id, a); }
      a.score += score;
      a.reasons.push(reason);
    };

    const patch = { total: 0, fresh: 0, upToDate: 0, needsUpdates: 0, stale: 0, noScan: 0, newestScanAt: null as Date | null, oldestFreshScanAt: null as Date | null };
    const restart: { device: { id: string; name: string }; business: Biz | null; source: 'scan' | 'alert'; evidenceAt: string | null; stale: boolean }[] = [];
    const offlineByBiz = new Map<string, number>();
    let online = 0, agentSilent = 0;
    const offline: { id: string; name: string; business: Biz | null; lastSeenAt: string | null }[] = [];

    for (const e of endpoints) {
      if (e.isOnline) {
        online++;
        if (!e.lastSeenAt || now.getTime() - e.lastSeenAt.getTime() > AGENT_SILENT_MS) {
          agentSilent++;
          flag(e.id, 1, `Agent silent for ${e.lastSeenAt ? age(e.lastSeenAt, now) : 'ever'}: reachable, but nothing it reports is current`);
        }
      } else {
        offline.push({ id: e.id, name: label(e), business: e.customer, lastSeenAt: iso(e.lastSeenAt) });
        if (e.customer) offlineByBiz.set(e.customer.id, (offlineByBiz.get(e.customer.id) ?? 0) + 1);
        flag(e.id, 2, e.lastSeenAt ? `Offline, last seen ${age(e.lastSeenAt, now)} ago` : 'Offline, never checked in');
      }
      const inv = e.inventory;
      const parsed = Posture.safeParse(inv?.patchPosture);
      const s = buildPatchSummary({
        now, posture: parsed.success ? parsed.data : null, postureScannedAt: inv?.patchScannedAt ?? null,
        basic: inv ? { checkedAt: inv.updatesCheckedAt, rebootRequired: inv.rebootRequired, updates: Array.isArray(inv.pendingUpdates) ? (inv.pendingUpdates as { title: string; kb: string | null; severity: string | null }[]) : [] } : null,
        lastBootAt: inv?.lastBootAt ?? null, isOnline: e.isOnline, lastSeenAt: e.lastSeenAt, signedCapable: false, outcomes: [],
      });
      patch.total++;
      const at = s.evidence.at;
      if (s.evidence.freshness === 'none') patch.noScan++;
      else if (s.evidence.freshness === 'stale') patch.stale++;
      else {
        patch.fresh++;
        if (s.pendingCount === 0) patch.upToDate++; else patch.needsUpdates++;
        if (at && (!patch.oldestFreshScanAt || at < patch.oldestFreshScanAt)) patch.oldestFreshScanAt = at;
      }
      if (at && (!patch.newestScanAt || at > patch.newestScanAt)) patch.newestScanAt = at;
      if (s.rebootRequired) {
        const stale = s.evidence.freshness !== 'fresh';
        restart.push({ device: { id: e.id, name: label(e) }, business: e.customer, source: 'scan', evidenceAt: iso(at), stale });
        flag(e.id, 1, `Restart pending (update scan ${at ? `${age(at, now)} old` : 'of unknown age'}${stale ? ', stale' : ''})`);
      }
    }
    offline.sort((a, b) => (b.lastSeenAt ?? '').localeCompare(a.lastSeenAt ?? ''));

    // ── Alerts ──────────────────────────────────────────────────────────────
    const active: Prisma.MonitorAlertWhereInput | null = alertWhere ? { AND: [alertWhere, { state: { in: ['OPEN', 'ACKNOWLEDGED'] } }] } : null;
    const alertSelect = {
      id: true, kind: true, severity: true, state: true, title: true, firstSeenAt: true, lastSeenAt: true, occurrences: true,
      suppressed: true, acknowledgedAt: true, acknowledgedById: true, endpointId: true,
      endpoint: { select: { id: true, name: true, hostname: true } },
      site: { select: { id: true, name: true } },
      customer: { select: { id: true, name: true } },
    } as const;
    const [alertGroups, alertByBiz, alertByDevice, outages, openAlerts, acknowledged, rebootAlerts] = active
      ? await Promise.all([
          this.prisma.monitorAlert.groupBy({ by: ['state', 'severity', 'suppressed'], where: active, _count: true }),
          this.prisma.monitorAlert.groupBy({ by: ['customerId', 'severity'], where: { AND: [active, { suppressed: false }] }, _count: true }),
          this.prisma.monitorAlert.groupBy({ by: ['endpointId', 'severity'], where: { AND: [active, { suppressed: false }, { endpointId: { not: null } }] }, _count: true }),
          this.prisma.monitorAlert.findMany({ where: { AND: [active, { kind: 'SITE_OUTAGE' }] }, select: { ...alertSelect, _count: { select: { children: true } } }, orderBy: { firstSeenAt: 'asc' }, take: 20 }),
          this.prisma.monitorAlert.findMany({
            where: { AND: [alertWhere!, { state: 'OPEN', suppressed: false, parentId: null }, { kind: { not: 'SITE_OUTAGE' } }] },
            select: alertSelect, orderBy: { firstSeenAt: 'asc' }, take: 100,
          }),
          this.prisma.monitorAlert.findMany({ where: { AND: [alertWhere!, { state: 'ACKNOWLEDGED' }] }, select: alertSelect, orderBy: { acknowledgedAt: 'desc' }, take: 8 }),
          this.prisma.monitorAlert.findMany({ where: { AND: [active, { kind: 'REBOOT_PENDING' }] }, select: { endpointId: true, firstSeenAt: true } }),
        ])
      : [[], [], [], [], [], [], []];
    const sum = (f: (r: (typeof alertGroups)[number]) => boolean) => alertGroups.filter(f).reduce((n, r) => n + r._count, 0);
    const live = (r: (typeof alertGroups)[number]) => !r.suppressed;

    for (const g of alertByDevice) {
      if (!g.endpointId) continue;
      const w = g.severity === 'CRITICAL' ? 4 : g.severity === 'WARNING' ? 2 : 0;
      if (w) flag(g.endpointId, w * g._count, `${g._count} ${g.severity.toLowerCase()} alert${g._count === 1 ? '' : 's'}`);
    }
    const restartIds = new Set(restart.map((r) => r.device.id));
    const rebootAlertIds = new Set<string>();
    for (const r of rebootAlerts) {
      if (!r.endpointId) continue;
      rebootAlertIds.add(r.endpointId);
      const e = epById.get(r.endpointId);
      if (e && !restartIds.has(e.id)) {
        restart.push({ device: { id: e.id, name: label(e) }, business: e.customer, source: 'alert', evidenceAt: iso(r.firstSeenAt), stale: false });
        restartIds.add(e.id);
      }
    }

    // Users named as acknowledgers — only for alerts already in scope.
    const ackIds = [...new Set(acknowledged.map((a) => a.acknowledgedById).filter((x): x is string => !!x))];
    const ackUsers = new Map((ackIds.length ? await this.prisma.user.findMany({ where: { id: { in: ackIds } }, select: { id: true, firstName: true, lastName: true, email: true } }) : []).map((u) => [u.id, person(u)]));

    // ── Approved actions and patch deployments ──────────────────────────────
    // A plan is visible only if every computer it names is: the same rule
    // ActionsService.get applies, and stricter for a Business User, whose
    // visibility is their ComputerAccess grants.
    const jobVisible: Prisma.ActionJobWhereInput | null = visible
      ? { AND: [bizWhere, { targets: { some: {} } }, { targets: { every: { endpoint: visible } } }] }
      : null;
    const jobSelect = {
      id: true, actionId: true, actionVersion: true, status: true, reason: true, createdAt: true, notAfter: true, approvalsRequired: true,
      dispatchedAt: true, deploymentId: true, ring: true,
      customer: { select: { id: true, name: true } },
      endpoint: { select: { id: true, name: true, hostname: true } },
      _count: { select: { targets: true } },
    } as const;
    const [awaiting, inFlight, badTargets, deployments, rollFails] = await Promise.all([
      when(jobVisible, () => this.prisma.actionJob.findMany({ where: { AND: [jobVisible!, { status: 'AWAITING_APPROVAL', notAfter: { gt: now } }] }, select: jobSelect, orderBy: { createdAt: 'asc' }, take: 20 })),
      when(jobVisible, () => this.prisma.actionJob.findMany({ where: { AND: [jobVisible!, { status: { in: ['APPROVED', 'DISPATCHED'] } }] }, select: jobSelect, orderBy: { createdAt: 'desc' }, take: 10 })),
      when(jobVisible, () => this.prisma.actionTarget.findMany({
            where: {
              job: jobVisible!, reconciledAt: null,
              OR: [{ status: 'UNKNOWN' }, { status: { in: FAILED_TARGET }, updatedAt: { gte: new Date(now.getTime() - RECENT_MS) } }],
            },
            select: {
              id: true, status: true, statusReason: true, updatedAt: true, resultAt: true, endpointId: true,
              job: { select: { id: true, actionId: true, actionVersion: true, deploymentId: true, customer: { select: { id: true, name: true } } } },
            },
            orderBy: { updatedAt: 'asc' }, take: 50,
          })),
      when(visible, () => this.prisma.patchDeployment.findMany({ where: { ...bizWhere, status: { in: ['ACTIVE', 'PAUSED'] } }, select: { id: true, name: true, status: true, pausedReason: true, rings: true, createdAt: true, customer: { select: { id: true, name: true } } }, orderBy: { createdAt: 'desc' }, take: 20 })),
      // Client (RustDesk / agent) rollouts are a Platform Admin's: the
      // rollouts API is admin-only, so their failures are too.
      actor.isPlatformAdmin
        ? this.prisma.updateJob.findMany({ where: { ...bizWhere, status: 'FAILED', updatedAt: { gte: new Date(now.getTime() - RECENT_MS) } }, select: { rolloutId: true, updatedAt: true, rollout: { select: { name: true, status: true } } }, take: 200 })
        : null,
    ]);
    // A deployment's computers are in a JSON column, so its "every computer
    // visible" check happens here against the visible set.
    const visibleDeployments = deployments.filter((d) => (d.rings as unknown as { endpointIds: string[] }[]).every((r) => r.endpointIds.every((id) => epById.has(id))));
    for (const t of badTargets) flag(t.endpointId, 3, t.status === 'UNKNOWN' ? 'Action outcome unknown' : 'Action failed');

    // ── Sessions ────────────────────────────────────────────────────────────
    const seeOthers = owner || this.acl.can(actor, CAP.HISTORY_VIEW);
    const sessionWhere: Prisma.SupportSessionWhereInput | null = canSessions
      ? {
          AND: [
            bizWhere,
            seeOthers ? {} : { technicianId: actor.userId },
            // Not an owner: other people's sessions only on computers this person can see.
            owner ? {} : { OR: [{ technicianId: actor.userId }, ...(visible ? [{ endpoint: visible }] : [])] },
          ],
        }
      : null;
    const sessionSelect = {
      id: true, status: true, createdAt: true, lastSignalAt: true, connectionConfirmedAt: true, isAdHoc: true,
      technician: { select: { id: true, firstName: true, lastName: true, email: true } },
      endpoint: { select: { id: true, name: true, hostname: true } },
      customer: { select: { id: true, name: true } },
    } as const;
    const [liveSessions, mine, activity] = await Promise.all([
      when(sessionWhere, () => this.prisma.supportSession.findMany({ where: { AND: [sessionWhere!, { status: { in: LIVE_SESSION } }, { updatedAt: { gte: new Date(now.getTime() - SESSION_LIVE_MS) } }] }, select: { ...sessionSelect, updatedAt: true }, orderBy: { createdAt: 'desc' }, take: 10 })),
      // This person's own recent sessions: the devices they were last on.
      when(visible, () => this.prisma.supportSession.findMany({ where: { ...bizWhere, technicianId: actor.userId, endpoint: visible! }, select: { createdAt: true, status: true, endpointId: true }, orderBy: { createdAt: 'desc' }, take: 40 })),
      canAudit
        ? this.prisma.activityLog.findMany({
            where: { ...bizWhere, action: { in: RELEVANT_ACTIVITY }, createdAt: { gte: new Date(now.getTime() - RECENT_MS) } },
            select: { id: true, action: true, resource: true, resourceId: true, createdAt: true, customer: { select: { id: true, name: true } }, actor: { select: { firstName: true, lastName: true, email: true } } },
            orderBy: { createdAt: 'desc' }, take: 15,
          })
        : null,
    ]);
    const recentDevices: { id: string; name: string; business: Biz | null; isOnline: boolean; lastSeenAt: string | null; lastSessionAt: string }[] = [];
    for (const s of mine) {
      const e = s.endpointId ? epById.get(s.endpointId) : undefined;
      if (!e || recentDevices.some((d) => d.id === e.id)) continue;
      recentDevices.push({ id: e.id, name: label(e), business: e.customer, isOnline: e.isOnline, lastSeenAt: iso(e.lastSeenAt), lastSessionAt: s.createdAt.toISOString() });
      if (recentDevices.length >= 6) break;
    }

    // ── Customers affected ──────────────────────────────────────────────────
    type Affected = { business: Biz; critical: number; warning: number; outages: number; offline: number; failedActions: number };
    const affected = new Map<string, Affected>();
    const names = new Map<string, string>();
    for (const e of endpoints) if (e.customer) names.set(e.customer.id, e.customer.name);
    for (const o of outages) if (o.customer) names.set(o.customer.id, o.customer.name);
    const missing = [...new Set(alertByBiz.map((g) => g.customerId).filter((id): id is string => !!id && !names.has(id)))];
    if (missing.length) for (const c of await this.prisma.customer.findMany({ where: { id: { in: missing } }, select: { id: true, name: true } })) names.set(c.id, c.name);
    const bump = (id: string | null | undefined, k: keyof Omit<Affected, 'business'>, n = 1) => {
      if (!id) return;
      let a = affected.get(id);
      if (!a) { a = { business: { id, name: names.get(id) ?? 'Unknown business' }, critical: 0, warning: 0, outages: 0, offline: 0, failedActions: 0 }; affected.set(id, a); }
      a[k] += n;
    };
    for (const g of alertByBiz) {
      if (g.severity === 'CRITICAL') bump(g.customerId, 'critical', g._count);
      if (g.severity === 'WARNING') bump(g.customerId, 'warning', g._count);
    }
    for (const o of outages) bump(o.customer?.id, 'outages');
    for (const [id, n] of offlineByBiz) bump(id, 'offline', n);
    for (const t of badTargets) bump(t.job.customer.id, 'failedActions');
    const customers = [...affected.values()].sort((a, b) =>
      b.outages - a.outages || b.critical - a.critical || b.failedActions - a.failedActions || b.warning - a.warning || b.offline - a.offline || a.business.name.localeCompare(b.business.name));

    // ── Work on next ────────────────────────────────────────────────────────
    const items: QueueItem[] = [];
    const dev = (e: { id: string; name: string; hostname: string | null } | null) => (e ? { id: e.id, name: e.hostname || e.name } : null);
    for (const o of outages) {
      if (o.state !== 'OPEN' || o.suppressed) continue;
      items.push({
        key: `alert:${o.id}`, kind: 'site_outage', severity: 'critical', title: o.title,
        reason: `${o._count.children} device${o._count.children === 1 ? '' : 's'} at ${o.site?.name ?? 'one site'} stopped reporting together ${age(o.firstSeenAt, now)} ago: one site problem, so it comes first and its devices are not listed separately.`,
        business: o.customer, device: null, since: o.firstSeenAt.toISOString(), href: '/alerts',
      });
    }
    for (const a of openAlerts) {
      const sev = a.severity.toLowerCase() as 'critical' | 'warning' | 'info';
      items.push({
        key: `alert:${a.id}`, kind: 'alert', severity: sev, title: a.title,
        reason: `${a.severity === 'CRITICAL' ? 'Critical' : a.severity === 'WARNING' ? 'Warning' : 'Info'} alert, open ${age(a.firstSeenAt, now)} and not acknowledged${a.occurrences > 1 ? `; seen ${a.occurrences} times` : ''}.`,
        business: a.customer, device: dev(a.endpoint), since: a.firstSeenAt.toISOString(),
        href: a.endpoint ? `/endpoints/${a.endpoint.id}?tab=monitoring` : '/alerts',
      });
    }
    for (const t of badTargets) {
      const e = epById.get(t.endpointId);
      const what = actionTitle(t.job.actionId, t.job.actionVersion);
      const when = t.resultAt ?? t.updatedAt;
      items.push(t.status === 'UNKNOWN'
        ? {
            key: `target:${t.id}`, kind: 'action_uncertain', severity: 'warning', title: `${what}: outcome unknown`,
            reason: `The computer has not said whether it ran (${age(when, now)}). New requests for this action on it are blocked until someone records what they found.`,
            business: t.job.customer, device: e ? { id: e.id, name: label(e) } : null, since: when.toISOString(),
            href: `/endpoints/${t.endpointId}?tab=actions`,
          }
        : {
            key: `target:${t.id}`, kind: 'action_failed', severity: 'warning', title: `${what}: ${t.status === 'FAILED' ? 'failed' : t.status === 'REFUSED_BY_ENDPOINT' ? 'refused by the computer' : 'did not run'}`,
            reason: `Approved, sent, and not done ${age(when, now)} ago${t.statusReason ? `: ${clip(t.statusReason, 120)}` : ''}.`,
            business: t.job.customer, device: e ? { id: e.id, name: label(e) } : null, since: when.toISOString(),
            href: t.job.deploymentId ? `/patching/${t.job.deploymentId}` : `/endpoints/${t.endpointId}?tab=actions`,
          });
    }
    if (rollFails) {
      const byRollout = new Map<string, { name: string; status: string; n: number; since: Date }>();
      for (const j of rollFails) {
        const r = byRollout.get(j.rolloutId) ?? { name: j.rollout.name, status: j.rollout.status, n: 0, since: j.updatedAt };
        r.n++; if (j.updatedAt < r.since) r.since = j.updatedAt;
        byRollout.set(j.rolloutId, r);
      }
      for (const [id, r] of byRollout) {
        items.push({
          key: `rollout:${id}`, kind: 'rollout_failed', severity: 'warning', title: `Client rollout "${r.name}": ${r.n} failed`,
          reason: `${r.n} computer${r.n === 1 ? '' : 's'} failed to install the client update in the last 7 days${r.status === 'PAUSED' ? '; the rollout is paused' : ''}.`,
          business: null, device: null, since: r.since.toISOString(), href: `/admin/rollouts/${id}`,
        });
      }
    }
    for (const j of awaiting) {
      items.push({
        key: `job:${j.id}`, kind: 'approval_waiting', severity: 'info', title: `${actionTitle(j.actionId, j.actionVersion)}: waiting for approval`,
        reason: `Requested ${age(j.createdAt, now)} ago, needs ${j.approvalsRequired} approver${j.approvalsRequired === 1 ? '' : 's'} on the approval roster; expires in ${age(now, j.notAfter)}. Nothing runs until then.`,
        business: j.customer, device: j._count.targets === 1 ? dev(j.endpoint) : null, since: j.createdAt.toISOString(),
        href: j.deploymentId ? `/patching/${j.deploymentId}` : `/endpoints/${j.endpoint.id}?tab=actions`,
      });
    }
    for (const r of restart) {
      // A REBOOT_PENDING alert is already an item; stale evidence is not a reason to act.
      if (r.source !== 'scan' || r.stale || rebootAlertIds.has(r.device.id)) continue;
      items.push({
        key: `restart:${r.device.id}`, kind: 'restart_pending', severity: 'info', title: `${r.device.name}: restart pending`,
        reason: `The last update scan (${r.evidenceAt ? `${age(r.evidenceAt, now)} old` : 'age unknown'}) says Windows is waiting for a restart; updates do not finish until it happens.`,
        business: r.business, device: r.device, since: r.evidenceAt ?? now.toISOString(), href: `/endpoints/${r.device.id}?tab=patches`,
      });
    }
    const queue = rankQueue(items);

    const sessionView = (s: (typeof liveSessions)[number]) => ({
      id: s.id, status: s.status, connected: s.status === 'SESSION_STARTED', isAdHoc: s.isAdHoc,
      startedAt: s.createdAt.toISOString(), lastSignalAt: iso(s.lastSignalAt ?? s.updatedAt),
      technician: person(s.technician), device: dev(s.endpoint), business: s.customer,
    });
    const jobView = (j: (typeof inFlight)[number]) => ({
      id: j.id, title: actionTitle(j.actionId, j.actionVersion), status: j.status, targets: j._count.targets, createdAt: j.createdAt.toISOString(),
      dispatchedAt: iso(j.dispatchedAt), business: j.customer, device: j._count.targets === 1 ? dev(j.endpoint) : null,
      href: j.deploymentId ? `/patching/${j.deploymentId}` : `/endpoints/${j.endpoint.id}?tab=actions`,
    });

    return {
      generatedAt: now.toISOString(),
      scope: scope ? 'business' : 'platform',
      businessId: scope,
      devices: visible
        ? {
            total: endpoints.length, online, offline: endpoints.length - online, agentSilent,
            agentSilentAfterMinutes: AGENT_SILENT_MS / 60_000,
            offlineList: offline.slice(0, 8),
          }
        : null,
      alerts: active
        ? {
            open: sum((r) => r.state === 'OPEN'), acknowledged: sum((r) => r.state === 'ACKNOWLEDGED'),
            critical: sum((r) => live(r) && r.severity === 'CRITICAL'), warning: sum((r) => live(r) && r.severity === 'WARNING'), info: sum((r) => live(r) && r.severity === 'INFO'),
            criticalOpen: sum((r) => live(r) && r.severity === 'CRITICAL' && r.state === 'OPEN'),
            suppressed: sum((r) => r.suppressed),
            outages: outages.map((o) => ({ id: o.id, title: o.title, state: o.state, suppressed: o.suppressed, site: o.site, business: o.customer, devices: o._count.children, since: o.firstSeenAt.toISOString() })),
          }
        : null,
      restart: visible ? { devices: restart.length, list: restart.slice(0, 10) } : null,
      patch: visible
        ? {
            definition: `A device is up to date when its latest Windows Update scan is under ${STALE_AFTER_MS / 3_600_000} hours old and lists no pending updates. Compliance counts only devices with such a scan; coverage is how many devices have one.`,
            staleAfterHours: STALE_AFTER_MS / 3_600_000,
            ...patch,
            newestScanAt: iso(patch.newestScanAt), oldestFreshScanAt: iso(patch.oldestFreshScanAt),
            compliancePercent: patch.fresh ? Math.round((patch.upToDate / patch.fresh) * 100) : null,
            coveragePercent: patch.total ? Math.round((patch.fresh / patch.total) * 100) : null,
          }
        : null,
      actions: jobVisible
        ? {
            awaitingApproval: awaiting.length,
            failed: badTargets.filter((t) => t.status !== 'UNKNOWN').length,
            uncertain: badTargets.filter((t) => t.status === 'UNKNOWN').length,
            inFlight: inFlight.map(jobView),
          }
        : null,
      patchDeployments: visible
        ? visibleDeployments.map((d) => ({ id: d.id, name: d.name, status: d.status, pausedReason: clip(d.pausedReason), business: d.customer, createdAt: d.createdAt.toISOString() }))
        : null,
      sessions: sessionWhere ? { live: liveSessions.map(sessionView), liveAfterHours: SESSION_LIVE_MS / 3_600_000 } : null,
      acknowledged: active
        ? acknowledged.map((a) => ({
            id: a.id, title: a.title, severity: a.severity, business: a.customer, device: dev(a.endpoint),
            acknowledgedAt: iso(a.acknowledgedAt), by: a.acknowledgedById ? ackUsers.get(a.acknowledgedById) ?? null : null,
            href: a.endpoint ? `/endpoints/${a.endpoint.id}?tab=monitoring` : '/alerts',
          }))
        : null,
      customers,
      attention: [...attention.values()].sort((a, b) => b.score - a.score || a.device.name.localeCompare(b.device.name)).slice(0, 10),
      recentDevices: visible ? recentDevices : null,
      activity: activity
        ? activity.map((r) => ({
            id: r.id, action: r.action, label: ACTIVITY_LABEL[r.action] ?? r.action.toLowerCase().replace(/_/g, ' '),
            at: r.createdAt.toISOString(), actor: person(r.actor), business: r.customer,
            href: r.resource === 'endpoint' && r.resourceId ? `/endpoints/${r.resourceId}`
              : r.resource === 'monitor_alert' ? '/alerts'
                : r.resource === 'patch_deployment' && r.resourceId ? `/patching/${r.resourceId}`
                  : r.resource === 'session' || r.resource === 'support_session' ? '/sessions' : null,
          }))
        : null,
      queue: { items: queue.items, total: queue.total },
    };
  }
}
