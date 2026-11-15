import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import type { ActorContext } from '../rbac/access-control.service';
import { Schedule } from '../common/schedule';
import { MAX_RESTART_DELAY_MINUTES, MIN_RESTART_DELAY_MINUTES, REBOOT_SCHEDULE } from './catalog';
import { ActionsService } from './actions.service';

/**
 * 0.54: "Schedule restart" for the device list's selection or a device
 * group (the bulk path's restart.schedule). The bulk service resolves and
 * scopes the computers (at most 200, as the caller sees them, a group
 * resolved at request time) and hands them here; each one is then the
 * single computer's own request — ActionsService.request, one signed plan per
 * computer (windows.reboot.schedule names one computer), with the Actions
 * tab's scope, live-access, readiness, containment, one-at-a-time and
 * direct-mode checks, and its audit entry. Nothing here writes a plan itself.
 */
export const BulkRestart = z.object({
  delayMinutes: z.number().int().min(MIN_RESTART_DELAY_MINUTES).max(MAX_RESTART_DELAY_MINUTES),
  restartAt: Schedule.optional(),
  onlyIfRequired: z.literal(true).optional(),
  ignoreRemoteSession: z.literal(true).optional(),
}).strict();
export type BulkRestart = z.infer<typeof BulkRestart>;

type Target = { id: string; name: string; customerId: string | null };
type Result = { endpointId: string; name?: string; ok: boolean; code?: string; reason?: string; unchanged?: boolean; jobId?: string };

@Injectable()
export class RestartBulkService {
  private readonly log = new Logger('RestartBulk');
  constructor(private readonly actions: ActionsService) {}

  async bulk(a: ActorContext, targets: Target[], results: Map<string, Result>, opts: { restart: BulkRestart; reason: string; freshMethod: string | null }, refusalOf: (e: unknown) => { code: string; reason: string }) {
    const { delayMinutes, restartAt, onlyIfRequired, ignoreRemoteSession } = opts.restart;
    const params = { delayMinutes, ...(onlyIfRequired ? { onlyIfRequired: true } : {}), ...(ignoreRemoteSession ? { ignoreRemoteSession: true } : {}) };
    // Direct mode runs each plan as soon as it is requested: the fresh sign-in
    // is asked once, for the whole request, before anything is sent (§ 58).
    for (const biz of new Set(targets.map((t) => t.customerId).filter((x): x is string => !!x))) await this.actions.assertDirectFresh(biz, opts.freshMethod);
    let stopped: { code: string; reason: string } | null = null;
    for (const t of targets) {
      const base = { endpointId: t.id, name: t.name };
      if (stopped) { results.set(t.id, { ...base, ok: false, ...stopped }); continue; }
      try {
        const job = await this.actions.request(a, t.id, {
          actionId: REBOOT_SCHEDULE.id, version: REBOOT_SCHEDULE.version, params, reason: opts.reason, windowHours: REBOOT_SCHEDULE.maxWindowHours ?? 2,
          ...(restartAt ? { restartAt } : {}),
        }, { kind: 'technician', ticketRef: null, via: 'portal' }, undefined, opts.freshMethod);
        results.set(t.id, { ...base, ok: true, jobId: job.id });
      } catch (e) {
        const r = refusalOf(e);
        if (r.code === 'ERROR') this.log.warn(`bulk restart ${t.id}: ${String(e)}`);
        results.set(t.id, { ...base, ok: false, ...r });
        if (r.code === 'IDENTITY_PAUSED' || r.code === 'THRESHOLD_TRIPPED') stopped = { code: 'IDENTITY_PAUSED', reason: 'Not attempted: privileged work for you is paused until an administrator clears it.' };
      }
    }
  }
}

