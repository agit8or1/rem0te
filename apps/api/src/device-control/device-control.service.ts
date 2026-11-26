import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { assertAssigned } from '../common/unassigned';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { AccessPolicyService } from '../security-controls/access-policy.service';
import { ActionsService } from '../actions/actions.service';
import { SignerClient } from '../actions/signer.client';
import {
  KEEP_RUNNING_SERVICES, MAX_TREE_PROCESSES, NO_DISABLE_SERVICES, OWN_SERVICE_PREFIX, PROCESS_NAME_RE, PROCESS_STARTED_RE, PROCESS_STOP, PROTECTED_PROCESSES,
  PROTECTED_SERVICES, SERVICE_CONTROL, SERVICE_NAME_RE, SERVICE_PROCESS_UNPROVEN, SERVICE_START_TYPES, processRefusal, serviceDisplayNameOk, serviceRefusal,
  type CatalogAction, type ServiceOp, type ServiceStartType,
} from '../actions/catalog';
import { readOnlyAgentRefusal } from '../common/platform';

/**
 * The Services tab's controls and the Processes tab's End process (0.45):
 * windows.service.control@1 and windows.process.stop@1.
 *
 * A request names a row of this computer's own latest snapshot — a service
 * by its name and display name from service_list, a process by its id, name
 * and start time from process_list — and nothing the snapshot does not show
 * is ever planned. The protected lists are refused here, before a plan
 * exists, and again by the computer. The plan is made only by
 * ActionsService.createPlan, which re-checks access, readiness, containment
 * (the `actions` pause), the one-at-a-time rule and, in direct mode, the
 * fresh sign-in, and submits it to the approval signer.
 *
 * Editing a service means its startup type, nothing else: there is no
 * parameter for its program, account, password, recovery actions or
 * dependencies, here or on the computer.
 */

const Reason = z.string().trim().min(3).max(500).optional();
const WindowHours = z.number().int().min(1).max(4).default(1);

export const ServiceControlDto = z.object({
  service: z.string().regex(SERVICE_NAME_RE),
  displayName: z.string().refine(serviceDisplayNameOk, 'a display name without control characters, quotes, angle brackets or backslashes'),
  op: z.enum(['start', 'stop', 'restart', 'set_start_type']),
  startType: z.enum(SERVICE_START_TYPES).optional(),
  reason: Reason,
  windowHours: WindowHours,
}).strict().refine((d) => (d.op === 'set_start_type') === (d.startType !== undefined), { message: 'startType is given with set_start_type, and only then', path: ['startType'] });

export const ProcessStopDto = z.object({
  pid: z.number().int().min(1).max(4_294_967_295),
  name: z.string().regex(PROCESS_NAME_RE),
  startedAt: z.string().regex(PROCESS_STARTED_RE),
  tree: z.boolean().optional(),
  reason: Reason,
  windowHours: WindowHours,
}).strict();

type Ep = NonNullable<Awaited<ReturnType<ActionsService['endpointFor']>>>;
export interface Availability { possible: boolean; reason: string | null; fix: string | null }

const START_LABEL: Record<ServiceStartType, string> = { automatic: 'Automatic', automatic_delayed: 'Automatic (delayed)', manual: 'Manual', disabled: 'Disabled' };
const OP_LABEL: Record<ServiceOp, string> = { start: 'Start', stop: 'Stop', restart: 'Restart', set_start_type: 'Set the startup type of' };
const ACTION_IDS = [SERVICE_CONTROL.id, PROCESS_STOP.id];

function bad(e: z.ZodError): never {
  throw new BadRequestException({ code: 'INVALID_REQUEST', message: e.issues.slice(0, 4).map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
}

@Injectable()
export class DeviceControlService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly acl: AccessControlService,
    private readonly policy: AccessPolicyService,
    private readonly actions: ActionsService,
    private readonly signer: SignerClient,
  ) {}

  /** Why this person cannot put this computer in such a plan now, or possible. Asked again by createPlan. */
  async availability(actor: ActorContext, ep: Ep, action: CatalogAction): Promise<Availability> {
    const no = (reason: string, fix: string | null = null): Availability => ({ possible: false, reason, fix });
    const full = await this.prisma.endpoint.findUnique({ where: { id: ep.id }, select: { platform: true, isOnline: true } });
    const ro = readOnlyAgentRefusal(full?.platform, action === SERVICE_CONTROL ? 'Controlling a service' : 'Ending a process');
    if (ro) return no(ro.message);
    const notReady = this.actions.readiness(ep, `${action.id}@${action.version}`);
    if (notReady) return no(notReady, /does not report support/i.test(notReady) ? 'Update it to a signed agent build from 0.45.' : /legacy agent/i.test(notReady) ? 'Switch this computer to the signed channel (Patching setup, step 2).' : null);
    if (!full?.isOnline) return no('The computer is offline. A plan is only delivered while it checks in.', 'Wait until it is online.');
    if (!this.signer.configured()) return no('The approval signer is not set up on this server, so nothing can be approved.', 'Install the approval signer and set APPROVAL_SIGNER_INTERNAL_URL (Patching setup, steps 3–5).');
    const d = await this.policy.evaluateAction(actor, ep, 'high');
    if (!d.ok) return no(d.message, d.reason === 'action_not_granted' ? 'Ask someone whose access includes higher-risk requests.' : null);
    const blocking = await this.actions.blocking(ep.id, action.id);
    if (blocking) return no(blocking.status === 'UNKNOWN' ? 'An earlier request on this computer has an uncertain outcome.' : `An earlier ${action === SERVICE_CONTROL ? 'service change' : 'End process'} on this computer is still ${blocking.status.toLowerCase().replace(/_/g, ' ')}.`, blocking.status === 'UNKNOWN' ? 'Reconcile it on the Actions tab first.' : 'Wait for it to finish, or cancel it on the Actions tab.');
    return { possible: true, reason: null, fix: null };
  }

  private async endpoint(actor: ActorContext, endpointId: string): Promise<Ep> {
    await this.acl.assertEndpointInScope(actor, endpointId);
    const ep = await this.actions.endpointFor(endpointId);
    // 0.57 (§70): no service or process change on an unassigned computer.
    if (ep) assertAssigned(ep);
    if (!ep?.customerId) throw new NotFoundException('Computer not found');
    return ep;
  }

  private async latest(endpointId: string, key: 'service_list' | 'process_list') {
    return this.prisma.diagnosticRun.findFirst({ where: { endpointId, key, status: 'COMPLETED' }, orderBy: { completedAt: 'desc' }, select: { id: true, completedAt: true, result: true } });
  }

  /** What the two tabs need to offer their buttons: availability, the approval mode, the protected lists and recent requests. */
  async overview(actor: ActorContext, endpointId: string) {
    const ep = await this.endpoint(actor, endpointId);
    const [service, process, approval, recent] = await Promise.all([
      this.availability(actor, ep, SERVICE_CONTROL),
      this.availability(actor, ep, PROCESS_STOP),
      this.actions.approvalModeFor(actor, endpointId),
      this.prisma.actionTarget.findMany({
        where: { endpointId, job: { actionId: { in: ACTION_IDS } } }, orderBy: { createdAt: 'desc' }, take: 20,
        select: { jobId: true, status: true, statusReason: true, outcome: true, result: true, resultAt: true, createdAt: true, job: { select: { actionId: true, params: true, status: true } } },
      }),
    ]);
    return {
      service, process,
      // 0.40: 'direct', 'signed', or null with no signer.
      approval,
      unproven: SERVICE_PROCESS_UNPROVEN,
      protected: {
        services: PROTECTED_SERVICES, ownServicePrefix: OWN_SERVICE_PREFIX, keepRunning: KEEP_RUNNING_SERVICES, noDisable: NO_DISABLE_SERVICES,
        processes: PROTECTED_PROCESSES, maxTree: MAX_TREE_PROCESSES,
      },
      recent: recent.map((t) => ({
        jobId: t.jobId, actionId: t.job.actionId, params: t.job.params, jobStatus: t.job.status, status: t.status, reason: t.statusReason, outcome: t.outcome,
        observed: (t.result as { observed?: Record<string, string> } | null)?.observed ?? null, detail: (t.result as { detail?: string } | null)?.detail ?? null,
        at: t.resultAt ?? t.createdAt,
      })),
    };
  }

  /** Start, stop or restart one service from the latest service list, or change its startup type. */
  async controlService(actor: ActorContext, endpointId: string, raw: unknown, freshMethod: string | null) {
    const p = ServiceControlDto.safeParse(raw);
    if (!p.success) bad(p.error);
    const d = p.data;
    const ep = await this.endpoint(actor, endpointId);
    const refused = serviceRefusal(d.service, d.op, d.startType ?? null);
    if (refused) throw new ConflictException({ code: 'PROTECTED_SERVICE', message: refused.reason });
    const st = await this.availability(actor, ep, SERVICE_CONTROL);
    if (!st.possible) throw new ConflictException({ code: 'SERVICE_CONTROL_NOT_POSSIBLE', message: st.reason, fix: st.fix });
    const snap = await this.latest(endpointId, 'service_list');
    const rows = ((snap?.result as { services?: unknown } | null)?.services ?? []) as { name?: unknown; displayName?: unknown }[];
    const row = Array.isArray(rows) ? rows.find((r) => r?.name === d.service && r?.displayName === d.displayName) : undefined;
    if (!row) throw new NotFoundException({ code: 'SERVICE_NOT_IN_SNAPSHOT', message: 'This device\'s latest service list does not show that service with that display name. Refresh the Services tab and try again.' });
    const params = d.op === 'set_start_type' ? { service: d.service, displayName: d.displayName, op: d.op, startType: d.startType! } : { service: d.service, displayName: d.displayName, op: d.op };
    const what = d.op === 'set_start_type' ? `Set ${d.displayName} (${d.service}) to start ${START_LABEL[d.startType!]}` : `${OP_LABEL[d.op]} ${d.displayName} (${d.service})`;
    const job = await this.actions.createPlan(actor, {
      action: SERVICE_CONTROL, endpointIds: [endpointId], params,
      reason: (d.reason ?? what).slice(0, 500), startsInMinutes: 0, windowHours: d.windowHours, freshMethod,
    });
    return { job: await this.actions.view(job, actor) };
  }

  /** End one process from the latest process list: its id, name and start time, all three. */
  async stopProcess(actor: ActorContext, endpointId: string, raw: unknown, freshMethod: string | null) {
    const p = ProcessStopDto.safeParse(raw);
    if (!p.success) bad(p.error);
    const d = p.data;
    const ep = await this.endpoint(actor, endpointId);
    const refused = processRefusal(d.name, d.pid);
    if (refused) throw new ConflictException({ code: 'PROTECTED_PROCESS', message: refused.reason });
    const st = await this.availability(actor, ep, PROCESS_STOP);
    if (!st.possible) throw new ConflictException({ code: 'PROCESS_STOP_NOT_POSSIBLE', message: st.reason, fix: st.fix });
    const snap = await this.latest(endpointId, 'process_list');
    const rows = ((snap?.result as { processes?: unknown } | null)?.processes ?? []) as { name?: unknown; pid?: unknown; startedAt?: unknown }[];
    const row = Array.isArray(rows) ? rows.find((r) => r?.pid === d.pid && r?.name === d.name && r?.startedAt === d.startedAt) : undefined;
    if (!row) throw new NotFoundException({ code: 'PROCESS_NOT_IN_SNAPSHOT', message: 'This device\'s latest process list does not show that process (that id, name and start time). Refresh the Processes tab and try again.' });
    const params = { pid: d.pid, name: d.name, startedAt: d.startedAt, ...(d.tree ? { tree: true } : {}) };
    const job = await this.actions.createPlan(actor, {
      action: PROCESS_STOP, endpointIds: [endpointId], params,
      reason: (d.reason ?? `End ${d.name} (PID ${d.pid})${d.tree ? ' and the processes it started' : ''}`).slice(0, 500), startsInMinutes: 0, windowHours: d.windowHours, freshMethod,
    });
    return { job: await this.actions.view(job, actor) };
  }
}
