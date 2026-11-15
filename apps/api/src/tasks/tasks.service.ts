import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';
import { ContainmentService } from '../containment/containment.service';
import { ActionsService } from '../actions/actions.service';
import { catalogEntry as actionEntry } from '../actions/catalog';
import { catalogEntry as diagnosticEntry, isSnapshotKey } from '../diagnostics-catalog/catalog';
import { migrationState } from '../update-trust/agent-migration';
import {
  POLL_FAST_MS, POLL_SLOW_MS, STATE_FILTERS, TASK_TYPES, actionTask, commandTask, diagnosticTask, matchesState, migrationTask, nodeTasks, patchScanTask, sortTasks,
  type EndpointRow, type StateFilter, type TaskType, type TaskView,
} from './lifecycle';

/**
 * Task progress (0.52), read only. Every list is built from the rows the
 * heartbeat and the action pipeline already write — ActionJob / ActionTarget,
 * DiagnosticRun, EndpointCommand, AgentMigration and the RustdeskNode flags —
 * through lifecycle.ts. Nothing here writes, and nothing changes what a
 * computer is sent.
 *
 * Visibility: a computer's tasks need computers:view on that computer
 * (assertEndpointInScope); every list goes through endpointVisibilityWhere,
 * so another business's computer, or one a Business User was not granted,
 * never contributes a row. A ring plan is shown one computer at a time: the
 * reader sees the rows of the computers they can see, never the others.
 */

const OPEN_TARGET = ['PENDING', 'DISPATCHED', 'UNKNOWN'] as const;
const LIVE_JOB = ['AWAITING_APPROVAL', 'APPROVED', 'DISPATCHED', 'UNKNOWN'] as const;
const RECENT_DAYS = 14;
const MAX_ROWS = 200;
const EP_SELECT = { id: true, name: true, hostname: true, customerId: true, lastSeenAt: true } as const;

type JobRow = Prisma.ActionTargetGetPayload<{ include: { job: true } }>;

@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly acl: AccessControlService,
    private readonly containment: ContainmentService,
    private readonly actions: ActionsService,
  ) {}

  /**
   * A plan awaiting approval is decided on the signer; the portal learns of
   * it on a read (ActionsService.refresh, the same pull GET /actions/:id and
   * the heartbeat make). Without it a just-approved plan still read
   * "waiting for approval" here. At most 20 per read.
   */
  private async pullApprovals(targets: JobRow[]): Promise<JobRow[]> {
    const waiting = [...new Set(targets.filter((t) => t.job.status === 'AWAITING_APPROVAL').map((t) => t.jobId))].slice(0, 20);
    if (!waiting.length) return targets;
    const fresh = new Map<string, JobRow['job']>();
    for (const id of waiting) {
      const j = targets.find((t) => t.jobId === id)!.job;
      const r = await this.actions.refresh(j);
      if (r.status !== j.status) fresh.set(id, r as JobRow['job']);
    }
    if (!fresh.size) return targets;
    // A plan that was refused or canceled on the signer canceled its targets too: read them again.
    const ids = [...fresh.keys()];
    const again = new Map((await this.prisma.actionTarget.findMany({ where: { jobId: { in: ids } }, include: { job: true } })).map((t) => [t.id, t]));
    return targets.map((t) => again.get(t.id) ?? t);
  }

  private titleOf = (actionId: string) => actionEntry(actionId, 1)?.title ?? actionEntry(actionId, 2)?.title ?? actionId;

  private async heldFor(customerIds: (string | null)[]): Promise<Set<string>> {
    const held = new Set<string>();
    for (const id of new Set(customerIds.filter((x): x is string => !!x))) {
      if (await this.containment.blocking('actions', id)) held.add(id);
    }
    return held;
  }

  /** Every row, as lifecycle views. `eps` names each computer; containment is read once per business. */
  private async build(rows: {
    targets: JobRow[];
    runs: Prisma.DiagnosticRunGetPayload<object>[];
    commands: Prisma.EndpointCommandGetPayload<object>[];
    migrations: Prisma.AgentMigrationGetPayload<object>[];
    nodes: Prisma.RustdeskNodeGetPayload<object>[];
    scans: { id: string; patchScanRequestedAt: Date | null; patchScannedAt: Date | null }[];
  }, now: Date): Promise<TaskView[]> {
    const ids = new Set<string>([
      ...rows.targets.map((t) => t.endpointId), ...rows.runs.map((r) => r.endpointId), ...rows.commands.map((c) => c.endpointId),
      ...rows.migrations.map((m) => m.endpointId), ...rows.nodes.map((n) => n.endpointId!).filter(Boolean), ...rows.scans.map((s) => s.id),
    ]);
    const eps = new Map<string, EndpointRow>((await this.prisma.endpoint.findMany({ where: { id: { in: [...ids] } }, select: EP_SELECT })).map((e) => [e.id, e]));
    rows.targets = await this.pullApprovals(rows.targets);
    const held = await this.heldFor(rows.targets.filter((t) => t.status === 'PENDING').map((t) => t.job.customerId));
    const out: TaskView[] = [];
    for (const t of rows.targets) out.push(actionTask(t.job, t, { now, held: held.has(t.job.customerId), titleOf: this.titleOf, endpoint: eps.get(t.endpointId) ?? null }));
    for (const r of rows.runs) {
      const e = diagnosticEntry(r.key);
      out.push(diagnosticTask(r, eps.get(r.endpointId) ?? null, e?.label ?? r.key, isSnapshotKey(r.key), now));
    }
    for (const c of rows.commands) out.push(commandTask(c, eps.get(c.endpointId) ?? null, now));
    for (const m of rows.migrations) out.push(migrationTask(m, eps.get(m.endpointId) ?? null, migrationState(m, now.getTime()), now));
    for (const n of rows.nodes) if (n.endpointId) out.push(...nodeTasks({ ...n, endpointId: n.endpointId }, eps.get(n.endpointId) ?? null, now));
    for (const s of rows.scans) {
      if (!s.patchScanRequestedAt) continue;
      const v = patchScanTask(s.id, eps.get(s.id) ?? null, s.patchScanRequestedAt, s.patchScannedAt, now);
      if (v) out.push(v);
    }
    return out.sort(sortTasks);
  }

  /** Recent and open rows for these computers. `where` is always a visibility filter (or one computer already checked). */
  private async rowsFor(where: Prisma.EndpointWhereInput, now: Date, opts: { take: number; requestedById?: string }) {
    const since = new Date(now.getTime() - RECENT_DAYS * 86_400_000);
    const recentOrOpenTarget: Prisma.ActionTargetWhereInput = {
      OR: [
        { createdAt: { gte: since } },
        { status: { in: [...OPEN_TARGET] }, result: { equals: Prisma.DbNull }, reconciledAt: null, job: { status: { in: [...LIVE_JOB] } } },
      ],
    };
    const mine = opts.requestedById;
    const [targets, runs, commands, migrations, nodes, scans] = await Promise.all([
      this.prisma.actionTarget.findMany({
        where: { AND: [{ endpoint: where }, recentOrOpenTarget, ...(mine ? [{ job: { requestedById: mine } }] : [])] },
        include: { job: true }, orderBy: { createdAt: 'desc' }, take: opts.take,
      }),
      // Automatic snapshots (no requester) are the server's own housekeeping: not shown.
      this.prisma.diagnosticRun.findMany({
        where: { endpoint: where, requestedById: mine ?? { not: null }, OR: [{ requestedAt: { gte: since } }, { status: { in: ['REQUESTED', 'DELIVERED', 'RUNNING'] } }] },
        orderBy: { requestedAt: 'desc' }, take: opts.take,
      }),
      this.prisma.endpointCommand.findMany({
        where: { endpoint: where, requestedById: mine ?? { not: null }, OR: [{ createdAt: { gte: since } }, { status: { in: ['PENDING', 'DISPATCHED'] } }] },
        orderBy: { createdAt: 'desc' }, take: opts.take,
      }),
      this.prisma.agentMigration.findMany({
        where: { endpoint: where, ...(mine ? { requestedById: mine } : {}), OR: [{ requestedAt: { gte: since } }, { completedAt: null, cancelledAt: null }] },
        orderBy: { requestedAt: 'desc' }, take: Math.min(opts.take, 50),
      }),
      this.prisma.rustdeskNode.findMany({
        where: { endpoint: where, OR: [{ reinstallRequestedAt: { not: null }, ...(mine ? { reinstallRequestedBy: mine } : {}) }, { updateRequestedAt: { not: null }, ...(mine ? { updateRequestedById: mine } : {}) }] },
        take: Math.min(opts.take, 50),
      }),
      mine ? Promise.resolve([]) : this.prisma.endpoint.findMany({
        where: { AND: [where, { patchScanRequestedAt: { not: null } }] },
        select: { id: true, patchScanRequestedAt: true, inventory: { select: { patchScannedAt: true } } }, take: Math.min(opts.take, 100),
      }).then((r) => r.map((e) => ({ id: e.id, patchScanRequestedAt: e.patchScanRequestedAt, patchScannedAt: e.inventory?.patchScannedAt ?? null }))),
    ]);
    return { targets, runs, commands, migrations, nodes: nodes.filter((n) => !mine || n.reinstallRequestedBy === mine || n.updateRequestedById === mine), scans };
  }

  private assertView(actor: ActorContext) {
    this.acl.assertCapability(actor, CAP.COMPUTERS_VIEW);
  }

  private summary(tasks: TaskView[], now: Date) {
    const inFlight = tasks.filter((t) => t.inFlight);
    return {
      inFlight: inFlight.length,
      scheduled: tasks.filter((t) => t.state === 'scheduled').length,
      overdue: inFlight.filter((t) => t.overdue).length,
      checkedAt: now.toISOString(),
      // Fast while something is moving; a scheduled task alone is not moving.
      pollMs: inFlight.some((t) => t.state !== 'scheduled') ? POLL_FAST_MS : POLL_SLOW_MS,
    };
  }

  /** One computer's recent and open tasks (its page's Tasks panel). */
  async forEndpoint(actor: ActorContext, endpointId: string, now = new Date()) {
    this.assertView(actor);
    await this.acl.assertEndpointInScope(actor, endpointId, CAP.COMPUTERS_VIEW);
    const tasks = await this.build(await this.rowsFor({ id: endpointId }, now, { take: 30 }), now);
    return { ...this.summary(tasks, now), tasks: tasks.slice(0, 60) };
  }

  /** Every computer this person can see (the Tasks page). */
  async list(actor: ActorContext, q: { state?: string; type?: string; businessId?: string; endpointId?: string }, now = new Date()) {
    this.assertView(actor);
    const state = (q.state ?? 'all') as StateFilter;
    if (!STATE_FILTERS.includes(state)) throw new BadRequestException({ code: 'INVALID_REQUEST', message: `state is one of ${STATE_FILTERS.join(', ')}` });
    if (q.type && !(TASK_TYPES as readonly string[]).includes(q.type)) throw new BadRequestException({ code: 'INVALID_REQUEST', message: `type is one of ${TASK_TYPES.join(', ')}` });
    if (q.businessId && !/^[A-Za-z0-9_-]{8,64}$/.test(q.businessId)) throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'businessId is not an id' });
    const where = this.acl.endpointVisibilityWhere(actor, q.businessId ?? null);
    const all = await this.build(await this.rowsFor(where, now, { take: MAX_ROWS }), now);
    const tasks = all.filter((t) => matchesState(t, state) && (!q.type || t.type === (q.type as TaskType)));
    return { ...this.summary(all, now), total: tasks.length, tasks: tasks.slice(0, MAX_ROWS), filters: { states: STATE_FILTERS, types: TASK_TYPES } };
  }

  /**
   * The console's toast poll: the tasks this person started that finished
   * after `since` (at most the last day), and how many of theirs are still
   * open. Small on purpose: it is asked every few seconds from every page.
   * Automatic snapshots and inventory refreshes are left out — their own tabs
   * show them as they arrive.
   */
  async mine(actor: ActorContext, sinceRaw: string | undefined, now = new Date()) {
    this.assertView(actor);
    const floor = now.getTime() - 86_400_000;
    const parsed = sinceRaw ? Date.parse(sinceRaw) : NaN;
    const since = new Date(Number.isFinite(parsed) ? Math.min(Math.max(parsed, floor), now.getTime()) : now.getTime());
    const where = this.acl.endpointVisibilityWhere(actor);
    const r = await this.rowsFor(where, now, { take: 40, requestedById: actor.userId });
    r.runs = r.runs.filter((x) => !isSnapshotKey(x.key));
    r.commands = r.commands.filter((x) => x.type === 'UPDATE_SCAN');
    const tasks = await this.build(r, now);
    const finished = tasks.filter((t) => !t.inFlight && t.finishedAt && Date.parse(t.finishedAt) > since.getTime())
      .sort((a, b) => Date.parse(a.finishedAt!) - Date.parse(b.finishedAt!)).slice(-10);
    const open = tasks.filter((t) => t.inFlight);
    return {
      now: now.toISOString(),
      inFlight: open.length,
      running: open.filter((t) => t.state !== 'scheduled').length,
      pollMs: open.some((t) => t.state !== 'scheduled') ? POLL_FAST_MS : POLL_SLOW_MS / 4,
      finished: finished.map((t) => ({ id: t.id, title: t.title, computerName: t.computerName, endpointId: t.endpointId, state: t.state, text: t.text, finishedAt: t.finishedAt, link: t.link })),
    };
  }
}
