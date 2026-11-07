import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { EndpointsService } from '../endpoints/endpoints.service';
import { PLATFORM_PERM } from '../rbac/platform-permissions';

export type StepState = 'done' | 'pending' | 'skipped' | 'failed';
export interface OffboardingStep { key: string; label: string; state: StepState; detail?: string; count?: number }

/**
 * Offboarding: remove a person's access and deal with what they already have.
 *
 * Two things are kept honest throughout, in the API and the UI copy alike:
 *
 *   - Revoking portal access stops NEW connections through Rem0te at once
 *     (memberships, grants and assignments are re-read on every request and
 *     every token redemption). It does nothing to a RustDesk password the
 *     person already saw. Only rotating that computer's credential does.
 *   - Rotation is the existing protocol: a new password is staged and the
 *     computer applies and acknowledges it on its next check-in. Until then
 *     it is PENDING, never "done", and an offline computer can stay pending
 *     indefinitely. Rotation does not end a RustDesk session already open.
 *
 * Scope:
 *   business  A Business Owner (or Platform Admin) offboards someone from ONE
 *             business: their membership there, their grants on its
 *             computers, technician assignments into it, unredeemed tokens
 *             for its computers, and rotation of its computers only. The
 *             account itself is suspended only if this business is all the
 *             person has, or the actor is a Platform Admin.
 *   platform  A Platform Admin, or a holder of `technicians:manage` for an
 *             MSP technician account (no business membership): every
 *             assignment and group membership, the account, all tokens.
 */
@Injectable()
export class OffboardingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly acl: AccessControlService,
    private readonly endpoints: EndpointsService,
  ) {}

  // ── Authorization ────────────────────────────────────────────────────────

  async authorize(actor: ActorContext, subjectUserId: string, businessId?: string) {
    if (actor.technician) throw new ForbiddenException('Switch back to your own business to offboard people');
    if (actor.userId === subjectUserId) throw new ForbiddenException('You cannot offboard yourself');
    const subject = await this.prisma.user.findUnique({
      where: { id: subjectUserId },
      select: {
        id: true, email: true, firstName: true, lastName: true, status: true, isPlatformAdmin: true,
        memberships: { select: { id: true, customerId: true, isActive: true, role: { select: { type: true } } } },
      },
    });
    if (!subject) throw new NotFoundException('User not found');
    if (subject.isPlatformAdmin && !actor.isPlatformAdmin) throw new ForbiddenException('Only a Platform Admin can offboard a Platform Admin');

    if (businessId) {
      const scope = this.acl.requireScope(actor, businessId);
      if (!actor.isPlatformAdmin && !this.acl.isBusinessOwner(actor)) {
        throw new ForbiddenException('Only a Business Owner can offboard people from this business');
      }
      const membership = subject.memberships.find((m) => m.customerId === scope);
      if (membership) {
        // The same rules as every other change to this person (owners vs users).
        this.acl.assertMayManage(actor, { roleType: membership.role.type, isPlatformAdmin: subject.isPlatformAdmin, userId: subject.id });
      } else {
        const assigned = await this.prisma.technicianAssignment.count({ where: { customerId: scope, OR: [{ userId: subject.id }, { group: { members: { some: { userId: subject.id } } } }] } });
        const grants = await this.prisma.computerAccess.count({ where: { userId: subject.id, endpoint: { customerId: scope } } });
        if (!assigned && !grants) throw new NotFoundException('That person has no access to this business');
      }
      return { subject, businessId: scope as string, kind: 'business' as const };
    }

    const isTechAccount = subject.memberships.length === 0;
    if (!actor.isPlatformAdmin && !(isTechAccount && this.acl.hasPlatformPermission(actor, PLATFORM_PERM.TECHNICIANS_MANAGE))) {
      throw new ForbiddenException('Offboarding across every business needs a Platform Admin (or technicians:manage, for a technician account)');
    }
    return { subject, businessId: null, kind: 'platform' as const };
  }

  // ── What the person obtained ─────────────────────────────────────────────

  /** Computers whose credential this person has had in hand, from the records that show it. */
  private async credentialsObtained(subjectUserId: string, businessId: string | null) {
    const epWhere = businessId ? { customerId: businessId } : {};
    const [reveals, grants, launches] = await Promise.all([
      this.prisma.activityLog.findMany({
        where: { actorId: subjectUserId, action: 'ENDPOINT_PASSWORD_REVEALED', resource: 'endpoint' },
        select: { resourceId: true, createdAt: true, metadata: true }, orderBy: { createdAt: 'desc' }, take: 1000,
      }),
      this.prisma.connectionGrant.findMany({
        where: { userId: subjectUserId, usedAt: { not: null }, endpoint: epWhere },
        select: { endpointId: true, usedAt: true }, orderBy: { usedAt: 'desc' }, take: 1000,
      }),
      this.prisma.launcherToken.findMany({
        where: { userId: subjectUserId, usedAt: { not: null }, targetEndpointId: { not: null } },
        select: { targetEndpointId: true, usedAt: true }, orderBy: { usedAt: 'desc' }, take: 1000,
      }),
    ]);
    const last = new Map<string, { at: Date; how: Set<string> }>();
    const add = (id: string | null, at: Date | null, how: string) => {
      if (!id || !at) return;
      const cur = last.get(id) ?? { at, how: new Set<string>() };
      if (at > cur.at) cur.at = at;
      cur.how.add(how);
      last.set(id, cur);
    };
    for (const r of reveals) {
      // Refused reveals are logged with the same action and a `denied` reason.
      if ((r.metadata as { denied?: unknown } | null)?.denied) continue;
      add(r.resourceId, r.createdAt, 'revealed the password');
    }
    for (const g of grants) add(g.endpointId, g.usedAt, 'connected (credential released)');
    for (const l of launches) add(l.targetEndpointId, l.usedAt, 'connected through the launcher');

    const eps = await this.prisma.endpoint.findMany({
      where: { id: { in: [...last.keys()] }, ...epWhere, status: { not: 'ARCHIVED' } },
      select: {
        id: true, name: true, customerId: true, isOnline: true, lastSeenAt: true,
        customer: { select: { name: true } },
        rustdeskNode: { select: { agentSecretHash: true, pendingPasswordAt: true } },
      },
    });
    return eps.map((e) => ({
      endpointId: e.id, name: e.name, businessId: e.customerId, businessName: e.customer?.name ?? null,
      lastObtainedAt: last.get(e.id)!.at.toISOString(), how: [...last.get(e.id)!.how],
      online: e.isOnline, lastSeenAt: e.lastSeenAt?.toISOString() ?? null,
      canRotate: !!e.rustdeskNode?.agentSecretHash,
      rotationAlreadyPending: !!e.rustdeskNode?.pendingPasswordAt,
    }));
  }

  /** Groups of computers that share one password, among those listed. */
  private async sharedPasswordGroups(endpointIds: string[], businessId: string | null) {
    if (!endpointIds.length) return [];
    // Compare against the whole business (or the businesses involved), so a
    // password shared with a computer the person never touched still shows.
    const pool = await this.prisma.endpoint.findMany({
      where: businessId ? { customerId: businessId, status: { not: 'ARCHIVED' } }
        : { customerId: { in: (await this.prisma.endpoint.findMany({ where: { id: { in: endpointIds } }, select: { customerId: true } })).map((e) => e.customerId).filter((x): x is string => !!x) }, status: { not: 'ARCHIVED' } },
      select: { id: true, name: true },
    });
    const fp = await this.endpoints.credentialFingerprints(pool.map((p) => p.id));
    const byHash = new Map<string, string[]>();
    for (const [id, h] of fp) byHash.set(h, [...(byHash.get(h) ?? []), id]);
    const names = new Map(pool.map((p) => [p.id, p.name]));
    return [...byHash.values()]
      .filter((ids) => ids.length > 1 && ids.some((id) => endpointIds.includes(id)))
      .map((ids) => ({ computers: ids.map((id) => ({ endpointId: id, name: names.get(id) ?? id })) }));
  }

  private async endpointIdsOf(businessId: string) {
    return (await this.prisma.endpoint.findMany({ where: { customerId: businessId }, select: { id: true } })).map((e) => e.id);
  }

  // ── Preview ──────────────────────────────────────────────────────────────

  async preview(actor: ActorContext, subjectUserId: string, businessId?: string) {
    const { subject, businessId: scope, kind } = await this.authorize(actor, subjectUserId, businessId);
    const epFilter = scope ? { endpoint: { customerId: scope } } : {};
    // Launcher tokens: the same scope execute() revokes in.
    const tokenScope = scope ? { OR: [{ targetEndpointId: { in: await this.endpointIdsOf(scope) } }, { supportSession: { customerId: scope } }] } : {};
    const [grants, assignments, groups, launcherTokens, connectionGrants, otherMemberships] = await Promise.all([
      this.prisma.computerAccess.count({ where: { userId: subject.id, ...epFilter } }),
      this.prisma.technicianAssignment.count({ where: { userId: subject.id, revokedAt: null, ...(scope ? { customerId: scope } : {}) } }),
      kind === 'platform' ? this.prisma.technicianGroupMember.count({ where: { userId: subject.id } }) : 0,
      this.prisma.launcherToken.count({ where: { userId: subject.id, usedAt: null, revokedAt: null, expiresAt: { gt: new Date() }, ...tokenScope } }),
      this.prisma.connectionGrant.count({ where: { userId: subject.id, usedAt: null, expiresAt: { gt: new Date() }, ...epFilter } }),
      scope ? this.prisma.membership.count({ where: { userId: subject.id, isActive: true, customerId: { not: scope } } }) : 0,
    ]);
    const otherAssignments = scope
      ? await this.prisma.technicianAssignment.count({ where: { userId: subject.id, revokedAt: null, customerId: { not: scope } } })
      : 0;
    const credentials = await this.credentialsObtained(subject.id, scope);
    const canSuspendAccount = actor.isPlatformAdmin || kind === 'platform' || (otherMemberships === 0 && otherAssignments === 0);
    return {
      subject: { id: subject.id, email: subject.email, name: [subject.firstName, subject.lastName].filter(Boolean).join(' ') || subject.email, status: subject.status },
      scope: kind, businessId: scope,
      willRevoke: {
        membership: scope ? subject.memberships.some((m) => m.customerId === scope && m.isActive) : subject.memberships.some((m) => m.isActive),
        computerGrants: grants, technicianAssignments: assignments, groupMemberships: groups,
        unredeemedLauncherTokens: launcherTokens, unredeemedConnectionGrants: connectionGrants,
      },
      canSuspendAccount,
      suspendBlockedReason: canSuspendAccount ? null : 'This person also has access to other businesses; only a Platform Admin can suspend the whole account.',
      credentialsObtained: credentials,
      sharedPasswords: await this.sharedPasswordGroups(credentials.map((c) => c.endpointId), scope),
      limits: [
        'Revoking access stops new connections through Rem0te immediately. It does not change any RustDesk password this person already saw.',
        'Rotating a computer\'s credential changes it on the computer at its next check-in. Until the computer acknowledges it, the old password still works. An offline computer stays pending until it comes back.',
        'Neither revoking access nor rotating ends a RustDesk session that is already open.',
      ],
    };
  }

  // ── Execute ──────────────────────────────────────────────────────────────

  async execute(
    actor: ActorContext,
    dto: { userId: string; businessId?: string; suspendAccount?: boolean; rotateEndpointIds?: string[]; notes?: string },
  ) {
    const pre = await this.preview(actor, dto.userId, dto.businessId);
    const { subject, businessId: scope, kind } = await this.authorize(actor, dto.userId, dto.businessId);
    const now = new Date();
    const steps: OffboardingStep[] = [];
    const epFilter = scope ? { endpoint: { customerId: scope } } : {};

    // Validate everything before the first write, so a refused request
    // changes nothing.
    if (dto.suspendAccount && !pre.canSuspendAccount) {
      throw new ForbiddenException(pre.suspendBlockedReason ?? 'Cannot suspend this account');
    }
    const wanted = new Set(dto.rotateEndpointIds ?? []);
    const eligible = pre.credentialsObtained.filter((c) => wanted.has(c.endpointId));
    if ([...wanted].some((id) => !eligible.some((c) => c.endpointId === id))) {
      throw new BadRequestException('Only computers this person obtained a credential for can be rotated here');
    }

    // 1. Membership(s).
    const m = await this.prisma.membership.updateMany({
      where: { userId: subject.id, isActive: true, ...(scope ? { customerId: scope } : {}) }, data: { isActive: false },
    });
    steps.push({ key: 'membership', label: scope ? 'Removed from this business' : 'All business memberships disabled', state: m.count ? 'done' : 'skipped', count: m.count });

    // 2. Account.
    if (dto.suspendAccount) {
      await this.prisma.user.update({ where: { id: subject.id }, data: { status: 'SUSPENDED', sessionsValidAfter: now } });
      steps.push({ key: 'account', label: 'Account suspended and every signed-in session ended', state: 'done' });
    } else {
      steps.push({ key: 'account', label: 'Account left active (access elsewhere is unchanged)', state: 'skipped' });
    }

    // 3. Grants, assignments, groups.
    const ca = await this.prisma.computerAccess.deleteMany({ where: { userId: subject.id, ...epFilter } });
    steps.push({ key: 'computer_grants', label: 'Per-computer access removed', state: ca.count ? 'done' : 'skipped', count: ca.count });
    const ta = await this.prisma.technicianAssignment.updateMany({
      where: { userId: subject.id, revokedAt: null, ...(scope ? { customerId: scope } : {}) },
      data: { revokedAt: now, revokedById: actor.userId, revokeReason: 'offboarding' },
    });
    steps.push({ key: 'assignments', label: 'Technician assignments revoked', state: ta.count ? 'done' : 'skipped', count: ta.count });
    if (kind === 'platform') {
      const gm = await this.prisma.technicianGroupMember.deleteMany({ where: { userId: subject.id } });
      steps.push({ key: 'groups', label: 'Removed from technician groups', state: gm.count ? 'done' : 'skipped', count: gm.count });
    } else {
      const viaGroup = await this.prisma.technicianAssignment.count({
        where: { customerId: scope!, revokedAt: null, group: { members: { some: { userId: subject.id } } } },
      });
      steps.push({
        key: 'groups', label: 'Group-based access to this business', state: viaGroup ? 'pending' : 'skipped', count: viaGroup,
        detail: viaGroup ? 'This person still reaches the business through a technician group. Remove them from the group, or revoke the group\'s assignment here.' : undefined,
      });
    }

    // 4. Unredeemed tokens and grants.
    const scopeEndpointIds = scope ? await this.endpointIdsOf(scope) : [];
    const lt = await this.prisma.launcherToken.updateMany({
      where: {
        userId: subject.id, usedAt: null, revokedAt: null, expiresAt: { gt: now },
        ...(scope ? { OR: [{ targetEndpointId: { in: scopeEndpointIds } }, { supportSession: { customerId: scope } }] } : {}),
      },
      data: { revokedAt: now },
    });
    const cg = await this.prisma.connectionGrant.updateMany({
      where: { userId: subject.id, usedAt: null, expiresAt: { gt: now }, ...epFilter }, data: { expiresAt: now },
    });
    steps.push({ key: 'tokens', label: 'Unredeemed launcher tokens and connection grants revoked', state: lt.count + cg.count ? 'done' : 'skipped', count: lt.count + cg.count });

    // 5. Rotations — only computers in scope that the person actually had.
    const rotations: { endpointId: string; name: string; stagedAt: string | null; error?: string }[] = [];
    for (const c of eligible) {
      try {
        await this.endpoints.rotateCredential(actor, c.endpointId);
        rotations.push({ endpointId: c.endpointId, name: c.name, stagedAt: new Date().toISOString() });
      } catch (e) {
        rotations.push({ endpointId: c.endpointId, name: c.name, stagedAt: null, error: (e as Error).message });
      }
    }
    const notChosen = pre.credentialsObtained.filter((c) => !wanted.has(c.endpointId)).length;
    steps.push({
      key: 'rotation', label: 'Credential rotation',
      state: rotations.length === 0 ? (notChosen ? 'pending' : 'skipped') : rotations.some((r) => r.error) ? 'failed' : 'pending',
      count: rotations.filter((r) => r.stagedAt).length,
      detail: rotations.length
        ? 'Staged. Each computer applies its new password at its next check-in; status below is live.'
        : notChosen ? `${notChosen} computer(s) this person had a credential for were not rotated.` : undefined,
    });

    const rec = await this.prisma.offboardingCase.create({
      data: {
        tenantId: actor.tenantId, subjectUserId: subject.id, customerId: scope, startedById: actor.userId,
        steps: { steps, rotations } as unknown as Prisma.InputJsonValue, notes: dto.notes?.slice(0, 1000) ?? null,
      },
    });
    await this.audit.log({
      tenantId: actor.tenantId ?? undefined, customerId: scope ?? undefined, actorId: actor.userId, actorIp: actor.ip,
      action: 'OFFBOARDING_STARTED', resource: 'user', resourceId: subject.id,
      meta: { caseId: rec.id, scope: kind, suspended: !!dto.suspendAccount, steps: steps.map((s) => `${s.key}:${s.state}`), rotations: rotations.length },
    });
    return this.get(actor, rec.id);
  }

  // ── Live status ──────────────────────────────────────────────────────────

  async list(actor: ActorContext, businessId?: string) {
    if (actor.technician) throw new ForbiddenException('Switch back to your own business');
    const where: Prisma.OffboardingCaseWhereInput = actor.isPlatformAdmin
      ? (businessId ? { customerId: businessId } : {})
      : this.acl.isBusinessOwner(actor) ? { customerId: this.acl.requireScope(actor, businessId) }
        : this.acl.hasPlatformPermission(actor, PLATFORM_PERM.TECHNICIANS_MANAGE) ? { customerId: null }
          : { id: '__none__' };
    const rows = await this.prisma.offboardingCase.findMany({ where, orderBy: { startedAt: 'desc' }, take: 100 });
    const users = await this.prisma.user.findMany({ where: { id: { in: rows.map((r) => r.subjectUserId) } }, select: { id: true, email: true } });
    const email = new Map(users.map((u) => [u.id, u.email]));
    return Promise.all(rows.map(async (r) => ({ id: r.id, subjectEmail: email.get(r.subjectUserId) ?? null, businessId: r.customerId, startedAt: r.startedAt, completedAt: r.completedAt, rotation: (await this.rotationStatus(r)).summary })));
  }

  private async rotationStatus(r: { startedAt: Date; steps: Prisma.JsonValue }) {
    const rotations = ((r.steps as { rotations?: { endpointId: string; name: string; stagedAt: string | null; error?: string }[] })?.rotations ?? []);
    const ids = rotations.filter((x) => x.stagedAt).map((x) => x.endpointId);
    const [nodes, confirmed] = await Promise.all([
      this.prisma.endpoint.findMany({
        where: { id: { in: ids } },
        select: { id: true, isOnline: true, lastSeenAt: true, rustdeskNode: { select: { pendingPasswordAt: true } } },
      }),
      this.prisma.activityLog.findMany({
        where: { action: 'ENDPOINT_CREDENTIAL_ROTATED', resourceId: { in: ids }, createdAt: { gte: r.startedAt } },
        select: { resourceId: true, createdAt: true },
      }),
    ]);
    const conf = new Map(confirmed.map((c) => [c.resourceId, c.createdAt]));
    const node = new Map(nodes.map((n) => [n.id, n]));
    const items = rotations.map((x) => {
      const n = node.get(x.endpointId);
      const at = conf.get(x.endpointId);
      const state = x.error ? 'failed' : at ? 'confirmed' : 'pending';
      return {
        ...x, state, confirmedAt: at?.toISOString() ?? null,
        online: n?.isOnline ?? false, lastSeenAt: n?.lastSeenAt?.toISOString() ?? null,
        note: state === 'pending' ? (n?.isOnline ? 'Waiting for the computer\'s next check-in (every 3 minutes).' : 'The computer is offline. The old password keeps working on it until it comes back and acknowledges the new one.') : undefined,
      };
    });
    return {
      items,
      summary: { total: items.length, confirmed: items.filter((i) => i.state === 'confirmed').length, pending: items.filter((i) => i.state === 'pending').length, failed: items.filter((i) => i.state === 'failed').length, offlinePending: items.filter((i) => i.state === 'pending' && !i.online).length },
    };
  }

  async get(actor: ActorContext, id: string) {
    const r = await this.prisma.offboardingCase.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('Offboarding case not found');
    const allowed = actor.isPlatformAdmin
      || (r.customerId && this.acl.isBusinessOwner(actor) && !actor.technician && actor.businessId === r.customerId)
      || (!r.customerId && this.acl.hasPlatformPermission(actor, PLATFORM_PERM.TECHNICIANS_MANAGE));
    if (!allowed) throw new NotFoundException('Offboarding case not found');
    const subject = await this.prisma.user.findUnique({ where: { id: r.subjectUserId }, select: { id: true, email: true, status: true } });
    const rot = await this.rotationStatus(r);
    const steps = ((r.steps as { steps?: OffboardingStep[] })?.steps ?? []).map((s) =>
      s.key === 'rotation' && rot.items.length
        ? { ...s, state: (rot.summary.failed ? 'failed' : rot.summary.pending ? 'pending' : 'done') as StepState }
        : s);
    if (!r.completedAt && steps.every((s) => s.state === 'done' || s.state === 'skipped')) {
      await this.prisma.offboardingCase.updateMany({ where: { id, completedAt: null }, data: { completedAt: new Date() } });
    }
    return { id: r.id, subject, businessId: r.customerId, startedAt: r.startedAt, completedAt: r.completedAt, notes: r.notes, steps, rotations: rot.items, rotationSummary: rot.summary };
  }

  /** Every computer with a staged rotation that its endpoint has not acknowledged. */
  async unresolvedRotations(actor: ActorContext, businessId?: string) {
    const scope = this.acl.resolveScope(actor, businessId);
    const rows = await this.prisma.endpoint.findMany({
      where: { ...(scope ? { customerId: scope } : {}), status: { not: 'ARCHIVED' }, rustdeskNode: { pendingPasswordAt: { not: null } } },
      select: { id: true, name: true, isOnline: true, lastSeenAt: true, customer: { select: { name: true } }, rustdeskNode: { select: { pendingPasswordAt: true } } },
      orderBy: { name: 'asc' },
    });
    return rows.map((e) => ({
      endpointId: e.id, name: e.name, businessName: e.customer?.name ?? null, online: e.isOnline,
      lastSeenAt: e.lastSeenAt?.toISOString() ?? null, stagedAt: e.rustdeskNode!.pendingPasswordAt!.toISOString(),
    }));
  }
}
