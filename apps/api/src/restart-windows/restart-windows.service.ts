import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, type AutomationPolicy, type RestartWindowSetting } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { ActorResolverService } from '../rbac/actor-resolver.service';
import { AccessPolicyService } from '../security-controls/access-policy.service';
import { assertFresh } from '../security-controls/review';
import { CAP } from '../rbac/capabilities';
import { ActionsService } from '../actions/actions.service';
import { SignerClient } from '../actions/signer.client';
import { REBOOT_SCHEDULE, RESTART_FLAGS_MIN_AGENT, UPDATE_INSTALL } from '../actions/catalog';
import { MAX_RESTART_PLAN_HOURS, PolicyWindow, RESTART_RULES, describePolicyWindow, nextOccurrence, nextOccurrences, occurrenceAt, restartRuleOf, type RestartRule } from '../actions/patch-policy';
import {
  AutomationDoc, MAX_AUTOMATION_DAYS, MAX_RUNS_PER_OCCURRENCE, MIN_RESTART_WINDOW_MINUTES, RESTART_WINDOW_DELAY_MINUTES, restartParamsFor, taskInWords, type RestartTask,
} from '../actions/automation-policy';
import { AutomationService } from '../automation/automation.service';
import { ContainmentService } from '../containment/containment.service';
import { GroupMembershipService } from '../group-policy/membership.service';
import { PRIORITY_MAX, PRIORITY_MIN } from '../group-policy/precedence';
import { Posture } from '../patching/posture';
import { connectivityOf } from '../common/connectivity';
import { compareVersions } from '../common/agent-contract';
import { effectiveSetting, inForce, mayRetry, sourceInWords, type RestartScope, type SettingLike } from './resolve';

/**
 * The simple restart window (0.60, docs/restart-windows.md).
 *
 * A person sets "restart if Windows needs it (or always), nightly 02:00–04:00
 * in this time zone" on a business — the default for its computers — on a
 * device group, or on one computer, which may instead say "no automatic
 * restarts". Precedence is computer > group (priority) > business
 * (resolve.ts, the 0.35 rule).
 *
 * Nothing here restarts anything by itself. A window is an automation policy
 * (0.58) whose task is `restart`, proposed through AutomationService and
 * approved on the approval signer by two people with passkeys, or active at
 * once in direct mode (§58). Inside an open window, RESTART_WINDOW_SWEEP
 * asks the signer, through ActionsService.createPlan, for one
 * windows.reboot.schedule plan per computer the window governs — with the
 * fixed 15-minute warning, onlyIfRequired under "if required", and the
 * RustDesk exception only if a person ticked it. The signer decides each
 * plan against the approved window (evaluateAutomationRestart): the
 * computer's business, the window, the warning, the rule, at most three
 * plans per computer per window, none while one is open. The agent decides
 * again from Windows' own state. A plan deferred by a RustDesk session (or
 * "cannot tell"), or one that never reached the computer, is asked for again
 * 15 minutes later in the same window, and in the next window.
 *
 * "No automatic restarts" (mode off) is a portal setting only: it narrows,
 * so it needs no signer and no fresh sign-in. Anything that can make a
 * computer restart where it would not before — setting a window, or removing
 * a computer's or group's own setting so it inherits one — needs a fresh
 * sign-in (catalog key restart.window).
 */

const Id = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const Reason = z.string().trim().min(3).max(500);
export const SetWindowDto = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('window'),
    rule: z.enum(RESTART_RULES),
    window: PolicyWindow,
    /** Present only when a person ticked it; never by default (§67). */
    ignoreRemoteSession: z.literal(true).optional(),
    priority: z.number().int().min(PRIORITY_MIN).max(PRIORITY_MAX).optional(),
    expiresInDays: z.number().int().min(7).max(MAX_AUTOMATION_DAYS).default(MAX_AUTOMATION_DAYS),
    reason: Reason.optional(),
  }).strict(),
  z.object({
    mode: z.literal('off'),
    priority: z.number().int().min(PRIORITY_MIN).max(PRIORITY_MAX).optional(),
    reason: Reason.optional(),
  }).strict(),
]);
const ClearDto = z.object({ reason: Reason.optional() }).strict();
export const BulkDto = z.object({
  endpointIds: z.array(Id).min(1).max(200),
  mode: z.enum(['off', 'inherit']),
  reason: Reason.optional(),
}).strict();

/** The sweep's pace and bounds. */
const RESTART_RETRY_MS = 15 * 60_000;
/** A restart plan is valid this long (the same as 0.54's): the next attempt comes after it closes. */
const RESTART_PLAN_MS = RESTART_RETRY_MS;
/** Less than this left for a plan and nothing is asked in this window. */
const MIN_RESTART_PLAN_MS = 10 * 60_000;
/** The most plans one pass asks for, across every business. The rest wait for the next pass. */
const MAX_PLANS_PER_PASS = 100;
/** Three tries per computer per window: the first and two retries. */
export const RESTART_ATTEMPTS = MAX_RUNS_PER_OCCURRENCE;
/** A window is shown as "renew soon" this many days before it expires. */
export const RENEW_WARNING_DAYS = 14;

type SettingRow = RestartWindowSetting & { policy: AutomationPolicy | null; pendingPolicy: AutomationPolicy | null; group: { name: string } | null; endpoint: { name: string; hostname: string | null } | null };

@Injectable()
export class RestartWindowsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('RestartWindows');
  private timer: ReturnType<typeof setInterval> | null = null;
  private first: ReturnType<typeof setTimeout> | null = null;
  private busy = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly acl: AccessControlService,
    private readonly actors: ActorResolverService,
    private readonly access: AccessPolicyService,
    private readonly actions: ActionsService,
    private readonly signer: SignerClient,
    private readonly automation: AutomationService,
    private readonly containment: ContainmentService,
    private readonly membership: GroupMembershipService,
  ) {}

  // ── The sweep ─────────────────────────────────────────────────────────────

  static sweepEnabled() { return process.env.RESTART_WINDOW_SWEEP !== 'off'; }
  static sweepSeconds() { return Math.max(2, Number(process.env.RESTART_WINDOW_SWEEP_SECONDS) || 60); }

  onModuleInit() {
    if (!RestartWindowsService.sweepEnabled()) return;
    const every = RestartWindowsService.sweepSeconds() * 1000;
    this.first = setTimeout(() => { void this.sweep(); }, Math.min(30_000, every));
    this.timer = setInterval(() => { void this.sweep(); }, every);
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); if (this.first) clearTimeout(this.first); }

  /** One pass: mirror every restart window's policy from the signer, settle the settings, then ask for the restarts that are due. */
  async sweep(now = new Date()) {
    if (this.busy) return;
    this.busy = true;
    try {
      const pols = await this.prisma.automationPolicy.findMany({
        where: { taskKind: 'restart', OR: [{ status: { in: ['AWAITING_APPROVAL', 'ACTIVE'] } }, { status: 'REVOKED', signerRevokedAt: null }] },
        orderBy: { createdAt: 'asc' }, take: 500,
      });
      for (const p of pols) { try { await this.automation.mirror(p, now); } catch (e) { this.logger.warn(`restart window policy ${p.id}: ${(e as Error).message}`); } }
      await this.settle();
      const businesses = await this.prisma.restartWindowSetting.findMany({
        where: { mode: 'window', policy: { status: 'ACTIVE', pausedAt: null, expiresAt: { gt: now } } },
        select: { customerId: true }, distinct: ['customerId'],
      });
      let budget = MAX_PLANS_PER_PASS;
      for (const b of businesses) {
        if (budget <= 0) break;
        try { budget -= await this.proposeFor(b.customerId, now, budget); } catch (e) { this.logger.warn(`restart windows of ${b.customerId}: ${(e as Error).message}`); }
      }
    } finally { this.busy = false; }
  }

  /** A change approved on the signer takes over from the window it replaces; a refused or lapsed change is dropped. */
  async settle() {
    const rows = await this.prisma.restartWindowSetting.findMany({ where: { pendingPolicyId: { not: null } }, include: { pendingPolicy: true } });
    for (const s of rows) {
      const p = s.pendingPolicy;
      if (p?.status === 'ACTIVE') {
        await this.prisma.restartWindowSetting.updateMany({ where: { id: s.id, pendingPolicyId: p.id }, data: { policyId: p.id, pendingPolicyId: null } });
      } else if (!p || ['REJECTED', 'EXPIRED', 'REVOKED'].includes(p.status)) {
        await this.prisma.restartWindowSetting.updateMany({ where: { id: s.id, pendingPolicyId: s.pendingPolicyId }, data: { pendingPolicyId: null } });
      }
    }
  }

  /** Every setting of one business, with the names the pages need. */
  private settingsOf(customerId: string): Promise<SettingRow[]> {
    return this.prisma.restartWindowSetting.findMany({
      where: { customerId },
      include: { policy: true, pendingPolicy: true, group: { select: { name: true } }, endpoint: { select: { name: true, hostname: true } } },
      orderBy: [{ scope: 'asc' }, { priority: 'asc' }, { createdAt: 'asc' }],
    });
  }

  private static like(s: SettingRow): SettingLike & { row: SettingRow } {
    return {
      id: s.id, scope: s.scope as RestartScope, customerId: s.customerId, groupId: s.groupId, endpointId: s.endpointId, priority: s.priority,
      mode: s.mode === 'off' ? 'off' : 'window', policyLive: !!s.policy && s.policy.status === 'ACTIVE' && !s.policy.pausedAt && s.policy.expiresAt > new Date(),
      row: s,
    };
  }

  /** Which computers a patch policy's own restart window governs (0.54): never restarted by a simple window as well. */
  private async patchPolicyRestarts(endpointIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!endpointIds.length) return out;
    const rows = await this.prisma.patchPolicyComputer.findMany({
      where: { endpointId: { in: endpointIds }, live: true, policy: { status: 'ACTIVE' } },
      select: { endpointId: true, policy: { select: { name: true, document: true } } },
    });
    for (const r of rows) if (restartRuleOf((r.policy.document ?? {}) as { restart?: unknown })) out.set(r.endpointId, r.policy.name);
    return out;
  }

  /** Inside each open window of this business: ask for the restarts that are due. Returns how many plans it asked for. */
  private async proposeFor(customerId: string, now: Date, budget: number): Promise<number> {
    const settings = (await this.settingsOf(customerId)).map(RestartWindowsService.like);
    const open = new Map<string, { s: SettingRow; doc: AutomationDoc; occ: { start: Date; end: Date } }>();
    for (const x of settings) {
      if (x.mode !== 'window' || !x.policyLive || !x.row.policy) continue;
      const doc = AutomationDoc.safeParse(x.row.policy.document);
      if (!doc.success || doc.data.task.kind !== 'restart') continue;
      const w = PolicyWindow.safeParse(doc.data.recurrence);
      const occ = w.success ? occurrenceAt(now, w.data) : null;
      if (occ) open.set(x.row.policy.id, { s: x.row, doc: doc.data, occ });
    }
    if (!open.size) return 0;
    // Containment pauses every action of the business, restarts included.
    if (await this.containment.blocking('actions', customerId)) {
      for (const o of open.values()) await this.note(o.s.policy!, 'contained', 'Containment pauses actions for this business; no restart is asked for until it is lifted.', now);
      return 0;
    }
    const eps = await this.prisma.endpoint.findMany({
      where: { customerId, status: { not: 'ARCHIVED' } },
      select: { id: true, name: true, hostname: true, isOnline: true, lastSeenAt: true, updateChannel: true, agentVersion: true, rustdeskNode: { select: { rustdeskId: true, agentSecretHash: true } } },
      orderBy: { id: 'asc' },
    });
    const groupIds = settings.filter((s) => s.scope === 'group' && s.groupId).map((s) => s.groupId!);
    const members = await this.membership.snapshot(groupIds, eps.map((e) => e.id));
    const patchGoverned = await this.patchPolicyRestarts(eps.map((e) => e.id));
    const actors = new Map<string, ActorContext | null>();
    let asked = 0;
    for (const ep of eps) {
      if (asked >= budget) break;
      const eff = effectiveSetting({ id: ep.id, customerId, groupIds: members.groupsOf(ep.id) }, settings);
      const w = eff.winner;
      if (!w || w.mode !== 'window' || !w.row.policyId) continue;
      const o = open.get(w.row.policyId);
      if (!o || patchGoverned.has(ep.id)) continue;
      const p = o.s.policy!;
      if (!actors.has(p.id)) actors.set(p.id, await this.actors.contextFor(o.doc.createdBy.userId, p.tenantId ?? '', customerId));
      const actor = actors.get(p.id)!;
      if (!actor) { await this.note(p, 'author_inactive', `${o.doc.createdBy.name}, who set this restart window, is no longer active or no longer reaches this business. Restarts are requested on their behalf, so none is. Set the window again.`, now); continue; }
      try { if (await this.restartOne(p, o.doc, o.occ, actor, ep, now)) asked++; } catch (e) { this.logger.warn(`restart window ${p.id} on ${ep.id}: ${(e as Error).message}`); }
    }
    return asked;
  }

  /** The policy's last word from the sweep, for the pages. Written only when it changes. */
  private async note(p: AutomationPolicy, code: string, message: string, now: Date) {
    const last = p.lastProposal as { code?: string } | null;
    if (last?.code === code) return;
    await this.prisma.automationPolicy.update({ where: { id: p.id }, data: { lastProposal: { at: now.toISOString(), occurrence: null, ok: false, code, message } as Prisma.InputJsonValue } });
  }

  /** Does Windows say this computer needs a restart? Its signed scan's word, else its inventory's. */
  async restartRequired(endpointId: string): Promise<boolean | null> {
    const inv = await this.prisma.endpointInventory.findUnique({ where: { endpointId }, select: { patchPosture: true, rebootRequired: true } });
    const p = Posture.safeParse(inv?.patchPosture);
    if (p.success && p.data.reboot) return !!p.data.reboot.pending;
    return inv?.rebootRequired ?? null;
  }

  /** Why this computer is not asked to restart now, or null. Only reads. */
  private async skipReason(doc: AutomationDoc, ep: { id: string; isOnline: boolean; lastSeenAt: Date | null; updateChannel: string | null; agentVersion: string | null; rustdeskNode: { rustdeskId: string; agentSecretHash: string | null } | null }, now: Date): Promise<string | null> {
    const task = doc.task as RestartTask;
    if (connectivityOf(ep.isOnline, ep.lastSeenAt, now.getTime()) !== 'online') return 'offline';
    if (ep.updateChannel !== 'signed' || !ep.rustdeskNode?.agentSecretHash) return 'not_signed_agent';
    if (doc.targets.kind === 'computers') {
      const c = doc.targets.computers.find((x) => x.endpointId === ep.id);
      if (!c || c.rustdeskId !== ep.rustdeskNode.rustdeskId || c.deviceSecretSha256 !== ep.rustdeskNode.agentSecretHash) return 're_enrolled';
    }
    const flags = Object.keys(restartParamsFor(task)).length > 1;
    if (flags && (!ep.agentVersion || compareVersions(ep.agentVersion, RESTART_FLAGS_MIN_AGENT) < 0)) return 'agent_too_old';
    if (task.rule === 'if_required' && (await this.restartRequired(ep.id)) !== true) return 'not_required';
    if (await this.actions.blocking(ep.id, UPDATE_INSTALL.id)) return 'install_open';
    if (await this.actions.blocking(ep.id, REBOOT_SCHEDULE.id)) return 'restart_open';
    return null;
  }

  /** One computer, in one open window: at most three plans, the next only after the last was deferred or never delivered. Returns whether it asked. */
  private async restartOne(p: AutomationPolicy, doc: AutomationDoc, occ: { start: Date; end: Date }, actor: ActorContext, ep: Parameters<RestartWindowsService['skipReason']>[1] & { name: string; hostname: string | null }, now: Date): Promise<boolean> {
    const windowKey = occ.start.toISOString();
    // Picked up by notAfter at the latest, restarted the warning later: the restart itself falls inside the window.
    const notAfter = new Date(Math.min(occ.end.getTime() - RESTART_WINDOW_DELAY_MINUTES * 60_000, now.getTime() + Math.min(RESTART_PLAN_MS, MAX_RESTART_PLAN_HOURS * 3_600_000), p.expiresAt.getTime()));
    if (notAfter.getTime() - now.getTime() < MIN_RESTART_PLAN_MS) return false;
    const rows = await this.prisma.restartWindowAttempt.findMany({ where: { policyId: p.id, endpointId: ep.id, windowKey }, orderBy: { attempt: 'asc' } });
    const last = rows[rows.length - 1];
    if (last) {
      if (rows.length >= Math.min(doc.maxRunsPerOccurrence, RESTART_ATTEMPTS)) return false;
      if (now.getTime() - last.updatedAt.getTime() < RESTART_RETRY_MS) return false;
      if (last.jobId) {
        // A plan nobody picked up before its window closed is rolled up first, so it reads as expired.
        await this.actions.rollup(last.jobId, now).catch(() => undefined);
        const j = await this.prisma.actionJob.findUnique({ where: { id: last.jobId }, select: { status: true, targets: { where: { endpointId: ep.id }, select: { status: true, result: true } } } });
        const t = j?.targets[0];
        if (!mayRetry({ jobId: last.jobId, jobStatus: j?.status ?? null, targetStatus: t?.status ?? null, reason: (t?.result as { reason?: string } | null)?.reason ?? null })) return false;
      }
    }
    if (await this.skipReason(doc, ep, now)) return false;
    const attempt = (last?.attempt ?? 0) + 1;
    let row: { id: string };
    try {
      row = await this.prisma.restartWindowAttempt.create({ data: { policyId: p.id, endpointId: ep.id, customerId: p.customerId, windowKey, attempt, code: 'claimed', message: 'Asking the signer for a restart plan.' }, select: { id: true } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return false; // another sweep took this attempt
      throw e;
    }
    const task = doc.task as RestartTask;
    try {
      const job = await this.actions.createPlan(actor, {
        action: REBOOT_SCHEDULE, endpointIds: [ep.id], params: restartParamsFor(task),
        reason: `${doc.name}, window ${windowKey}${attempt > 1 ? `, attempt ${attempt}` : ''}`.slice(0, 400), startsInMinutes: 0, windowHours: MAX_RESTART_PLAN_HOURS,
        window: { notBefore: now, notAfter },
        display: { updates: [], deployment: null, policy: { id: p.id, name: doc.name.slice(0, 120), digest: p.digest } },
        underPolicy: { policyId: p.id, digest: p.digest, evidence: null, kind: 'automation' },
      });
      await this.prisma.restartWindowAttempt.update({ where: { id: row.id }, data: { jobId: job.id, code: 'signed', message: `Restart plan signed; the computer picks it up by ${notAfter.toISOString()} and restarts ${RESTART_WINDOW_DELAY_MINUTES} minutes later.` } });
      if ((p.lastProposal as { code?: string } | null)?.code) await this.prisma.automationPolicy.update({ where: { id: p.id }, data: { lastProposal: Prisma.DbNull } });
    } catch (e) {
      const b = (e as { getResponse?: () => { code?: string; signerCode?: string | null; message?: string } }).getResponse?.();
      await this.prisma.restartWindowAttempt.update({ where: { id: row.id }, data: { code: (b?.signerCode ?? b?.code ?? 'request_failed').slice(0, 64), message: (b?.message ?? (e as Error).message).slice(0, 400) } });
    }
    return true;
  }

  // ── Who may ───────────────────────────────────────────────────────────────

  private bad(code: string, message: string): never { throw new BadRequestException({ code, message }); }

  private isMsp(a: ActorContext) {
    return a.isPlatformAdmin || (!a.technician && (a.platformPermissions ?? []).includes('technicians:manage' as never));
  }

  /** May this person change the restart windows of a business (its own, or a group's)? The refusal, or null. Client updates' rule, plus requesting actions. */
  editRefusal(a: ActorContext, customerId: string): string | null {
    if (this.isMsp(a)) return null;
    if (a.technician) {
      if (a.technician.businessId !== customerId) return 'You are not assigned to this business.';
      const whole = a.technician.sources.some((s) => s.endpointIds === null && (s.capabilities as string[]).includes(CAP.COMPUTERS_EDIT) && (s.capabilities as string[]).includes(CAP.ACTIONS_REQUEST));
      return whole ? null : 'Setting a restart window needs an assignment that grants computers:edit and actions:request over the whole business.';
    }
    if (a.businessId !== customerId) return 'You do not have access to that business.';
    if (this.acl.isBusinessOwner(a)) return null;
    return 'A restart window is set by a Business Owner of this business, a technician with computers:edit and actions:request over the whole business, or the MSP.';
  }

  /** May this person change one computer's own setting? */
  private async computerRefusal(a: ActorContext, endpointId: string): Promise<string | null> {
    await this.acl.assertEndpointInScope(a, endpointId);
    if (a.isPlatformAdmin) return null;
    if (!this.acl.can(a, CAP.COMPUTERS_EDIT)) return 'Changing this computer\'s restart window needs computers:edit.';
    if (!this.acl.can(a, CAP.ACTIONS_REQUEST)) return 'Changing this computer\'s restart window needs actions:request: its restarts are requested on your behalf.';
    try { await this.acl.assertEndpointInScope(a, endpointId, CAP.COMPUTERS_EDIT); } catch { return 'Changing this computer\'s restart window needs computers:edit on it.'; }
    return null;
  }

  private assertView(a: ActorContext) {
    if (!this.acl.can(a, CAP.COMPUTERS_VIEW) && !a.technician) throw new ForbiddenException({ code: 'NOT_ALLOWED', message: 'Seeing restart windows needs computers:view.' });
  }

  // ── Reading ───────────────────────────────────────────────────────────────

  private async readiness() {
    const r = await this.automation.readiness();
    return {
      signerConfigured: r.signerConfigured, signerSupportsRestartWindows: r.signerSupportsRestartWindows,
      sweep: { enabled: RestartWindowsService.sweepEnabled(), everySeconds: RestartWindowsService.sweepSeconds() },
      why: !r.signerConfigured ? 'Restart windows need the approval signer: every automatic restart is a signed plan.'
        : !r.signerSupportsRestartWindows ? 'The approval signer answering is older than 0.60 and does not support restart windows. Install the 0.60 signer.' : null,
    };
  }

  /** One policy as a page shows it. */
  private policyView(p: AutomationPolicy | null, now: Date) {
    if (!p) return null;
    const doc = AutomationDoc.safeParse(p.document);
    if (!doc.success || doc.data.task.kind !== 'restart') return null;
    const d = doc.data;
    const task = d.task as RestartTask;
    const w = PolicyWindow.safeParse(d.recurrence);
    const live = p.status === 'ACTIVE' && !p.pausedAt && p.expiresAt > now;
    return {
      id: p.id, status: p.status, paused: !!p.pausedAt, direct: p.direct, approvalUrl: p.approvalUrl,
      approvals: Array.isArray(p.approvals) ? (p.approvals as unknown[]).length : 0,
      rule: task.rule, ignoreRemoteSession: task.ignoreRemoteSession === true,
      window: w.success ? w.data : null, description: w.success ? describePolicyWindow(w.data) : 'an unrecognised window',
      does: taskInWords(task),
      expiresAt: p.expiresAt, expiresSoon: live && p.expiresAt.getTime() - now.getTime() < RENEW_WARNING_DAYS * 86_400_000,
      nextWindow: live && w.success ? nextOccurrence(now, w.data, p.expiresAt) : null,
      upcoming: live && w.success ? nextOccurrences(now, w.data, 3, p.expiresAt) : [],
      setBy: d.createdBy.name, setAt: p.createdAt, reason: d.reason,
      lastNote: p.lastProposal as { at: string; code: string; message: string } | null,
    };
  }

  private settingView(s: SettingRow, now: Date) {
    const like = RestartWindowsService.like(s);
    const policy = this.policyView(s.policy, now);
    const pending = this.policyView(s.pendingPolicy, now);
    const why = s.mode === 'off' ? null
      : !s.policy ? 'its restart window is gone'
        : s.policy.status === 'AWAITING_APPROVAL' ? 'it is waiting for approval on the approval signer'
          : s.policy.status === 'REJECTED' ? 'it was rejected on the approval signer'
            : s.policy.status === 'REVOKED' ? 'it was revoked'
              : s.policy.status === 'EXPIRED' || s.policy.expiresAt <= now ? 'it expired; set it again (Renew)'
                : s.policy.pausedAt ? 'it is paused' : null;
    return {
      id: s.id, scope: s.scope, mode: s.mode, priority: s.priority,
      groupId: s.groupId, groupName: s.group?.name ?? null, endpointId: s.endpointId, computer: s.endpoint ? (s.endpoint.hostname ?? s.endpoint.name) : null,
      inForce: inForce(like), notInForceBecause: inForce(like) ? null : why,
      window: policy, pending, updatedAt: s.updatedAt,
    };
  }

  /** A business's restart windows: its own, its groups', and the computers with their own setting. */
  async forBusiness(actor: ActorContext, businessId: string, now = new Date()) {
    if (!Id.safeParse(businessId).success) throw new NotFoundException('Business not found');
    await this.acl.assertBusinessInScope(actor, businessId);
    this.assertView(actor);
    const biz = await this.prisma.customer.findUnique({ where: { id: businessId }, select: { name: true } });
    if (!biz) throw new NotFoundException('Business not found');
    const rows = await this.settingsOf(businessId);
    // A computer this person cannot see is not named.
    const visible = new Set((await this.prisma.endpoint.findMany({ where: { AND: [{ customerId: businessId }, this.acl.endpointVisibilityWhere(actor, businessId)] }, select: { id: true } })).map((e) => e.id));
    const groups = await this.prisma.endpointGroup.findMany({ where: { customerId: businessId }, select: { id: true, name: true, kind: true }, orderBy: { name: 'asc' } });
    const refusal = this.editRefusal(actor, businessId);
    return {
      businessId, businessName: biz.name,
      readiness: await this.readiness(),
      approval: await this.actions.approvalModeForBusiness(actor, businessId).catch(() => null),
      contained: await this.containment.blocking('actions', businessId).then((b) => !!b).catch(() => false),
      business: (() => { const b = rows.find((r) => r.scope === 'business'); return b ? this.settingView(b, now) : null; })(),
      groups: rows.filter((r) => r.scope === 'group').map((r) => this.settingView(r, now)),
      computers: rows.filter((r) => r.scope === 'computer' && visible.has(r.endpointId!)).map((r) => this.settingView(r, now)),
      // The window has one IANA zone; the page offers the business's sites' zones first.
      siteTimezones: [...new Set((await this.prisma.site.findMany({ where: { customerId: businessId, timezone: { not: null } }, select: { timezone: true } })).map((s) => s.timezone!).filter(Boolean))].slice(0, 20),
      availableGroups: groups.filter((g) => !rows.some((r) => r.groupId === g.id)).map((g) => ({ id: g.id, name: g.name, kind: g.kind === 'RULE' ? 'rule' : 'static' })),
      may: { edit: refusal === null, reason: refusal },
      attemptsLast7Days: await this.attemptCounts({ customerId: businessId }, now),
    };
  }

  private async attemptCounts(where: Prisma.RestartWindowAttemptWhereInput, now: Date) {
    const rows = await this.prisma.restartWindowAttempt.findMany({ where: { ...where, createdAt: { gte: new Date(now.getTime() - 7 * 86_400_000) } }, select: { code: true } });
    return { asked: rows.length, signed: rows.filter((r) => r.code === 'signed').length, refused: rows.filter((r) => !['signed', 'claimed'].includes(r.code)).length };
  }

  /**
   * One computer: its own setting, the setting that governs it and where it
   * comes from, the next window, and what happened lately. What the Patches
   * tab's card and its "restart required" banner say.
   */
  async forComputer(actor: ActorContext, endpointId: string, now = new Date()) {
    if (!Id.safeParse(endpointId).success) throw new NotFoundException('Computer not found');
    await this.acl.assertEndpointInScope(actor, endpointId);
    const ep = await this.prisma.endpoint.findUnique({ where: { id: endpointId }, select: { id: true, name: true, hostname: true, customerId: true, isOnline: true, lastSeenAt: true, updateChannel: true, agentVersion: true, platform: true, customer: { select: { name: true } }, site: { select: { timezone: true } } } });
    if (!ep) throw new NotFoundException('Computer not found');
    const pending = await this.restartRequired(endpointId);
    if (!ep.customerId) {
      return { endpointId, own: null, effective: null, notInForce: [], text: 'This computer is in no business, so no restart window applies to it.', restartPending: pending, attempts: [], may: { edit: false, reason: 'Assign the computer to a business first.' }, readiness: await this.readiness(), patchPolicy: null };
    }
    const rows = await this.settingsOf(ep.customerId);
    const groupIds = rows.filter((r) => r.scope === 'group' && r.groupId).map((r) => r.groupId!);
    const members = await this.membership.snapshot(groupIds, [endpointId]);
    const like = rows.map(RestartWindowsService.like);
    const eff = effectiveSetting({ id: endpointId, customerId: ep.customerId, groupIds: members.groupsOf(endpointId) }, like);
    const patchPolicy = (await this.patchPolicyRestarts([endpointId])).get(endpointId) ?? null;
    const own = rows.find((r) => r.scope === 'computer' && r.endpointId === endpointId) ?? null;
    const names = (s: SettingRow) => ({ group: s.group?.name ?? null, business: ep.customer?.name ?? null });
    const effective = eff.winner ? { ...this.settingView(eff.winner.row, now), source: sourceInWords(eff.winner, names(eff.winner.row)) } : null;
    const attempts = await this.prisma.restartWindowAttempt.findMany({ where: { endpointId }, orderBy: { createdAt: 'desc' }, take: 10 });
    const jobs = new Map((await this.prisma.actionJob.findMany({ where: { id: { in: attempts.map((a) => a.jobId).filter((x): x is string => !!x) } }, select: { id: true, status: true, targets: { where: { endpointId }, select: { status: true, outcome: true, result: true, resultAt: true } } } })).map((j) => [j.id, j]));
    const attemptViews = attempts.map((a) => {
      const j = a.jobId ? jobs.get(a.jobId) : undefined;
      const t = j?.targets[0];
      const result = t?.result as { reason?: string; observed?: { scheduledFor?: string } } | null | undefined;
      return { at: a.createdAt, windowKey: a.windowKey, attempt: a.attempt, code: a.code, message: a.message, jobId: a.jobId, jobStatus: j?.status ?? null, targetStatus: t?.status ?? null, outcome: t?.outcome ?? null, reason: result?.reason ?? null, scheduledFor: result?.observed?.scheduledFor ?? null, resultAt: t?.resultAt ?? null };
    });
    const refusal = await this.computerRefusal(actor, endpointId).catch(() => 'You cannot change this computer.');
    return {
      endpointId, businessId: ep.customerId, businessName: ep.customer?.name ?? null, siteTimezone: ep.site?.timezone ?? null,
      own: own ? this.settingView(own, now) : null,
      effective, patchPolicy,
      notInForce: eff.notInForce.map((s) => ({ ...this.settingView(s.row, now), source: sourceInWords(s, names(s.row)) })),
      restartPending: pending,
      text: this.sentence(effective, eff.notInForce.map((s) => ({ ...this.settingView(s.row, now), source: sourceInWords(s, names(s.row)) })), patchPolicy, pending, attemptViews[0] ?? null, ep, now),
      attempts: attemptViews,
      may: { edit: refusal === null, reason: refusal },
      readiness: await this.readiness(),
      approval: await this.actions.approvalModeFor(actor, endpointId).catch(() => null),
    };
  }

  /** One sentence for the banner: whether, and when, this computer will be restarted automatically. */
  private sentence(
    effective: (ReturnType<RestartWindowsService['settingView']> & { source: string }) | null,
    notInForce: (ReturnType<RestartWindowsService['settingView']> & { source: string })[],
    patchPolicy: string | null, pending: boolean | null,
    last: { code: string; reason: string | null; scheduledFor: string | null; at: Date; targetStatus: string | null } | null,
    ep: { isOnline: boolean; lastSeenAt: Date | null; updateChannel: string | null }, now: Date,
  ): string {
    if (patchPolicy) return `Its patch policy "${patchPolicy}" has its own restart window, which restarts it; a simple restart window does not as well.`;
    const waiting = notInForce.length ? ` (${notInForce[0].source}: not in force — ${notInForce[0].notInForceBecause})` : '';
    if (!effective) return `No restart window applies, so this computer is never restarted automatically${waiting}. Set one on its business, a device group or this computer.`;
    if (effective.mode === 'off') return `No automatic restarts (${effective.source}).${waiting}`;
    const w = effective.window!;
    const tz = w.window?.timezone ?? 'UTC';
    const at = (x: Date | string) => `${new Date(x).toLocaleString('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })}`;
    const nw = w.nextWindow ? `${at(w.nextWindow.start)}–${new Date(w.nextWindow.end).toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false })} ${tz}` : null;
    if (last?.scheduledFor && Date.parse(last.scheduledFor) > now.getTime() - 3_600_000) return `Restart scheduled for ${at(last.scheduledFor)} ${tz} by the restart window (${effective.source}).`;
    const signed = ep.updateChannel === 'signed';
    const head = w.rule === 'always' ? 'Restarts in every restart window (maintenance restart)' : pending === false ? 'No restart is pending. If Windows asks for one, it restarts in the restart window' : 'Restarts automatically if Windows needs it';
    const when = nw ? `, next window ${nw}` : '';
    const deferred = last && last.reason && ['remote_session_open', 'session_state_unknown'].includes(last.reason) ? ' The last try was deferred because a technician was connected through RustDesk (or the computer could not tell); it is tried again 15 minutes later, and in the next window.' : '';
    const caveat = !signed ? ' It runs the standard agent, so nothing is restarted until it moves to the signed agent.' : '';
    return `${head}${when} (${effective.source}).${deferred}${caveat}${waiting && effective.scope !== 'computer' ? waiting : ''}`;
  }

  // ── Writing ───────────────────────────────────────────────────────────────

  private nameFor(scope: RestartScope, label: string) { return `Restart window — ${label}`.slice(0, 120); }

  /**
   * Set (or change) a window, or "no automatic restarts", for one scope.
   * A window is a new automation policy: the first is the setting's; a
   * change replaces the one in force only once it is approved (pending until
   * then). Off withdraws any window at once and asks the signer for nothing.
   */
  private async write(actor: ActorContext, freshMethod: string | null, raw: unknown, target: { scope: RestartScope; customerId: string; groupId?: string; endpointId?: string; label: string; computers?: AutomationDoc['targets'] }, now: Date) {
    const parsed = SetWindowDto.safeParse(raw);
    if (!parsed.success) this.bad('INVALID_REQUEST', parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const dto = parsed.data!;
    if (target.scope === 'business' && dto.mode === 'off') this.bad('INVALID_REQUEST', 'A business has a restart window or none. To stop automatic restarts for the whole business, remove its window.');
    if (target.scope !== 'group' && dto.priority !== undefined) this.bad('INVALID_REQUEST', 'Only a device group\'s setting has a priority.');
    const existing = await this.prisma.restartWindowSetting.findFirst({
      where: target.scope === 'business' ? { customerId: target.customerId, scope: 'business' } : target.scope === 'group' ? { groupId: target.groupId } : { endpointId: target.endpointId },
      include: { policy: true, pendingPolicy: true },
    });
    const priority = target.scope !== 'group' ? null : dto.priority ?? existing?.priority ?? await this.nextPriority(target.customerId);
    if (target.scope === 'group' && priority !== null) {
      const clash = await this.prisma.restartWindowSetting.findFirst({ where: { customerId: target.customerId, scope: 'group', priority, ...(existing ? { id: { not: existing.id } } : {}) }, include: { group: { select: { name: true } } } });
      if (clash) throw new ConflictException({ code: 'PRIORITY_TAKEN', message: `Priority ${priority} is already the device group "${clash.group?.name ?? clash.groupId}"'s. Two groups never share one; pick another.` });
    }

    if (dto.mode === 'off') {
      // Narrowing: no signer, no fresh sign-in.
      const withdrawn = await this.withdraw(existing, `set to no automatic restarts by ${actor.email ?? actor.userId}`);
      const data = { mode: 'off', policyId: null, pendingPolicyId: null, priority, updatedById: actor.userId };
      const row = existing
        ? await this.prisma.restartWindowSetting.update({ where: { id: existing.id }, data })
        : await this.prisma.restartWindowSetting.create({ data: { ...data, tenantId: actor.tenantId ?? null, customerId: target.customerId, scope: target.scope, groupId: target.groupId ?? null, endpointId: target.endpointId ?? null } });
      await this.audit.log({
        tenantId: actor.tenantId ?? undefined, customerId: target.customerId, actorId: actor.userId, actorIp: actor.ip, action: 'RESTART_WINDOW_SET', resource: 'restart_window', resourceId: row.id,
        meta: { scope: target.scope, groupId: target.groupId ?? null, endpointId: target.endpointId ?? null, before: this.auditState(existing), after: { mode: 'off', priority }, withdrawnPolicies: withdrawn, reason: dto.reason ?? null },
      });
      return row;
    }

    // A window can make computers restart: confirm it is you (restart.window), whoever you are.
    assertFresh(freshMethod, { action: 'restart.window', message: 'Setting a restart window lets computers be restarted automatically. Confirm it is you.' });
    const w = PolicyWindow.parse(dto.window);
    const first = nextOccurrence(now, w, new Date(now.getTime() + dto.expiresInDays * 86_400_000));
    if (!first) this.bad('WINDOW_NEVER_OPENS', 'This window never opens before the restart window would expire.');
    if (first!.end.getTime() - first!.start.getTime() < MIN_RESTART_WINDOW_MINUTES * 60_000) this.bad('RESTART_WINDOW_TOO_SHORT', `A restart window is at least ${MIN_RESTART_WINDOW_MINUTES} minutes long: the computer picks the plan up and warns for ${RESTART_WINDOW_DELAY_MINUTES} minutes, and the restart must fall inside the window.`);
    const task: RestartTask = { kind: 'restart', rule: dto.rule as RestartRule, ...(dto.ignoreRemoteSession ? { ignoreRemoteSession: true as const } : {}) };
    const targets: AutomationDoc['targets'] = target.scope === 'business' ? { kind: 'business' }
      : target.scope === 'group' ? { kind: 'group_members', groupId: target.groupId!, groupName: target.label.slice(0, 120) }
        : target.computers!;
    // A change replaces the window in force once it is approved; one that never was approved is simply replaced.
    const inForceNow = existing?.policy && existing.policy.status === 'ACTIVE' ? existing.policy : null;
    if (existing?.pendingPolicy) await this.withdraw({ ...existing, policy: null }, `replaced by a newer change by ${actor.email ?? actor.userId}`);
    if (existing?.policy && !inForceNow) await this.withdraw({ ...existing, pendingPolicy: null }, `replaced by a newer change by ${actor.email ?? actor.userId}`);
    const p = await this.automation.createRestart(actor, {
      businessId: target.customerId, name: this.nameFor(target.scope, target.label), task, targets, recurrence: w,
      maxRunsPerOccurrence: RESTART_ATTEMPTS, expiresInDays: dto.expiresInDays,
      reason: dto.reason ?? `Restart window set ${target.scope === 'computer' ? 'on this computer' : target.scope === 'group' ? `on device group ${target.label}` : 'for the business'} from the console`,
      supersedes: inForceNow?.id ?? null,
    }, freshMethod, now);
    const active = p.status === 'ACTIVE';
    const data = active || !inForceNow
      ? { mode: 'window', policyId: p.id, pendingPolicyId: null, priority, updatedById: actor.userId }
      : { mode: 'window', policyId: inForceNow.id, pendingPolicyId: p.id, priority, updatedById: actor.userId };
    const row = existing
      ? await this.prisma.restartWindowSetting.update({ where: { id: existing.id }, data })
      : await this.prisma.restartWindowSetting.create({ data: { ...data, tenantId: actor.tenantId ?? null, customerId: target.customerId, scope: target.scope, groupId: target.groupId ?? null, endpointId: target.endpointId ?? null } });
    await this.audit.log({
      tenantId: actor.tenantId ?? undefined, customerId: target.customerId, actorId: actor.userId, actorIp: actor.ip, action: 'RESTART_WINDOW_SET', resource: 'restart_window', resourceId: row.id,
      meta: {
        scope: target.scope, groupId: target.groupId ?? null, endpointId: target.endpointId ?? null, before: this.auditState(existing),
        after: { mode: 'window', rule: task.rule, window: w, ignoreRemoteSession: task.ignoreRemoteSession === true, priority, policyId: p.id, status: p.status, expiresAt: p.expiresAt },
        replaces: inForceNow?.id ?? null, reason: dto.reason ?? null,
      },
    });
    return row;
  }

  private auditState(s: (RestartWindowSetting & { policy?: AutomationPolicy | null }) | null) {
    if (!s) return null;
    const d = s.policy ? AutomationDoc.safeParse(s.policy.document) : null;
    const t = d?.success && d.data.task.kind === 'restart' ? d.data.task : null;
    return { mode: s.mode, priority: s.priority, policyId: s.policyId, pendingPolicyId: s.pendingPolicyId, ...(t ? { rule: t.rule, window: d?.data?.recurrence, ignoreRemoteSession: t.ignoreRemoteSession === true } : {}) };
  }

  private async nextPriority(customerId: string): Promise<number> {
    const top = await this.prisma.restartWindowSetting.findFirst({ where: { customerId, scope: 'group' }, orderBy: { priority: 'desc' }, select: { priority: true } });
    return Math.min(PRIORITY_MAX, (top?.priority ?? 0) + 1);
  }

  /** Withdraw a setting's windows: revoked here and on the signer, and restart plans not yet delivered canceled. Returns the policy ids. */
  private async withdraw(s: { policy?: AutomationPolicy | null; pendingPolicy?: AutomationPolicy | null } | null, why: string): Promise<string[]> {
    const out: string[] = [];
    for (const p of [s?.policy, s?.pendingPolicy]) {
      if (!p || ['REVOKED', 'REJECTED', 'EXPIRED'].includes(p.status)) continue;
      await this.automation.withdrawRestart(p, why);
      await this.cancelUndelivered(p.id, why);
      out.push(p.id);
    }
    return out;
  }

  /** Cancel this window's restart plans that have not reached their computer. Anything delivered runs to its own result. */
  private async cancelUndelivered(policyId: string, why: string) {
    const ids = (await this.prisma.restartWindowAttempt.findMany({ where: { policyId, jobId: { not: null } }, select: { jobId: true } })).map((x) => x.jobId!);
    for (const j of await this.prisma.actionJob.findMany({ where: { id: { in: ids }, status: { in: ['AWAITING_APPROVAL', 'APPROVED'] } }, select: { id: true, status: true, tenantId: true, customerId: true } })) {
      if (j.status === 'AWAITING_APPROVAL') await this.signer.cancel(j.id).catch(() => undefined);
      const c = await this.prisma.actionJob.updateMany({ where: { id: j.id, status: { in: ['AWAITING_APPROVAL', 'APPROVED'] } }, data: { status: 'CANCELED', statusReason: why.slice(0, 200) } });
      if (!c.count) continue;
      await this.prisma.actionTarget.updateMany({ where: { jobId: j.id, status: 'PENDING' }, data: { status: 'CANCELED', statusReason: 'plan canceled' } });
      await this.audit.log({ tenantId: j.tenantId ?? undefined, customerId: j.customerId, action: 'ACTION_CANCELED', resource: 'action_job', resourceId: j.id, meta: { reason: why, restartWindowPolicyId: policyId } });
    }
  }

  /**
   * Remove a setting. The business's own window: nothing below it, so it
   * only narrows. A group's or a computer's: its computers inherit whatever
   * is above, which may restart them where they were not before — that asks
   * for a fresh sign-in.
   */
  private async clear(actor: ActorContext, freshMethod: string | null, raw: unknown, where: Prisma.RestartWindowSettingWhereInput, scope: RestartScope, customerId: string) {
    const dto = ClearDto.safeParse(raw ?? {});
    if (!dto.success) this.bad('INVALID_REQUEST', 'reason: at least 3 characters, if given.');
    const s = await this.prisma.restartWindowSetting.findFirst({ where, include: { policy: true, pendingPolicy: true } });
    if (!s) throw new NotFoundException({ code: 'NO_SETTING', message: 'There is no restart window setting here to remove.' });
    if (scope !== 'business') assertFresh(freshMethod, { action: 'restart.window', message: 'Removing this setting hands its computers to the restart window above it, which may restart them. Confirm it is you.' });
    const withdrawn = await this.withdraw(s, `restart window removed by ${actor.email ?? actor.userId}`);
    await this.prisma.restartWindowSetting.delete({ where: { id: s.id } });
    await this.audit.log({
      tenantId: actor.tenantId ?? undefined, customerId, actorId: actor.userId, actorIp: actor.ip, action: 'RESTART_WINDOW_CLEARED', resource: 'restart_window', resourceId: s.id,
      meta: { scope, groupId: s.groupId, endpointId: s.endpointId, before: this.auditState(s), withdrawnPolicies: withdrawn, reason: dto.data!.reason ?? null },
    });
  }

  private assertEditBusiness(actor: ActorContext, customerId: string) {
    const why = this.editRefusal(actor, customerId);
    if (why) throw new ForbiddenException({ code: 'NOT_ALLOWED', message: why });
  }

  private async business(actor: ActorContext, businessId: string) {
    if (!Id.safeParse(businessId).success) throw new NotFoundException('Business not found');
    await this.acl.assertBusinessInScope(actor, businessId);
    const b = await this.prisma.customer.findUnique({ where: { id: businessId }, select: { id: true, name: true, isActive: true, isArchived: true } });
    if (!b || !b.isActive || b.isArchived) throw new NotFoundException('Business not found');
    return b;
  }

  async setBusiness(actor: ActorContext, businessId: string, raw: unknown, freshMethod: string | null, now = new Date()) {
    const b = await this.business(actor, businessId);
    this.assertEditBusiness(actor, b.id);
    await this.write(actor, freshMethod, raw, { scope: 'business', customerId: b.id, label: b.name }, now);
    return this.forBusiness(actor, b.id, now);
  }

  async clearBusiness(actor: ActorContext, businessId: string, raw: unknown, freshMethod: string | null, now = new Date()) {
    const b = await this.business(actor, businessId);
    this.assertEditBusiness(actor, b.id);
    await this.clear(actor, freshMethod, raw, { customerId: b.id, scope: 'business' }, 'business', b.id);
    return this.forBusiness(actor, b.id, now);
  }

  async setGroup(actor: ActorContext, businessId: string, groupId: string, raw: unknown, freshMethod: string | null, now = new Date()) {
    const b = await this.business(actor, businessId);
    this.assertEditBusiness(actor, b.id);
    // Another business's group, a rule on alerts or an unreadable rule: refused as for any group policy.
    const g = await this.membership.groupForPolicy(b.id, groupId);
    await this.write(actor, freshMethod, raw, { scope: 'group', customerId: b.id, groupId: g.id, label: g.name }, now);
    return this.forBusiness(actor, b.id, now);
  }

  async clearGroup(actor: ActorContext, businessId: string, groupId: string, raw: unknown, freshMethod: string | null, now = new Date()) {
    const b = await this.business(actor, businessId);
    this.assertEditBusiness(actor, b.id);
    if (!Id.safeParse(groupId).success) throw new NotFoundException('Group not found');
    await this.clear(actor, freshMethod, raw, { customerId: b.id, scope: 'group', groupId }, 'group', b.id);
    return this.forBusiness(actor, b.id, now);
  }

  /** One computer, as a restart window may name it: bound to its enrolled identity, and one the person may act on. */
  private async namedComputer(actor: ActorContext, endpointId: string) {
    const ep = await this.actions.endpointFor(endpointId);
    if (!ep || !ep.customerId || ep.status === 'ARCHIVED' || !(await this.acl.canReachEndpoint(actor, ep))) throw new NotFoundException('Computer not found');
    const name = (ep.hostname ?? ep.name).slice(0, 64);
    const dec = await this.access.evaluateAction(actor, ep, 'high');
    if (!dec.ok) throw new ForbiddenException({ code: dec.reason.toUpperCase(), message: `${name}: ${dec.message}` });
    if (!ep.rustdeskNode?.rustdeskId || !ep.rustdeskNode.agentSecretHash) throw new ConflictException({ code: 'ENDPOINT_NOT_READY', message: `${name}: this computer has no enrolled device identity.` });
    return { ep, name, computers: { kind: 'computers' as const, computers: [{ endpointId: ep.id, hostname: name, rustdeskId: ep.rustdeskNode.rustdeskId, deviceSecretSha256: ep.rustdeskNode.agentSecretHash }] } };
  }

  async setComputer(actor: ActorContext, endpointId: string, raw: unknown, freshMethod: string | null, now = new Date()) {
    if (!Id.safeParse(endpointId).success) throw new NotFoundException('Computer not found');
    const why = await this.computerRefusal(actor, endpointId);
    if (why) throw new ForbiddenException({ code: 'NOT_ALLOWED', message: why });
    const mode = (raw as { mode?: unknown } | null)?.mode;
    if (mode === 'window') {
      const c = await this.namedComputer(actor, endpointId);
      await this.write(actor, freshMethod, raw, { scope: 'computer', customerId: c.ep.customerId!, endpointId, label: c.name, computers: c.computers }, now);
    } else {
      const ep = await this.prisma.endpoint.findUnique({ where: { id: endpointId }, select: { customerId: true, name: true, hostname: true } });
      if (!ep?.customerId) throw new NotFoundException('Computer not found');
      await this.write(actor, freshMethod, raw, { scope: 'computer', customerId: ep.customerId, endpointId, label: ep.hostname ?? ep.name }, now);
    }
    return this.forComputer(actor, endpointId, now);
  }

  async clearComputer(actor: ActorContext, endpointId: string, raw: unknown, freshMethod: string | null, now = new Date()) {
    if (!Id.safeParse(endpointId).success) throw new NotFoundException('Computer not found');
    const why = await this.computerRefusal(actor, endpointId);
    if (why) throw new ForbiddenException({ code: 'NOT_ALLOWED', message: why });
    const ep = await this.prisma.endpoint.findUnique({ where: { id: endpointId }, select: { customerId: true } });
    if (!ep?.customerId) throw new NotFoundException('Computer not found');
    await this.clear(actor, freshMethod, raw, { endpointId }, 'computer', ep.customerId);
    return this.forComputer(actor, endpointId, now);
  }

  /**
   * The device list's "Set restart window…" for a selection: no automatic
   * restarts, or inherit (remove each computer's own setting). Each computer
   * is the single-computer path, with its own checks and audit entry.
   * Inherit can widen, so it asks for a fresh sign-in once for the request.
   */
  async bulk(actor: ActorContext, raw: unknown, freshMethod: string | null, now = new Date()) {
    const parsed = BulkDto.safeParse(raw);
    if (!parsed.success) this.bad('INVALID_REQUEST', parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const dto = parsed.data!;
    if (new Set(dto.endpointIds).size !== dto.endpointIds.length) this.bad('INVALID_REQUEST', 'A computer is named twice.');
    if (dto.mode === 'inherit') assertFresh(freshMethod, { action: 'restart.window', message: 'Removing these computers\' own settings hands them to the restart window above, which may restart them. Confirm it is you.' });
    const results: { endpointId: string; ok: boolean; code?: string; reason?: string }[] = [];
    for (const id of dto.endpointIds) {
      try {
        if (dto.mode === 'off') await this.setComputer(actor, id, { mode: 'off', ...(dto.reason ? { reason: dto.reason } : {}) }, freshMethod, now);
        else {
          const has = await this.prisma.restartWindowSetting.findUnique({ where: { endpointId: id }, select: { id: true } });
          if (has) await this.clearComputer(actor, id, dto.reason ? { reason: dto.reason } : {}, freshMethod, now);
          else await this.acl.assertEndpointInScope(actor, id);
        }
        results.push({ endpointId: id, ok: true });
      } catch (e) {
        const r = (e as { getResponse?: () => unknown }).getResponse?.() as { code?: string; message?: string } | string | undefined;
        results.push({ endpointId: id, ok: false, code: typeof r === 'object' ? r?.code ?? 'REFUSED' : 'REFUSED', reason: (typeof r === 'object' ? r?.message : r) ?? (e as Error).message });
      }
    }
    return { mode: dto.mode, results };
  }
}
