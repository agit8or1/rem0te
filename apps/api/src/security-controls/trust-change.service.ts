import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { ActorContext } from '../rbac/access-control.service';
import { sanitizePlatformPermissions } from '../rbac/platform-permissions';
import { SecurityAlertService } from './alerts.service';
import { ControlsStore } from './controls.store';
import { AccessControls, PresetPolicy, presetCapabilities } from './presets';
import { assertIndependentReviewer } from './review';

export type TrustKind = 'access_policy' | 'preset' | 'platform_permissions' | 'device_class' | 'managed_workstation' | 'update_trust';

/**
 * Changes that WIDEN trust — who approves, who is told, what a tier may do,
 * which computers are protected, which workstation counts as managed — are
 * not applied by the person who asks for them. They become a pending
 * TrustChangeRequest that someone else decides; the previous alert contacts
 * are told when it is requested and when it is applied.
 *
 * Tightening is never routed here: making things stricter must stay easy.
 *
 * `before` / `after` hold policy values only. Nothing secret is stored in a
 * policy (alert destinations are validated to carry no credentials or query).
 */
@Injectable()
export class TrustChangeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly alerts: SecurityAlertService,
    private readonly controls: ControlsStore,
  ) {}

  async request(actor: ActorContext, p: { kind: TrustKind; target: string; before: unknown; after: unknown; payload: unknown; widening: string[] }) {
    // One open request per target: a newer one supersedes the old, so a
    // reviewer never approves a stale diff.
    await this.prisma.trustChangeRequest.updateMany({ where: { kind: p.kind, target: p.target, status: 'PENDING' }, data: { status: 'SUPERSEDED' } });
    const row = await this.prisma.trustChangeRequest.create({
      data: {
        kind: p.kind, target: p.target, requestedById: actor.userId,
        before: (p.before ?? null) as Prisma.InputJsonValue, after: (p.after ?? null) as Prisma.InputJsonValue,
        payload: { value: p.payload, widening: p.widening } as Prisma.InputJsonValue,
      },
    });
    await this.audit.log({
      actorId: actor.userId, actorIp: actor.ip, action: 'TRUST_CHANGE_REQUESTED', resource: 'trust_change', resourceId: row.id,
      meta: { kind: p.kind, target: p.target, widening: p.widening },
    });
    const current = await this.controls.platform();
    await this.alerts.raise({
      kind: 'trust_change_requested', identity: `user:${actor.userId}`,
      details: { request: row.id, kind: p.kind, target: p.target, widening: p.widening },
      destinations: current.alertDestinations,
    });
    return { pendingReview: true, request: { id: row.id, kind: row.kind, target: row.target, status: row.status, widening: p.widening } };
  }

  /** `payload` holds the value to apply (it may carry a webhook URL); it is never listed. */
  async list(status?: string) {
    const rows = await this.prisma.trustChangeRequest.findMany({ where: status ? { status } : {}, orderBy: { createdAt: 'desc' }, take: 200 });
    return rows.map(({ payload, ...r }) => ({ ...r, widening: (payload as { widening?: string[] } | null)?.widening ?? [] }));
  }

  async decide(actor: ActorContext, id: string, decision: 'APPROVE' | 'DENY') {
    const row = await this.prisma.trustChangeRequest.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Request not found');
    if (row.status !== 'PENDING') throw new ConflictException(`Request is ${row.status.toLowerCase()}`);
    assertIndependentReviewer(actor, row.requestedById, 'trust change');

    // Claim it first (conditional update), so two reviewers cannot both apply.
    const claimed = await this.prisma.trustChangeRequest.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: decision === 'APPROVE' ? 'APPLIED' : 'DENIED', reviewedById: actor.userId, reviewedAt: new Date() },
    });
    if (claimed.count !== 1) throw new ConflictException('Request was decided by someone else');

    const previous = await this.controls.platform();
    if (decision === 'APPROVE') await this.apply(row.kind as TrustKind, row.target, (row.payload as { value: unknown }).value);

    await this.audit.log({
      actorId: actor.userId, actorIp: actor.ip, action: 'TRUST_CHANGE_DECIDED', resource: 'trust_change', resourceId: id,
      meta: { kind: row.kind, target: row.target, decision, requestedById: row.requestedById, before: row.before, after: row.after },
    });
    // Tell the contacts as they were BEFORE the change — if this replaced
    // them, the old ones are exactly who must hear about it.
    await this.alerts.raise({
      kind: 'trust_change_decided', identity: `user:${row.requestedById}`,
      details: { request: id, kind: row.kind, target: row.target, decision, reviewedBy: actor.userId },
      destinations: previous.alertDestinations,
    });
    return { id, status: decision === 'APPROVE' ? 'APPLIED' : 'DENIED', kind: row.kind, target: row.target };
  }

  private async apply(kind: TrustKind, target: string, value: unknown) {
    switch (kind) {
      case 'access_policy': {
        const parsed = AccessControls.parse(value);
        await this.prisma.accessPolicy.update({ where: { id: 'singleton' }, data: { controls: parsed as unknown as Prisma.InputJsonValue, version: { increment: 1 } } });
        return;
      }
      case 'preset': {
        const v = value as { policy: unknown; name?: string; description?: string };
        const policy = PresetPolicy.parse(v.policy);
        await this.prisma.technicianPreset.update({
          where: { id: target },
          data: { policy: policy as unknown as Prisma.InputJsonValue, capabilities: presetCapabilities(policy), version: { increment: 1 }, ...(v.name ? { name: v.name } : {}), ...(v.description !== undefined ? { description: v.description } : {}) },
        });
        return;
      }
      case 'platform_permissions': {
        const perms = sanitizePlatformPermissions((value as { permissions: unknown }).permissions);
        await this.prisma.user.update({ where: { id: target }, data: { platformPermissions: perms } });
        await this.audit.log({ action: 'PLATFORM_PERMISSIONS_CHANGED', resource: 'user', resourceId: target, meta: { after: perms, viaTrustReview: true } });
        return;
      }
      case 'device_class': {
        await this.prisma.endpoint.update({ where: { id: target }, data: { deviceClass: (value as { deviceClass: never }).deviceClass } });
        return;
      }
      case 'managed_workstation': {
        await this.prisma.technicianDevice.update({ where: { id: target }, data: { isManagedAdminWorkstation: (value as { managed: boolean }).managed } });
        return;
      }
      case 'update_trust': {
        // Loosening the signed-update containment (0.24). Re-validated here:
        // the payload was written by the requester, approved by someone else.
        const v = value as { mode?: string; legacyPortalMigration?: unknown };
        if (v.mode !== 'legacy_allowed' && v.mode !== 'signed_only') throw new BadRequestException('Unknown update trust mode');
        const data = { updateTrustMode: v.mode, legacyPortalMigration: v.legacyPortalMigration === true };
        await this.prisma.platformSettings.upsert({ where: { id: 'singleton' }, update: data, create: { id: 'singleton', ...data } });
        await this.audit.log({ action: 'PLATFORM_SETTINGS_UPDATED', resource: 'update_trust', resourceId: 'singleton', meta: { after: data, viaTrustReview: true } });
        return;
      }
      default: throw new BadRequestException('Unknown trust change');
    }
  }
}
