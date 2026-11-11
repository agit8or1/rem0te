import { HttpException, Injectable } from '@nestjs/common';
import type { ActionJob } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ActionsService } from '../actions/actions.service';
import { catalogEntry, CATALOG, BLOCKED_CATEGORIES } from '../actions/catalog';
import { ActionProposalRequest, CONTRACT, type ActionProposal, type DelegationClaims } from './contract';
import { canonicalJson, sha256Hex } from './crypto';
import { DelegationService } from './delegation.service';
import { E, IntegrationError } from './errors';
import type { Peer } from './peers';
import { ReplayGuardService } from './replay-guard.service';

/**
 * Action proposals from ClientSt0r (v0.26).
 *
 * A proposal is a request, made as the delegated technician, through exactly
 * the path the portal's own Request button uses (ActionsService.request):
 * the same catalog, the same live access check for that technician on that
 * computer, the same approval signer. It is labelled with where it came from
 * — `ai_suggestion` or `technician`, via `clientst0r` — and the approvers see
 * that label. It never authorizes anything: ClientSt0r gets the approval URL
 * to show, and status to poll.
 */
@Injectable()
export class ActionProposalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly delegation: DelegationService,
    private readonly replay: ReplayGuardService,
    private readonly actions: ActionsService,
  ) {}

  /** What capabilities advertises: catalog actions, only when a signer is configured. */
  proposable(): string[] {
    // 0.32: the maintenance actions are not offered to ClientSt0r (CatalogAction.integration).
    return this.actions.catalog().configured ? CATALOG.filter((a) => a.integration).map((a) => `${a.id}@${a.version}`) : [];
  }

  async propose(peer: Peer, rawBody: unknown, token: string | undefined): Promise<{ replayed: boolean; proposal: ActionProposal }> {
    const parsed = ActionProposalRequest.safeParse(rawBody);
    if (!parsed.success) {
      const where = parsed.error.issues.slice(0, 5).map((i) => i.path.join('.') || '(root)').join(', ');
      throw E.invalid(`Request does not match action-proposal-request schema at: ${where}`);
    }
    const body = parsed.data;
    const claims = this.delegation.verifyToken(peer, token, 'actions:propose', sha256Hex(canonicalJson(body)));
    if (claims.org !== body.organization_id || claims.sub !== body.technician_id) {
      await this.reject(peer, claims, 'ACTOR_MISMATCH', body);
      throw E.forbidden('organization_id / technician_id do not match the delegation token');
    }

    // Idempotency: the same key returns the same proposal; a different
    // request under it is a conflict, never a second plan.
    const existing = await this.prisma.actionJob.findUnique({ where: { integrationPeer_integrationKey: { integrationPeer: peer.id, integrationKey: body.idempotency_key } } });
    if (existing) {
      const same = existing.endpointId === body.rem0te_endpoint_id && existing.actionId === body.action.id && existing.actionVersion === body.action.version
        && canonicalJson(existing.params) === canonicalJson(body.params) && existing.reason === body.reason && existing.origin === body.origin;
      if (!same) throw E.idempotencyConflict();
      return { replayed: true, proposal: toProposal(existing, body.idempotency_key) };
    }
    if (!(await this.replay.consume(this.delegation.jtiKey(peer, claims), this.delegation.jtiExpiry(claims)))) throw E.replay('Delegation token already used');

    // Refused by name before anything else is looked up: the catalog is the
    // whole vocabulary, and the categories below are never in it.
    if (!catalogEntry(body.action.id, body.action.version)?.integration) {
      await this.reject(peer, claims, 'ACTION_NOT_IN_CATALOG', body);
      throw new IntegrationError(400, 'ACTION_NOT_IN_CATALOG', `Only these catalog actions can be proposed: ${CATALOG.filter((a) => a.integration).map((a) => `${a.id}@${a.version}`).join(', ')}. Never: ${BLOCKED_CATEGORIES.join(', ').replace(/_/g, ' ')}.`);
    }

    const who = await this.delegation.requireActor(peer.id, claims).catch(async (e) => {
      await this.reject(peer, claims, 'NO_ACCESS', body);
      throw e;
    });
    await this.delegation.assertEndpoint(who.actor, body.rem0te_endpoint_id);

    try {
      const view = await this.actions.request(
        who.actor, body.rem0te_endpoint_id,
        { actionId: body.action.id, version: body.action.version, params: body.params, reason: body.reason, startsInMinutes: body.starts_in_minutes, windowHours: body.window_hours },
        { kind: body.origin, ticketRef: body.ticket_ref, via: 'clientst0r' },
        { peer: peer.id, key: body.idempotency_key },
      );
      const row = await this.prisma.actionJob.findUniqueOrThrow({ where: { id: view.id } });
      return { replayed: false, proposal: toProposal(row, body.idempotency_key) };
    } catch (e) {
      // The portal's refusals carry stable codes and human messages; pass
      // them through as contract errors rather than a bare "refused".
      if (e instanceof HttpException && !(e instanceof IntegrationError)) {
        const r = e.getResponse() as { code?: string; message?: string };
        const code = typeof r === 'object' && r?.code && /^[A-Z_]{3,64}$/.test(r.code) ? r.code : 'REFUSED';
        await this.reject(peer, claims, code, body);
        throw new IntegrationError(e.getStatus() === 404 ? 400 : e.getStatus(), code, typeof r?.message === 'string' ? r.message.slice(0, 300) : 'Refused');
      }
      throw e;
    }
  }

  async get(peer: Peer, jobId: string, token: string | undefined): Promise<ActionProposal> {
    const claims = this.delegation.verifyToken(peer, token, 'actions:read');
    await this.delegation.consumeReadToken(peer, claims);
    const who = await this.delegation.requireActor(peer.id, claims);
    if (!/^[a-f0-9]{32}$/.test(jobId)) throw E.notFound();
    let row = await this.prisma.actionJob.findUnique({ where: { id: jobId } });
    // Another peer's, another business's and a nonexistent proposal look the same.
    if (!row || row.integrationPeer !== peer.id || row.customerId !== who.customerId || !row.integrationKey) throw E.notFound();
    await this.actions.get(who.actor, jobId).catch(() => undefined); // pulls the signer's state in
    row = (await this.prisma.actionJob.findUnique({ where: { id: jobId } }))!;
    return toProposal(row, row.integrationKey!);
  }

  private async reject(peer: Peer, claims: DelegationClaims, reason: string, body: ActionProposalRequest) {
    const org = await this.prisma.integrationOrgMapping.findUnique({ where: { peerId_externalOrgId: { peerId: peer.id, externalOrgId: claims.org } } }).catch(() => null);
    await this.audit.log({
      customerId: org?.customerId, action: 'ACTION_DISPATCH_BLOCKED', resource: 'integration_action_proposal', resourceId: body.idempotency_key.slice(0, 128),
      meta: { stage: 'proposal', peer: peer.id, technician: claims.sub, reason, action: `${body.action.id}@${body.action.version}`, endpointId: body.rem0te_endpoint_id, origin: body.origin },
    }).catch(() => undefined);
  }
}

export function toProposal(j: ActionJob, key: string): ActionProposal {
  const result = (j.result ?? null) as { observed?: Record<string, string> } | null;
  return {
    contract: CONTRACT,
    idempotency_key: key,
    job_id: j.id,
    status: j.status.toLowerCase() as ActionProposal['status'],
    status_reason: j.statusReason,
    rem0te_endpoint_id: j.endpointId,
    action: { id: j.actionId, version: j.actionVersion },
    origin: j.origin === 'ai_suggestion' ? 'ai_suggestion' : 'technician',
    ticket_ref: j.ticketRef,
    risk: j.risk === 'high' ? 'high' : 'low',
    approvals_required: j.approvalsRequired,
    customer_signoff: j.customerSignoff,
    approval_url: j.approvalUrl,
    plan_digest: j.digest,
    window: { not_before: j.notBefore.toISOString(), not_after: j.notAfter.toISOString() },
    outcome: (j.outcome as ActionProposal['outcome']) ?? null,
    observed: result?.observed ?? null,
    created_at: j.createdAt.toISOString(),
    updated_at: j.updatedAt.toISOString(),
  };
}
