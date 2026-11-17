import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { Prisma, type PatchDeployment, type PatchPolicy } from '@prisma/client';
import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { ActorResolverService } from '../rbac/actor-resolver.service';
import { AccessPolicyService } from '../security-controls/access-policy.service';
import { ActionsService } from '../actions/actions.service';
import { SignerClient } from '../actions/signer.client';
import { ContainmentService } from '../containment/containment.service';
import { UpdateTrustService } from '../update-trust/update-trust.service';
import { PUBLISH_COMMAND } from '../update-trust/agent-migration';
import { MAX_RING_TARGETS, MAX_UPDATES_PER_PLAN, REBOOT_SCHEDULE, UPDATE_INSTALL, UpdateReboot } from '../actions/catalog';
import {
  MAX_POLICY_DAYS, MAX_POLICY_RINGS, MAX_RESTART_ATTEMPTS, STAGINGS, stagingOf, MAX_RESTART_PLAN_HOURS, POLICY_RESTART_DELAY_MINUTES, POLICY_SCHEMA, PolicyAllow, PolicyDoc, PolicyRestart, PolicyWindow,
  allowParams, describePolicyWindow, localTime, nextOccurrence, nextOccurrences, occurrenceAt, policyAllowsUpdate, policyDigest, restartInWords, restartRuleOf, scheduleInWords, validatePolicyDoc, windowKind,
  type RestartRule,
} from '../actions/patch-policy';
import { resultKeyFingerprint, selfSignedScanKey } from '../actions/device-result';
import { MANAGER_LABEL, eligibility, type Posture } from './posture';
import { PatchingService } from './patching.service';

/**
 * Automatic patch policies (v0.32).
 *
 * A policy is a bounded document — one business, named computers in fixed
 * rings with a one-computer canary, the update classes and severities it may
 * install, KBs it never installs, a maintenance window, soak and failure
 * threshold, a restart rule (0.34: never, or if required inside the
 * window), and an expiry at most 90 days out. Two people on
 * the approval signer's roster approve it there, with passkeys. After that
 * the signer signs each ring plan the portal proposes *only if the plan is
 * inside the document*: the portal cannot widen the computers, the classes,
 * the window or the ring order, nor skip the canary or its proof.
 *
 * 0.62, at the owner's request: that is the canary staging. A policy may
 * instead install all at once (staging none, signed into the document):
 * every ring is proposed in the window together, with no canary, no evidence
 * and no soak, and a computer without a result key may be in any ring. A
 * document without the field is canary, so every policy before 0.62 keeps
 * its bytes and its gate.
 *
 * This service proposes policies, mirrors their status from the signer,
 * revokes them, and runs the sweep that proposes ring plans inside an open
 * window. It has no approve route and cannot sign anything.
 *
 * Revocation is one-way and lives on the signer: the portal asks the signer
 * to revoke (and keeps asking until it confirms), and the signer's operator
 * can revoke from its own CLI. The portal's own row goes REVOKED at once, so
 * the portal stops proposing even while the signer is unreachable; the
 * signer refuses every later plan regardless of what the portal says.
 */

const Id = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const PolicyIdRe = /^[a-f0-9]{32}$/;

export const CreatePolicyDto = z.object({
  businessId: Id,
  name: z.string().trim().min(3).max(120),
  /** Endpoint ids. Under canary staging ring 0 is the canary: exactly one. */
  rings: z.array(z.array(Id).min(1).max(MAX_RING_TARGETS)).min(1).max(MAX_POLICY_RINGS),
  /** 0.62: 'none' (all at once) or 'canary'. Absent means canary, as before 0.62; the console sends it explicitly. */
  staging: z.enum(STAGINGS).default('canary'),
  allow: PolicyAllow,
  soakHours: z.number().int().min(0).max(168).default(24),
  failureThreshold: z.number().int().min(0).max(MAX_RING_TARGETS).default(0),
  window: PolicyWindow,
  /** 0.34: never (the default), or restart if required inside the window. Signed into the policy. */
  reboot: UpdateReboot.default('never'),
  /** 0.54: a restart window and rule (if required, or a maintenance restart). Signed into the policy; absent means none. */
  restart: PolicyRestart.optional(),
  /** 0.54: the RustDesk-session exception for this policy's restarts. Present only when ticked. */
  ignoreRemoteSession: z.literal(true).optional(),
  expiresInDays: z.number().int().min(1).max(MAX_POLICY_DAYS).default(30),
  reason: z.string().trim().min(3).max(500),
}).strict();

const ReasonDto = z.object({ reason: z.string().trim().min(3).max(300) }).strict();
/** 0.53: the window to preview, checked as PolicyWindow inside, and the expiry it must open before. */
const WindowPreviewDto = z.object({ window: z.unknown(), expiresInDays: z.number().int().min(1).max(MAX_POLICY_DAYS).optional() }).strict();

/** Less than this left in a window and nothing new is proposed in it. */
const MIN_WINDOW_MS = 15 * 60_000;
/** 0.54: a restart plan needs at least this long to be picked up before its last moment (the window's end less the warning). */
const MIN_RESTART_PLAN_MS = 10 * 60_000;
/** 0.54: how long the sweep waits before another restart attempt for the same computer in the same window. */
const RESTART_RETRY_MS = 15 * 60_000;
/**
 * 0.54: how long a policy restart plan is valid. No longer than the retry
 * wait: the signer counts a restart plan "open" until its notAfter (it cannot
 * know the agent deferred it), so a deferred plan must have closed before
 * the next attempt is asked for. A computer checks in about every 3 minutes;
 * one that misses all three attempts is tried again in the next window.
 */
const RESTART_PLAN_MS = RESTART_RETRY_MS;
/** 0.54: the agent results after which a policy restart is tried again in the same window: a RustDesk session, or "cannot tell". */
const RESTART_RETRY_REASONS = ['remote_session_open', 'session_state_unknown'];

/** 0.50: what a series revision carries into admission. Set only by PatchSeriesService. */
export interface SeriesRevision { seriesId: string; revision: number; supersedesId: string | null }
/** 0.50: the series service, attached at start so the sweep can run it (no import cycle). */
export interface SeriesHooks {
  tick(now: Date): Promise<void>;
  onRevoked(r: PatchPolicy, by: 'portal' | 'approval signer', actorId: string | null): Promise<void>;
}
export type CreatePolicy = z.infer<typeof CreatePolicyDto>;

type LastProposal = { at: string; windowKey: string | null; ok: boolean; code: string; message: string; deploymentId?: string | null; ring?: number | null; jobId?: string | null };

@Injectable()
export class PatchPolicyService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('PatchPolicies');
  private timer: ReturnType<typeof setInterval> | null = null;
  private first: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  private series: SeriesHooks | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly acl: AccessControlService,
    private readonly actors: ActorResolverService,
    private readonly access: AccessPolicyService,
    private readonly actions: ActionsService,
    private readonly signer: SignerClient,
    private readonly containment: ContainmentService,
    private readonly updateTrust: UpdateTrustService,
    private readonly patching: PatchingService,
  ) {}

  // ── The sweep ─────────────────────────────────────────────────────────────

  static sweepEnabled() { return process.env.PATCH_POLICY_SWEEP !== 'off'; }
  static sweepSeconds() { return Math.max(2, Number(process.env.PATCH_POLICY_SWEEP_SECONDS) || 60); }

  onModuleInit() {
    if (!PatchPolicyService.sweepEnabled()) return;
    const every = PatchPolicyService.sweepSeconds() * 1000;
    this.first = setTimeout(() => { void this.sweep(); }, Math.min(30_000, every));
    this.timer = setInterval(() => { void this.sweep(); }, every);
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); if (this.first) clearTimeout(this.first); }

  /** 0.50: PatchSeriesService registers itself here once. */
  attachSeries(h: SeriesHooks) { this.series = h; }

  /** One pass over every live policy. Never runs twice at once in this process; the database's unique (policy, window) stops a second process. */
  async sweep(now = new Date()) {
    if (this.busy) return;
    this.busy = true;
    try {
      const rows = await this.prisma.patchPolicy.findMany({
        where: { OR: [{ status: { in: ['AWAITING_APPROVAL', 'ACTIVE'] } }, { status: 'REVOKED', signerRevokedAt: null }] },
        orderBy: { createdAt: 'asc' }, take: 200,
      });
      const fresh: PatchPolicy[] = [];
      for (const r0 of rows) {
        try { fresh.push(await this.refresh(r0, now)); } catch (e) { this.logger.warn(`policy ${r0.id}: ${(e as Error).message}`); }
      }
      // 0.50: company-wide and assignable policies revise and take over here,
      // between mirroring the signer and proposing ring plans.
      if (this.series) await this.series.tick(now).catch((e) => this.logger.warn(`series: ${(e as Error).message}`));
      for (const r0 of fresh) {
        try {
          if (r0.status !== 'ACTIVE') continue;
          const r = await this.prisma.patchPolicy.findUnique({ where: { id: r0.id } });
          // A series revision is proposed under only while it is the series' running one.
          if (!r || r.status !== 'ACTIVE' || !(await this.isRunning(r))) continue;
          await this.propose(r, now);
          // 0.54: the restart window runs beside the install window, on its own schedule.
          await this.proposeRestarts(r, now);
        } catch (e) {
          this.logger.warn(`policy ${r0.id}: ${(e as Error).message}`);
        }
      }
    } finally { this.busy = false; }
  }

  /** A hand-made policy runs while ACTIVE; a series revision only while it is the series' current one. */
  async isRunning(r: PatchPolicy): Promise<boolean> {
    if (!r.seriesId) return true;
    const s = await this.prisma.patchPolicySeries.findUnique({ where: { id: r.seriesId }, select: { currentPolicyId: true, status: true } });
    return !!s && s.status === 'active' && s.currentPolicyId === r.id;
  }

  /**
   * 0.50: a hand-made policy that became ACTIVE takes its computers' live
   * rows, one at a time, so a computer another policy already holds (the
   * partial unique index) stays out of this one and its sweep leaves it out.
   * A series revision goes live only through PatchSeriesService.promote.
   */
  private async goLive(r: PatchPolicy) {
    if (r.seriesId || r.status !== 'ACTIVE') return;
    for (const m of await this.prisma.patchPolicyComputer.findMany({ where: { policyId: r.id, live: false }, select: { endpointId: true } })) {
      await this.prisma.patchPolicyComputer.update({ where: { policyId_endpointId: { policyId: r.id, endpointId: m.endpointId } }, data: { live: true } }).catch(() => undefined);
    }
  }

  /** Mirror the signer's view of a policy; keep asking it to revoke until it confirms. */
  private async refresh(r: PatchPolicy, now = new Date()): Promise<PatchPolicy> {
    if (!this.signer.configured()) return r;
    if (r.status === 'REVOKED') {
      if (r.signerRevokedAt) return r;
      const out = await this.signer.revokePolicy(r.id, r.revokeReason ?? 'revoked at the portal').catch(() => null);
      if (out?.status !== 200) return r;
      const u = await this.prisma.patchPolicy.update({ where: { id: r.id }, data: { signerRevokedAt: new Date(out.body.revokedAt ?? now) } });
      await this.audit.log({ tenantId: r.tenantId ?? undefined, customerId: r.customerId, action: 'PATCH_POLICY_UPDATED', resource: 'patch_policy', resourceId: r.id, meta: { signerConfirmedRevocation: true } });
      return u;
    }
    if (!['AWAITING_APPROVAL', 'ACTIVE'].includes(r.status)) return r;
    const s = await this.signer.policyStatus(r.id).catch(() => null);
    if (!s || s.status !== 200) {
      // An expiry needs no signer to be true.
      if (r.expiresAt <= now) return this.setStatus(r, 'EXPIRED', { reason: 'expired' });
      return r;
    }
    if (s.body.digest !== r.digest) {
      // Never take a status for a document other than the one stored here.
      this.logger.error(`policy ${r.id}: the signer holds a different document (digest mismatch); not mirroring its status`);
      return r;
    }
    const st = s.body.status as PatchPolicy['status'] | undefined;
    const approvals = (s.body.approvals ?? []) as unknown as Prisma.InputJsonValue;
    if (st === 'REVOKED') {
      // Revoked by the signer's own operator: the portal follows.
      const u = await this.prisma.patchPolicy.update({ where: { id: r.id }, data: { status: 'REVOKED', revokedAt: new Date(s.body.revokedAt ?? now), revokeReason: r.revokeReason ?? 'revoked on the approval signer', signerRevokedAt: new Date(s.body.revokedAt ?? now), approvals } });
      await this.stopDeployments(u, 'the policy was revoked on the approval signer');
      await this.audit.log({ tenantId: r.tenantId ?? undefined, customerId: r.customerId, action: 'PATCH_POLICY_REVOKED', resource: 'patch_policy', resourceId: r.id, meta: { by: 'approval signer' } });
      if (u.seriesId && this.series) await this.series.onRevoked(u, 'approval signer', null);
      return u;
    }
    if (st && st !== r.status && ['AWAITING_APPROVAL', 'ACTIVE', 'REJECTED', 'EXPIRED'].includes(st)) return this.setStatus(r, st, { approvals: s.body.approvals ?? [] }, approvals);
    if (JSON.stringify(r.approvals ?? []) !== JSON.stringify(s.body.approvals ?? [])) return this.prisma.patchPolicy.update({ where: { id: r.id }, data: { approvals } });
    return r;
  }

  private async setStatus(r: PatchPolicy, status: PatchPolicy['status'], meta: Record<string, unknown>, approvals?: Prisma.InputJsonValue) {
    const u = await this.prisma.patchPolicy.update({ where: { id: r.id }, data: { status, ...(approvals !== undefined ? { approvals } : {}) } });
    await this.audit.log({ tenantId: r.tenantId ?? undefined, customerId: r.customerId, action: 'PATCH_POLICY_UPDATED', resource: 'patch_policy', resourceId: r.id, meta: { from: r.status, status, ...meta } });
    if (status === 'ACTIVE') await this.goLive(u);
    return u;
  }

  private async record(r: PatchPolicy, p: Omit<LastProposal, 'at'>, audit: boolean, now: Date) {
    const last = r.lastProposal as LastProposal | null;
    const same = !!last && last.windowKey === p.windowKey && last.code === p.code && last.ok === p.ok && (last.ring ?? null) === (p.ring ?? null) && (last.jobId ?? null) === (p.jobId ?? null);
    if (same) return;
    await this.prisma.patchPolicy.update({ where: { id: r.id }, data: { lastProposal: { at: now.toISOString(), ...p } as unknown as Prisma.InputJsonValue } });
    r.lastProposal = { at: now.toISOString(), ...p } as unknown as Prisma.JsonValue;
    if (audit) {
      await this.audit.log({
        tenantId: r.tenantId ?? undefined, customerId: r.customerId, actorId: r.createdById,
        action: p.ok ? 'PATCH_POLICY_PROPOSED' : 'PATCH_POLICY_REFUSED', resource: 'patch_policy', resourceId: r.id,
        meta: { windowKey: p.windowKey, code: p.code, message: p.message, deploymentId: p.deploymentId ?? null, ring: p.ring ?? null, jobId: p.jobId ?? null },
      });
    }
  }

  /** Inside an open window: start this window's deployment, or move an open one on by one ring. */
  private async propose(r: PatchPolicy, now: Date) {
    const doc = PolicyDoc.parse(r.document);
    const occ = occurrenceAt(now, doc.window);
    if (!occ) return;
    const windowKey = occ.start.toISOString();
    const notAfter = new Date(Math.min(occ.end.getTime(), now.getTime() + 24 * 3_600_000, Date.parse(doc.expiresAt)));
    if (notAfter.getTime() - now.getTime() < MIN_WINDOW_MS) return;
    const rec = (ok: boolean, code: string, message: string, extra: Partial<LastProposal> = {}, audit = true) => this.record(r, { windowKey, ok, code, message, ...extra }, audit, now);

    if (await this.containment.blocking('actions', r.customerId)) return rec(false, 'contained', 'Containment pauses actions for this business; nothing is proposed until it is lifted.');
    const actor = await this.actors.contextFor(doc.createdBy.userId, r.tenantId ?? '', r.customerId);
    if (!actor) return rec(false, 'author_inactive', `${doc.createdBy.name}, who created the policy, is no longer active or no longer reaches this business. Plans are requested on the author's behalf, so nothing is proposed. Revoke it and create a new one.`);

    // A deployment already open under this policy is moved on, across windows.
    let d: PatchDeployment | null = await this.prisma.patchDeployment.findFirst({ where: { policyId: r.id, status: { in: ['ACTIVE', 'PAUSED'] } }, orderBy: { createdAt: 'desc' } });
    if (d?.status === 'PAUSED') return rec(false, 'deployment_paused', `Deployment "${d.name}" is paused${d.pausedReason ? `: ${d.pausedReason}` : ''}. Resume or cancel it; nothing new is proposed meanwhile.`, { deploymentId: d.id }, false);
    if (!d) {
      if (await this.prisma.patchDeployment.findFirst({ where: { policyId: r.id, windowKey }, select: { id: true } })) return; // this window had its deployment
      d = await this.startDeployment(r, doc, actor, windowKey, now, rec);
      if (!d) return;
    }
    await this.nextRing(r, doc, actor, d, windowKey, now, notAfter, rec);
  }

  /**
   * The canary's offered, installable, policy-allowed updates become this
   * window's deployment. 0.62, all at once: there is no canary, so they are
   * those of every computer ready now, together (each computer's agent
   * installs only what Windows Update offers it).
   */
  private async startDeployment(r: PatchPolicy, doc: PolicyDoc, actor: ActorContext, windowKey: string, now: Date, rec: (ok: boolean, code: string, message: string, extra?: Partial<LastProposal>, audit?: boolean) => Promise<void>): Promise<PatchDeployment | null> {
    const staging = stagingOf(doc);
    if (!staging) { await rec(false, 'staging_unknown', 'The policy\'s staging is not one this version knows; nothing is proposed under it.'); return null; }
    let updates: { updateId: string; revision: number }[];
    if (staging === 'none') {
      const ready: string[] = [];
      let firstWhy = '';
      for (const c of doc.rings.flat()) {
        const no = await this.notReady(actor, c, false, r.id);
        if (no) { firstWhy ||= `${c.hostname}: ${no}`; continue; }
        ready.push(c.endpointId);
      }
      if (!ready.length) { await rec(false, 'none_ready', `No computer in the policy is ready (${firstWhy})`); return null; }
      const postures = await this.patching.postures(ready);
      const seen = new Map<string, { updateId: string; revision: number }>();
      for (const id of ready) {
        for (const u of postures.get(id)?.updates ?? []) {
          if (eligibility(u).ok && policyAllowsUpdate(doc.allow, u).ok && !seen.has(`${u.updateId}@${u.revision}`)) seen.set(`${u.updateId}@${u.revision}`, u);
        }
      }
      updates = [...seen.values()].slice(0, MAX_UPDATES_PER_PLAN);
      if (!updates.length) { await rec(true, 'nothing_to_install', `Windows Update offers the ${ready.length} ready computer(s) nothing this policy installs.`, {}, false); return null; }
    } else {
      const canary = doc.rings[0][0];
      const why = await this.notReady(actor, canary, doc.rings.length > 1, r.id);
      if (why) { await rec(false, 'canary_not_ready', `The canary, ${canary.hostname}: ${why}`); return null; }
      const posture = (await this.patching.postures([canary.endpointId])).get(canary.endpointId)!;
      updates = posture.updates.filter((u) => eligibility(u).ok && policyAllowsUpdate(doc.allow, u).ok).slice(0, MAX_UPDATES_PER_PLAN);
      if (!updates.length) { await rec(true, 'nothing_to_install', `Windows Update offers the canary nothing this policy installs (scan of ${posture.scannedAt}).`, {}, false); return null; }
    }
    const local = localTime(new Date(windowKey), doc.window.timezone);
    const date = `${local.y}-${String(local.m).padStart(2, '0')}-${String(local.d).padStart(2, '0')}`;
    try {
      return await this.patching.build(actor, {
        businessId: r.customerId, name: `${doc.name} — ${date}`.slice(0, 120),
        updates: updates.map((u) => ({ updateId: u.updateId, revision: u.revision })),
        rings: doc.rings.map((ring) => ring.map((c) => c.endpointId)),
        soakHours: doc.soakHours, failureThreshold: doc.failureThreshold, windowHours: 24, reboot: doc.reboot, staging,
      }, 'POLICY', { policyId: r.id, windowKey, createdById: doc.createdBy.userId });
    } catch (e) {
      // Another sweep (another process) made this window's deployment first.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return null;
      const b = (e as { getResponse?: () => { code?: string; message?: string } }).getResponse?.();
      await rec(false, b?.code ?? 'deployment_refused', b?.message ?? (e as Error).message);
      return null;
    }
  }

  private async nextRing(r: PatchPolicy, doc: PolicyDoc, actor: ActorContext, d: PatchDeployment, windowKey: string, now: Date, notAfter: Date, rec: (ok: boolean, code: string, message: string, extra?: Partial<LastProposal>, audit?: boolean) => Promise<void>) {
    const detail = await this.patching.detail(actor, d.id, now);
    if (detail.status !== 'ACTIVE') return;
    if (stagingOf(doc) === 'none') {
      // 0.62, all at once: every ring not yet running is proposed now, each
      // its own plan, and none waits for another.
      if (!detail.next.requestable.length) return rec(true, 'waiting', detail.next.why, { deploymentId: d.id, ring: null }, false);
      for (const ring of detail.next.requestable) await this.requestPolicyRing(r, doc, actor, d, ring, windowKey, now, notAfter, rec, false);
      return;
    }
    const { ring, canRequest, why } = detail.next;
    if (ring === null || !canRequest) return rec(true, 'waiting', why, { deploymentId: d.id, ring }, false);
    await this.requestPolicyRing(r, doc, actor, d, ring, windowKey, now, notAfter, rec, true);
  }

  /** One ring of a policy deployment, proposed to the signer; a computer not ready now is left out, with why. */
  private async requestPolicyRing(r: PatchPolicy, doc: PolicyDoc, actor: ActorContext, d: PatchDeployment, ring: number, windowKey: string, now: Date, notAfter: Date, rec: (ok: boolean, code: string, message: string, extra?: Partial<LastProposal>, audit?: boolean) => Promise<void>, canary: boolean) {
    // A computer not ready now is left out of this ring's plan, with why — it
    // is never swapped for another, and the signer checks each one against
    // the approved identity.
    const exclude: { endpointId: string; why: string }[] = [];
    if (ring > 0 || !canary) {
      for (const c of doc.rings[ring]) {
        const no = await this.notReady(actor, c, canary && ring < doc.rings.length - 1, r.id);
        if (no) exclude.push({ endpointId: c.endpointId, why: no.slice(0, 200) });
      }
      if (exclude.length === doc.rings[ring].length) return rec(false, 'ring_not_ready', `No computer in ring ${ring} is ready: ${exclude.map((x) => x.why).slice(0, 2).join('; ')}`, { deploymentId: d.id, ring });
    } else {
      const no = await this.notReady(actor, doc.rings[0][0], doc.rings.length > 1, r.id);
      if (no) return rec(false, 'canary_not_ready', `The canary, ${doc.rings[0][0].hostname}: ${no}`, { deploymentId: d.id, ring });
    }
    try {
      const out = await this.patching.requestRing(actor, d.id, ring, { reason: `Patch policy "${doc.name}", window ${windowKey}`.slice(0, 400), exclude }, {
        policyId: r.id, name: doc.name, digest: r.digest, allow: allowParams(doc.allow), window: { notBefore: now, notAfter },
        ...(doc.ignoreRemoteSession ? { ignoreRemoteSession: true as const } : {}),
      });
      await rec(true, 'signed', `Ring ${ring} of "${d.name}" was signed under the policy${exclude.length ? `, leaving out ${exclude.length} computer(s) not ready` : ''}.`, { deploymentId: d.id, ring, jobId: out.job.id });
    } catch (e) {
      const b = (e as { getResponse?: () => { code?: string; signerCode?: string | null; message?: string } }).getResponse?.();
      const code = b?.signerCode ?? b?.code ?? 'request_failed';
      await rec(false, code, b?.message ?? (e as Error).message, { deploymentId: d.id, ring });
      if (code === 'ring_retry_limit') {
        // The signer will not sign this ring under the policy again. Close the
        // deployment so the next window starts afresh with a new canary run.
        await this.prisma.patchDeployment.update({ where: { id: d.id }, data: { status: 'CANCELED', pausedReason: b?.message ?? 'retry limit' } });
        await this.audit.log({ tenantId: d.tenantId ?? undefined, customerId: d.customerId, action: 'PATCH_DEPLOYMENT_UPDATED', resource: 'patch_deployment', resourceId: d.id, meta: { status: 'CANCELED', reason: 'ring_retry_limit', policyId: r.id } });
      }
    }
  }

  // ── Restarts (0.54) ───────────────────────────────────────────────────────

  /**
   * Inside an open restart window: one windows.reboot.schedule plan for each
   * computer of the policy that reports a restart required (`if_required`)
   * or for each computer (`always`), submitted under the policy so the signer
   * decides it against the signed restart window. At most
   * MAX_RESTART_ATTEMPTS per computer per occurrence, claimed first.
   */
  async proposeRestarts(r: PatchPolicy, now: Date) {
    const doc = PolicyDoc.parse(r.document);
    const rule = restartRuleOf(doc);
    if (!doc.restart || !rule) return;
    const occ = occurrenceAt(now, doc.restart.window);
    if (!occ) return;
    const windowKey = occ.start.toISOString();
    // The computer may pick the plan up as late as notAfter, and restarts the
    // warning after that: the restart itself must fall inside the window.
    const notAfter = new Date(Math.min(occ.end.getTime() - POLICY_RESTART_DELAY_MINUTES * 60_000, now.getTime() + Math.min(RESTART_PLAN_MS, MAX_RESTART_PLAN_HOURS * 3_600_000), Date.parse(doc.expiresAt)));
    if (notAfter.getTime() - now.getTime() < MIN_RESTART_PLAN_MS) return;
    if (await this.containment.blocking('actions', r.customerId)) return;
    const actor = await this.actors.contextFor(doc.createdBy.userId, r.tenantId ?? '', r.customerId);
    if (!actor) return;
    for (const c of doc.rings.flat()) {
      try { await this.restartOne(r, doc, rule, actor, c, windowKey, now, notAfter); } catch (e) { this.logger.warn(`policy ${r.id} restart ${c.endpointId}: ${(e as Error).message}`); }
    }
  }

  /** Does Windows say this computer needs a restart? Its signed scan's word, else its inventory's. */
  async restartRequired(endpointId: string): Promise<boolean> {
    const p = (await this.patching.postures([endpointId])).get(endpointId);
    if (p) return !!p.reboot.pending;
    const inv = await this.prisma.endpointInventory.findUnique({ where: { endpointId }, select: { rebootRequired: true } });
    return !!inv?.rebootRequired;
  }

  /** Why this computer is not restarted under the policy's rule now, or null. Only reads. */
  async restartSkip(r: PatchPolicy, rule: RestartRule, c: PolicyDoc['rings'][number][number]): Promise<string | null> {
    const member = await this.prisma.patchPolicyComputer.findUnique({ where: { policyId_endpointId: { policyId: r.id, endpointId: c.endpointId } }, select: { live: true } });
    if (!member?.live) return 'another active policy patches it';
    const ep = await this.prisma.endpoint.findUnique({ where: { id: c.endpointId }, select: { status: true, patchPolicyMode: true, rustdeskNode: { select: { rustdeskId: true, agentSecretHash: true } } } });
    if (!ep || ep.status === 'ARCHIVED') return 'it is no longer enrolled';
    if (ep.patchPolicyMode === 'exclude') return 'its Patch policy is set to Exclude';
    if (ep.rustdeskNode?.rustdeskId !== c.rustdeskId || ep.rustdeskNode?.agentSecretHash !== c.deviceSecretSha256) return 'it was re-enrolled since the policy was approved';
    if (rule === 'if_required' && !(await this.restartRequired(c.endpointId))) return 'no restart required';
    // Never under an install still running, and never beside another open restart request.
    if (await this.actions.blocking(c.endpointId, UPDATE_INSTALL.id)) return 'an update install is still open on it';
    if (await this.actions.blocking(c.endpointId, REBOOT_SCHEDULE.id)) return 'a restart request is already open for it';
    return null;
  }

  private async restartOne(r: PatchPolicy, doc: PolicyDoc, rule: RestartRule, actor: ActorContext, c: PolicyDoc['rings'][number][number], windowKey: string, now: Date, notAfter: Date) {
    const rows = await this.prisma.patchPolicyRestart.findMany({ where: { policyId: r.id, endpointId: c.endpointId, windowKey }, orderBy: { attempt: 'asc' } });
    const last = rows[rows.length - 1];
    if (last) {
      if (rows.length >= MAX_RESTART_ATTEMPTS) return;
      if (now.getTime() - last.updatedAt.getTime() < RESTART_RETRY_MS) return;
      if (last.jobId) {
        // Tried again only after a RustDesk session (or "cannot tell") held it
        // back, or a plan that never reached the computer.
        const j = await this.prisma.actionJob.findUnique({ where: { id: last.jobId }, select: { status: true, targets: { where: { endpointId: c.endpointId }, select: { status: true, result: true } } } });
        const t = j?.targets[0];
        const reason = (t?.result as { reason?: string } | null)?.reason ?? '';
        const again = !j || ['REJECTED', 'CANCELED', 'EXPIRED'].includes(j.status) || t?.status === 'CANCELED' || (t?.status === 'NOT_EXECUTED' && RESTART_RETRY_REASONS.includes(reason));
        if (!again) return;
      }
    }
    if (await this.restartSkip(r, rule, c)) return;
    const attempt = (last?.attempt ?? 0) + 1;
    let row: { id: string };
    try {
      row = await this.prisma.patchPolicyRestart.create({ data: { policyId: r.id, endpointId: c.endpointId, customerId: r.customerId, windowKey, attempt, code: 'claimed', message: 'Proposing a restart plan.' }, select: { id: true } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return; // another sweep took this attempt
      throw e;
    }
    const params = {
      delayMinutes: POLICY_RESTART_DELAY_MINUTES,
      ...(rule === 'if_required' ? { onlyIfRequired: true as const } : {}),
      ...(doc.ignoreRemoteSession ? { ignoreRemoteSession: true as const } : {}),
    };
    try {
      const job = await this.actions.createPlan(actor, {
        action: REBOOT_SCHEDULE, endpointIds: [c.endpointId], params,
        reason: `Patch policy "${doc.name}", restart window ${windowKey}`.slice(0, 400), startsInMinutes: 0, windowHours: MAX_RESTART_PLAN_HOURS,
        window: { notBefore: now, notAfter },
        display: { updates: [], deployment: null, policy: { id: r.id, name: doc.name.slice(0, 120), digest: r.digest } },
        underPolicy: { policyId: r.id, digest: r.digest, evidence: null },
      });
      await this.prisma.patchPolicyRestart.update({ where: { id: row.id }, data: { jobId: job.id, code: 'signed', message: `Restart plan signed under the policy; it runs from ${now.toISOString()} to ${notAfter.toISOString()}.` } });
    } catch (e) {
      const b = (e as { getResponse?: () => { code?: string; signerCode?: string | null; message?: string } }).getResponse?.();
      await this.prisma.patchPolicyRestart.update({ where: { id: row.id }, data: { code: (b?.signerCode ?? b?.code ?? 'request_failed').slice(0, 64), message: (b?.message ?? (e as Error).message).slice(0, 400) } });
    }
  }

  /**
   * 0.54: what the policy will do about one computer's restart, in words, for
   * the Patches tab: "Restart planned for …", or the next restart window. Reads only.
   */
  async restartPlanFor(policyId: string, endpointId: string, rebootPending: boolean | null, now = new Date()) {
    const r = await this.prisma.patchPolicy.findUnique({ where: { id: policyId } });
    if (!r || r.status !== 'ACTIVE') return null;
    const doc = PolicyDoc.safeParse(r.document);
    if (!doc.success) return null;
    const d = doc.data;
    const rule = restartRuleOf(d);
    const words = restartInWords(d);
    const latest = await this.prisma.patchPolicyRestart.findFirst({ where: { policyId, endpointId }, orderBy: { createdAt: 'desc' } });
    const job = latest?.jobId ? await this.prisma.actionJob.findUnique({ where: { id: latest.jobId }, select: { id: true, status: true, notBefore: true, notAfter: true, targets: { where: { endpointId }, select: { status: true, result: true, resultAt: true } } } }) : null;
    const t = job?.targets[0];
    const scheduledFor = (t?.result as { observed?: { scheduledFor?: string } } | null)?.observed?.scheduledFor ?? null;
    const next = d.restart && rule ? nextOccurrence(now, d.restart.window, r.expiresAt) : null;
    const tz = d.restart?.window.timezone ?? d.window.timezone;
    const at = (x: Date | string) => `${new Date(x).toLocaleString('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })} ${tz}`;
    let text: string;
    if (job && scheduledFor && Date.parse(scheduledFor) > now.getTime() - 3_600_000) text = `Restart planned for ${at(scheduledFor)} (policy "${d.name}").`;
    else if (job && ['APPROVED', 'DISPATCHED', 'AWAITING_APPROVAL'].includes(job.status) && !t?.resultAt) text = `Restart planned: the computer picks it up at its next check-in after ${at(job.notBefore)} and restarts ${POLICY_RESTART_DELAY_MINUTES} minutes later (policy "${d.name}").`;
    else if (rule && next && (rule === 'always' || rebootPending)) text = `${rule === 'always' ? 'Maintenance restart' : 'Restart'} planned in the next restart window, ${at(next.start)} to ${at(next.end)} (policy "${d.name}").`;
    else if (!d.restart && rebootPending) text = `Policy "${d.name}" has no restart window: ${words}. Schedule a restart here, or add a restart window to the policy.`;
    else text = `Policy "${d.name}" restarts: ${words}.`;
    return {
      policyId, policyName: d.name, rule, words, ignoreRemoteSession: d.ignoreRemoteSession === true,
      restartWindow: d.restart ? { description: describePolicyWindow(d.restart.window), window: d.restart.window } : null,
      nextRestartWindow: next, latest: latest ? { at: latest.createdAt, windowKey: latest.windowKey, attempt: latest.attempt, code: latest.code, message: latest.message, jobId: latest.jobId, jobStatus: job?.status ?? null, scheduledFor } : null,
      text,
    };
  }

  /** The result key a computer's latest signed scan names, if that scan verifies under it and names this identity. */
  private resultKeyOf(p: Posture | null, rustdeskId: string, deviceSecretSha256: string): string | null {
    return p?.signed ? selfSignedScanKey(p.signed, { rustdeskId, deviceSecretSha256 }) : null;
  }

  /** Why this policy computer cannot be in a plan right now, or null. */
  private async notReady(actor: ActorContext, c: PolicyDoc['rings'][number][number], gatesNextRing = true, policyId: string | null = null): Promise<string | null> {
    const ep = await this.actions.endpointFor(c.endpointId);
    if (!ep || ep.status === 'ARCHIVED') return 'it is no longer enrolled.';
    // 0.50: one policy patches a computer at a time (its live row), and
    // Exclude on its Patches tab stops automatic patching at once, before any
    // revision drops it.
    if (policyId) {
      const member = await this.prisma.patchPolicyComputer.findUnique({ where: { policyId_endpointId: { policyId, endpointId: c.endpointId } }, select: { live: true } });
      if (!member?.live) return 'another active policy patches it (one policy per computer).';
    }
    const mode = await this.prisma.endpoint.findUnique({ where: { id: c.endpointId }, select: { patchPolicyMode: true } });
    if (mode?.patchPolicyMode === 'exclude') return 'its Patch policy is set to Exclude (no automatic patching).';
    if (ep.rustdeskNode?.rustdeskId !== c.rustdeskId || ep.rustdeskNode?.agentSecretHash !== c.deviceSecretSha256) return 'it was re-enrolled since the policy was approved, so it is not the computer that was approved.';
    const d = await this.access.evaluateAction(actor, ep, 'high');
    if (!d.ok) return d.message;
    const nr = this.actions.readiness(ep, `${UPDATE_INSTALL.id}@${UPDATE_INSTALL.version}`);
    if (nr) return nr;
    const p = (await this.patching.postures([ep.id])).get(ep.id);
    if (!p) return 'it has not reported a signed Windows Update scan.';
    if (p.managers.length) return `its updates are managed by ${p.managers.map((m) => MANAGER_LABEL[m]).join(', ')}.`;
    if (c.resultKey && gatesNextRing) {
      // Its results are verified against the approved key: a computer now
      // signing with another one would only produce results the signer refuses.
      const now = this.resultKeyOf(p, c.rustdeskId, c.deviceSecretSha256);
      if (now && now !== c.resultKey) return `it now signs its results with another key (${resultKeyFingerprint(now)}, approved: ${resultKeyFingerprint(c.resultKey)}), so its results would be refused. Its agent's state was reset; approve a new policy.`;
    }
    const blocking = await this.actions.blocking(ep.id, UPDATE_INSTALL.id);
    if (blocking) return `an earlier install on it is ${blocking.status.toLowerCase().replace(/_/g, ' ')}.`;
    return null;
  }

  // ── People ────────────────────────────────────────────────────────────────

  private bad(code: string, message: string): never { throw new BadRequestException({ code, message }); }

  async create(actor: ActorContext, raw: unknown, now = new Date()) {
    const parsed = CreatePolicyDto.safeParse(raw);
    if (!parsed.success) this.bad('INVALID_REQUEST', parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    return this.admit(actor, parsed.data, now, null);
  }

  /**
   * The one way a policy document reaches the approval signer: a person's
   * create, or (0.50) a series revision proposed by PatchSeriesService. Every
   * computer is checked here, as the author, whichever asked; the document is
   * the closed list it always was.
   */
  async admit(actor: ActorContext, dto: CreatePolicy, now: Date, series: SeriesRevision | null) {
    if (!this.signer.configured()) throw new ServiceUnavailableException({ code: 'APPROVAL_SIGNER_NOT_CONFIGURED', message: 'Patch policies need the approval signer (APPROVAL_SIGNER_INTERNAL_URL). See Patching setup.' });
    const caps = await this.signer.capabilities();
    if (caps.status !== 200 || caps.body.patchPolicies !== 1) throw new ConflictException({ code: 'SIGNER_TOO_OLD', message: 'The approval signer does not support patch policies. Install the 0.32 signer.' });
    // 0.62: an older signer refuses a document carrying staging (its schema is strict); say why first.
    const canary = dto.staging === 'canary';
    if (!canary && caps.body.patchStaging !== 1) throw new ConflictException({ code: 'SIGNER_TOO_OLD', message: 'The approval signer cannot sign a policy that installs all at once. Install the 0.62 signer, or tick "Test on one computer first".' });

    const all = dto.rings.flat();
    if (new Set(all).size !== all.length) this.bad('BAD_RINGS', 'A computer can be in one ring only.');
    if (canary && dto.rings[0].length !== 1) this.bad('BAD_RINGS', 'Ring 0 is the canary: exactly one computer.');
    const rings: PolicyDoc['rings'] = [];
    let businessName = '';
    let tenantId: string | null = null;
    for (const [i, ring] of dto.rings.entries()) {
      const out: PolicyDoc['rings'][number] = [];
      for (const id of ring) {
        await this.acl.assertEndpointInScope(actor, id);
        const ep = await this.actions.endpointFor(id);
        if (!ep || ep.customerId !== dto.businessId || !ep.customer || ep.status === 'ARCHIVED' || !(await this.acl.canReachEndpoint(actor, ep))) throw new NotFoundException('Computer not found');
        const name = (ep.hostname ?? ep.name).slice(0, 64);
        const dec = await this.access.evaluateAction(actor, ep, 'high');
        if (!dec.ok) throw new ForbiddenException({ code: dec.reason.toUpperCase(), message: `${name}: ${dec.message}`, endpointId: id });
        if (!ep.rustdeskNode?.rustdeskId || !ep.rustdeskNode.agentSecretHash) throw new ConflictException({ code: 'ENDPOINT_NOT_READY', message: `${name}: this computer has no enrolled device identity.`, endpointId: id });
        if (ep.updateChannel !== 'signed') throw new ConflictException({ code: 'ENDPOINT_NOT_READY', message: `${name}: runs the standard agent. Move it to the signed channel first.`, endpointId: id });
        if (canary && i === 0) {
          const nr = this.actions.readiness(ep, `${UPDATE_INSTALL.id}@${UPDATE_INSTALL.version}`);
          if (nr) throw new ConflictException({ code: 'ENDPOINT_NOT_READY', message: `${name} (the canary): ${nr}`, endpointId: id });
        }
        // v0.34: the key this computer signs results with, as its own signed
        // scan reports it (and only if that scan names this computer's
        // enrolled identity). The portal cannot vouch for it — approving the
        // policy on the signer is what makes it trusted — but a wrong one here
        // can only stop the policy, never open a ring.
        const posture = (await this.patching.postures([id])).get(id) ?? null;
        const resultKey = this.resultKeyOf(posture, ep.rustdeskNode.rustdeskId, ep.rustdeskNode.agentSecretHash);
        if (canary && !resultKey && dto.rings.length > 1 && i < dto.rings.length - 1) {
          throw new ConflictException({ code: 'RESULT_KEY_MISSING', message: `${name}${i === 0 ? ' (the canary)' : ''}: no signed scan from a 0.34+ agent, so its results cannot be verified, and they would open ring ${i + 1}. Update its agent and let it scan, or put it in the last ring.`, endpointId: id });
        }
        // 0.50: one policy per computer. A hand-made policy names only
        // computers no series covers and no other policy holds; a revision only
        // computers no other policy holds (its own series' revisions aside).
        const held = await this.heldElsewhere(id, series?.seriesId ?? null);
        if (held) throw new ConflictException({ code: 'COMPUTER_IN_POLICY', message: `${name}: ${held}`, endpointId: id });
        businessName = ep.customer.name.slice(0, 120);
        tenantId = ep.tenantId;
        out.push({ endpointId: id, hostname: name, rustdeskId: ep.rustdeskNode.rustdeskId, deviceSecretSha256: ep.rustdeskNode.agentSecretHash, ...(resultKey ? { resultKey } : {}) });
      }
      rings.push(out);
    }
    const user = await this.prisma.user.findUnique({ where: { id: actor.userId }, select: { firstName: true, lastName: true, email: true } });
    const expiresAt = new Date(now.getTime() + dto.expiresInDays * 86_400_000);
    const doc: PolicyDoc = {
      schema: POLICY_SCHEMA, policyId: randomBytes(16).toString('hex'), name: dto.name, businessId: dto.businessId, businessName,
      rings,
      // 0.62: signed only for all at once. A canary document leaves it out and is byte-for-byte what 0.61 made.
      ...(canary ? {} : { staging: 'none' as const }),
      allow: dto.allow, soakHours: dto.soakHours, failureThreshold: dto.failureThreshold, window: dto.window, reboot: dto.reboot,
      // 0.54: only when chosen, so a document without them is byte-for-byte what 0.53 made.
      ...(dto.restart ? { restart: dto.restart } : {}),
      ...(dto.ignoreRemoteSession ? { ignoreRemoteSession: true as const } : {}),
      createdAt: now.toISOString(), expiresAt: expiresAt.toISOString(),
      createdBy: { userId: actor.userId, name: ([user?.firstName, user?.lastName].filter(Boolean).join(' ') || user?.email || actor.userId).slice(0, 120) },
      reason: dto.reason,
    };
    const shape = PolicyDoc.safeParse(doc);
    if (!shape.success) this.bad('INVALID_REQUEST', shape.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const v = validatePolicyDoc(doc, now);
    if (!v.ok) this.bad(v.reason.toUpperCase(), v.message);
    const digest = policyDigest(doc);
    const sub = await this.signer.submitPolicy(doc);
    if (sub.status !== 201 || sub.body.digest !== digest || !sub.body.approvalUrl) {
      throw new ConflictException({ code: 'APPROVAL_SIGNER_REFUSED', signerCode: sub.body.error ?? null, message: sub.body.message ?? sub.body.error ?? 'The approval signer refused the policy.' });
    }
    const [row] = await this.prisma.$transaction([
      this.prisma.patchPolicy.create({
        data: {
          id: doc.policyId, tenantId, customerId: dto.businessId, name: dto.name, document: doc as unknown as Prisma.InputJsonValue, digest,
          // 0.40: in direct mode the signer makes it active at admission; the mirror follows its word.
          status: sub.body.direct === true && sub.body.status === 'ACTIVE' ? 'ACTIVE' : 'AWAITING_APPROVAL', approvalUrl: sub.body.approvalUrl, expiresAt, createdById: actor.userId,
          ...(series ? { seriesId: series.seriesId, revision: series.revision, supersedesId: series.supersedesId } : {}),
        },
      }),
      // 0.50: which computers it names, not yet live (goLive, or a series promotion).
      this.prisma.patchPolicyComputer.createMany({ data: rings.flatMap((ring, i) => ring.map((c) => ({ policyId: doc.policyId, endpointId: c.endpointId, customerId: dto.businessId, ring: i, live: false }))) }),
    ]);
    await this.goLive(row);
    await this.audit.log({
      tenantId: tenantId ?? undefined, customerId: dto.businessId, actorId: actor.userId, actorIp: actor.ip, action: 'PATCH_POLICY_CREATED', resource: 'patch_policy', resourceId: row.id,
      meta: { name: dto.name, digest, approval: sub.body.direct === true ? 'direct' : 'signed', ...(series ? { seriesId: series.seriesId, revision: series.revision, supersedes: series.supersedesId } : {}), rings: rings.map((x) => x.length), staging: dto.staging, allow: allowParams(dto.allow), window: dto.window, soakHours: dto.soakHours, failureThreshold: dto.failureThreshold, reboot: dto.reboot, restart: dto.restart ?? null, ...(dto.ignoreRemoteSession ? { ignoreRemoteSession: true } : {}), expiresAt: doc.expiresAt, reason: dto.reason },
    });
    return this.detail(actor, row.id, now);
  }

  /**
   * Why this computer cannot be named by a new policy, or null. `seriesId`:
   * the series proposing a revision (its own revisions do not count). A
   * hand-made policy (seriesId null) also refuses a computer that a series
   * covers or that is set to Exclude.
   */
  async heldElsewhere(endpointId: string, seriesId: string | null): Promise<string | null> {
    const live = await this.prisma.patchPolicyComputer.findFirst({
      where: { endpointId, live: true, ...(seriesId ? { policy: { OR: [{ seriesId: null }, { seriesId: { not: seriesId } }] } } : {}) },
      select: { policy: { select: { name: true, revision: true, series: { select: { id: true, scope: true } } } } },
    });
    // A revision may name a computer another series still holds only when
    // the computer's setting has moved it away from that series: the holder
    // drops it at its own revision, and this one takes over only after
    // (promote refuses while the live row is held).
    if (live && seriesId && live.policy.series) {
      const ep = await this.prisma.endpoint.findUnique({ where: { id: endpointId }, select: { patchPolicyMode: true, patchPolicySeriesId: true } });
      const stillThere = live.policy.series.scope === 'business' ? ep?.patchPolicyMode === 'inherit' : ep?.patchPolicyMode === 'policy' && ep.patchPolicySeriesId === live.policy.series.id;
      if (!stillThere) return null;
    }
    if (live) return `the active policy "${live.policy.name}"${live.policy.revision ? ` (revision ${live.policy.revision})` : ''} already patches it. A computer is in one policy at a time.`;
    const pending = await this.prisma.patchPolicyComputer.findFirst({
      where: { endpointId, policy: { status: 'AWAITING_APPROVAL', seriesId: null } },
      select: { policy: { select: { name: true } } },
    });
    if (pending) return `the policy "${pending.policy.name}", awaiting approval, already names it. A computer is in one policy at a time.`;
    if (seriesId) return null;
    const ep = await this.prisma.endpoint.findUnique({ where: { id: endpointId }, select: { customerId: true, patchPolicyMode: true, patchPolicySeries: { select: { name: true } } } });
    if (ep?.patchPolicyMode === 'exclude') return 'its Patch policy is set to Exclude (no automatic patching). Change it on its Patches tab first.';
    if (ep?.patchPolicyMode === 'policy') return `its Patch policy is set to use "${ep.patchPolicySeries?.name ?? 'another policy'}". Change it on its Patches tab first.`;
    const biz = ep?.customerId ? await this.prisma.patchPolicySeries.findFirst({ where: { customerId: ep.customerId, scope: 'business', status: 'active' }, select: { name: true } }) : null;
    if (biz) return `the company-wide policy "${biz.name}" covers it. Set its Patch policy to Exclude or to another policy first.`;
    return null;
  }

  private async scoped(actor: ActorContext, id: string): Promise<PatchPolicy> {
    const r = PolicyIdRe.test(id) ? await this.prisma.patchPolicy.findUnique({ where: { id } }) : null;
    if (!r) throw new NotFoundException('Policy not found');
    // Every computer it names must be visible to this person.
    const doc = r.document as unknown as PolicyDoc;
    for (const c of doc.rings.flat()) await this.acl.assertEndpointInScope(actor, c.endpointId).catch(() => { throw new NotFoundException('Policy not found'); });
    return r;
  }

  /**
   * 0.53: what a window would be — its description and its next openings —
   * computed by the same functions the signer runs, so the editor shows what
   * the signer will hold the policy to. Reads nothing and writes nothing.
   */
  previewWindow(raw: unknown, now = new Date()) {
    const parsed = WindowPreviewDto.safeParse(raw);
    if (!parsed.success) this.bad('INVALID_REQUEST', parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const w = PolicyWindow.safeParse(parsed.data.window);
    if (!w.success) return { valid: false, message: w.error.issues.slice(0, 3).map((i) => `${['window', ...i.path].join('.')}: ${i.message}`).join('; '), occurrences: [] };
    const until = parsed.data.expiresInDays ? new Date(now.getTime() + parsed.data.expiresInDays * 86_400_000) : undefined;
    const occurrences = nextOccurrences(now, w.data, 3, until);
    return {
      valid: true, kind: windowKind(w.data), description: describePolicyWindow(w.data), occurrences,
      opensBeforeExpiry: until ? occurrences.length > 0 : null,
    };
  }

  async list(actor: ActorContext, businessId: string, now = new Date()) {
    if (!Id.safeParse(businessId).success) this.bad('INVALID_REQUEST', 'businessId is required');
    const rows = await this.prisma.patchPolicy.findMany({ where: { customerId: businessId }, orderBy: { createdAt: 'desc' }, take: 50 });
    const out = [];
    for (const r0 of rows) {
      try { await this.scoped(actor, r0.id); } catch { continue; }
      const r = await this.refresh(r0, now).catch(() => r0);
      const doc = r.document as unknown as PolicyDoc;
      out.push({
        id: r.id, name: r.name, status: r.status, expiresAt: r.expiresAt, createdAt: r.createdAt,
        seriesId: r.seriesId, revision: r.revision, supersededAt: r.supersededAt,
        computers: doc.rings.flat().length, rings: doc.rings.length, staging: stagingOf(doc), window: doc.window,
        nextWindow: r.status === 'ACTIVE' ? nextOccurrence(now, doc.window, r.expiresAt) : null,
        // 0.54: the install and restart schedule in plain words, and when restarts next run.
        schedule: scheduleInWords(doc), reboot: doc.reboot, restart: doc.restart ?? null, ignoreRemoteSession: doc.ignoreRemoteSession === true,
        nextRestartWindow: r.status === 'ACTIVE' && doc.restart ? nextOccurrence(now, doc.restart.window, r.expiresAt) : null,
        lastProposal: r.lastProposal,
      });
    }
    return out;
  }

  async detail(actor: ActorContext, id: string, now = new Date()) {
    const r = await this.refresh(await this.scoped(actor, id), now).catch(async () => this.scoped(actor, id));
    const doc = r.document as unknown as PolicyDoc;
    const signer = this.signer.configured() ? await this.signer.policyStatus(r.id).catch(() => null) : null;
    const deployments = await this.prisma.patchDeployment.findMany({ where: { policyId: r.id }, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, name: true, status: true, windowKey: true, pausedReason: true, createdAt: true } });
    return {
      id: r.id, name: r.name, businessId: r.customerId, status: r.status, digest: r.digest, approvalUrl: r.approvalUrl,
      approvals: r.approvals ?? [], expiresAt: r.expiresAt, createdAt: r.createdAt, createdById: r.createdById,
      revokedAt: r.revokedAt, revokeReason: r.revokeReason, signerConfirmedRevocation: !!r.signerRevokedAt,
      // 0.50: a revision of a company-wide or assignable policy, and what it replaced.
      seriesId: r.seriesId, revision: r.revision, supersedesId: r.supersedesId, supersededAt: r.supersededAt,
      document: doc, staging: stagingOf(doc),
      // v0.34: compare these with `rem0te-agent.exe status` on each computer.
      resultKeys: Object.fromEntries(doc.rings.flat().map((c) => [c.endpointId, c.resultKey ? resultKeyFingerprint(c.resultKey) : null])),
      currentWindow: r.status === 'ACTIVE' ? occurrenceAt(now, doc.window) : null,
      nextWindow: r.status === 'ACTIVE' ? nextOccurrence(now, doc.window, r.expiresAt) : null,
      // 0.53: the window in words and its next three openings before expiry, from the signer's own functions.
      windowDescription: describePolicyWindow(doc.window),
      upcomingWindows: r.status === 'ACTIVE' ? nextOccurrences(now, doc.window, 3, r.expiresAt) : [],
      // 0.54: the restart schedule, from the same functions the signer runs, and the restarts it proposed.
      schedule: scheduleInWords(doc as PolicyDoc), restartWords: restartInWords(doc as PolicyDoc),
      restartWindowDescription: doc.restart ? describePolicyWindow(doc.restart.window) : null,
      currentRestartWindow: r.status === 'ACTIVE' && doc.restart ? occurrenceAt(now, doc.restart.window) : null,
      upcomingRestartWindows: r.status === 'ACTIVE' && doc.restart ? nextOccurrences(now, doc.restart.window, 3, r.expiresAt) : [],
      restarts: await this.restartRows(r.id),
      lastProposal: r.lastProposal,
      // 0.40: activated in direct mode, with no approvals (the signer's word).
      direct: signer?.status === 200 && signer.body.direct === true,
      signer: signer?.status === 200 ? { reachable: true, status: signer.body.status ?? null, signedPlans: signer.body.signedPlans ?? 0, refusals: signer.body.refusals ?? [] } : { reachable: false, status: null, signedPlans: null, refusals: [] },
      deployments,
      sweep: { enabled: PatchPolicyService.sweepEnabled(), everySeconds: PatchPolicyService.sweepSeconds() },
      mayRevoke: this.mayManage(actor, r) && !['REVOKED', 'REJECTED', 'EXPIRED'].includes(r.status),
    };
  }

  /** 0.54: the latest restart attempts under a policy, with the computer's name and the plan's state. */
  private async restartRows(policyId: string) {
    const rows = await this.prisma.patchPolicyRestart.findMany({ where: { policyId }, orderBy: { createdAt: 'desc' }, take: 30, include: { endpoint: { select: { name: true, hostname: true } } } });
    const jobs = new Map((await this.prisma.actionJob.findMany({ where: { id: { in: rows.map((x) => x.jobId).filter((x): x is string => !!x) } }, select: { id: true, status: true, targets: { select: { status: true, outcome: true, result: true } } } })).map((j) => [j.id, j]));
    return rows.map((x) => {
      const j = x.jobId ? jobs.get(x.jobId) : undefined;
      const t = j?.targets[0];
      const res = (t?.result ?? null) as { reason?: string; observed?: Record<string, string> } | null;
      return {
        endpointId: x.endpointId, computer: x.endpoint.hostname ?? x.endpoint.name, windowKey: x.windowKey, attempt: x.attempt, at: x.createdAt,
        code: x.code, message: x.message, jobId: x.jobId, jobStatus: j?.status ?? null, outcome: t?.outcome ?? null, reason: res?.reason ?? null,
        scheduledFor: res?.observed?.scheduledFor ?? null, sessionOverride: res?.observed?.sessionOverride === 'true',
      };
    });
  }

  private mayManage(actor: ActorContext, r: PatchPolicy) {
    return actor.isPlatformAdmin || r.createdById === actor.userId || (!actor.technician && actor.businessId === r.customerId && this.acl.isBusinessOwner(actor));
  }

  /** Revoke: the portal stops at once; the signer is told now and on every sweep until it confirms. One-way. */
  async revoke(actor: ActorContext, id: string, raw: unknown, now = new Date()) {
    const dto = ReasonDto.safeParse(raw ?? {});
    if (!dto.success) this.bad('INVALID_REQUEST', 'A reason of at least 3 characters is required.');
    const r = await this.scoped(actor, id);
    if (!this.mayManage(actor, r)) throw new ForbiddenException({ code: 'NOT_ALLOWED', message: 'Only whoever created the policy, a Business Owner of this business or a Platform Admin can revoke it.' });
    if (r.status === 'REVOKED') throw new ConflictException({ code: 'NOT_ALLOWED_NOW', message: 'The policy is already revoked.' });
    const reason = dto.data!.reason;
    const u = await this.prisma.patchPolicy.update({ where: { id }, data: { status: 'REVOKED', revokedAt: now, revokedById: actor.userId, revokeReason: reason } });
    const stopped = await this.stopDeployments(u, `policy revoked by ${actor.email ?? actor.userId}`);
    let confirmed = false;
    const out = this.signer.configured() ? await this.signer.revokePolicy(id, reason).catch(() => null) : null;
    if (out?.status === 200) { await this.prisma.patchPolicy.update({ where: { id }, data: { signerRevokedAt: new Date(out.body.revokedAt ?? now) } }); confirmed = true; }
    await this.audit.log({ tenantId: r.tenantId ?? undefined, customerId: r.customerId, actorId: actor.userId, actorIp: actor.ip, action: 'PATCH_POLICY_REVOKED', resource: 'patch_policy', resourceId: id, meta: { reason, from: r.status, signerConfirmed: confirmed, canceledPlans: stopped.plans, canceledDeployments: stopped.deployments } });
    // 0.50: revoking a revision by hand ends its series, so the sweep does not propose it again.
    if (u.seriesId && this.series) await this.series.onRevoked(u, 'portal', actor.userId);
    return this.detail(actor, id, now);
  }

  /**
   * 0.50: withdraw a policy the portal itself replaced or emptied (a series
   * revision superseded, a stale pending revision, an emptied series). Only
   * ever narrows: the row goes REVOKED, its open deployments stop, the signer
   * is told now and by every sweep until it confirms. Audited.
   */
  async withdraw(r: PatchPolicy, reason: string, meta: Record<string, unknown>, now = new Date()) {
    if (r.status === 'REVOKED') return r;
    const superseded = typeof meta.supersededBy === 'string';
    const u = await this.prisma.patchPolicy.update({ where: { id: r.id }, data: { status: 'REVOKED', revokedAt: now, revokeReason: reason.slice(0, 300), ...(superseded ? { supersededAt: now } : {}) } });
    const stopped = await this.stopDeployments(u, reason);
    const out = this.signer.configured() ? await this.signer.revokePolicy(r.id, reason.slice(0, 300)).catch(() => null) : null;
    if (out?.status === 200) await this.prisma.patchPolicy.update({ where: { id: r.id }, data: { signerRevokedAt: new Date(out.body.revokedAt ?? now) } });
    await this.audit.log({
      tenantId: r.tenantId ?? undefined, customerId: r.customerId, action: superseded ? 'PATCH_POLICY_SUPERSEDED' : 'PATCH_POLICY_REVOKED', resource: 'patch_policy', resourceId: r.id,
      meta: { reason, from: r.status, signerConfirmed: out?.status === 200, canceledPlans: stopped.plans, canceledDeployments: stopped.deployments, ...meta },
    });
    return u;
  }

  /** Cancel what has not reached a computer and close the policy's open deployments. Anything delivered runs to its own result. */
  private async stopDeployments(r: PatchPolicy, why: string) {
    const deps = await this.prisma.patchDeployment.findMany({ where: { policyId: r.id, status: { in: ['ACTIVE', 'PAUSED'] } }, select: { id: true } });
    let plans = 0;
    for (const j of await this.prisma.actionJob.findMany({ where: { deployment: { policyId: r.id }, status: { in: ['AWAITING_APPROVAL', 'APPROVED'] } }, select: { id: true, status: true, tenantId: true, customerId: true } })) {
      if (j.status === 'AWAITING_APPROVAL') await this.signer.cancel(j.id).catch(() => undefined);
      const c = await this.prisma.actionJob.updateMany({ where: { id: j.id, status: { in: ['AWAITING_APPROVAL', 'APPROVED'] } }, data: { status: 'CANCELED', statusReason: why.slice(0, 200) } });
      if (!c.count) continue;
      plans++;
      await this.prisma.actionTarget.updateMany({ where: { jobId: j.id, status: 'PENDING' }, data: { status: 'CANCELED', statusReason: 'plan canceled' } });
      await this.audit.log({ tenantId: j.tenantId ?? undefined, customerId: j.customerId, action: 'ACTION_CANCELED', resource: 'action_job', resourceId: j.id, meta: { reason: why, policyId: r.id } });
    }
    for (const d of deps) {
      await this.prisma.patchDeployment.update({ where: { id: d.id }, data: { status: 'CANCELED', pausedReason: why.slice(0, 200) } });
      await this.audit.log({ tenantId: r.tenantId ?? undefined, customerId: r.customerId, action: 'PATCH_DEPLOYMENT_UPDATED', resource: 'patch_deployment', resourceId: d.id, meta: { status: 'CANCELED', reason: why, policyId: r.id } });
    }
    return { plans, deployments: deps.length };
  }

  // ── Pre-flight (Platform Admin) ───────────────────────────────────────────

  /**
   * Which production prerequisites for signed patching are missing, from real
   * state only: the served repository, the signer's own answers, and the
   * computers' reported builds. Nothing here is a stored checkbox.
   */
  async preflight(actor: ActorContext) {
    if (!actor.isPlatformAdmin) throw new ForbiddenException({ code: 'NOT_ALLOWED', message: 'The patching pre-flight is for Platform Admins.' });
    type Check = { id: string; ok: boolean; title: string; detail: string; fix: string | null; step: number };
    const checks: Check[] = [];
    const add = (c: Check) => checks.push(c);

    const agent = this.updateTrust.agentTarget();
    add({ id: 'signed_release', step: 1, ok: !!agent, title: 'A signed agent release is published',
      detail: agent ? `windows/rem0te-agent.exe is served, sha256 ${agent.sha256.slice(0, 16)}…` : 'The update repository serves no signed agent build (windows/rem0te-agent.exe), so no plan can name one.',
      fix: agent ? null : `Publish one on this server: ${PUBLISH_COMMAND} (Devices → Full agent shows each step).` });

    let trustedKids: string[] = [];
    const kf = this.updateTrust.targetFile('approval/keys.json');
    if (kf) { try { const j = JSON.parse(readFileSync(kf.path, 'utf8')) as { keys?: { kid?: string }[] }; trustedKids = (j.keys ?? []).map((k) => String(k.kid)); } catch { /* reported below */ } }

    const configured = this.signer.configured();
    add({ id: 'signer_configured', step: 4, ok: configured, title: 'The portal knows where the approval signer is',
      detail: configured ? `APPROVAL_SIGNER_INTERNAL_URL is ${this.signer.base()}` : 'APPROVAL_SIGNER_INTERNAL_URL is unset or not a loopback http address.',
      fix: configured ? null : 'Install the signer (step 3) and set APPROVAL_SIGNER_INTERNAL_URL in the API environment.' });

    let caps: { patchPolicies?: number; kid?: string; roster?: { approvers: number }; approval?: { default: 'direct' | 'signed'; directBusinesses: number } } | null = null;
    let reachable = false;
    if (configured) {
      const c = await this.signer.capabilities().catch(() => null);
      reachable = !!c && (c.status === 200 || c.status === 404);
      caps = c?.status === 200 ? c.body : null;
    }
    add({ id: 'signer_reachable', step: 4, ok: reachable, title: 'The approval signer answers',
      detail: !configured ? 'Not configured.' : reachable ? 'Its internal listener answered.' : 'It did not answer on its internal listener.',
      fix: reachable ? null : 'Start the approval signer service and check its internal listen address matches.' });
    add({ id: 'signer_policies', step: 3, ok: caps?.patchPolicies === 1, title: 'The signer supports patch policies',
      detail: caps?.patchPolicies === 1 ? 'Signer 0.32 or later.' : reachable ? 'The signer answering is older than 0.32.' : 'Unknown: the signer is not reachable.',
      fix: caps?.patchPolicies === 1 ? null : 'Install the 0.32 approval signer (apps/api/scripts/build-approval-signer.mjs).' });
    const kidOk = !!caps?.kid && trustedKids.includes(caps.kid);
    add({ id: 'signer_key_published', step: 3, ok: kidOk, title: 'Agents trust the signer\'s key',
      detail: !kf ? 'approval/keys.json is not in the signed repository, so agents trust no approval key.' : !caps?.kid ? `approval/keys.json lists ${trustedKids.length} key(s); the signer's key id is unknown.` : kidOk ? `approval/keys.json lists the signer's key ${caps.kid}.` : `approval/keys.json does not list the signer's key ${caps.kid}; agents would refuse every plan it signs.`,
      fix: kidOk ? null : 'Print the signer\'s keys.json (approval-signer keys) and publish it as approval/keys.json with rem0te-release.' });
    // 0.40: direct mode (the signer operator's default) needs no approvers at all.
    const approvers = caps?.roster?.approvers ?? 0;
    const direct = caps?.approval?.default === 'direct';
    const others = caps?.approval?.directBusinesses ?? 0;
    add({ id: 'approvers', step: 5, ok: direct || approvers >= 2, title: direct ? 'Approval mode: direct' : 'Approval mode: signed — at least two approvers are enrolled',
      detail: !caps ? 'Unknown: the signer is not reachable.'
        : direct ? `The signer's default policy is in direct mode: plans and patch policies are signed as soon as they are requested, with a fresh sign-in and no approval step. ${approvers} approver(s) on the roster, for any business set to signed.`
        : `Signed mode: ${approvers} approver(s) on the roster.${others ? ` ${others} business(es) are set to direct mode on the signer.` : ''}`,
      fix: direct || approvers >= 2 ? null : 'Either turn on direct mode for a single operator (approval-signer policy set --business default --approval direct), or enrol two approvers on the signer with the fingerprint ceremony (docs/approved-actions.md, Setting it up).' });

    const key = `${UPDATE_INSTALL.id}@${UPDATE_INSTALL.version}`;
    const [windows, signed, capable, current] = await Promise.all([
      this.prisma.endpoint.count({ where: { status: { not: 'ARCHIVED' }, platform: { contains: 'windows', mode: 'insensitive' } } }).catch(() => this.prisma.endpoint.count({ where: { status: { not: 'ARCHIVED' } } })),
      this.prisma.endpoint.count({ where: { status: { not: 'ARCHIVED' }, updateChannel: 'signed' } }),
      this.prisma.endpoint.count({ where: { status: { not: 'ARCHIVED' }, updateChannel: 'signed', agentActions: { has: key } } }),
      agent ? this.prisma.endpoint.count({ where: { status: { not: 'ARCHIVED' }, updateChannel: 'signed', agentActions: { has: key }, agentSha256: agent.sha256 } }) : Promise.resolve(0),
    ]);
    add({ id: 'computers_signed', step: 2, ok: current > 0, title: 'Computers are on the signed channel, on the published build',
      detail: `${signed} of ${windows} computer(s) on the signed channel; ${capable} report the update action; ${current} run the published build.`,
      fix: current > 0 ? null : 'Migrate computers to the signed channel (Devices → Full agent: automatic, canary first) and let them update to the published build.' });
    const withPosture = await this.prisma.endpointInventory.count({ where: { patchScannedAt: { not: null }, endpoint: { updateChannel: 'signed', status: { not: 'ARCHIVED' } } } });
    add({ id: 'computers_scanned', step: 2, ok: withPosture > 0, title: 'Signed computers have reported a Windows Update scan',
      detail: `${withPosture} signed computer(s) have a signed scan.`,
      fix: withPosture > 0 ? null : 'Press Scan now on a signed computer\'s Patches tab.' });
    const activePolicies = await this.prisma.patchPolicy.count({ where: { status: 'ACTIVE' } });
    add({ id: 'sweep', step: 6, ok: PatchPolicyService.sweepEnabled(), title: 'The policy sweep is running',
      detail: PatchPolicyService.sweepEnabled() ? `Every ${PatchPolicyService.sweepSeconds()} s; ${activePolicies} active polic${activePolicies === 1 ? 'y' : 'ies'}.` : 'PATCH_POLICY_SWEEP=off: approved policies are never acted on.',
      fix: PatchPolicyService.sweepEnabled() ? null : 'Remove PATCH_POLICY_SWEEP=off from the API environment.' });
    return { ready: checks.every((c) => c.ok), checks, fixtureTestedOnly: true };
  }
}

export type { PolicyWindow };
