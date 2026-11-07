import {
  BadRequestException, ConflictException, Global, Injectable, Logger, Module,
  NotFoundException, OnModuleDestroy, OnModuleInit,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Prisma, UpdateComponent, UpdateJobStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { ActorContext } from '../rbac/access-control.service';
import { compareVersions } from '../common/agent-contract';
import { rustdeskAssetSha256 } from '../common/rustdesk-release';
import { isWithinSchedule, parseSchedule } from '../rbac/schedule';
import { queryHbbsOnline } from '../enrollment/hbbs-presence';

const TAG_RE = /^\d+\.\d+\.\d+$/;
const ACTIVE: UpdateJobStatus[] = ['DISPATCHED', 'INSTALLING', 'AWAITING_VERIFICATION'];
const NOT_DONE: UpdateJobStatus[] = ['REQUESTED', ...ACTIVE];
const DONE: UpdateJobStatus[] = ['SUCCEEDED', 'FAILED', 'CANCELED', 'SKIPPED'];

export interface RolloutInput {
  name: string;
  component: 'RUSTDESK' | 'AGENT';
  targetVersion: string;
  endpointIds?: string[];
  businessIds?: string[];
  pilotGroupId?: string | null;
  batchSize?: number;
  failureThreshold?: number;
  maxAttempts?: number;
  backoffMinutes?: number;
  verifyTimeoutMinutes?: number;
  maintenanceWindow?: unknown;
  deferOnUnknownSession?: boolean;
  /** Proceed when GitHub publishes no digest: the installer then requires Authenticode. */
  allowSignatureOnly?: boolean;
}

export interface HeartbeatFacts {
  endpointId: string;
  rustdeskId: string;
  authenticated: boolean;
  rustdeskVersion?: string;
  agentVersion?: string;
  updateNonce?: string;
  reportedPassword: boolean;
  rdSessionsActive?: number;
}

/**
 * Controlled RustDesk client / Rem0te agent updates for managed endpoints.
 *
 * This extends the existing heartbeat staging rather than replacing it: an
 * endpoint still learns of an update from its heartbeat response and still
 * applies it by re-running the installer. What a rollout adds is control over
 * WHICH version, WHEN, to WHOM, and what counts as done.
 *
 * Job lifecycle, each step tied to evidence:
 *   REQUESTED              created; waiting for its batch, window, backoff, or an idle session
 *   DISPATCHED             handed out in one heartbeat response (conditional update — a
 *                          duplicate or concurrent heartbeat cannot dispatch twice)
 *   INSTALLING             the endpoint fetched the installer for this job's nonce
 *   AWAITING_VERIFICATION  an authenticated heartbeat reports the approved version;
 *                          waiting on RustDesk registration with hbbs
 *   SUCCEEDED              version + authenticated heartbeat + registration (or registration
 *                          explicitly unavailable, recorded as such)
 *   FAILED                 attempts exhausted, or an outcome that retrying cannot fix
 *                          (installed a NEWER version than approved)
 *   CANCELED / SKIPPED     operator, or nothing to do (already on target, unsupported platform)
 *
 * Bounded by construction: every retry consumes an attempt, attempts are
 * capped (maxAttempts), retries back off exponentially, and a job is only ever
 * re-dispatched from REQUESTED. There is no path that re-runs an installer on
 * every heartbeat.
 *
 * Exact version: the target and the release asset's SHA-256 are resolved when
 * the rollout is created and stored. The installer the endpoint fetches for a
 * job's nonce installs that version with that digest, never "latest".
 *
 * Rollback is not offered: RustDesk's installer does not support a tested
 * downgrade. docs/updates.md has the recovery procedure.
 */
@Injectable()
export class UpdateRolloutService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(UpdateRolloutService.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => {
      this.tick().catch((e) => this.logger.warn(`Rollout tick failed: ${e}`));
    }, 60_000);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private platformVersion(): string {
    try {
      const file = process.env.VERSION_FILE ?? path.join(process.env.PROJECT_ROOT ?? process.cwd(), 'version.json');
      return (JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: string }).version ?? 'unknown';
    } catch {
      return 'unknown';
    }
  }

  private async event(jobId: string, event: string, status: UpdateJobStatus | null, detail?: Record<string, unknown>) {
    await this.prisma.updateJobEvent.create({
      data: { jobId, event, status, detail: (detail ?? undefined) as Prisma.InputJsonValue | undefined },
    }).catch(() => { /* history is best-effort */ });
  }

  // ── Pilot groups ──────────────────────────────────────────────────────────

  listPilotGroups() {
    return this.prisma.updatePilotGroup.findMany({ include: { members: true }, orderBy: { name: 'asc' } });
  }

  async savePilotGroup(input: { id?: string; name: string; description?: string; endpointIds: string[] }) {
    const ids = [...new Set(input.endpointIds)];
    const found = await this.prisma.endpoint.count({ where: { id: { in: ids } } });
    if (found !== ids.length) throw new BadRequestException('Unknown computer in pilot group');
    return this.prisma.$transaction(async (tx) => {
      const g = input.id
        ? await tx.updatePilotGroup.update({ where: { id: input.id }, data: { name: input.name, description: input.description ?? null } })
        : await tx.updatePilotGroup.create({ data: { name: input.name, description: input.description ?? null } });
      await tx.updatePilotMember.deleteMany({ where: { groupId: g.id } });
      if (ids.length) await tx.updatePilotMember.createMany({ data: ids.map((endpointId) => ({ groupId: g.id, endpointId })) });
      return tx.updatePilotGroup.findUnique({ where: { id: g.id }, include: { members: true } });
    });
  }

  // ── Rollouts ──────────────────────────────────────────────────────────────

  async create(actor: ActorContext, input: RolloutInput) {
    const component = input.component as UpdateComponent;
    const target = String(input.targetVersion ?? '').trim();
    if (!TAG_RE.test(target)) throw new BadRequestException('targetVersion must be an exact version such as 1.4.4');

    let artifactName: string | null = null;
    let artifactSha256: string | null = null;
    if (component === 'RUSTDESK') {
      artifactName = `rustdesk-${target}-x86_64.exe`;
      artifactSha256 = await rustdeskAssetSha256(target, artifactName);
      if (!artifactSha256 && !input.allowSignatureOnly) {
        throw new BadRequestException(
          `GitHub did not return a SHA-256 for ${artifactName}, so the exact artifact cannot be pinned. ` +
          'Retry when GitHub is reachable, or allow signature-only verification (the installer then requires a valid Authenticode signature).',
        );
      }
    } else {
      // The server can only ever serve its own agent: a rollout "to agent X"
      // where X is not this server's version could never be satisfied.
      const current = this.platformVersion();
      if (target !== current) {
        throw new BadRequestException(`Agent rollouts can only target this server's version (${current})`);
      }
    }

    let window: ReturnType<typeof parseSchedule>;
    try { window = parseSchedule(input.maintenanceWindow); } catch (e) { throw new BadRequestException((e as Error).message); }

    const where: Prisma.EndpointWhereInput = {
      status: { not: 'ARCHIVED' },
      rustdeskNode: { isNot: null },
      ...(input.endpointIds?.length ? { id: { in: input.endpointIds } } : {}),
      ...(input.businessIds?.length ? { customerId: { in: input.businessIds } } : {}),
    };
    const endpoints = await this.prisma.endpoint.findMany({
      where,
      select: {
        id: true, customerId: true, platform: true, agentVersion: true,
        rustdeskNode: { select: { version: true, agentSecretHash: true } },
      },
    });
    if (endpoints.length === 0) throw new NotFoundException('No matching computers');

    // One active rollout per computer and component, or two would fight.
    const busy = await this.prisma.updateJob.findMany({
      where: { endpointId: { in: endpoints.map((e) => e.id) }, status: { in: NOT_DONE }, rollout: { component } },
      select: { endpointId: true },
    });
    const busyIds = new Set(busy.map((b) => b.endpointId));

    const pilotIds = new Set<string>();
    if (input.pilotGroupId) {
      const g = await this.prisma.updatePilotGroup.findUnique({ where: { id: input.pilotGroupId }, include: { members: true } });
      if (!g) throw new NotFoundException('Pilot group not found');
      g.members.forEach((m) => pilotIds.add(m.endpointId));
    }

    const batchSize = Math.max(1, Math.min(500, input.batchSize ?? 10));
    const jobs: Prisma.UpdateJobCreateManyRolloutInput[] = [];
    let idx = 0;
    for (const e of endpoints) {
      const from = component === 'RUSTDESK' ? e.rustdeskNode?.version ?? null : e.agentVersion;
      let skip: string | null = null;
      if (busyIds.has(e.id)) skip = 'already_in_another_rollout';
      else if (!/windows/i.test(e.platform ?? '')) skip = 'platform_not_supported (staged updates are Windows-only)';
      else if (!e.rustdeskNode?.agentSecretHash) skip = 'device_not_authenticated (re-run installer first)';
      else if (from && compareVersions(from, target) === 0) skip = 'already_on_target';
      else if (component === 'RUSTDESK' && from && compareVersions(from, target) > 0) skip = 'newer_than_target (downgrade not supported)';
      const batch = pilotIds.has(e.id) ? 0 : 1 + Math.floor(idx++ / batchSize);
      jobs.push({
        endpointId: e.id, customerId: e.customerId, batch,
        status: skip ? 'SKIPPED' : 'REQUESTED', failureReason: skip, fromVersion: from,
      });
    }

    const rollout = await this.prisma.updateRollout.create({
      data: {
        name: input.name.slice(0, 120),
        component, targetVersion: target, artifactName, artifactSha256,
        pilotGroupId: input.pilotGroupId ?? null,
        batchSize,
        failureThreshold: Math.max(0, Math.min(1000, input.failureThreshold ?? 1)),
        maxAttempts: Math.max(1, Math.min(10, input.maxAttempts ?? 3)),
        backoffMinutes: Math.max(5, Math.min(24 * 60, input.backoffMinutes ?? 30)),
        verifyTimeoutMinutes: Math.max(15, Math.min(24 * 60, input.verifyTimeoutMinutes ?? 60)),
        maintenanceWindow: window ? (window as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
        deferOnUnknownSession: input.deferOnUnknownSession ?? true,
        createdById: actor.userId,
        jobs: { createMany: { data: jobs } },
      },
      include: { jobs: true },
    });
    await this.audit.log({
      actorId: actor.userId, actorIp: actor.ip,
      action: 'UPDATE_ROLLOUT_CREATED', resource: 'update_rollout', resourceId: rollout.id,
      meta: {
        component, targetVersion: target, artifactSha256, jobs: jobs.length,
        skipped: jobs.filter((j) => j.status === 'SKIPPED').length,
      },
    });
    return rollout;
  }

  list() {
    return this.prisma.updateRollout.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { pilotGroup: { select: { id: true, name: true } }, _count: { select: { jobs: true } } },
    });
  }

  async detail(id: string) {
    const r = await this.prisma.updateRollout.findUnique({
      where: { id },
      include: {
        pilotGroup: { select: { id: true, name: true } },
        jobs: {
          orderBy: [{ batch: 'asc' }, { createdAt: 'asc' }],
          include: { events: { orderBy: { createdAt: 'asc' }, take: 50 } },
        },
      },
    });
    if (!r) throw new NotFoundException('Rollout not found');
    const names = await this.prisma.endpoint.findMany({
      where: { id: { in: r.jobs.map((j) => j.endpointId) } },
      select: { id: true, name: true, hostname: true, isOnline: true, lastSeenAt: true, customer: { select: { name: true } } },
    });
    const byId = new Map(names.map((n) => [n.id, n]));
    const counts: Record<string, number> = {};
    r.jobs.forEach((j) => { counts[j.status] = (counts[j.status] ?? 0) + 1; });
    return { ...r, counts, jobs: r.jobs.map((j) => ({ ...j, endpoint: byId.get(j.endpointId) ?? null })) };
  }

  async start(actor: ActorContext, id: string) {
    const r = await this.prisma.updateRollout.findUnique({ where: { id }, include: { jobs: { select: { batch: true, status: true } } } });
    if (!r) throw new NotFoundException('Rollout not found');
    if (r.status !== 'DRAFT' && r.status !== 'PAUSED') throw new ConflictException(`Rollout is ${r.status.toLowerCase()}`);
    const pending = r.jobs.filter((j) => j.status === 'REQUESTED').map((j) => j.batch);
    const first = r.status === 'DRAFT' ? (pending.length ? Math.min(...pending) : 0) : r.currentBatch;
    await this.prisma.updateRollout.update({
      where: { id },
      data: { status: 'RUNNING', currentBatch: first, pausedReason: null, startedAt: r.startedAt ?? new Date() },
    });
    await this.audit.log({
      actorId: actor.userId, actorIp: actor.ip,
      action: r.status === 'PAUSED' ? 'UPDATE_ROLLOUT_RESUMED' : 'UPDATE_ROLLOUT_STARTED',
      resource: 'update_rollout', resourceId: id,
    });
    await this.tick();
    return this.detail(id);
  }

  async pause(actor: ActorContext | null, id: string, reason: string) {
    const res = await this.prisma.updateRollout.updateMany({
      where: { id, status: 'RUNNING' }, data: { status: 'PAUSED', pausedReason: reason.slice(0, 300) },
    });
    if (res.count > 0) {
      await this.audit.log({
        actorId: actor?.userId, actorIp: actor?.ip,
        action: 'UPDATE_ROLLOUT_PAUSED', resource: 'update_rollout', resourceId: id, meta: { reason },
      });
    }
    return { paused: res.count > 0 };
  }

  async cancel(actor: ActorContext, id: string) {
    const r = await this.prisma.updateRollout.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('Rollout not found');
    if (r.status === 'COMPLETED' || r.status === 'CANCELED') throw new ConflictException(`Rollout is ${r.status.toLowerCase()}`);
    await this.prisma.updateRollout.update({ where: { id }, data: { status: 'CANCELED', canceledAt: new Date() } });
    // Not-yet-dispatched jobs simply stop. Jobs already handed to an endpoint
    // cannot be recalled — the installer may be running — so they are marked
    // canceled, and Rem0te stops tracking them: whatever the install does
    // afterwards shows only in the computer's reported version.
    const jobs = await this.prisma.updateJob.findMany({ where: { rolloutId: id, status: { in: NOT_DONE } }, select: { id: true, status: true } });
    for (const j of jobs) {
      await this.prisma.updateJob.update({
        where: { id: j.id },
        data: { status: 'CANCELED', completedAt: new Date(), failureReason: j.status === 'REQUESTED' ? 'rollout_canceled' : 'rollout_canceled_after_dispatch (install may still complete)' },
      });
      await this.event(j.id, 'canceled', 'CANCELED', { previous: j.status });
    }
    await this.audit.log({
      actorId: actor.userId, actorIp: actor.ip,
      action: 'UPDATE_ROLLOUT_CANCELED', resource: 'update_rollout', resourceId: id, meta: { jobs: jobs.length },
    });
    return this.detail(id);
  }

  async cancelJob(actor: ActorContext, jobId: string) {
    const j = await this.prisma.updateJob.findUnique({ where: { id: jobId } });
    if (!j) throw new NotFoundException('Job not found');
    if (DONE.includes(j.status)) throw new ConflictException(`Job is ${j.status.toLowerCase()}`);
    await this.prisma.updateJob.update({ where: { id: jobId }, data: { status: 'CANCELED', completedAt: new Date(), failureReason: 'canceled_by_operator' } });
    await this.event(jobId, 'canceled', 'CANCELED', { by: actor.userId });
    return { canceled: true };
  }

  /** Per-device update history. */
  history(endpointId: string) {
    return this.prisma.updateJob.findMany({
      where: { endpointId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: {
        rollout: { select: { id: true, name: true, component: true, targetVersion: true, status: true } },
        events: { orderBy: { createdAt: 'asc' } },
      },
    });
  }

  // ── Engine ────────────────────────────────────────────────────────────────

  private async failAttempt(job: { id: string; attempts: number; rolloutId: string }, maxAttempts: number, backoffMinutes: number, reason: string) {
    if (job.attempts >= maxAttempts) {
      await this.prisma.updateJob.update({
        where: { id: job.id },
        data: { status: 'FAILED', completedAt: new Date(), failureReason: reason, dispatchNonce: null },
      });
      await this.event(job.id, 'failed', 'FAILED', { reason, attempts: job.attempts });
      await this.audit.log({ action: 'UPDATE_JOB_FAILED', resource: 'update_job', resourceId: job.id, meta: { reason } });
      await this.checkThreshold(job.rolloutId);
      return;
    }
    const delay = backoffMinutes * 2 ** Math.max(0, job.attempts - 1);
    await this.prisma.updateJob.update({
      where: { id: job.id },
      data: {
        status: 'REQUESTED', failureReason: reason, dispatchNonce: null,
        nextAttemptAt: new Date(Date.now() + delay * 60_000),
      },
    });
    await this.event(job.id, 'retry_scheduled', 'REQUESTED', { reason, attempt: job.attempts, retryInMinutes: delay });
  }

  private async fail(jobId: string, rolloutId: string, reason: string, detail?: Record<string, unknown>) {
    await this.prisma.updateJob.update({
      where: { id: jobId }, data: { status: 'FAILED', completedAt: new Date(), failureReason: reason, dispatchNonce: null },
    });
    await this.event(jobId, 'failed', 'FAILED', { reason, ...detail });
    await this.audit.log({ action: 'UPDATE_JOB_FAILED', resource: 'update_job', resourceId: jobId, meta: { reason } });
    await this.checkThreshold(rolloutId);
  }

  private async checkThreshold(rolloutId: string) {
    const r = await this.prisma.updateRollout.findUnique({ where: { id: rolloutId }, select: { status: true, failureThreshold: true } });
    if (!r || r.status !== 'RUNNING' || r.failureThreshold <= 0) return;
    const failed = await this.prisma.updateJob.count({ where: { rolloutId, status: 'FAILED' } });
    if (failed >= r.failureThreshold) {
      await this.pause(null, rolloutId, `Paused automatically: ${failed} failed update(s) reached the threshold of ${r.failureThreshold}`);
    }
  }

  /** Timeouts, batch advancement, completion. Idempotent; runs every minute. */
  async tick(now: Date = new Date()) {
    const running = await this.prisma.updateRollout.findMany({ where: { status: { in: ['RUNNING', 'PAUSED'] } } });
    for (const r of running) {
      // Timeouts apply to paused rollouts too: an install in flight still
      // needs a verdict.
      const stale = await this.prisma.updateJob.findMany({
        where: {
          rolloutId: r.id, status: { in: ACTIVE },
          dispatchedAt: { lt: new Date(now.getTime() - r.verifyTimeoutMinutes * 60_000) },
        },
      });
      for (const j of stale) {
        const node = await this.prisma.rustdeskNode.findUnique({
          where: { endpointId: j.endpointId }, select: { candidateSecretSeenAt: true, lastSeenAt: true },
        });
        const reason =
          node?.candidateSecretSeenAt && j.dispatchedAt && node.candidateSecretSeenAt > j.dispatchedAt
            ? 'device_secret_changed (accept the new device secret on the computer page)'
            : j.status === 'DISPATCHED'
              ? (node?.lastSeenAt && j.dispatchedAt && node.lastSeenAt > j.dispatchedAt
                  ? 'installer_not_fetched (endpoint kept heartbeating but did not run the update)'
                  : 'no_heartbeat_after_dispatch (endpoint went offline or the install interrupted it)')
              : j.status === 'INSTALLING'
                ? 'install_not_completed (installer fetched, approved version never reported)'
                : 'not_registered_with_hbbs (version is correct but RustDesk did not re-register)';
        await this.failAttempt(j, r.maxAttempts, r.backoffMinutes, reason);
      }

      if (r.status !== 'RUNNING') continue;
      const jobs = await this.prisma.updateJob.findMany({ where: { rolloutId: r.id }, select: { batch: true, status: true } });
      const inBatch = jobs.filter((j) => j.batch <= r.currentBatch);
      if (inBatch.some((j) => NOT_DONE.includes(j.status))) continue;
      const later = jobs.filter((j) => j.batch > r.currentBatch && j.status === 'REQUESTED').map((j) => j.batch);
      if (later.length === 0) {
        await this.prisma.updateRollout.updateMany({ where: { id: r.id, status: 'RUNNING' }, data: { status: 'COMPLETED', completedAt: now } });
        continue;
      }
      // Batch boundary: the threshold is re-checked before anything new is
      // released, so a failed pilot stops the fleet.
      await this.checkThreshold(r.id);
      const still = await this.prisma.updateRollout.findUnique({ where: { id: r.id }, select: { status: true } });
      if (still?.status !== 'RUNNING') continue;
      await this.prisma.updateRollout.update({ where: { id: r.id }, data: { currentBatch: Math.min(...later) } });
    }
  }

  /**
   * Called by the heartbeat for an authenticated device. Records evidence for
   * any job in flight, and dispatches at most one job.
   *
   * Returns `managed: true` when a non-terminal rollout job exists for this
   * computer, in which case the legacy one-click staging must NOT also hand
   * out an update.
   */
  async onHeartbeat(f: HeartbeatFacts): Promise<{
    managed: boolean;
    updateRustdesk?: { targetVersion: string; nonce: string } | null;
    reinstallAgent?: { targetVersion: string; nonce: string } | null;
  }> {
    if (!f.authenticated) return { managed: false };
    const jobs = await this.prisma.updateJob.findMany({
      where: { endpointId: f.endpointId, status: { in: NOT_DONE } },
      include: { rollout: true },
      orderBy: { createdAt: 'asc' },
    });
    if (jobs.length === 0) return { managed: false };

    for (const j of jobs.filter((x) => ACTIVE.includes(x.status))) {
      await this.recordEvidence(j, f);
    }

    const fresh = await this.prisma.updateJob.findMany({
      where: { endpointId: f.endpointId, status: { in: NOT_DONE } },
      include: { rollout: true },
      orderBy: { createdAt: 'asc' },
    });
    if (fresh.length === 0) return { managed: true, updateRustdesk: null, reinstallAgent: null };
    // Something already in flight: never dispatch a second installer.
    if (fresh.some((j) => ACTIVE.includes(j.status))) return { managed: true, updateRustdesk: null, reinstallAgent: null };

    const now = new Date();
    for (const j of fresh) {
      const r = j.rollout;
      if (r.status !== 'RUNNING' || j.batch > r.currentBatch) continue;
      if (j.nextAttemptAt && j.nextAttemptAt > now) continue;

      const defer = await this.deferReason(f, r.deferOnUnknownSession, r.maintenanceWindow, now);
      if (defer) {
        if (j.deferReason !== defer) {
          await this.prisma.updateJob.update({ where: { id: j.id }, data: { deferReason: defer } });
          await this.event(j.id, 'deferred', 'REQUESTED', { reason: defer });
        }
        return { managed: true, updateRustdesk: null, reinstallAgent: null };
      }

      const nonce = randomBytes(18).toString('base64url');
      // Conditional on REQUESTED: two heartbeats racing cannot both dispatch.
      const claimed = await this.prisma.updateJob.updateMany({
        where: { id: j.id, status: 'REQUESTED' },
        data: {
          status: 'DISPATCHED', dispatchNonce: nonce, dispatchedAt: now, attempts: { increment: 1 },
          deferReason: null, installStartedAt: null,
        },
      });
      if (claimed.count === 0) return { managed: true, updateRustdesk: null, reinstallAgent: null };
      await this.event(j.id, 'dispatched', 'DISPATCHED', { attempt: j.attempts + 1, targetVersion: r.targetVersion });
      const payload = { targetVersion: r.targetVersion, nonce };
      return r.component === 'RUSTDESK'
        ? { managed: true, updateRustdesk: payload, reinstallAgent: null }
        : { managed: true, updateRustdesk: null, reinstallAgent: payload };
    }
    return { managed: true, updateRustdesk: null, reinstallAgent: null };
  }

  private async deferReason(f: HeartbeatFacts, deferOnUnknown: boolean, window: unknown, now: Date): Promise<string | null> {
    if (window) {
      let open: boolean;
      try { open = isWithinSchedule(parseSchedule(window), now); } catch { open = false; }
      if (!open) return 'outside_maintenance_window';
    }
    if ((f.rdSessionsActive ?? 0) > 0) return 'active_session_reported_by_endpoint';
    const sessions = await this.prisma.supportSession.findMany({
      where: {
        endpointId: f.endpointId,
        status: { in: ['SESSION_STARTED', 'LAUNCH_REQUESTED', 'LAUNCHER_ACKNOWLEDGED', 'CLIENT_OPENED'] },
      },
      select: { status: true, createdAt: true },
    });
    if (sessions.some((s) => s.status === 'SESSION_STARTED')) return 'active_session_confirmed';
    if (deferOnUnknown && sessions.some((s) => now.getTime() - s.createdAt.getTime() < 2 * 3600_000)) {
      return 'session_state_unknown (a recent launch has not been confirmed or closed)';
    }
    return null;
  }

  private async recordEvidence(j: Prisma.UpdateJobGetPayload<{ include: { rollout: true } }>, f: HeartbeatFacts) {
    const r = j.rollout;
    const reported = r.component === 'RUSTDESK' ? f.rustdeskVersion : f.agentVersion;
    const nonceMatches = !!f.updateNonce && f.updateNonce === j.dispatchNonce;
    const credentialSync = f.reportedPassword ? 'reported' : 'unchanged';
    if (!reported) return; // nothing to judge by yet

    const cmp = compareVersions(reported, r.targetVersion);
    if (r.component === 'RUSTDESK' && cmp > 0) {
      // Retrying cannot fix this and must not loop: the endpoint's installer
      // (an agent older than 0.20.0 ignores the pin) installed a newer build.
      await this.prisma.updateJob.update({ where: { id: j.id }, data: { installedVersion: reported, credentialSync } });
      await this.fail(j.id, j.rolloutId, `installed_newer_than_approved (${reported} > ${r.targetVersion}; the endpoint's agent predates version pinning)`, { reported });
      return;
    }
    if (cmp < 0) {
      // Still on the old version. Only a heartbeat that echoes this job's
      // nonce proves the install ran and fell short; otherwise keep waiting
      // for the timeout.
      if (nonceMatches && (j.status === 'INSTALLING' || j.status === 'DISPATCHED')) {
        await this.prisma.updateJob.update({ where: { id: j.id }, data: { installedVersion: reported } });
        await this.failAttempt(j, r.maxAttempts, r.backoffMinutes, `version_not_reached (installer ran, ${reported} is still installed)`);
      }
      return;
    }

    // On the approved version, reported by an authenticated heartbeat.
    if (j.status !== 'AWAITING_VERIFICATION') {
      await this.prisma.updateJob.update({
        where: { id: j.id },
        data: { status: 'AWAITING_VERIFICATION', installedVersion: reported, credentialSync },
      });
      await this.event(j.id, 'version_reported', 'AWAITING_VERIFICATION', {
        reported, nonceEchoed: nonceMatches, heartbeat: 'authenticated',
      });
    }
    const online = await queryHbbsOnline([f.rustdeskId], {
      host: process.env.HBBS_PRESENCE_HOST || undefined,
      port: Number(process.env.HBBS_PRESENCE_PORT) || undefined,
      timeoutMs: 1500,
    });
    const registration = online === null ? 'unavailable' : online.has(f.rustdeskId) ? 'registered' : 'not_registered';
    if (registration === 'not_registered') return; // wait; the timeout decides
    await this.prisma.updateJob.update({
      where: { id: j.id },
      data: { status: 'SUCCEEDED', verifiedAt: new Date(), completedAt: new Date(), dispatchNonce: null, failureReason: null, credentialSync },
    });
    await this.event(j.id, 'verified', 'SUCCEEDED', {
      installedVersion: reported, heartbeat: 'authenticated', registration,
      nonceEchoed: nonceMatches,
      ...(registration === 'unavailable' ? { note: 'hbbs presence could not be queried; registration not independently verified' } : {}),
    });
    await this.audit.log({ action: 'UPDATE_JOB_SUCCEEDED', resource: 'update_job', resourceId: j.id, meta: { installedVersion: reported, registration } });
  }

  /**
   * The endpoint fetched the installer for a job. Returns the exact version
   * and digest to bake into it, or null when the nonce names no live
   * dispatch (then the normal installer is served).
   */
  async installerFetched(nonce: string | undefined): Promise<{ version: string; sha256: string | null; component: UpdateComponent } | null> {
    if (!nonce || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) return null;
    const j = await this.prisma.updateJob.findUnique({ where: { dispatchNonce: nonce }, include: { rollout: true } });
    if (!j || !ACTIVE.includes(j.status)) return null;
    if (j.status === 'DISPATCHED') {
      await this.prisma.updateJob.updateMany({ where: { id: j.id, status: 'DISPATCHED' }, data: { status: 'INSTALLING', installStartedAt: new Date() } });
      await this.event(j.id, 'installer_fetched', 'INSTALLING');
    }
    return { version: j.rollout.targetVersion, sha256: j.rollout.artifactSha256, component: j.rollout.component };
  }
}

@Global()
@Module({
  providers: [UpdateRolloutService],
  exports: [UpdateRolloutService],
})
export class UpdateRolloutModule {}
