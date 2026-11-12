import {
  BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus,
  Injectable, Logger, NotFoundException,
} from '@nestjs/common';
import { Prisma, type DiagnosticRun } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { ActorResolverService } from '../rbac/actor-resolver.service';
import type { Capability } from '../rbac/capabilities';
import { AbuseGuardService } from '../security-controls/abuse-guard.service';
import { AccessPolicyService } from '../security-controls/access-policy.service';
import { EndpointInventoryService } from '../endpoint-inventory/endpoint-inventory.service';
import { MonitoringService } from '../monitoring/monitoring.service';
import {
  CATALOG, MAX_AGENT_RESULT_CHARS, MAX_RUNS_PER_DEVICE, MAX_RUNS_PER_USER, PICKUP_TTL_MINUTES,
  RATE_WINDOW_MINUTES, RUNS_PER_HEARTBEAT, RUN_TTL_MINUTES, START_TTL_MINUTES,
  SNAPSHOT_KEYS, capResult, catalogEntry, isCatalogKey, isSnapshotKey, publicCatalog, resultCapFor, sanitizeResult,
  type CatalogEntry, type SnapshotKey,
} from './catalog';
import {
  Pacer, WATCH_WINDOW_MS, automaticState, dueKeys, ineligible, isWindows, parseScheduleUpdate, perMinuteFrom,
  scheduleFrom, sweepEnabled, type KeyHistory, type SnapshotSchedule,
} from './snapshot-schedule';

const OPEN = ['REQUESTED', 'DELIVERED', 'RUNNING'] as const;
const DONE = ['COMPLETED', 'FAILED', 'EXPIRED'] as const;
const minutes = (n: number) => n * 60_000;
const SCHEDULE_CACHE_MS = 30_000;
const SCHEDULE_SELECT = {
  snapshotAutoEnabled: true, snapshotProcessMinutes: true, snapshotServiceMinutes: true, snapshotNetworkMinutes: true, snapshotWatchMinutes: true,
} as const;

/**
 * One-click read-only diagnostics: request, deliver on the authenticated
 * heartbeat, record the result. See catalog.ts for why the catalog is closed.
 *
 * Lifecycle: REQUESTED → DELIVERED (handed out on a heartbeat) → RUNNING (the
 * agent said it started) → COMPLETED | FAILED, or EXPIRED at any open step,
 * with `error` saying which step stalled and what that usually means.
 */
@Injectable()
export class DiagnosticsCatalogService {
  private readonly logger = new Logger(DiagnosticsCatalogService.name);
  /** SNAPSHOT_SWEEP=off: this process asks for nothing automatically (Refresh still works). */
  private readonly autoEnabled = sweepEnabled(process.env);
  private readonly pacer = new Pacer(perMinuteFrom(process.env));
  private scheduleCache: { at: number; value: SnapshotSchedule } | null = null;
  /**
   * `${endpointId}:${key}` → when someone last read that snapshot. A read
   * within WATCH_WINDOW_MS means the tab is open, and the key gets the
   * watched cadence. In memory, because the API runs as one process
   * (docs/server-sizing.md); a restart only forgets who was looking.
   */
  private readonly watched = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly acl: AccessControlService,
    private readonly actors: ActorResolverService,
    private readonly abuse: AbuseGuardService,
    private readonly policy: AccessPolicyService,
    private readonly inventory: EndpointInventoryService,
    private readonly monitoring: MonitoringService,
  ) {}

  private can(actor: ActorContext, cap: Capability) {
    return actor.isPlatformAdmin || actor.capabilities.includes(cap);
  }

  /**
   * Business scope, then the device-list visibility rule (0.33): a Business
   * User sees only the computers granted to them or COMPANY_WIDE ones, so a
   * computer they cannot see in the list is a missing one here too — for
   * requesting, for the history and for snapshots. Before 0.33 only business
   * scope was checked, and a run requested that way failed at delivery.
   */
  private async assertVisible(actor: ActorContext, endpointId: string, cap: Capability) {
    const endpoint = await this.acl.assertEndpointInScope(actor, endpointId, cap);
    const visible = await this.prisma.endpoint.count({ where: { AND: [this.acl.endpointVisibilityWhere(actor), { id: endpointId }] } });
    if (!visible) throw new NotFoundException('Computer not found');
    return endpoint;
  }

  // ── Console side ──────────────────────────────────────────────────────────

  /** The catalog for one computer, with what this person may run on it. */
  async catalogFor(actor: ActorContext, endpointId: string) {
    await this.assertVisible(actor, endpointId, 'computers:view');
    this.acl.assertCapability(actor, 'computers:view');
    const [ep, node] = await Promise.all([
      this.prisma.endpoint.findUnique({ where: { id: endpointId }, select: { platform: true, isOnline: true, lastSeenAt: true } }),
      this.prisma.rustdeskNode.findUnique({ where: { endpointId }, select: { agentSecretHash: true } }),
    ]);
    const supported = isWindows(ep?.platform);
    return {
      supported,
      agentBound: !!node?.agentSecretHash,
      isOnline: !!ep?.isOnline,
      lastSeenAt: ep?.lastSeenAt ?? null,
      items: publicCatalog().map((e) => ({ ...e, allowed: this.can(actor, e.capability as Capability) })),
    };
  }

  /**
   * Ask a computer to run one catalog diagnostic. The body is a key and
   * nothing else; an unknown key is refused before anything is written.
   */
  async request(actor: ActorContext, endpointId: string, key: unknown) {
    if (!isCatalogKey(key)) {
      throw new BadRequestException({ code: 'UNKNOWN_DIAGNOSTIC', message: `Not a catalog diagnostic. Known: ${CATALOG.map((e) => e.key).join(', ')}` });
    }
    const entry = catalogEntry(key)!;
    const cap = entry.capability as Capability;
    const endpoint = await this.assertVisible(actor, endpointId, cap);
    this.acl.assertCapability(actor, cap);
    if (endpoint.status === 'ARCHIVED') throw new BadRequestException({ code: 'ENDPOINT_ARCHIVED', message: 'This computer is archived.' });

    const [ep, node] = await Promise.all([
      this.prisma.endpoint.findUnique({ where: { id: endpointId }, select: { platform: true } }),
      this.prisma.rustdeskNode.findUnique({ where: { endpointId }, select: { agentSecretHash: true } }),
    ]);
    if (!isWindows(ep?.platform)) {
      throw new BadRequestException({ code: 'DIAGNOSTIC_OS_UNSUPPORTED', message: `${entry.label} runs on Windows computers with the standard agent.` });
    }
    // The heartbeat only hands work to a machine that proved it is the device;
    // staging for one that never has would look like it worked and do nothing.
    if (!node?.agentSecretHash) {
      throw new ConflictException({ code: 'AGENT_NOT_BOUND', message: 'This computer has never authenticated with a device secret, so it cannot be asked to run anything. Re-run the installer on it once.' });
    }

    // One open run of a key per computer: a second click returns the first.
    const existing = await this.prisma.diagnosticRun.findFirst({ where: { endpointId, key, status: { in: [...OPEN] } }, orderBy: { requestedAt: 'desc' } });
    if (existing && existing.expiresAt > new Date()) return { run: await this.present(actor, existing), deduplicated: true };

    const since = new Date(Date.now() - minutes(RATE_WINDOW_MINUTES));
    const [perDevice, perUser] = await Promise.all([
      // People's requests only: automatic snapshots (0.35) must not use up a technician's Refresh.
      this.prisma.diagnosticRun.count({ where: { endpointId, requestedById: { not: null }, requestedAt: { gte: since } } }),
      this.prisma.diagnosticRun.count({ where: { requestedById: actor.userId, requestedAt: { gte: since } } }),
    ]);
    if (perDevice >= MAX_RUNS_PER_DEVICE || perUser >= MAX_RUNS_PER_USER) {
      throw new HttpException({
        code: 'DIAGNOSTIC_RATE_LIMITED',
        message: perDevice >= MAX_RUNS_PER_DEVICE
          ? `This computer has had ${perDevice} diagnostics in the last ${RATE_WINDOW_MINUTES} minutes; wait a few minutes.`
          : `You have run ${perUser} diagnostics in the last ${RATE_WINDOW_MINUTES} minutes; wait a few minutes.`,
      }, HttpStatus.TOO_MANY_REQUESTS);
    }

    // The fleet abuse guard and identity pauses, as for an event-log fetch:
    // read-only evidence, counted against devices and businesses, not writes.
    const admit = await this.abuse.admit({
      identity: `user:${actor.userId}`, tier: this.policy.tierFor(actor, endpointId), kind: 'EVIDENCE',
      endpointId, customerId: endpoint.customerId, entryPoint: 'ui',
    });
    if (!admit.ok) throw new ForbiddenException({ code: admit.reason.toUpperCase(), message: admit.message });

    const run = await this.prisma.diagnosticRun.create({
      data: {
        endpointId, tenantId: endpoint.tenantId, customerId: endpoint.customerId, key,
        requestedById: actor.userId, expiresAt: new Date(Date.now() + minutes(PICKUP_TTL_MINUTES)),
      },
    });
    await this.audit.log({
      tenantId: endpoint.tenantId ?? undefined, customerId: endpoint.customerId ?? undefined,
      actorId: actor.userId, actorIp: actor.ip,
      action: 'ENDPOINT_DIAGNOSTIC_REQUESTED', resource: 'endpoint', resourceId: endpointId,
      meta: { runId: run.id, key, capability: cap, risk: entry.risk },
    });
    return { run: await this.present(actor, run), deduplicated: false };
  }

  /**
   * Recent runs, newest first. Results only where the reader holds the key's
   * capability. A snapshot key's result (up to 128 KB) is left out here —
   * `resultOnTab` says where it is — so the history stays small.
   */
  async history(actor: ActorContext, endpointId: string, limit = 20) {
    await this.assertVisible(actor, endpointId, 'computers:view');
    this.acl.assertCapability(actor, 'computers:view');
    await this.expire({ endpointId });
    const rows = await this.prisma.diagnosticRun.findMany({ where: { endpointId }, orderBy: { requestedAt: 'desc' }, take: Math.min(Math.max(limit, 1), 50) });
    return (await this.presentMany(actor, rows)).map((r) => (isSnapshotKey(r.key) ? { ...r, result: null, resultOnTab: true } : r));
  }

  /**
   * The workspace snapshot for one snapshot key (0.33): the newest completed
   * result, and whatever happened since — a run still open (the Refresh in
   * flight) or the newest one that failed or expired after it. Reading a
   * snapshot reads what is stored; only a POST to runs asks the computer.
   */
  async snapshot(actor: ActorContext, endpointId: string, key: unknown) {
    if (!isSnapshotKey(key)) {
      throw new BadRequestException({ code: 'UNKNOWN_SNAPSHOT', message: 'Not a snapshot. Known: process_list, service_list, network_adapters' });
    }
    const entry = catalogEntry(key)!;
    const cap = entry.capability as Capability;
    await this.assertVisible(actor, endpointId, cap);
    this.acl.assertCapability(actor, cap);
    await this.expire({ endpointId });
    // Reading the tab is what "watched" means (0.35): only after the
    // visibility and capability checks above, so nobody can make a computer
    // they cannot see collect anything.
    this.markWatched(endpointId, key);
    const [ep, node, latest, newest, schedule, history] = await Promise.all([
      this.prisma.endpoint.findUnique({ where: { id: endpointId }, select: { platform: true, isOnline: true, lastSeenAt: true, status: true, agentVersion: true } }),
      this.prisma.rustdeskNode.findUnique({ where: { endpointId }, select: { agentSecretHash: true } }),
      this.prisma.diagnosticRun.findFirst({ where: { endpointId, key, status: 'COMPLETED' }, orderBy: { completedAt: 'desc' } }),
      this.prisma.diagnosticRun.findFirst({ where: { endpointId, key }, orderBy: { requestedAt: 'desc' } }),
      this.schedule(),
      this.keyHistory(endpointId),
    ]);
    const now = Date.now();
    const computer = { status: ep?.status, platform: ep?.platform, agentBound: !!node?.agentSecretHash, agentVersion: ep?.agentVersion, lastSeenAt: ep?.lastSeenAt };
    const automatic = automaticState({ schedule, processEnabled: this.autoEnabled, key, computer, history: history[key], watched: this.isWatched(endpointId, key, now), now });
    const since = newest && (!latest || newest.id !== latest.id) && newest.requestedAt > (latest?.requestedAt ?? new Date(0)) ? newest : null;
    const [shownLatest, shownSince] = await Promise.all([
      latest ? this.present(actor, latest) : null,
      since ? this.present(actor, since) : null,
    ]);
    return {
      key, label: entry.label, tab: entry.tab,
      supported: isWindows(ep?.platform), agentBound: !!node?.agentSecretHash,
      isOnline: !!ep?.isOnline, lastSeenAt: ep?.lastSeenAt ?? null,
      agentVersion: ep?.agentVersion ?? null,
      // 0.35: whether the agent itself is checking in. isOnline can be true
      // through RustDesk alone (0.34), and then nothing will be collected.
      agentSilent: ineligible(computer, now) === 'agent_silent',
      automatic,
      // takenAt is when the computer reported it, which is when it was read.
      takenAt: latest?.completedAt ?? null,
      latest: shownLatest,
      pending: shownSince && OPEN.includes(shownSince.status as (typeof OPEN)[number]) ? shownSince : null,
      lastFailure: shownSince && !OPEN.includes(shownSince.status as (typeof OPEN)[number]) ? shownSince : null,
    };
  }

  async getRun(actor: ActorContext, endpointId: string, runId: string) {
    await this.assertVisible(actor, endpointId, 'computers:view');
    this.acl.assertCapability(actor, 'computers:view');
    await this.expire({ endpointId });
    const run = await this.prisma.diagnosticRun.findFirst({ where: { id: runId, endpointId } });
    if (!run) throw new NotFoundException('Diagnostic run not found');
    return this.present(actor, run);
  }

  private async presentMany(actor: ActorContext, rows: DiagnosticRun[]) {
    const ids = [...new Set(rows.map((r) => r.requestedById).filter((x): x is string => !!x))];
    const users = ids.length ? await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, firstName: true, lastName: true, email: true } }) : [];
    const byId = new Map(users.map((u) => [u.id, u]));
    return rows.map((r) => this.shape(actor, r, r.requestedById ? byId.get(r.requestedById) : undefined));
  }
  private async present(actor: ActorContext, row: DiagnosticRun) {
    return (await this.presentMany(actor, [row]))[0];
  }
  private shape(actor: ActorContext, r: DiagnosticRun, u?: { firstName: string | null; lastName: string | null; email: string }) {
    // A run with no requester is an automatic snapshot (0.35): the server asked.
    const entry = catalogEntry(r.key);
    const readable = !!entry && this.can(actor, entry.capability as Capability);
    return {
      id: r.id, key: r.key, label: entry?.label ?? r.key, status: r.status,
      requestedAt: r.requestedAt, deliveredAt: r.deliveredAt, startedAt: r.startedAt, completedAt: r.completedAt, expiresAt: r.expiresAt,
      automatic: r.requestedById === null,
      requestedBy: { id: r.requestedById, name: u ? ([u.firstName, u.lastName].filter(Boolean).join(' ') || u.email) : null },
      error: r.error, truncated: r.truncated, resultBytes: r.resultBytes,
      // A recent_system_errors result is event-log text: someone who can see
      // the computer but not read its logs sees that it ran, not what it said.
      result: readable ? r.result : null,
      resultWithheld: !readable && r.result !== null,
    };
  }

  // ── Expiry ────────────────────────────────────────────────────────────────

  /**
   * Close out runs that stalled, saying where. Audited one by one, so an
   * expiry is as visible afterwards as a completion.
   */
  async expire(where: { endpointId?: string } = {}) {
    const now = Date.now();
    const open = await this.prisma.diagnosticRun.findMany({ where: { ...where, status: { in: [...OPEN] } } });
    for (const r of open) {
      const entry = catalogEntry(r.key);
      let why: string | null = null;
      if (r.status === 'REQUESTED' && r.expiresAt.getTime() < now) {
        why = `Not picked up: the computer did not check in within ${PICKUP_TTL_MINUTES} minutes of the request. It is probably offline, asleep, or its heartbeat task is not running.`;
      } else if (r.status === 'DELIVERED' && r.deliveredAt && now - r.deliveredAt.getTime() > minutes(START_TTL_MINUTES)) {
        why = `Delivered to the computer but never started. Its agent probably predates the diagnostics catalog (0.31) — reinstall the agent from the Specs tab.`;
      } else if (r.status === 'RUNNING' && r.startedAt && entry && now - r.startedAt.getTime() > minutes(RUN_TTL_MINUTES[entry.duration])) {
        why = `Started, but no result arrived within ${RUN_TTL_MINUTES[entry.duration]} minutes. The computer may have gone offline mid-run.`;
      }
      if (!why) continue;
      const n = await this.prisma.diagnosticRun.updateMany({ where: { id: r.id, status: r.status }, data: { status: 'EXPIRED', error: why, completedAt: new Date() } });
      if (n.count) await this.auditDone(r, 'expired', { reason: why.split(':')[0] });
    }
  }

  private async auditDone(r: DiagnosticRun, outcome: 'completed' | 'failed' | 'expired', extra: Record<string, unknown> = {}) {
    // An automatic snapshot (0.35) is not audited run by run: at 5,000
    // computers that would be tens of thousands of audit entries a day for
    // housekeeping nobody asked for, in a log that can never be pruned. Its
    // record is the run itself (requestedById null, shown as "Automatic"),
    // and the schedule that caused it is audited when it changes.
    if (r.requestedById === null) return;
    await this.audit.log({
      tenantId: r.tenantId ?? undefined, customerId: r.customerId ?? undefined,
      action: 'ENDPOINT_DIAGNOSTIC_COMPLETED', resource: 'endpoint', resourceId: r.endpointId,
      meta: { runId: r.id, key: r.key, outcome, requestedById: r.requestedById, ...extra },
    });
  }

  // ── Automatic snapshots (0.35) ────────────────────────────────────────────

  /** The platform-wide schedule, cached for 30 s (it is read on every heartbeat). */
  async schedule(fresh = false): Promise<SnapshotSchedule> {
    if (!fresh && this.scheduleCache && Date.now() - this.scheduleCache.at < SCHEDULE_CACHE_MS) return this.scheduleCache.value;
    const row = await this.prisma.platformSettings.findUnique({ where: { id: 'singleton' }, select: SCHEDULE_SELECT });
    const value = scheduleFrom(row);
    this.scheduleCache = { at: Date.now(), value };
    return value;
  }

  private markWatched(endpointId: string, key: SnapshotKey) {
    const now = Date.now();
    this.watched.set(`${endpointId}:${key}`, now);
    // Bounded: forget anyone who stopped looking, once the map grows.
    if (this.watched.size > 5_000) for (const [k, at] of this.watched) if (now - at > WATCH_WINDOW_MS) this.watched.delete(k);
  }
  private isWatched(endpointId: string, key: SnapshotKey, now = Date.now()) {
    const at = this.watched.get(`${endpointId}:${key}`);
    return at !== undefined && now - at <= WATCH_WINDOW_MS;
  }

  /** Per snapshot key on one computer: the newest completion, the newest automatic attempt, and whether one is open. One query. */
  private async keyHistory(endpointId: string): Promise<Record<SnapshotKey, KeyHistory>> {
    const rows = await this.prisma.$queryRaw<{ key: string; last_ok: Date | null; last_auto: Date | null; last_auto_status: string | null; open: boolean }[]>`
      SELECT r."key",
        max(r."completedAt") FILTER (WHERE r."status" = 'COMPLETED') AS last_ok,
        max(r."requestedAt") FILTER (WHERE r."requestedById" IS NULL) AS last_auto,
        (array_agg(r."status"::text ORDER BY r."requestedAt" DESC) FILTER (WHERE r."requestedById" IS NULL))[1] AS last_auto_status,
        bool_or(r."status" IN ('REQUESTED', 'DELIVERED', 'RUNNING')) AS open
      FROM "DiagnosticRun" r
      WHERE r."endpointId" = ${endpointId} AND r."key" IN ('process_list', 'service_list', 'network_adapters')
      GROUP BY r."key"`;
    const out = {} as Record<SnapshotKey, KeyHistory>;
    for (const k of SNAPSHOT_KEYS) {
      const r = rows.find((x) => x.key === k);
      out[k] = {
        lastCompletedAt: r?.last_ok ?? null, lastAutoRequestedAt: r?.last_auto ?? null,
        lastAutoFailed: r?.last_auto_status === 'FAILED' || r?.last_auto_status === 'EXPIRED', open: !!r?.open,
      };
    }
    return out;
  }

  /**
   * Stage the snapshot keys this computer is due for, on the heartbeat that
   * found them stale. Called only from forHeartbeat, which only an
   * authenticated heartbeat reaches. Writes no audit entry (see auditDone).
   */
  private async scheduleAutomatic(endpointId: string) {
    if (!this.autoEnabled) return;
    const schedule = await this.schedule();
    if (!schedule.enabled) return;
    const [ep, node] = await Promise.all([
      this.prisma.endpoint.findUnique({ where: { id: endpointId }, select: { status: true, platform: true, agentVersion: true, lastSeenAt: true, tenantId: true, customerId: true } }),
      this.prisma.rustdeskNode.findUnique({ where: { endpointId }, select: { agentSecretHash: true } }),
    ]);
    const now = Date.now();
    if (!ep || ineligible({ ...ep, agentBound: !!node?.agentSecretHash }, now)) return;
    const due = dueKeys(schedule, now, await this.keyHistory(endpointId), (k) => this.isWatched(endpointId, k, now));
    for (const d of due) {
      // Someone is looking: not held back. Otherwise the fleet-wide pacer decides.
      if (d.basis !== 'watch' && !this.pacer.take(now)) continue;
      await this.pruneAutomatic(endpointId, d.key, null);
      try {
        await this.prisma.diagnosticRun.create({
          data: {
            endpointId, tenantId: ep.tenantId, customerId: ep.customerId, key: d.key,
            requestedById: null, expiresAt: new Date(now + minutes(PICKUP_TTL_MINUTES)),
          },
        });
      } catch (e) {
        // The partial unique index: another heartbeat staged it first.
        if ((e as { code?: string })?.code !== 'P2002') throw e;
      }
    }
  }

  /**
   * Automatic runs are housekeeping: only the newest completed one of a key
   * is worth keeping (older ones would pile up at 5,000 computers × 4 a day
   * of up to 128 KB). Removes this computer's finished automatic runs of
   * `key` other than the newest completed one (or `keep`). People's runs are
   * never touched here; they age out under the retention sweep (0.34), which
   * covers automatic runs too.
   */
  private async pruneAutomatic(endpointId: string, key: SnapshotKey, keep: string | null) {
    const newest = keep ?? (await this.prisma.diagnosticRun.findFirst({
      where: { endpointId, key, requestedById: null, status: 'COMPLETED' }, orderBy: { completedAt: 'desc' }, select: { id: true },
    }))?.id;
    await this.prisma.diagnosticRun.deleteMany({
      where: { endpointId, key, requestedById: null, status: { in: [...DONE] }, ...(newest ? { id: { not: newest } } : {}) },
    });
  }

  /** Settings → Monitoring & API → Automatic snapshots. Platform Admin only (the schedule is platform-wide). */
  async getSchedule(actor: ActorContext) {
    this.acl.assertPlatformAdmin(actor);
    return { ...(await this.schedule(true)), processEnabled: this.autoEnabled, perMinute: perMinuteFrom(process.env) };
  }

  async updateSchedule(actor: ActorContext, body: unknown) {
    this.acl.assertPlatformAdmin(actor);
    const parsed = parseScheduleUpdate(body);
    if (!parsed.ok) throw new BadRequestException({ code: 'INVALID_SNAPSHOT_SCHEDULE', message: parsed.error });
    const before = await this.schedule(true);
    await this.prisma.platformSettings.upsert({ where: { id: 'singleton' }, create: { id: 'singleton', ...parsed.data }, update: parsed.data });
    this.scheduleCache = null;
    const after = await this.schedule(true);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      await this.audit.log({
        actorId: actor.userId, actorIp: actor.ip,
        action: 'SNAPSHOT_SCHEDULE_CHANGED', resource: 'platform_settings', resourceId: 'singleton',
        meta: { before, after },
      });
    }
    return { ...after, processEnabled: this.autoEnabled, perMinute: perMinuteFrom(process.env) };
  }

  // ── Agent side ────────────────────────────────────────────────────────────

  /**
   * Runs due for this computer, decided at heartbeat time. Called only for a
   * heartbeat that authenticated with the device secret. Returns ids and
   * keys — never parameters — and re-authorizes each requester first.
   */
  async forHeartbeat(endpointId: string): Promise<{ id: string; key: string }[]> {
    await this.expire({ endpointId });
    try {
      await this.scheduleAutomatic(endpointId);
    } catch (e) {
      // Never cost the computer the runs a person asked for.
      this.logger.warn(`Automatic snapshots for ${endpointId}: ${String(e)}`);
    }
    const due = await this.prisma.diagnosticRun.findMany({
      where: { endpointId, status: 'REQUESTED' },
      // A person's request before an automatic snapshot (requestedById null
      // last — Postgres sorts NULLs first on DESC, hence `nulls`), oldest
      // first within each, so neither starves.
      orderBy: [{ requestedById: { sort: 'desc', nulls: 'last' } }, { requestedAt: 'asc' }], take: RUNS_PER_HEARTBEAT,
    });
    if (!due.length) return [];
    const ep = await this.prisma.endpoint.findUnique({ where: { id: endpointId }, select: { id: true, customerId: true, accessMode: true, tenantId: true } });
    const out: { id: string; key: string }[] = [];
    for (const r of due) {
      const entry = catalogEntry(r.key);
      // An automatic run has no requester to re-check; it was decided on this
      // heartbeat, from this computer's own state, for a snapshot key only.
      const why = !entry ? 'unknown_key' : !ep ? 'endpoint_missing' : r.requestedById === null ? (isSnapshotKey(r.key) ? null : 'not_a_snapshot') : await this.requesterStillAllowed(r, entry, ep);
      if (why) {
        const n = await this.prisma.diagnosticRun.updateMany({ where: { id: r.id, status: 'REQUESTED' }, data: { status: 'FAILED', error: `Not delivered: the person who requested this is no longer allowed to (${why}).`, completedAt: new Date() } });
        if (n.count) await this.auditDone(r, 'failed', { reason: why });
        continue;
      }
      const n = await this.prisma.diagnosticRun.updateMany({ where: { id: r.id, status: 'REQUESTED' }, data: { status: 'DELIVERED', deliveredAt: new Date(), dispatchCount: { increment: 1 } } });
      if (n.count) out.push({ id: r.id, key: r.key });
    }
    return out;
  }

  /** A run can wait up to its pickup window; the requester may have lost access since. */
  private async requesterStillAllowed(r: DiagnosticRun, entry: CatalogEntry, ep: { id: string; customerId: string | null; accessMode: string; tenantId: string | null }): Promise<string | null> {
    if (!r.requestedById) return 'no_requester';
    if (await this.abuse.isPaused(`user:${r.requestedById}`)) return 'requester_paused';
    const tenantId = r.tenantId ?? ep.tenantId;
    if (!tenantId) return 'no_tenant';
    const actor = await this.actors.contextFor(r.requestedById, tenantId, ep.customerId);
    if (!actor) return 'requester_inactive';
    if (!actor.isPlatformAdmin && actor.businessId !== ep.customerId) return 'requester_out_of_business';
    const cap = entry.capability as Capability;
    if (!actor.technician && !this.can(actor, cap)) return 'requester_lost_capability';
    return (await this.acl.canReachEndpoint(actor, ep as never, undefined, cap)) ? null : 'requester_lost_access';
  }

  /**
   * The agent reporting on a run it was handed. Scoped by endpoint as well
   * as run id, and the key must match the run's: a machine cannot write into
   * another machine's run, or file one diagnostic's output under another.
   */
  async report(endpointId: string, dto: { runId: string; key: string; state: string; result?: unknown; error?: string }) {
    if (!isCatalogKey(dto.key)) return { accepted: false, reason: 'unknown_key' };
    const run = await this.prisma.diagnosticRun.findFirst({ where: { id: dto.runId, endpointId } });
    if (!run) return { accepted: false, reason: 'unknown_run' };
    if (run.key !== dto.key) return { accepted: false, reason: 'key_mismatch' };
    const entry = catalogEntry(run.key)!;

    if (dto.state === 'running') {
      const n = await this.prisma.diagnosticRun.updateMany({ where: { id: run.id, status: 'DELIVERED' }, data: { status: 'RUNNING', startedAt: new Date() } });
      return n.count ? { accepted: true } : { accepted: false, reason: `not_delivered (${run.status})` };
    }
    if (dto.state !== 'completed' && dto.state !== 'failed') return { accepted: false, reason: 'unknown_state' };
    if (run.status !== 'DELIVERED' && run.status !== 'RUNNING') return { accepted: false, reason: `already_${run.status.toLowerCase()}` };

    if (dto.state === 'failed') {
      const error = (typeof dto.error === 'string' && dto.error.trim() ? dto.error : 'The agent reported a failure with no detail.').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 500); // eslint-disable-line no-control-regex
      const n = await this.prisma.diagnosticRun.updateMany({ where: { id: run.id, status: run.status }, data: { status: 'FAILED', error, completedAt: new Date(), startedAt: run.startedAt ?? new Date() } });
      if (n.count) await this.auditDone(run, 'failed');
      return { accepted: !!n.count };
    }

    let raw = dto.result;
    if (raw !== undefined && JSON.stringify(raw).length > MAX_AGENT_RESULT_CHARS) raw = undefined;
    const shaped = await this.shapeAgentResult(endpointId, run.key, raw);
    if (!shaped) {
      const n = await this.prisma.diagnosticRun.updateMany({ where: { id: run.id, status: run.status }, data: { status: 'FAILED', error: 'The result was missing, malformed or too large and was not stored.', completedAt: new Date() } });
      if (n.count) await this.auditDone(run, 'failed', { reason: 'bad_result' });
      return { accepted: !!n.count };
    }
    const capped = capResult(shaped, resultCapFor(run.key));
    const n = await this.prisma.diagnosticRun.updateMany({
      where: { id: run.id, status: run.status },
      data: {
        status: 'COMPLETED', result: capped.result as Prisma.InputJsonValue, resultBytes: capped.bytes, truncated: capped.truncated,
        error: null, completedAt: new Date(), startedAt: run.startedAt ?? new Date(),
      },
    });
    if (n.count) await this.auditDone(run, 'completed', { resultBytes: capped.bytes, truncated: capped.truncated, duration: entry.duration });
    if (n.count && run.requestedById === null && isSnapshotKey(run.key)) await this.pruneAutomatic(endpointId, run.key, run.id);
    return { accepted: !!n.count };
  }

  /**
   * refresh_inventory and pending_updates reuse the existing collections:
   * the agent sends what INVENTORY_REFRESH / UPDATE_SCAN send, it is stored
   * through the inventory service exactly as those are, and the run keeps a
   * summary. service_health keeps only the monitored services this server
   * asked about, as the monitor report does.
   */
  private async shapeAgentResult(endpointId: string, key: string, raw: unknown): Promise<Record<string, unknown> | null> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    if (key === 'refresh_inventory') {
      const inv = r.inventory;
      if (!inv || typeof inv !== 'object') return null;
      await this.inventory.recordInventory(endpointId, inv);
      const i = inv as Record<string, unknown>;
      return sanitizeResult(key, {
        collected: true, osCaption: i.osCaption, osBuild: i.osBuild,
        disks: Array.isArray(i.disks) ? i.disks.length : 0, networks: Array.isArray(i.networks) ? i.networks.length : 0, software: Array.isArray(i.software) ? i.software.length : 0,
      });
    }
    if (key === 'pending_updates') {
      const upd = r.updates;
      if (!upd || typeof upd !== 'object') return null;
      await this.inventory.recordUpdateScan(endpointId, upd);
      const u = upd as Record<string, unknown>;
      return sanitizeResult(key, { pending: u.pending, rebootRequired: u.rebootRequired, count: Array.isArray(u.pending) ? u.pending.length : 0 });
    }
    const out = sanitizeResult(key, r);
    if (out && key === 'service_health') {
      let wanted: string[] = [];
      try { wanted = ((await this.monitoring.heartbeatConfig(endpointId))?.services ?? []).map((s) => String(s).toLowerCase()); } catch (e) { this.logger.warn(`monitor config for ${endpointId}: ${String(e)}`); }
      out.monitored = (out.monitored as { name: string }[]).filter((s) => wanted.includes(s.name.toLowerCase()));
    }
    return out;
  }
}
