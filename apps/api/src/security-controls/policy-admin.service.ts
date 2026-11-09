import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DeviceClass, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { isOwnerRole } from '../rbac/capabilities';
import { PLATFORM_PERM } from '../rbac/platform-permissions';
import { ControlsStore } from './controls.store';
import { TrustChangeService } from './trust-change.service';
import {
  AccessControls, BUILT_IN_PRESETS, BusinessControls, CONTROL_STATUS, PresetPolicy, PROTECTED_CLASSES_MINIMUM,
  presetCapabilities, presetWidening, redactControls, restoreDestinations, wideningOf,
} from './presets';
import { validatePeerUrl } from '../integration/peers';
import { assertIndependentReviewer } from './review';

/**
 * Mutations behind Settings → Security → Technician Access. Every one that
 * widens trust is diverted to TrustChangeService; tightening applies at once.
 */
@Injectable()
export class PolicyAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly acl: AccessControlService,
    private readonly controls: ControlsStore,
    private readonly trust: TrustChangeService,
  ) {}

  private assertManager(actor: ActorContext) {
    this.acl.assertPlatformPermission(actor, PLATFORM_PERM.TECHNICIANS_MANAGE);
    if (actor.technician) throw new ForbiddenException('Switch back to your own account context to manage technician access');
  }

  // ── Presets ───────────────────────────────────────────────────────────────

  async listPresets(actor: ActorContext) {
    this.assertManager(actor);
    const rows = await this.prisma.technicianPreset.findMany({ orderBy: [{ builtIn: 'desc' }, { tier: 'asc' }, { name: 'asc' }], include: { _count: { select: { assignments: { where: { revokedAt: null } } } } } });
    return { presets: rows, controlStatus: CONTROL_STATUS };
  }

  /** Validate a candidate policy: locked items cannot move, unavailable ones cannot be enabled. */
  private validatePolicy(raw: unknown): PresetPolicy {
    const parsed = PresetPolicy.safeParse(raw);
    if (!parsed.success) throw new BadRequestException({ message: 'Invalid preset policy', issues: parsed.error.issues.slice(0, 10) });
    const p = parsed.data;
    // Standing access to anything the endpoint cannot enforce, or anything the
    // brief keeps off for every tier, cannot be configured. Eligibility to
    // REQUEST is allowed: the launch decision still refuses what it cannot
    // enforce. View-only may be "allowed" — it is gated per endpoint at launch.
    const refuse = (k: keyof PresetPolicy, why: string) => { throw new BadRequestException({ code: 'CONTROL_UNAVAILABLE', message: `${CONTROL_STATUS[k].label}: ${why}` }); };
    if (p.unattended !== 'off') refuse('unattended', 'off for every tier; unattended access is a platform policy, not a tier setting');
    if (p.clipboard !== 'off') refuse('clipboard', CONTROL_STATUS.clipboard.unavailable!);
    if (p.fileTransfer !== 'off') refuse('fileTransfer', CONTROL_STATUS.fileTransfer.unavailable!);
    if (p.elevation === 'allowed') refuse('elevation', 'standing elevation is never configurable; L3 may only request it');
    if (p.remoteControl === 'allowed') refuse('remoteControl', 'standing control is never configurable; it needs a temporary grant');
    return parsed.data;
  }

  async clonePreset(actor: ActorContext, id: string, name: string) {
    this.assertManager(actor);
    const src = await this.prisma.technicianPreset.findUnique({ where: { id } });
    if (!src) throw new NotFoundException('Preset not found');
    const row = await this.prisma.technicianPreset.create({
      data: {
        key: `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, name: name.slice(0, 100), tier: src.tier,
        builtIn: false, description: src.description, capabilities: src.capabilities, policy: src.policy as Prisma.InputJsonValue, clonedFromId: src.id,
      },
    });
    await this.audit.log({ actorId: actor.userId, actorIp: actor.ip, action: 'TECHNICIAN_PRESET_CHANGED', resource: 'technician_preset', resourceId: row.id, meta: { op: 'clone', from: src.id } });
    return row;
  }

  /** What a change would do, without doing it. */
  async previewPreset(actor: ActorContext, id: string, policyRaw: unknown) {
    this.assertManager(actor);
    const row = await this.prisma.technicianPreset.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Preset not found');
    const after = this.validatePolicy(policyRaw);
    const before = PresetPolicy.parse(row.policy);
    const capsBefore = presetCapabilities(before), capsAfter = presetCapabilities(after);
    const affected = await this.prisma.technicianAssignment.count({ where: { presetId: id, revokedAt: null } });
    return {
      widening: presetWidening(before, after), needsReview: presetWidening(before, after).length > 0,
      capabilities: { gains: capsAfter.filter((c) => !capsBefore.includes(c)), loses: capsBefore.filter((c) => !capsAfter.includes(c)) },
      affectedAssignments: affected,
    };
  }

  async updatePreset(actor: ActorContext, id: string, input: { name?: string; description?: string; policy: unknown }) {
    this.assertManager(actor);
    const row = await this.prisma.technicianPreset.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Preset not found');
    const after = this.validatePolicy(input.policy);
    const before = PresetPolicy.parse(row.policy);
    const widening = presetWidening(before, after);
    if (widening.length) {
      return this.trust.request(actor, { kind: 'preset', target: id, before, after, payload: { policy: after, name: input.name, description: input.description }, widening });
    }
    const updated = await this.prisma.technicianPreset.update({
      where: { id },
      data: { policy: after as unknown as Prisma.InputJsonValue, capabilities: presetCapabilities(after), version: { increment: 1 }, ...(input.name ? { name: input.name.slice(0, 100) } : {}), ...(input.description !== undefined ? { description: input.description.slice(0, 500) } : {}) },
    });
    await this.audit.log({ actorId: actor.userId, actorIp: actor.ip, action: 'TECHNICIAN_PRESET_CHANGED', resource: 'technician_preset', resourceId: id, meta: { op: 'update', before, after } });
    return { pendingReview: false, preset: updated };
  }

  /** Back to the shipped definition. If that is wider than today, it is reviewed. */
  async resetPreset(actor: ActorContext, id: string) {
    const row = await this.prisma.technicianPreset.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Preset not found');
    const shipped = BUILT_IN_PRESETS.find((p) => p.key === row.key);
    if (!shipped) throw new BadRequestException('Only built-in presets can be reset; delete a custom preset instead');
    return this.updatePreset(actor, id, { name: shipped.name, description: shipped.description, policy: shipped.policy });
  }

  async deletePreset(actor: ActorContext, id: string) {
    this.assertManager(actor);
    const row = await this.prisma.technicianPreset.findUnique({ where: { id }, include: { _count: { select: { assignments: { where: { revokedAt: null } } } } } });
    if (!row) throw new NotFoundException('Preset not found');
    if (row.builtIn) throw new BadRequestException('Built-in presets cannot be deleted; reset them instead');
    if (row._count.assignments > 0) throw new ConflictException('Revoke or move the assignments using this preset first');
    await this.prisma.technicianPreset.delete({ where: { id } });
    await this.audit.log({ actorId: actor.userId, actorIp: actor.ip, action: 'TECHNICIAN_PRESET_CHANGED', resource: 'technician_preset', resourceId: id, meta: { op: 'delete' } });
    return { deleted: true };
  }

  // ── Policy ────────────────────────────────────────────────────────────────

  async getPolicy(actor: ActorContext, businessId?: string) {
    if (businessId) this.assertBusinessPolicyEditor(actor, businessId, true);
    else this.assertManager(actor);
    const platform = await this.controls.platform();
    if (!businessId) return { platform: redactControls(platform), pending: await this.trust.list('PENDING') };
    return { platform: redactControls(platform), business: await this.controls.business(businessId), effective: redactControls(await this.controls.effective(businessId)) };
  }

  async setPlatformPolicy(actor: ActorContext, raw: unknown) {
    this.acl.assertPlatformAdmin(actor);
    const before = await this.controls.platform();
    let restored: unknown;
    try { restored = restoreDestinations(raw, before); } catch (e) { throw new BadRequestException((e as Error).message); }
    const parsed = AccessControls.safeParse(restored);
    if (!parsed.success) throw new BadRequestException({ message: 'Invalid policy', issues: parsed.error.issues.slice(0, 10) });
    const after = parsed.data;
    for (const c of PROTECTED_CLASSES_MINIMUM) {
      if (!after.protectedClasses.includes(c)) throw new BadRequestException({ code: 'LOCKED', message: `${c} is always protected and cannot be removed` });
    }
    for (const d of after.alertDestinations) {
      try { validatePeerUrl(d.url, 'alert destination'); } catch (e) { throw new BadRequestException((e as Error).message); }
    }
    const widening = wideningOf(before, after);
    if (widening.length) return this.trust.request(actor, { kind: 'access_policy', target: 'singleton', before: redactControls(before), after: redactControls(after), payload: after, widening });
    await this.prisma.accessPolicy.update({ where: { id: 'singleton' }, data: { controls: after as unknown as Prisma.InputJsonValue, version: { increment: 1 } } });
    await this.audit.log({ actorId: actor.userId, actorIp: actor.ip, action: 'ACCESS_POLICY_CHANGED', resource: 'access_policy', resourceId: 'singleton', meta: { before: redactControls(before), after: redactControls(after) } });
    return { pendingReview: false, policy: redactControls(after) };
  }

  /** Business Owner of that business (or Platform Admin). */
  private assertBusinessPolicyEditor(actor: ActorContext, businessId: string, readOnly = false) {
    if (actor.isPlatformAdmin) return;
    if (readOnly && (actor.platformPermissions ?? []).includes('technicians:manage')) return;
    if (!actor.technician && actor.businessId === businessId && isOwnerRole(actor.roleType)) return;
    throw new ForbiddenException('Only this business\'s Business Owner can change its access policy');
  }

  /**
   * A business can only tighten: effectiveControls() takes the stricter of
   * platform and business for every field, so whatever is stored here can
   * never widen anything. No review needed, by construction.
   */
  async setBusinessPolicy(actor: ActorContext, businessId: string, raw: unknown) {
    this.assertBusinessPolicyEditor(actor, businessId);
    const parsed = BusinessControls.safeParse(raw);
    if (!parsed.success) throw new BadRequestException({ message: 'Invalid policy', issues: parsed.error.issues.slice(0, 10) });
    const id = `business:${businessId}`;
    const before = await this.controls.business(businessId);
    await this.prisma.accessPolicy.upsert({
      where: { id }, create: { id, customerId: businessId, controls: parsed.data as Prisma.InputJsonValue },
      update: { controls: parsed.data as Prisma.InputJsonValue, version: { increment: 1 } },
    });
    await this.audit.log({ actorId: actor.userId, actorIp: actor.ip, customerId: businessId, action: 'ACCESS_POLICY_CHANGED', resource: 'access_policy', resourceId: id, meta: { before, after: parsed.data } });
    return { effective: await this.controls.effective(businessId) };
  }

  // ── Device class & managed workstations ───────────────────────────────────

  async setDeviceClass(actor: ActorContext, endpointId: string, deviceClass: DeviceClass) {
    this.acl.assertPlatformAdmin(actor);
    const ep = await this.prisma.endpoint.findUnique({ where: { id: endpointId }, select: { id: true, deviceClass: true, customerId: true } });
    if (!ep) throw new NotFoundException('Computer not found');
    const controls = await this.controls.effective(ep.customerId);
    const wasProtected = (controls.protectedClasses as string[]).includes(ep.deviceClass);
    const nowProtected = (controls.protectedClasses as string[]).includes(deviceClass);
    if (wasProtected && !nowProtected) {
      return this.trust.request(actor, { kind: 'device_class', target: ep.id, before: { deviceClass: ep.deviceClass }, after: { deviceClass }, payload: { deviceClass }, widening: [`deviceClass: ${ep.deviceClass} → ${deviceClass} (leaves protection)`] });
    }
    await this.prisma.endpoint.update({ where: { id: ep.id }, data: { deviceClass } });
    await this.audit.log({ actorId: actor.userId, actorIp: actor.ip, customerId: ep.customerId ?? undefined, action: 'DEVICE_CLASS_CHANGED', resource: 'endpoint', resourceId: ep.id, meta: { before: ep.deviceClass, after: deviceClass } });
    return { pendingReview: false, deviceClass };
  }

  async setManagedWorkstation(actor: ActorContext, technicianDeviceId: string, managed: boolean) {
    this.acl.assertPlatformAdmin(actor);
    const d = await this.prisma.technicianDevice.findUnique({ where: { id: technicianDeviceId }, select: { id: true, userId: true, isManagedAdminWorkstation: true } });
    if (!d) throw new NotFoundException('Workstation not found');
    if (managed && !d.isManagedAdminWorkstation) {
      return this.trust.request(actor, { kind: 'managed_workstation', target: d.id, before: { managed: false }, after: { managed: true }, payload: { managed: true }, widening: ['managed admin workstation designation'] });
    }
    await this.prisma.technicianDevice.update({ where: { id: d.id }, data: { isManagedAdminWorkstation: managed } });
    await this.audit.log({ actorId: actor.userId, actorIp: actor.ip, action: 'TRUST_CHANGE_DECIDED', resource: 'technician_device', resourceId: d.id, meta: { managed, direct: true } });
    return { pendingReview: false, managed };
  }

  // ── Pauses, exceptions, suppressions, alerts ──────────────────────────────

  private assertReviewerish(actor: ActorContext) {
    if (!actor.isPlatformAdmin && !(actor.platformPermissions ?? []).includes('approvals:review')) throw new ForbiddenException('Platform Admin or independent reviewer required');
  }

  async pauses(actor: ActorContext) {
    this.assertReviewerish(actor);
    return this.prisma.identityPause.findMany({ orderBy: { createdAt: 'desc' }, take: 200 });
  }

  /** Clearing a pause is independent: never by the paused identity. */
  async clearPause(actor: ActorContext, id: string) {
    const p = await this.prisma.identityPause.findUnique({ where: { id } });
    if (!p || p.clearedAt) throw new NotFoundException('No active pause');
    assertIndependentReviewer(actor, p.identity.startsWith('user:') ? p.identity.slice(5) : '', 'pause clearance');
    await this.prisma.identityPause.update({ where: { id }, data: { clearedAt: new Date(), clearedById: actor.userId } });
    await this.audit.log({ actorId: actor.userId, actorIp: actor.ip, action: 'IDENTITY_PAUSE_CLEARED', resource: 'identity', resourceId: p.identity, meta: { pause: id, reason: p.reason } });
    return { cleared: true };
  }

  async requestException(actor: ActorContext, input: { identity: string; endpointIds: string[]; kinds: string[]; reason: string; expiresAt: string }) {
    if (!/^(user|peer):[\w-]{1,64}$/.test(input.identity)) throw new BadRequestException('identity must be user:<id> or peer:<id>');
    const expiresAt = new Date(input.expiresAt);
    if (isNaN(expiresAt.getTime()) || expiresAt <= new Date()) throw new BadRequestException('expiresAt must be in the future');
    if (expiresAt.getTime() - Date.now() > 7 * 86_400_000) throw new BadRequestException('A maintenance exception lasts at most 7 days');
    const kinds = input.kinds.filter((k) => ['LAUNCH', 'WRITE', 'EVIDENCE'].includes(k));
    if (!kinds.length || !input.endpointIds.length) throw new BadRequestException('Name the computers and the kinds of work');
    const n = await this.prisma.endpoint.count({ where: { id: { in: input.endpointIds } } });
    if (n !== new Set(input.endpointIds).size) throw new BadRequestException('Unknown computer in the list');
    const row = await this.prisma.maintenanceException.create({ data: { identity: input.identity, endpointIds: [...new Set(input.endpointIds)], kinds, reason: input.reason.slice(0, 500), requestedById: actor.userId, expiresAt } });
    await this.audit.log({ actorId: actor.userId, actorIp: actor.ip, action: 'MAINTENANCE_EXCEPTION_CHANGED', resource: 'maintenance_exception', resourceId: row.id, meta: { op: 'request', identity: input.identity, count: row.endpointIds.length, kinds, expiresAt } });
    return row;
  }

  async decideException(actor: ActorContext, id: string, decision: 'APPROVE' | 'DENY') {
    const row = await this.prisma.maintenanceException.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Exception not found');
    assertIndependentReviewer(actor, row.requestedById, 'maintenance exception');
    // The beneficiary cannot approve it either.
    if (row.identity === `user:${actor.userId}`) throw new ForbiddenException({ code: 'NOT_INDEPENDENT', message: 'You cannot approve an exception for yourself' });
    const done = await this.prisma.maintenanceException.updateMany({ where: { id, status: 'PENDING' }, data: { status: decision === 'APPROVE' ? 'APPROVED' : 'DENIED', approvedById: actor.userId } });
    if (done.count !== 1) throw new ConflictException('No longer pending');
    await this.audit.log({ actorId: actor.userId, actorIp: actor.ip, action: 'MAINTENANCE_EXCEPTION_CHANGED', resource: 'maintenance_exception', resourceId: id, meta: { op: decision } });
    return this.prisma.maintenanceException.findUnique({ where: { id } });
  }

  async revokeException(actor: ActorContext, id: string) {
    this.assertReviewerish(actor);
    await this.prisma.maintenanceException.update({ where: { id }, data: { status: 'REVOKED', expiresAt: new Date() } });
    await this.audit.log({ actorId: actor.userId, actorIp: actor.ip, action: 'MAINTENANCE_EXCEPTION_CHANGED', resource: 'maintenance_exception', resourceId: id, meta: { op: 'revoke' } });
    return { revoked: true };
  }

  exceptions(actor: ActorContext) {
    this.assertReviewerish(actor);
    return this.prisma.maintenanceException.findMany({ orderBy: { createdAt: 'desc' }, take: 200 });
  }

  /** Silences delivery only — never lifts a pause. Max 24 h. */
  async suppress(actor: ActorContext, input: { identity?: string | null; kind: string; reason: string; until: string }) {
    this.assertReviewerish(actor);
    const until = new Date(input.until);
    if (isNaN(until.getTime()) || until <= new Date() || until.getTime() - Date.now() > 86_400_000) throw new BadRequestException('until must be within the next 24 hours');
    if (input.identity === `user:${actor.userId}`) throw new ForbiddenException('You cannot suppress alerts about yourself');
    const row = await this.prisma.alertSuppression.create({ data: { identity: input.identity ?? null, kind: input.kind.slice(0, 64), reason: input.reason.slice(0, 500), until, createdById: actor.userId } });
    await this.audit.log({ actorId: actor.userId, actorIp: actor.ip, action: 'ALERT_SUPPRESSION_CHANGED', resource: 'alert_suppression', resourceId: row.id, meta: { op: 'create', identity: row.identity, kind: row.kind, until } });
    return row;
  }

  async unsuppress(actor: ActorContext, id: string) {
    this.assertReviewerish(actor);
    await this.prisma.alertSuppression.update({ where: { id }, data: { revokedAt: new Date() } });
    await this.audit.log({ actorId: actor.userId, actorIp: actor.ip, action: 'ALERT_SUPPRESSION_CHANGED', resource: 'alert_suppression', resourceId: id, meta: { op: 'revoke' } });
    return { revoked: true };
  }

  async alerts(actor: ActorContext) {
    this.assertReviewerish(actor);
    const [alerts, suppressions] = await Promise.all([
      this.prisma.securityAlert.findMany({ orderBy: { createdAt: 'desc' }, take: 200 }),
      this.prisma.alertSuppression.findMany({ where: { revokedAt: null, until: { gt: new Date() } } }),
    ]);
    return { alerts, suppressions };
  }
}
