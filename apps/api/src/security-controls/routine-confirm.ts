import { BadRequestException, ForbiddenException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { ActorContext } from '../rbac/access-control.service';
import { ROUTINE_ACTIONS, assertFresh, setRoutineConfirm, type RoutineConfirm } from './review';

/**
 * Whether everyday changes ask the person to confirm it is them again
 * (0.46.1, PlatformSettings.routineConfirm, review.ts ROUTINE_ACTIONS).
 *
 * The value is read at start and every 30 s, and set at once on a change, so
 * assertFresh can consult it synchronously. Until the first read it asks
 * (review.ts fails closed). Reading it: any signed-in user (the console words
 * its prompts from it). Changing it: a Platform Admin, audited
 * (ROUTINE_CONFIRM_CHANGED). Turning the confirmation off is loosening a
 * protection, so it always needs a fresh sign-in itself; turning it on never
 * does.
 */
@Injectable()
export class RoutineConfirmService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('RoutineConfirm');
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async onModuleInit() {
    await this.load();
    this.timer = setInterval(() => { void this.load(); }, 30_000);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async load(): Promise<RoutineConfirm> {
    try {
      const s = await this.prisma.platformSettings.findUnique({ where: { id: 'singleton' }, select: { routineConfirm: true } });
      const v: RoutineConfirm = s?.routineConfirm === 'off' ? 'off' : 'every';
      setRoutineConfirm(v);
      return v;
    } catch (e) {
      // Keep the last value read; review.ts asks until a first read succeeds.
      this.log.warn(`could not read routineConfirm: ${String(e)}`);
      return 'every';
    }
  }

  view(v: RoutineConfirm, actor: ActorContext) {
    return { value: v, actions: [...ROUTINE_ACTIONS], canChange: actor.isPlatformAdmin === true };
  }

  async set(actor: ActorContext, raw: unknown, freshMethod: string | null) {
    if (!actor.isPlatformAdmin) throw new ForbiddenException('Platform Admin access required');
    if (raw !== 'off' && raw !== 'every') throw new BadRequestException({ code: 'INVALID_ROUTINE_CONFIRM', message: "value must be 'off' or 'every'" });
    const before = await this.load();
    if (before === raw) return this.view(before, actor);
    if (raw === 'off') {
      // Not a routine action: removing the confirmation always confirms first.
      assertFresh(freshMethod, { action: 'fresh.auth', message: 'Turning off the confirmation for everyday changes: confirm it is you.' });
    }
    await this.prisma.platformSettings.upsert({ where: { id: 'singleton' }, update: { routineConfirm: raw }, create: { id: 'singleton', routineConfirm: raw } });
    setRoutineConfirm(raw);
    await this.audit.log({
      actorId: actor.userId, actorIp: actor.ip, action: 'ROUTINE_CONFIRM_CHANGED', resource: 'platform_settings', resourceId: 'singleton',
      meta: { before, after: raw },
    });
    return this.view(raw, actor);
  }
}
