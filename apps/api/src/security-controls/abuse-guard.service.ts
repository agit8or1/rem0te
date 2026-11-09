import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SecurityAlertService } from './alerts.service';
import { ControlsStore } from './controls.store';
import type { AccessControls } from './presets';

export type WorkKind = 'LAUNCH' | 'WRITE' | 'EVIDENCE';
export type ThresholdKey = keyof AccessControls['thresholds'];

export interface AdmitRequest {
  identity: string;            // user:<id> | peer:<id>
  tier: ThresholdKey;
  kind: WorkKind;
  endpointId: string | null;
  customerId: string | null;
  entryPoint: 'ui' | 'api' | 'launcher' | 'scheduler' | 'integration';
}
export type AdmitResult = { ok: true } | { ok: false; reason: 'identity_paused' | 'threshold_tripped'; message: string; limit?: string };

/**
 * Fleet-abuse detection that cannot be split across small jobs.
 *
 * Every unit of privileged work — a launch, a write to a computer, endpoint
 * evidence for an integration — is admitted here, whatever the entry point.
 * Admission takes a per-identity Postgres advisory lock for the length of
 * one transaction, counts DISTINCT computers and businesses plus launches and
 * writes inside the window, and either records the work or refuses it. Forty
 * concurrent requests for forty different computers serialise on the lock,
 * so exactly `devices` of them get in.
 *
 * Tripping a limit pauses the identity: new privileged work is refused until
 * someone else clears the pause. An independent contact is alerted. The pause
 * and the alert are separate — suppressing the alert does not lift the pause.
 *
 * A maintenance exception (approved by someone other than the requester)
 * lets named computers past the cap until it expires; nothing else.
 */
@Injectable()
export class AbuseGuardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly alerts: SecurityAlertService,
    private readonly controls: ControlsStore,
  ) {}

  async isPaused(identity: string): Promise<boolean> {
    return !!(await this.prisma.identityPause.findFirst({ where: { identity, clearedAt: null }, select: { id: true } }));
  }

  async admit(r: AdmitRequest): Promise<AdmitResult> {
    const controls = await this.controls.platform();
    const limits = controls.thresholds[r.tier];
    const windowMs = controls.windowMinutes * 60_000;

    const outcome = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${r.identity}, 0))`;
      const paused = await tx.identityPause.findFirst({ where: { identity: r.identity, clearedAt: null }, select: { id: true } });
      if (paused) return { ok: false as const, reason: 'identity_paused' as const, message: 'Privileged work for this identity is paused until an administrator clears it.' };

      const now = new Date();
      const rows = await tx.privilegedActivity.findMany({
        where: { identity: r.identity, at: { gte: new Date(now.getTime() - windowMs) } },
        select: { kind: true, endpointId: true, customerId: true },
      });
      const devices = new Set(rows.map((x) => x.endpointId).filter(Boolean));
      const businesses = new Set(rows.map((x) => x.customerId).filter(Boolean));
      const launches = rows.filter((x) => x.kind === 'LAUNCH').length;
      const writes = rows.filter((x) => x.kind === 'WRITE').length;

      const exception = r.endpointId ? await tx.maintenanceException.findFirst({
        where: {
          identity: r.identity, status: 'APPROVED', endpointIds: { has: r.endpointId }, kinds: { has: r.kind },
          startsAt: { lte: now }, expiresAt: { gt: now },
        },
        select: { id: true },
      }) : null;

      let tripped: string | null = null;
      if (!exception) {
        if (r.endpointId && !devices.has(r.endpointId) && devices.size + 1 > limits.devices) tripped = `devices ${devices.size + 1} > ${limits.devices}`;
        else if (r.customerId && !businesses.has(r.customerId) && businesses.size + 1 > limits.businesses) tripped = `businesses ${businesses.size + 1} > ${limits.businesses}`;
        else if (r.kind === 'LAUNCH' && launches + 1 > limits.launches) tripped = `launches ${launches + 1} > ${limits.launches}`;
        else if (r.kind === 'WRITE' && writes + 1 > limits.writes) tripped = `writes ${writes + 1} > ${limits.writes}`;
      }
      if (tripped) {
        const pause = await tx.identityPause.create({
          data: {
            identity: r.identity, reason: `threshold_tripped: ${tripped}`,
            details: { tier: r.tier, kind: r.kind, entryPoint: r.entryPoint, endpointId: r.endpointId, customerId: r.customerId, windowMinutes: controls.windowMinutes, limits, observed: { devices: devices.size, businesses: businesses.size, launches, writes } } as Prisma.InputJsonValue,
          },
        });
        return { ok: false as const, reason: 'threshold_tripped' as const, message: `Limit reached (${tripped} in ${controls.windowMinutes} min). Privileged work is paused and an administrator has been alerted.`, limit: tripped, pauseId: pause.id };
      }
      await tx.privilegedActivity.create({
        data: { identity: r.identity, kind: r.kind, endpointId: r.endpointId, customerId: r.customerId, entryPoint: r.entryPoint },
      });
      return { ok: true as const, exception: exception?.id ?? null };
    });

    if (!outcome.ok) {
      await this.audit.log({
        action: outcome.reason === 'threshold_tripped' ? 'IDENTITY_PAUSED' : 'PRIVILEGED_WORK_DENIED',
        customerId: r.customerId ?? undefined, actorId: r.identity.startsWith('user:') ? r.identity.slice(5) : undefined,
        resource: 'identity', resourceId: r.identity,
        meta: { reason: outcome.reason, limit: (outcome as { limit?: string }).limit, kind: r.kind, entryPoint: r.entryPoint, endpointId: r.endpointId },
      });
      if (outcome.reason === 'threshold_tripped') {
        await this.alerts.raise({
          kind: 'fleet_abuse_threshold', identity: r.identity, customerId: r.customerId,
          details: { limit: (outcome as { limit?: string }).limit, tier: r.tier, kind: r.kind, entryPoint: r.entryPoint, endpointId: r.endpointId },
          destinations: controls.alertDestinations,
        });
      }
      return { ok: false, reason: outcome.reason, message: outcome.message, limit: (outcome as { limit?: string }).limit };
    }
    return { ok: true };
  }
}
