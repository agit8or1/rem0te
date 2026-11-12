import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Script, ScriptAllowlistEntry, ScriptVersion } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { CAP, type Capability } from '../rbac/capabilities';
import { PLATFORM_PERM } from '../rbac/platform-permissions';
import { ActionsService } from '../actions/actions.service';
import { SignerClient } from '../actions/signer.client';
import { RevocationRelay } from '../actions/revocations.controller';
import { MAX_RING_TARGETS, MAX_WINDOW_HOURS, SCRIPT_RUN } from '../actions/catalog';
import {
  MAX_SCRIPT_OUTPUT_BYTES, SCRIPT_OUTPUT_RETENTION_DAYS, TIMEOUT_MINUTES, ScriptRunParams, argumentsProblem, type ParameterDecl, type ScriptBlock, type ScriptProposal,
} from '../actions/script-run';

/**
 * Running approved library scripts (0.34, docs/script-library.md).
 *
 * The portal's part is small on purpose. It proposes an APPROVED library
 * version to the approval signer's own allowlist (the signer's approvers add
 * it, after reading the content on the signer's origin), and it requests a
 * run: a windows.script.run@1 plan through ActionsService.createPlan, the
 * same path — scope, access level, containment, readiness, one at a time —
 * as every other catalog action. It holds no key, cannot add to the
 * allowlist, cannot approve a run, and cannot change what runs: the agent
 * hashes the delivered content against the signed SHA-256.
 *
 * Who may do what:
 *   see readiness  — whoever may see the version in the library (scripts:author
 *                    or scripts:review in its business; for a global script, a
 *                    Platform Admin or independent reviewer, or a business's
 *                    authors and reviewers for an approved version)
 *   propose/revoke — scripts:review in the script's business; for a global
 *                    script, a Platform Admin or independent reviewer
 *   request a run  — the above visibility AND actions:request (higher risk) on
 *                    every computer, decided per computer by createPlan
 *
 * Output is stored by ActionsService.recordResults (ScriptRunOutput) and
 * pruned here after SCRIPT_OUTPUT_RETENTION_DAYS (SCRIPT_OUTPUT_SWEEP=off
 * stops the sweep).
 */

const Id = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
export const RunDto = z.object({
  scriptVersionId: Id,
  endpointIds: z.array(Id).min(1).max(MAX_RING_TARGETS),
  parameters: z.record(z.string(), z.unknown()).default({}),
  timeoutMinutes: z.number().int(),
  reason: z.string().trim().min(3).max(500),
  startsInMinutes: z.number().int().min(0).max(24 * 60).default(0),
  windowHours: z.number().int().min(1).max(MAX_WINDOW_HOURS).default(4),
}).strict();
export const RevokeDto = z.object({ reason: z.string().trim().min(3).max(300) }).strict();

type VersionRow = ScriptVersion & { script: Script & { customer: { name: string } | null } };
const LIVE: string[] = ['AWAITING_APPROVAL', 'ACTIVE'];
const SWEEP_EVERY_MS = 6 * 3600_000;

function bad(e: z.ZodError) {
  return new BadRequestException({ code: 'INVALID_REQUEST', message: e.issues.slice(0, 4).map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
}

@Injectable()
export class ScriptRunService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('ScriptRun');
  private timer: ReturnType<typeof setInterval> | null = null;
  private first: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly acl: AccessControlService,
    private readonly actions: ActionsService,
    private readonly signer: SignerClient,
    private readonly relay: RevocationRelay,
  ) {}

  // ── Retention ───────────────────────────────────────────────────────────

  onModuleInit() {
    if (process.env.SCRIPT_OUTPUT_SWEEP === 'off') return;
    this.first = setTimeout(() => { void this.prune(); }, 60_000);
    this.timer = setInterval(() => { void this.prune(); }, SWEEP_EVERY_MS);
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); if (this.first) clearTimeout(this.first); }

  /** Delete run output older than the retention period. The run's summary on its ActionTarget stays. */
  async prune(now = new Date()): Promise<number> {
    try {
      const r = await this.prisma.scriptRunOutput.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - SCRIPT_OUTPUT_RETENTION_DAYS * 86_400_000) } } });
      if (r.count) this.log.log(`pruned ${r.count} script output record(s) older than ${SCRIPT_OUTPUT_RETENTION_DAYS} days`);
      return r.count;
    } catch (e) { this.log.warn(`script output prune failed: ${(e as Error).message}`); return 0; }
  }

  // ── Who may do what (the library's rules, applied to one version) ─────────

  private hasBusinessCap(actor: ActorContext, cap: Capability): boolean {
    if (actor.isPlatformAdmin) return true;
    if (!actor.businessId) return false;
    // A grant naming computers confers no library rights (as in the library).
    if (actor.technician) return actor.technician.businessId === actor.businessId && actor.technician.sources.some((s) => s.endpointIds === null && (s.capabilities as string[]).includes(cap));
    return actor.capabilities.includes(cap);
  }
  private platformReviewer(actor: ActorContext) { return actor.isPlatformAdmin || (actor.platformPermissions ?? []).includes(PLATFORM_PERM.APPROVALS_REVIEW); }
  private libraryUser(actor: ActorContext) { return this.hasBusinessCap(actor, CAP.SCRIPTS_AUTHOR) || this.hasBusinessCap(actor, CAP.SCRIPTS_REVIEW); }

  /** The version, if this person may see it in the library. Anything else is a 404, as there. */
  private async load(actor: ActorContext, versionId: string): Promise<VersionRow> {
    const v = typeof versionId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(versionId)
      ? await this.prisma.scriptVersion.findUnique({ where: { id: versionId }, include: { script: { include: { customer: { select: { name: true } } } } } })
      : null;
    const s = v?.script;
    const visible = !!s && (s.scope === 'GLOBAL'
      ? this.platformReviewer(actor) || (this.libraryUser(actor) && v!.status === 'APPROVED')
      : actor.isPlatformAdmin || (s.customerId === actor.businessId && this.libraryUser(actor)));
    if (!v || !visible) throw new NotFoundException('Script version not found');
    return v;
  }

  private mayPropose(actor: ActorContext, s: Script) {
    if (s.scope === 'GLOBAL') return this.platformReviewer(actor);
    return actor.isPlatformAdmin || (s.customerId === actor.businessId && this.hasBusinessCap(actor, CAP.SCRIPTS_REVIEW));
  }

  /** The signer's word on an entry, mirrored. Never the other way: the row cannot make the entry active. */
  private async refresh(e: ScriptAllowlistEntry): Promise<ScriptAllowlistEntry> {
    if (!LIVE.includes(e.status) || !this.signer.configured()) return e;
    let r: Awaited<ReturnType<SignerClient['scriptStatus']>>;
    try { r = await this.signer.scriptStatus(e.id); } catch { return e; }
    if (r.status !== 200 || !r.body.status || r.body.status === e.status) return e;
    return this.prisma.scriptAllowlistEntry.update({
      where: { id: e.id },
      data: { status: r.body.status, ...(r.body.status === 'REVOKED' ? { revokedAt: r.body.revokedAt ? new Date(r.body.revokedAt) : new Date(), revokeReason: r.body.revokeReason ?? null } : {}) },
    });
  }

  private async entries(versionId: string) {
    const rows = await this.prisma.scriptAllowlistEntry.findMany({ where: { scriptVersionId: versionId }, orderBy: { createdAt: 'desc' } });
    const out: ScriptAllowlistEntry[] = [];
    for (const e of rows) out.push(await this.refresh(e));
    return out;
  }

  private entryView(e: ScriptAllowlistEntry | undefined) {
    return e ? { id: e.id, status: e.status, approvalUrl: e.approvalUrl, contentSha256: e.contentSha256, createdAt: e.createdAt, revokedAt: e.revokedAt, revokeReason: e.revokeReason } : null;
  }

  // ── Reading ────────────────────────────────────────────────────────────────

  async readiness(actor: ActorContext, versionId: string) {
    const v = await this.load(actor, versionId);
    const s = v.script;
    const all = await this.entries(v.id);
    const current = all.find((e) => LIVE.includes(e.status)) ?? all[0];
    const revoked = all.some((e) => e.status === 'REVOKED');
    // Running and revoking both go through the approval signer. Without one
    // configured neither can happen, whatever the mirrored entry last said,
    // so neither is offered (0.35: the panel said "cannot be run here" and
    // showed Request a run and Revoke beside it).
    const signerConfigured = this.signer.configured();
    return {
      version: { id: v.id, scriptId: s.id, name: s.name, scope: s.scope.toLowerCase(), businessId: s.customerId, version: v.version, status: v.status, risk: v.risk, parameters: v.parameters as unknown as ParameterDecl[], contentSha256: v.contentSha256 },
      signerConfigured,
      allowlist: this.entryView(current),
      revoked,
      timeouts: TIMEOUT_MINUTES, maxTargets: SCRIPT_RUN.maxTargets, maxOutputBytes: MAX_SCRIPT_OUTPUT_BYTES, retentionDays: SCRIPT_OUTPUT_RETENTION_DAYS,
      you: {
        canPropose: v.status === 'APPROVED' && this.mayPropose(actor, s) && !revoked && !current?.status.match(/^(AWAITING_APPROVAL|ACTIVE)$/),
        canRevoke: signerConfigured && this.mayPropose(actor, s) && !!current && LIVE.includes(current.status),
        canRun: signerConfigured && v.status === 'APPROVED' && current?.status === 'ACTIVE',
      },
      warnings: SCRIPT_RUN.warnings, acknowledge: SCRIPT_RUN.acknowledge,
      // Said plainly wherever a run can be requested.
      proven: 'Tested against PowerShell 7 on Linux through the agent\'s own decision code. Not yet run on a real Windows computer: the Windows job object, SYSTEM context and Windows PowerShell 5.1 behaviour are unproven.',
    };
  }

  // ── The signer's allowlist ─────────────────────────────────────────────────

  async propose(actor: ActorContext, versionId: string) {
    const v = await this.load(actor, versionId);
    const s = v.script;
    if (!this.mayPropose(actor, s)) throw new ForbiddenException({ code: 'NOT_A_REVIEWER', message: s.scope === 'GLOBAL' ? 'Proposing a global script needs a Platform Admin or an independent reviewer.' : 'Proposing a script to the approval signer needs the Review scripts permission for this business.' });
    if (v.status !== 'APPROVED' || !v.decidedById || !v.decidedAt || v.approvedSha256 !== v.contentSha256) throw new ConflictException({ code: 'NOT_APPROVED', message: 'Only a version approved in the library can be proposed to the approval signer.' });
    const all = await this.entries(v.id);
    if (all.some((e) => e.status === 'REVOKED')) throw new ConflictException({ code: 'SCRIPT_REVOKED', message: 'This version was removed from the approval signer\'s allowlist. Revocation is permanent: edit it into a new version and have that reviewed.' });
    const live = all.find((e) => LIVE.includes(e.status));
    if (live) return this.entryView(live);
    const ppl = new Map((await this.prisma.user.findMany({ where: { id: { in: [...v.contributorIds, v.decidedById, actor.userId] } }, select: { id: true, email: true, firstName: true, lastName: true } }))
      .map((u) => [u.id, ([u.firstName, u.lastName].filter(Boolean).join(' ') || u.email).slice(0, 120)]));
    const name = (id: string) => ppl.get(id) ?? 'a removed user';
    const proposal: ScriptProposal = {
      allowlistId: randomBytes(16).toString('hex'), scriptId: s.id, versionId: v.id, name: s.name.slice(0, 120), version: v.version, description: v.description.slice(0, 2000),
      businessId: s.customerId, businessName: s.customer?.name.slice(0, 120) ?? null, language: 'powershell', targetOs: 'windows', risk: v.risk as ScriptProposal['risk'],
      parameters: v.parameters as unknown as ParameterDecl[], contentSha256: v.contentSha256, content: v.content,
      contributors: v.contributorIds.map((id) => ({ userId: id, name: name(id) })),
      reviewedBy: { userId: v.decidedById, name: name(v.decidedById), at: v.decidedAt.toISOString() },
      proposedBy: { userId: actor.userId, name: name(actor.userId) },
    };
    const r = await this.signer.proposeScript(proposal);
    if (r.status !== 201 || !r.body.id || r.body.contentSha256 !== v.contentSha256 || !r.body.approvalUrl) {
      throw new ConflictException({ code: 'APPROVAL_SIGNER_REFUSED', signerCode: r.body.error ?? null, message: r.body.message ?? r.body.error ?? 'The approval signer refused the proposal.' });
    }
    const e = await this.prisma.scriptAllowlistEntry.create({
      data: { id: r.body.id, scriptVersionId: v.id, customerId: s.customerId, contentSha256: v.contentSha256, status: r.body.status ?? 'AWAITING_APPROVAL', approvalUrl: r.body.approvalUrl, proposedById: actor.userId },
    });
    await this.audit.log({
      tenantId: s.tenantId ?? actor.tenantId ?? undefined, customerId: s.customerId ?? undefined, actorId: actor.userId, actorIp: actor.ip,
      action: 'SCRIPT_ALLOWLIST_PROPOSED', resource: 'script_version', resourceId: v.id,
      meta: { scriptId: s.id, version: v.version, allowlistId: e.id, contentSha256: v.contentSha256, definitionSha256: v.definitionSha256 },
    });
    return this.entryView(e);
  }

  async revoke(actor: ActorContext, versionId: string, raw: unknown) {
    const v = await this.load(actor, versionId);
    if (!this.mayPropose(actor, v.script)) throw new ForbiddenException({ code: 'NOT_A_REVIEWER', message: 'Revoking needs the same permission as proposing.' });
    const d = RevokeDto.safeParse(raw);
    if (!d.success) throw bad(d.error);
    const live = (await this.entries(v.id)).find((e) => LIVE.includes(e.status));
    if (!live) throw new ConflictException({ code: 'NOT_ALLOWLISTED', message: 'This version has no live entry on the approval signer\'s allowlist.' });
    const r = await this.signer.revokeScript(live.id, d.data.reason);
    if (r.status !== 200 || r.body.status !== 'REVOKED') throw new ConflictException({ code: 'APPROVAL_SIGNER_REFUSED', message: r.body.error ?? 'The approval signer did not revoke it.' });
    // 0.36: the next agent to ask gets a statement naming this hash, and
    // refuses a run of it that was signed before now (revocation.go).
    this.relay.invalidate();
    const e = await this.prisma.scriptAllowlistEntry.update({ where: { id: live.id }, data: { status: 'REVOKED', revokedAt: r.body.revokedAt ? new Date(r.body.revokedAt) : new Date(), revokeReason: d.data.reason } });
    await this.audit.log({
      tenantId: v.script.tenantId ?? actor.tenantId ?? undefined, customerId: v.script.customerId ?? undefined, actorId: actor.userId, actorIp: actor.ip,
      action: 'SCRIPT_ALLOWLIST_REVOKED', resource: 'script_version', resourceId: v.id, meta: { allowlistId: e.id, contentSha256: e.contentSha256, reason: d.data.reason },
    });
    return this.entryView(e);
  }

  // ── Requesting a run ──────────────────────────────────────────────────────

  async requestRun(actor: ActorContext, raw: unknown) {
    const p = RunDto.safeParse(raw);
    if (!p.success) throw bad(p.error);
    const d = p.data;
    const v = await this.load(actor, d.scriptVersionId);
    const s = v.script;
    if (v.status !== 'APPROVED' || !v.decidedById) throw new ConflictException({ code: 'NOT_APPROVED', message: 'Only a version approved in the library can be run.' });
    const entry = (await this.entries(v.id)).find((e) => e.status === 'ACTIVE');
    if (!entry) throw new ConflictException({ code: 'SCRIPT_NOT_ALLOWLISTED', message: 'This version is not on the approval signer\'s allowlist yet. Propose it, and have two approvers add it on the approval signer\'s page.' });
    const params = { scriptVersionId: v.id, sha256: v.contentSha256, parameters: d.parameters, timeoutMinutes: d.timeoutMinutes };
    const decls = v.parameters as unknown as ParameterDecl[];
    const why = argumentsProblem(decls, d.parameters);
    if (why || !ScriptRunParams.safeParse(params).success) {
      throw new BadRequestException({ code: 'PARAMS_NOT_ALLOWED', message: why ? `Those arguments do not match the script's declared parameters: ${why}.` : `The timeout is one of ${TIMEOUT_MINUTES.join(', ')} minutes.` });
    }
    // A business's script runs on that business's computers only. Scope first,
    // so a computer the requester cannot see is a 404 like any other.
    if (s.customerId) {
      for (const id of d.endpointIds) {
        await this.acl.assertEndpointInScope(actor, id);
        const ep = await this.prisma.endpoint.findUnique({ where: { id }, select: { customerId: true } });
        if (ep?.customerId !== s.customerId) throw new BadRequestException({ code: 'SCRIPT_WRONG_BUSINESS', message: 'This script belongs to another business; it runs on that business\'s computers only.' });
      }
    }
    const block: ScriptBlock = {
      allowlistId: entry.id, scriptId: s.id, versionId: v.id, name: s.name.slice(0, 120), version: v.version, businessId: s.customerId,
      language: 'powershell', targetOs: 'windows', risk: v.risk as ScriptBlock['risk'], parameters: decls,
      contentSha256: v.contentSha256, contentBytes: v.contentBytes, definitionSha256: v.definitionSha256, contributors: v.contributorIds, reviewedBy: v.decidedById,
    };
    const job = await this.actions.createPlan(actor, {
      action: SCRIPT_RUN, endpointIds: d.endpointIds, params, reason: d.reason, startsInMinutes: d.startsInMinutes, windowHours: d.windowHours, script: block,
    });
    return this.actions.view(job, actor);
  }
}
