import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type ActivityAction, type Script, type ScriptVersion } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { CAP, type Capability } from '../rbac/capabilities';
import { PLATFORM_PERM } from '../rbac/platform-permissions';
import { assertFresh } from '../security-controls/review';
import { VersionFields, contentProblem, contributorsOf, hashVersion, lineDiff, type ParameterDecl } from './definition';
import { staticCheck } from './static-checks';

/**
 * The script library (docs/script-library.md): scripts, immutable versions
 * and review. It stores, hashes, checks and records. It never runs a script,
 * and it has no way to: it creates no action job, talks to no agent and no
 * signer, and the invariants (§21) keep it that way.
 *
 *   DRAFT ─author submits─▶ IN_REVIEW ─reviewer─▶ APPROVED | REJECTED (final)
 *     ▲                        │
 *     └───author withdraws─────┘
 *
 * An edit is a new version, starting as a DRAFT. Approval names the content
 * hash the reviewer's page showed, and is refused to anyone who contributed
 * to the content (SAME_PERSON), whichever account context they use: the
 * comparison is on the user id. Migration 0035 enforces the same in the
 * database.
 */

const Name = z.string().trim().min(3).max(120).regex(/^[\p{L}\p{N} _.,()'-]+$/u, 'letters, digits, spaces and _ . , ( ) \' - only');
export const CreateScriptDto = VersionFields.extend({
  scope: z.enum(['global', 'business']),
  businessId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).optional(),
  name: Name,
}).strict();
export const NewVersionDto = VersionFields.extend({ basedOnVersion: z.number().int().min(1) }).strict();
export const ReviewDto = z.object({
  decision: z.enum(['approve', 'reject']),
  // The content hash the reviewer's page showed. An approval binds to it.
  expectedSha256: z.string().regex(/^[0-9a-f]{64}$/),
  note: z.string().trim().min(3).max(1000),
}).strict();

type View = 'full' | 'approved_only';
type ScriptRow = Script & { customer?: { name: string } | null };

function bad(e: z.ZodError) {
  return new BadRequestException({ code: 'INVALID_REQUEST', message: e.issues.slice(0, 4).map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
}

@Injectable()
export class ScriptLibraryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly acl: AccessControlService,
  ) {}

  // ── Who may do what ────────────────────────────────────────────────────────

  /**
   * A library capability in the business this request acts in. A technician
   * needs it on a grant covering the WHOLE business: a script is not scoped
   * to a computer, so a grant naming computers confers no library rights.
   */
  private hasBusinessCap(actor: ActorContext, cap: Capability): boolean {
    if (actor.isPlatformAdmin) return true;
    if (!actor.businessId) return false;
    if (actor.technician) {
      return actor.technician.businessId === actor.businessId
        && actor.technician.sources.some((s) => s.endpointIds === null && (s.capabilities as string[]).includes(cap));
    }
    return actor.capabilities.includes(cap);
  }

  private platformReviewer(actor: ActorContext) {
    return actor.isPlatformAdmin || (actor.platformPermissions ?? []).includes(PLATFORM_PERM.APPROVALS_REVIEW);
  }

  private anyRight(actor: ActorContext) {
    return this.platformReviewer(actor) || this.hasBusinessCap(actor, CAP.SCRIPTS_AUTHOR) || this.hasBusinessCap(actor, CAP.SCRIPTS_REVIEW);
  }

  /** How much of a script this person may see, or null (then it is a 404). */
  private viewOf(actor: ActorContext, s: Script): View | null {
    if (s.scope === 'GLOBAL') {
      if (this.platformReviewer(actor)) return 'full';
      // A business's authors and reviewers see the global scripts that have
      // been approved, as reference. Never their drafts.
      return this.hasBusinessCap(actor, CAP.SCRIPTS_AUTHOR) || this.hasBusinessCap(actor, CAP.SCRIPTS_REVIEW) ? 'approved_only' : null;
    }
    if (actor.isPlatformAdmin) return 'full';
    if (!actor.businessId || s.customerId !== actor.businessId) return null;
    return this.hasBusinessCap(actor, CAP.SCRIPTS_AUTHOR) || this.hasBusinessCap(actor, CAP.SCRIPTS_REVIEW) ? 'full' : null;
  }

  private canAuthor(actor: ActorContext, s: Script) {
    if (s.scope === 'GLOBAL') return actor.isPlatformAdmin;
    return actor.isPlatformAdmin || (s.customerId === actor.businessId && this.hasBusinessCap(actor, CAP.SCRIPTS_AUTHOR));
  }

  private canReview(actor: ActorContext, s: Script) {
    if (s.scope === 'GLOBAL') return this.platformReviewer(actor);
    return actor.isPlatformAdmin || (s.customerId === actor.businessId && this.hasBusinessCap(actor, CAP.SCRIPTS_REVIEW));
  }

  private async load(actor: ActorContext, scriptId: string): Promise<{ s: ScriptRow; view: View }> {
    const s = typeof scriptId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(scriptId)
      ? await this.prisma.script.findUnique({ where: { id: scriptId }, include: { customer: { select: { name: true } } } })
      : null;
    const view = s ? this.viewOf(actor, s) : null;
    // Another business's script and a missing one look the same. So does a
    // global script with nothing approved yet, to a business.
    if (!s || !view) throw new NotFoundException('Script not found');
    if (view === 'approved_only' && !(await this.prisma.scriptVersion.count({ where: { scriptId: s.id, status: 'APPROVED' } }))) throw new NotFoundException('Script not found');
    return { s, view };
  }

  private async loadVersion(actor: ActorContext, scriptId: string, n: number) {
    const { s, view } = await this.load(actor, scriptId);
    const v = Number.isInteger(n) && n >= 1 ? await this.prisma.scriptVersion.findUnique({ where: { scriptId_version: { scriptId: s.id, version: n } } }) : null;
    if (!v || (view === 'approved_only' && v.status !== 'APPROVED')) throw new NotFoundException('Version not found');
    return { s, view, v };
  }

  private auditBase(actor: ActorContext, s: Script) {
    return { actorId: actor.userId, actorIp: actor.ip, actorAgent: actor.userAgent, tenantId: s.tenantId ?? actor.tenantId ?? undefined, customerId: s.customerId ?? undefined };
  }

  private versionMeta(s: Script, v: Pick<ScriptVersion, 'version' | 'contentSha256' | 'definitionSha256' | 'risk' | 'content'>) {
    const checks = staticCheck(v.content, v.risk);
    return {
      scriptId: s.id, scriptName: s.name, scope: s.scope.toLowerCase(), version: v.version, contentSha256: v.contentSha256, definitionSha256: v.definitionSha256, risk: v.risk,
      checkerVersion: checks.checkerVersion, findings: [...new Set(checks.findings.map((f) => f.rule))],
    };
  }

  private async people(ids: (string | null | undefined)[]) {
    const want = [...new Set(ids.filter((x): x is string => !!x))];
    if (!want.length) return new Map<string, { id: string; name: string }>();
    const rows = await this.prisma.user.findMany({ where: { id: { in: want } }, select: { id: true, email: true, firstName: true, lastName: true } });
    return new Map(rows.map((u) => [u.id, { id: u.id, name: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email }]));
  }

  // ── Reading ────────────────────────────────────────────────────────────────

  async list(actor: ActorContext, businessId?: string) {
    if (!this.anyRight(actor)) throw new ForbiddenException({ code: 'NOT_ALLOWED', message: 'The script library needs the Write scripts or Review scripts permission.' });
    const scope = actor.isPlatformAdmin ? (businessId?.trim() || null) : (actor.businessId ?? null);
    if (!actor.isPlatformAdmin && businessId && businessId !== actor.businessId) throw new ForbiddenException('You do not have access to that business');
    const bizVisible = !!scope && (actor.isPlatformAdmin || this.hasBusinessCap(actor, CAP.SCRIPTS_AUTHOR) || this.hasBusinessCap(actor, CAP.SCRIPTS_REVIEW));
    const where: Prisma.ScriptWhereInput = actor.isPlatformAdmin && !scope
      ? {}
      : { OR: [{ scope: 'GLOBAL' }, ...(bizVisible ? [{ customerId: scope! }] : [])] };
    const rows = await this.prisma.script.findMany({
      where, orderBy: [{ scope: 'asc' }, { name: 'asc' }], take: 500,
      include: { customer: { select: { name: true } }, versions: { orderBy: { version: 'desc' }, select: { version: true, status: true, risk: true, createdAt: true, contentSha256: true, authorId: true } } },
    });
    const out = [];
    for (const s of rows) {
      const view = this.viewOf(actor, s);
      if (!view) continue;
      const versions = view === 'full' ? s.versions : s.versions.filter((v) => v.status === 'APPROVED');
      if (!versions.length) continue;
      const approved = versions.find((v) => v.status === 'APPROVED') ?? null;
      out.push({
        id: s.id, name: s.name, scope: s.scope.toLowerCase(), businessId: s.customerId, businessName: s.customer?.name ?? null,
        latest: { version: versions[0].version, status: versions[0].status, risk: versions[0].risk, createdAt: versions[0].createdAt },
        approved: approved ? { version: approved.version, contentSha256: approved.contentSha256 } : null,
        inReview: versions.filter((v) => v.status === 'IN_REVIEW').length,
        versions: versions.length,
        view,
      });
    }
    return {
      scripts: out,
      you: {
        canCreateBusiness: !!scope && (actor.isPlatformAdmin || this.hasBusinessCap(actor, CAP.SCRIPTS_AUTHOR)),
        canCreateGlobal: actor.isPlatformAdmin,
        businessId: scope,
      },
      execution: { available: false, why: 'Scripts can only run through the signed agent and the approval signer, and that path has not been validated on real Windows yet.' },
    };
  }

  async get(actor: ActorContext, scriptId: string) {
    const { s, view } = await this.load(actor, scriptId);
    const versions = await this.prisma.scriptVersion.findMany({
      where: { scriptId: s.id, ...(view === 'approved_only' ? { status: 'APPROVED' } : {}) },
      orderBy: { version: 'desc' },
      select: { id: true, version: true, basedOnId: true, status: true, risk: true, description: true, contentSha256: true, contentBytes: true, authorId: true, createdAt: true, submittedAt: true, decidedById: true, decidedAt: true },
    });
    const ppl = await this.people([s.createdById, ...versions.flatMap((v) => [v.authorId, v.decidedById])]);
    const num = new Map(versions.map((v) => [v.id, v.version]));
    return {
      id: s.id, name: s.name, scope: s.scope.toLowerCase(), businessId: s.customerId, businessName: s.customer?.name ?? null,
      createdAt: s.createdAt, createdBy: ppl.get(s.createdById) ?? null, view,
      versions: versions.map((v) => ({
        version: v.version, basedOn: v.basedOnId ? (num.get(v.basedOnId) ?? null) : null, status: v.status, risk: v.risk, description: v.description,
        contentSha256: v.contentSha256, contentBytes: v.contentBytes, author: ppl.get(v.authorId) ?? null, createdAt: v.createdAt, submittedAt: v.submittedAt,
        decidedBy: v.decidedById ? (ppl.get(v.decidedById) ?? null) : null, decidedAt: v.decidedAt,
      })),
      you: { canAuthor: view === 'full' && this.canAuthor(actor, s), canReview: view === 'full' && this.canReview(actor, s) },
    };
  }

  async version(actor: ActorContext, scriptId: string, n: number) {
    const { s, view, v } = await this.loadVersion(actor, scriptId, n);
    const base = v.basedOnId ? await this.prisma.scriptVersion.findUnique({ where: { id: v.basedOnId }, select: { version: true, status: true } }) : null;
    const ppl = await this.people([v.authorId, v.decidedById, ...v.contributorIds]);
    const checks = staticCheck(v.content, v.risk);
    const contributor = v.contributorIds.includes(actor.userId);
    const reviewer = view === 'full' && this.canReview(actor, s);
    const author = view === 'full' && this.canAuthor(actor, s) && v.authorId === actor.userId;
    return {
      script: { id: s.id, name: s.name, scope: s.scope.toLowerCase(), businessId: s.customerId, businessName: s.customer?.name ?? null },
      version: v.version, status: v.status,
      basedOn: base ? (view === 'approved_only' && base.status !== 'APPROVED' ? null : base.version) : null,
      description: v.description, language: v.language, targetOs: v.targetOs, risk: v.risk, parameters: v.parameters as unknown as ParameterDecl[],
      content: v.content, contentBytes: v.contentBytes, contentSha256: v.contentSha256, definitionSha256: v.definitionSha256,
      author: ppl.get(v.authorId) ?? null, createdAt: v.createdAt, submittedAt: v.submittedAt,
      contributors: view === 'full' ? v.contributorIds.map((id) => ppl.get(id) ?? { id, name: 'a removed user' }) : undefined,
      decision: v.decidedById ? { by: ppl.get(v.decidedById) ?? null, at: v.decidedAt, note: v.decisionNote, approvedSha256: v.approvedSha256 } : null,
      staticChecks: { ...checks, disclaimer: 'Pattern matches only. A script with no findings is not thereby safe; read it.' },
      you: {
        canSubmit: author && v.status === 'DRAFT',
        canWithdraw: author && v.status === 'IN_REVIEW',
        canReview: reviewer && v.status === 'IN_REVIEW' && !contributor,
        cannotReviewBecause: !reviewer ? 'You do not have the review permission for this script.'
          : contributor ? 'You wrote or edited this content, so someone else must review it.'
          : v.status !== 'IN_REVIEW' ? 'Only a version in review can be approved or rejected.' : null,
        canEdit: view === 'full' && this.canAuthor(actor, s),
      },
      execution: { available: false },
    };
  }

  async diff(actor: ActorContext, scriptId: string, from: number, to: number) {
    const a = await this.loadVersion(actor, scriptId, from);
    const b = await this.loadVersion(actor, scriptId, to);
    const d = lineDiff(a.v.content, b.v.content);
    const changed: string[] = [];
    for (const k of ['description', 'risk', 'language', 'targetOs'] as const) if (a.v[k] !== b.v[k]) changed.push(k);
    if (JSON.stringify(a.v.parameters) !== JSON.stringify(b.v.parameters)) changed.push('parameters');
    return {
      from: { version: a.v.version, contentSha256: a.v.contentSha256, risk: a.v.risk, description: a.v.description, parameters: a.v.parameters },
      to: { version: b.v.version, contentSha256: b.v.contentSha256, risk: b.v.risk, description: b.v.description, parameters: b.v.parameters },
      changed, ...d,
    };
  }

  // ── Writing ────────────────────────────────────────────────────────────────

  private checkContent(content: string) {
    const why = contentProblem(content);
    if (why) throw new BadRequestException({ code: 'INVALID_CONTENT', message: why });
  }

  async create(actor: ActorContext, raw: unknown) {
    const p = CreateScriptDto.safeParse(raw);
    if (!p.success) throw bad(p.error);
    const d = p.data;
    this.checkContent(d.content);
    let customer: { id: string; tenantId: string } | null = null;
    if (d.scope === 'global') {
      if (d.businessId) throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'A global script names no business.' });
      if (!actor.isPlatformAdmin) throw new ForbiddenException({ code: 'NOT_ALLOWED', message: 'Global scripts are written by a Platform Admin.' });
    } else {
      if (!actor.isPlatformAdmin && !actor.businessId) throw new ForbiddenException('Your account is not linked to a business.');
      // The business comes from the actor; a body naming another is refused.
      const businessId = this.acl.requireScope(actor, d.businessId ?? (actor.isPlatformAdmin ? null : actor.businessId));
      if (!this.hasBusinessCap(actor, CAP.SCRIPTS_AUTHOR)) throw new ForbiddenException({ code: 'NOT_ALLOWED', message: 'Adding a script needs the Write scripts permission on the whole business.' });
      customer = await this.prisma.customer.findUnique({ where: { id: businessId }, select: { id: true, tenantId: true } });
      if (!customer) throw new NotFoundException('Business not found');
    }
    const h = hashVersion(d);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const s = await tx.script.create({
          data: { scope: d.scope === 'global' ? 'GLOBAL' : 'BUSINESS', customerId: customer?.id ?? null, tenantId: customer?.tenantId ?? actor.tenantId ?? null, name: d.name, createdById: actor.userId },
        });
        const v = await tx.scriptVersion.create({
          data: {
            scriptId: s.id, version: 1, description: d.description, language: d.language, targetOs: d.targetOs, risk: d.risk,
            parameters: d.parameters as unknown as Prisma.InputJsonValue, content: d.content, ...h, authorId: actor.userId, contributorIds: [actor.userId],
          },
        });
        await tx.activityLog.create({ data: this.audit.entry({ ...this.auditBase(actor, s), action: 'SCRIPT_CREATED', resource: 'script', resourceId: s.id, meta: this.versionMeta(s, v) }) });
        return { id: s.id, version: v.version, status: v.status, contentSha256: v.contentSha256 };
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException({ code: 'NAME_TAKEN', message: 'A script with that name already exists here.' });
      throw e;
    }
  }

  async newVersion(actor: ActorContext, scriptId: string, raw: unknown) {
    const { s, view } = await this.load(actor, scriptId);
    if (view !== 'full' || !this.canAuthor(actor, s)) throw new ForbiddenException({ code: 'NOT_ALLOWED', message: 'Editing this script needs the Write scripts permission for it.' });
    const p = NewVersionDto.safeParse(raw);
    if (!p.success) throw bad(p.error);
    const d = p.data;
    this.checkContent(d.content);
    const base = await this.prisma.scriptVersion.findUnique({ where: { scriptId_version: { scriptId: s.id, version: d.basedOnVersion } } });
    if (!base) throw new NotFoundException('Version not found');
    const h = hashVersion(d);
    if (h.definitionSha256 === base.definitionSha256 && d.description === base.description) {
      throw new ConflictException({ code: 'NO_CHANGE', message: 'Nothing changed from the version this was edited from.' });
    }
    const contributorIds = contributorsOf(actor.userId, base);
    for (let attempt = 0; ; attempt++) {
      const last = await this.prisma.scriptVersion.findFirst({ where: { scriptId: s.id }, orderBy: { version: 'desc' }, select: { version: true } });
      try {
        return await this.prisma.$transaction(async (tx) => {
          const v = await tx.scriptVersion.create({
            data: {
              scriptId: s.id, version: (last?.version ?? 0) + 1, basedOnId: base.id, description: d.description, language: d.language, targetOs: d.targetOs, risk: d.risk,
              parameters: d.parameters as unknown as Prisma.InputJsonValue, content: d.content, ...h, authorId: actor.userId, contributorIds,
            },
          });
          await tx.activityLog.create({ data: this.audit.entry({
            ...this.auditBase(actor, s), action: 'SCRIPT_VERSION_CREATED', resource: 'script_version', resourceId: v.id,
            meta: { ...this.versionMeta(s, v), basedOn: base.version, basedOnSha256: base.contentSha256, contributors: contributorIds.length },
          }) });
          return { id: s.id, version: v.version, status: v.status, contentSha256: v.contentSha256 };
        });
      } catch (e) {
        // Two editors at once: the second takes the next number.
        if (attempt < 2 && e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') continue;
        throw e;
      }
    }
  }

  /** DRAFT → IN_REVIEW, or back. Only the version's author, while they may still author here. */
  private async move(actor: ActorContext, scriptId: string, n: number, from: 'DRAFT' | 'IN_REVIEW', to: 'DRAFT' | 'IN_REVIEW', action: ActivityAction) {
    const { s, view, v } = await this.loadVersion(actor, scriptId, n);
    if (view !== 'full' || !this.canAuthor(actor, s) || v.authorId !== actor.userId) {
      throw new ForbiddenException({ code: 'NOT_AUTHOR', message: from === 'DRAFT' ? 'Only the author of this version can submit it for review.' : 'Only the author of this version can withdraw it.' });
    }
    if (v.status !== from) throw new ConflictException({ code: 'WRONG_STATE', message: `This version is ${v.status.toLowerCase().replace('_', ' ')}.` });
    const done = await this.prisma.$transaction(async (tx) => {
      const r = await tx.scriptVersion.updateMany({ where: { id: v.id, status: from }, data: { status: to, submittedAt: to === 'IN_REVIEW' ? new Date() : null } });
      if (r.count !== 1) return false;
      await tx.activityLog.create({ data: this.audit.entry({ ...this.auditBase(actor, s), action, resource: 'script_version', resourceId: v.id, meta: this.versionMeta(s, v) }) });
      return true;
    });
    if (!done) throw new ConflictException({ code: 'WRONG_STATE', message: 'This version changed state meanwhile. Reload it.' });
    return { version: v.version, status: to };
  }

  submit(actor: ActorContext, scriptId: string, n: number) { return this.move(actor, scriptId, n, 'DRAFT', 'IN_REVIEW', 'SCRIPT_VERSION_SUBMITTED'); }
  withdraw(actor: ActorContext, scriptId: string, n: number) { return this.move(actor, scriptId, n, 'IN_REVIEW', 'DRAFT', 'SCRIPT_VERSION_WITHDRAWN'); }

  /**
   * Approve or reject a version in review. The order is deliberate: who you
   * are (SAME_PERSON) and what you saw (the hash) are checked before fresh
   * authentication is asked for, so a refused reviewer is told why rather
   * than prompted to sign in again for nothing. Refusals are audited.
   */
  async review(actor: ActorContext, scriptId: string, n: number, raw: unknown, freshMethod: string | null) {
    const { s, view, v } = await this.loadVersion(actor, scriptId, n);
    if (view !== 'full' || !this.canReview(actor, s)) {
      throw new ForbiddenException({ code: 'NOT_A_REVIEWER', message: s.scope === 'GLOBAL' ? 'Reviewing a global script needs a Platform Admin or an independent reviewer.' : 'Reviewing this script needs the Review scripts permission for this business.' });
    }
    const p = ReviewDto.safeParse(raw);
    if (!p.success) throw bad(p.error);
    const d = p.data;
    const refuse = async (reason: string) => this.audit.log({ ...this.auditBase(actor, s), action: 'SCRIPT_REVIEW_REFUSED', resource: 'script_version', resourceId: v.id, meta: { ...this.versionMeta(s, v), decision: d.decision, reason, expectedSha256: d.expectedSha256 } });
    // SAME_PERSON: by user id, so no context switch, role or assignment makes
    // the author someone else. Contributors include whoever wrote the
    // unapproved versions this one was edited from.
    if (v.authorId === actor.userId || v.contributorIds.includes(actor.userId)) {
      await refuse('same_person');
      throw new ForbiddenException({ code: 'SAME_PERSON', message: 'You wrote or edited this content. Someone else must review it.' });
    }
    if (v.status !== 'IN_REVIEW') throw new ConflictException({ code: 'NOT_IN_REVIEW', message: `This version is ${v.status.toLowerCase().replace('_', ' ')}; only a version in review can be decided.` });
    if (d.expectedSha256 !== v.contentSha256) {
      await refuse('hash_mismatch');
      throw new ConflictException({ code: 'HASH_MISMATCH', message: 'The content you reviewed is not this version\'s. Reload it and review again.' });
    }
    if (d.decision === 'approve') assertFresh(freshMethod);
    const approve = d.decision === 'approve';
    const done = await this.prisma.$transaction(async (tx) => {
      const r = await tx.scriptVersion.updateMany({
        where: { id: v.id, status: 'IN_REVIEW', contentSha256: d.expectedSha256 },
        data: { status: approve ? 'APPROVED' : 'REJECTED', decidedById: actor.userId, decidedAt: new Date(), decisionNote: d.note, approvedSha256: approve ? d.expectedSha256 : null },
      });
      if (r.count !== 1) return false;
      await tx.activityLog.create({ data: this.audit.entry({
        ...this.auditBase(actor, s), action: approve ? 'SCRIPT_VERSION_APPROVED' : 'SCRIPT_VERSION_REJECTED', resource: 'script_version', resourceId: v.id,
        meta: { ...this.versionMeta(s, v), note: d.note, approvedSha256: approve ? d.expectedSha256 : undefined, authorId: v.authorId, freshAuth: approve ? freshMethod : undefined },
      }) });
      return true;
    });
    if (!done) throw new ConflictException({ code: 'NOT_IN_REVIEW', message: 'This version changed state meanwhile. Reload it.' });
    return { version: v.version, status: approve ? 'APPROVED' : 'REJECTED', approvedSha256: approve ? d.expectedSha256 : null };
  }
}
