import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { ActorContext } from '../rbac/access-control.service';
import { TRANSCRIPT_DAYS_DEFAULT, TRANSCRIPT_DAYS_MAX, TRANSCRIPT_DAYS_MIN, ENDPOINT_ID_RE } from './limits';

const Body = z.strictObject({
  terminalTranscripts: z.boolean().optional(),
  transcriptDays: z.number().int().min(TRANSCRIPT_DAYS_MIN).max(TRANSCRIPT_DAYS_MAX).optional(),
});

/**
 * A business's terminal settings (0.77): whether a terminal's transcript is
 * kept (default off) and for how many days. Platform Admin only, audited
 * with before and after. The only writer of RemoteOpsSetting.
 */
@Injectable()
export class RemoteOpsSettingsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  private assertAdmin(actor: ActorContext) {
    if (!actor.isPlatformAdmin) throw new ForbiddenException('Only a Platform Admin can change terminal settings.');
  }

  private shape(row: { terminalTranscripts: boolean; transcriptDays: number } | null) {
    return {
      terminalTranscripts: row?.terminalTranscripts ?? false,
      transcriptDays: row?.transcriptDays ?? TRANSCRIPT_DAYS_DEFAULT,
      limits: { transcriptDaysMin: TRANSCRIPT_DAYS_MIN, transcriptDaysMax: TRANSCRIPT_DAYS_MAX },
    };
  }

  async get(actor: ActorContext, businessId: string) {
    this.assertAdmin(actor);
    if (!ENDPOINT_ID_RE.test(businessId)) throw new NotFoundException('Business not found');
    const biz = await this.prisma.customer.findUnique({ where: { id: businessId }, select: { id: true } });
    if (!biz) throw new NotFoundException('Business not found');
    return this.shape(await this.prisma.remoteOpsSetting.findUnique({ where: { businessId } }));
  }

  async put(actor: ActorContext, businessId: string, raw: unknown) {
    this.assertAdmin(actor);
    const p = Body.safeParse(raw ?? {});
    if (!p.success) throw new BadRequestException({ code: 'REMOTE_OPS_SETTINGS_INVALID', message: `Transcript days must be ${TRANSCRIPT_DAYS_MIN}–${TRANSCRIPT_DAYS_MAX}.` });
    if (!ENDPOINT_ID_RE.test(businessId)) throw new NotFoundException('Business not found');
    const biz = await this.prisma.customer.findUnique({ where: { id: businessId }, select: { id: true, tenantId: true } });
    if (!biz) throw new NotFoundException('Business not found');
    const before = this.shape(await this.prisma.remoteOpsSetting.findUnique({ where: { businessId } }));
    const row = await this.prisma.remoteOpsSetting.upsert({
      where: { businessId },
      create: { businessId, terminalTranscripts: p.data.terminalTranscripts ?? false, transcriptDays: p.data.transcriptDays ?? TRANSCRIPT_DAYS_DEFAULT, updatedById: actor.userId },
      update: { ...p.data, updatedById: actor.userId },
    });
    const after = this.shape(row);
    await this.audit.log({
      action: 'REMOTE_OPS_SETTINGS_CHANGED', actorId: actor.userId, actorIp: actor.ip, customerId: businessId, tenantId: biz.tenantId,
      resource: 'business', resourceId: businessId,
      meta: {
        before: { terminalTranscripts: before.terminalTranscripts, transcriptDays: before.transcriptDays },
        after: { terminalTranscripts: after.terminalTranscripts, transcriptDays: after.transcriptDays },
      },
    });
    return after;
  }
}
