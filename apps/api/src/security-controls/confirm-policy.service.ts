import { BadRequestException, ForbiddenException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { ActorContext } from '../rbac/access-control.service';
import { ALWAYS_ASK_KEYS, ALWAYS_ASK_NOTE, CONFIRM_CATALOG, CONFIRM_GROUPS, CONFIRM_KEYS, type ConfirmKey, type ConfirmValue } from './confirm-catalog';
import { assertFresh, confirmValues, setConfirmPolicy } from './review';

const CONFIGURABLE: ReadonlySet<string> = new Set<string>(CONFIRM_KEYS);
const ALWAYS: ReadonlySet<string> = new Set<string>(ALWAYS_ASK_KEYS);

/**
 * Settings → Confirm it is you (0.49): which functions ask a signed-in person
 * to confirm it is them again (confirm-catalog.ts, ConfirmPolicy rows).
 *
 * The rows are read at start and every 30 s, and the in-memory policy is set
 * at once on a change, so assertFresh and StepUpService.assert decide
 * synchronously. Until the first read everything asks (review.ts fails
 * closed); a failed read keeps the last policy read. A function with no row
 * takes its catalog default, which from 0.64 is `off` for every function:
 * a fresh install asks only at sign-in.
 *
 * Reading: any signed-in user (the console words its prompts from it).
 * Changing: a Platform Admin only. Each key must be in the configurable
 * catalog — an always-ask key or an unknown key is refused, never stored.
 * Turning any function from ask to off loosens a protection, so it needs a
 * fresh confirmation itself (`confirm.relax`, which is always-ask); turning
 * one back to ask never does. Every change is audited
 * (CONFIRM_POLICY_CHANGED, the changed keys before and after).
 */
@Injectable()
export class ConfirmPolicyService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('ConfirmPolicy');
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

  /** Read the rows and set the policy assertFresh consults. Returns the effective values. */
  async load(): Promise<Record<ConfirmKey, ConfirmValue>> {
    try {
      const rows = await this.prisma.confirmPolicy.findMany({ select: { key: true, value: true } });
      setConfirmPolicy(rows);
    } catch (e) {
      // Keep the last policy read; review.ts asks until a first read succeeds.
      this.log.warn(`could not read the confirm policy: ${String(e)}`);
    }
    return confirmValues();
  }

  view(values: Record<ConfirmKey, ConfirmValue>, actor: ActorContext) {
    return {
      groups: [...CONFIRM_GROUPS],
      catalog: CONFIRM_CATALOG.map((f) => ({ ...f, value: values[f.key] })),
      values,
      alwaysAsk: [...ALWAYS_ASK_NOTE],
      canChange: actor.isPlatformAdmin === true,
    };
  }

  /** Validate a PUT body: `{ values: { key: 'ask' | 'off' } }`, at least one key, every one configurable. */
  private parse(raw: unknown): Map<ConfirmKey, ConfirmValue> {
    const values = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? (raw as { values?: unknown }).values : undefined;
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      throw new BadRequestException({ code: 'INVALID_CONFIRM_POLICY', message: "values must be an object of { key: 'ask' | 'off' }" });
    }
    const entries = Object.entries(values as Record<string, unknown>);
    if (entries.length === 0 || entries.length > CONFIRM_KEYS.length) {
      throw new BadRequestException({ code: 'INVALID_CONFIRM_POLICY', message: `name between 1 and ${CONFIRM_KEYS.length} functions` });
    }
    const out = new Map<ConfirmKey, ConfirmValue>();
    for (const [k, v] of entries) {
      if (ALWAYS.has(k)) throw new BadRequestException({ code: 'CONFIRM_ALWAYS_ASKS', key: k, message: `${k} always asks and cannot be changed` });
      if (!CONFIGURABLE.has(k)) throw new BadRequestException({ code: 'UNKNOWN_CONFIRM_KEY', key: k, message: `${k} is not a function in the catalog` });
      if (v !== 'ask' && v !== 'off') throw new BadRequestException({ code: 'INVALID_CONFIRM_VALUE', key: k, message: `${k} must be 'ask' or 'off'` });
      out.set(k as ConfirmKey, v);
    }
    return out;
  }

  async set(actor: ActorContext, raw: unknown, freshMethod: string | null) {
    if (!actor.isPlatformAdmin) throw new ForbiddenException('Platform Admin access required');
    const want = this.parse(raw);
    const before = await this.load();
    const changed = [...want].filter(([k, v]) => before[k] !== v);
    if (changed.length === 0) return this.view(before, actor);
    if (changed.some(([, v]) => v === 'off')) {
      // Always-ask: removing a confirmation always confirms first. Asking again never does.
      assertFresh(freshMethod, { action: 'confirm.relax', message: 'Turning off a confirmation: confirm it is you.' });
    }
    await this.prisma.$transaction(changed.map(([key, value]) => this.prisma.confirmPolicy.upsert({
      where: { key }, update: { value, updatedById: actor.userId }, create: { key, value, updatedById: actor.userId },
    })));
    const after = await this.load();
    await this.audit.log({
      actorId: actor.userId, actorIp: actor.ip, action: 'CONFIRM_POLICY_CHANGED', resource: 'confirm_policy', resourceId: 'platform',
      meta: {
        before: Object.fromEntries(changed.map(([k]) => [k, before[k]])),
        after: Object.fromEntries(changed.map(([k]) => [k, after[k]])),
      },
    });
    return this.view(after, actor);
  }
}
