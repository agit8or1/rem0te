import { ConflictException, ForbiddenException, HttpException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';
import { activePause, pauseMessage } from '../containment/pause';
import { loadTrust, type Peer } from './peers';
import type { PeerCapabilities } from './contract';
import { GatewayError } from './gateway.client';
import { fetchPeerCapabilities, requestTimeline, timelineRequest } from './timeline.client';
import { buildTimelinePayload, TIMELINE_FIELDS, TIMELINE_NOT_SENT, TIMELINE_TASK, MAX_NOTES, MAX_SESSIONS, type TimelineSnapshot } from './timeline';

export type GateCode =
  | 'READY' | 'NOT_CONFIGURED' | 'NO_BUSINESS' | 'NOT_MAPPED' | 'AMBIGUOUS_MAPPING' | 'CONTAINED'
  | 'PEER_UNSUPPORTED' | 'PEER_UNREACHABLE' | 'PROFILE_NOT_ALLOWED';

type Gate =
  | { ok: true; code: 'READY'; message: string; peer: Peer; organizationId: string; modelProfile: string }
  | { ok: false; code: Exclude<GateCode, 'READY'>; message: string; peerId?: string; organizationId?: string };

/** How long the peer's capabilities document is believed. A failure is retried sooner. */
const CAPS_TTL_MS = Number(process.env.INTEGRATION_CAPABILITIES_TTL_MS ?? 60_000);
const CAPS_FAIL_TTL_MS = Math.min(CAPS_TTL_MS, 15_000);
const NEEDS = `Needs ClientSt0r support for ${TIMELINE_TASK}`;

/**
 * The device page's AI summary (0.34), through ClientSt0r.
 *
 * rem0te holds no model-provider key and names no model. The summary is one
 * signed request to the peer's inference gateway, for the organization the
 * computer's business is mapped to, with a profile the peer advertises for
 * `device_timeline_v1` AND the peers file allows. That task is a PROPOSED
 * contract addition (INTEGRATION_COORDINATION.md §5A): until the peer's own
 * capabilities document lists it, nothing is sent and the console says so.
 *
 * Order of refusal, each before anything leaves rem0te: scope (404),
 * capability (403), integration configured, business mapped to exactly one
 * organization, containment (`integration` pause), the peer offering the
 * operation, an allowed profile. Every refusal after scope and every request
 * is audited, with counts and ids — never the text.
 */
@Injectable()
export class AiTimelineService {
  private readonly logger = new Logger('AiTimeline');
  private readonly caps = new Map<string, { at: number; ok: true; doc: PeerCapabilities } | { at: number; ok: false; code: string }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly acl: AccessControlService,
  ) {}

  private async snapshot(id: string): Promise<TimelineSnapshot> {
    const ep = await this.prisma.endpoint.findUniqueOrThrow({
      where: { id },
      select: {
        id: true, platform: true, osVersion: true, agentVersion: true, status: true, isOnline: true, lastSeenAt: true, createdAt: true,
        noteRels: { orderBy: { createdAt: 'desc' }, take: MAX_NOTES, select: { createdAt: true, content: true, isPinned: true } },
        supportSessions: {
          orderBy: { createdAt: 'desc' }, take: MAX_SESSIONS,
          select: { createdAt: true, status: true, issueDescription: true, disposition: true, duration: true },
        },
      },
    });
    return { ...ep, notes: ep.noteRels, sessions: ep.supportSessions };
  }

  private async peerCaps(peer: Peer): Promise<{ ok: true; doc: PeerCapabilities } | { ok: false; code: string }> {
    const hit = this.caps.get(peer.id);
    if (hit && Date.now() - hit.at < (hit.ok ? CAPS_TTL_MS : CAPS_FAIL_TTL_MS)) return hit;
    let v: { at: number; ok: true; doc: PeerCapabilities } | { at: number; ok: false; code: string };
    try { v = { at: Date.now(), ok: true, doc: await fetchPeerCapabilities(peer) }; }
    catch (e) { v = { at: Date.now(), ok: false, code: e instanceof GatewayError ? e.code : 'CAPABILITIES_FAILED' }; }
    this.caps.set(peer.id, v);
    return v;
  }

  /** Whether a summary can be requested for this business now. Contacts the peer only for its capabilities, and never under a pause. */
  async gate(customerId: string | null): Promise<Gate> {
    const trust = loadTrust();
    if (!trust || trust.peers.size === 0) return { ok: false, code: 'NOT_CONFIGURED', message: 'The ClientSt0r integration is not configured on this server, so there is no AI summary.' };
    if (!customerId) return { ok: false, code: 'NO_BUSINESS', message: 'This computer belongs to no business, so it has no ClientSt0r organization to ask.' };
    const pause = await activePause(this.prisma, 'integration', customerId);
    if (pause) return { ok: false, code: 'CONTAINED', message: pauseMessage(pause, 'integration') };
    const maps = (await this.prisma.integrationOrgMapping.findMany({ where: { customerId, revokedAt: null }, orderBy: { createdAt: 'asc' } }))
      .filter((m) => trust.peers.has(m.peerId));
    if (maps.length === 0) return { ok: false, code: 'NOT_MAPPED', message: 'This business is not mapped to a ClientSt0r organization. A Platform Admin maps it under the integration settings.' };
    if (maps.length > 1) return { ok: false, code: 'AMBIGUOUS_MAPPING', message: 'This business is mapped to more than one ClientSt0r peer; rem0te will not guess which one to send its notes to.' };
    const m = maps[0];
    const peer = trust.peers.get(m.peerId)!;
    const ids = { peerId: peer.id, organizationId: m.externalOrgId };
    if (!peer.capabilitiesUrl) return { ok: false, code: 'PEER_UNSUPPORTED', message: `${NEEDS}. The peers file names no capabilitiesUrl for ${peer.id}, so rem0te cannot tell whether ClientSt0r offers it.`, ...ids };
    const caps = await this.peerCaps(peer);
    if (!caps.ok) return { ok: false, code: 'PEER_UNREACHABLE', message: `Could not read ClientSt0r's capabilities (${caps.code}). Try again shortly.`, ...ids };
    const task = caps.doc.inference_tasks.find((t) => t.task === TIMELINE_TASK);
    if (!task) return { ok: false, code: 'PEER_UNSUPPORTED', message: `${NEEDS}. ClientSt0r's capabilities do not list it yet.`, ...ids };
    const profile = task.model_profiles.find((p) => peer.modelProfiles.includes(p));
    if (!profile) return { ok: false, code: 'PROFILE_NOT_ALLOWED', message: `ClientSt0r offers ${TIMELINE_TASK} with ${task.model_profiles.join(', ')}, which this server's peers file does not allow.`, ...ids };
    return { ok: true, code: 'READY', message: `Ready: sent to ClientSt0r (${peer.id}) for organization ${m.externalOrgId}, profile ${profile}.`, peer, organizationId: m.externalOrgId, modelProfile: profile };
  }

  /** What the console shows before anything is sent: availability, and exactly what would leave rem0te. */
  async status(actor: ActorContext, id: string) {
    const ep = await this.acl.assertEndpointInScope(actor, id, CAP.COMPUTERS_VIEW);
    this.acl.assertCapability(actor, CAP.COMPUTERS_VIEW);
    const [gate, snap] = await Promise.all([this.gate(ep.customerId), this.snapshot(id)]);
    const payload = buildTimelinePayload(snap);
    return {
      operation: TIMELINE_TASK,
      available: gate.ok,
      code: gate.code,
      message: gate.message,
      peerId: gate.ok ? gate.peer.id : gate.peerId ?? null,
      organizationId: gate.organizationId ?? null,
      modelProfile: gate.ok ? gate.modelProfile : null,
      canRequest: this.acl.can(actor, CAP.COMPUTERS_EDIT) && this.acl.can(actor, CAP.TICKET_ANALYSIS),
      requires: [CAP.COMPUTERS_EDIT, CAP.TICKET_ANALYSIS],
      fields: TIMELINE_FIELDS,
      notSent: TIMELINE_NOT_SENT,
      preview: {
        rem0te_endpoint_id: id,
        untrusted_segments: payload.segments,
        redactions: payload.redactions,
        chars: payload.chars,
        droppedForSize: payload.dropped,
        notes: payload.counts.notes,
        sessions: payload.counts.sessions,
      },
    };
  }

  async generate(actor: ActorContext, id: string) {
    const ep = await this.acl.assertEndpointInScope(actor, id, CAP.COMPUTERS_EDIT);
    const base = {
      actorId: actor.userId, actorIp: actor.ip, actorAgent: actor.userAgent,
      tenantId: ep.tenantId ?? undefined, customerId: ep.customerId ?? undefined,
      resource: 'endpoint', resourceId: id,
    };
    const refuse = async (code: string, err: HttpException, extra: Record<string, unknown> = {}) => {
      await this.audit.log({ ...base, action: 'AI_TIMELINE_REFUSED', meta: { operation: TIMELINE_TASK, code, ...extra } });
      throw err;
    };
    if (!this.acl.can(actor, CAP.COMPUTERS_EDIT) || !this.acl.can(actor, CAP.TICKET_ANALYSIS)) {
      await refuse('NO_CAPABILITY', new ForbiddenException({ code: 'NO_CAPABILITY', message: `Requesting the AI summary needs ${CAP.COMPUTERS_EDIT} and ${CAP.TICKET_ANALYSIS} in this business.` }));
    }
    const gate = await this.gate(ep.customerId);
    if (!gate.ok) {
      const ids = { peerId: gate.peerId, organizationId: gate.organizationId };
      if (gate.code === 'CONTAINED') await refuse(gate.code, new ForbiddenException({ code: 'CONTAINED', message: gate.message }), ids);
      if (gate.code === 'PEER_UNREACHABLE') await refuse(gate.code, new ServiceUnavailableException({ code: gate.code, message: gate.message }), ids);
      await refuse(gate.code, new ConflictException({ code: gate.code, message: gate.message }), ids);
      throw new Error('unreachable');
    }

    const payload = buildTimelinePayload(await this.snapshot(id));
    const request = timelineRequest(gate.organizationId, gate.modelProfile, id, payload.segments, payload.redactions);
    const ids = { operation: TIMELINE_TASK, peerId: gate.peer.id, organizationId: gate.organizationId, modelProfile: gate.modelProfile, requestId: request.request_id };
    // The record of what left is written before it leaves, or nothing leaves.
    await this.audit.logOrFail({
      ...base, action: 'AI_TIMELINE_REQUESTED',
      meta: {
        ...ids, fields: TIMELINE_FIELDS.map((f) => f.field), notes: payload.counts.notes, sessions: payload.counts.sessions,
        chars: payload.chars, droppedForSize: payload.dropped, redactions: payload.redactions,
      },
    });

    let result;
    try {
      result = await requestTimeline(gate.peer, request);
    } catch (e) {
      const code = e instanceof GatewayError ? e.code : 'GATEWAY_FAILED';
      if (!(e instanceof GatewayError)) this.logger.error(`timeline request failed: ${(e as Error).message}`);
      await this.audit.log({ ...base, action: 'AI_TIMELINE_FINISHED', meta: { ...ids, status: 'failed', code } });
      throw new HttpException({ code, message: `ClientSt0r did not return a summary (${code}). Nothing was saved.` }, 502);
    }
    const outcome = { ...ids, resolvedModel: result.resolvedModel, latencyMs: result.latencyMs, usage: result.usage };
    if (!result.ok || !result.summary) {
      await this.audit.log({ ...base, action: 'AI_TIMELINE_FINISHED', meta: { ...outcome, status: 'failed', code: result.errorCode } });
      throw new HttpException({ code: result.errorCode, message: `ClientSt0r did not return a summary (${result.errorCode}). Nothing was saved.` }, 502);
    }
    await this.prisma.endpoint.update({ where: { id }, data: { aiTimeline: result.summary } });
    await this.audit.log({
      ...base, action: 'AI_TIMELINE_FINISHED',
      meta: { ...outcome, status: 'succeeded', summaryChars: result.summary.length, droppedUnknownFields: result.droppedUnknownFields },
    });
    return {
      text: result.summary,
      source: { peerId: gate.peer.id, organizationId: gate.organizationId, modelProfile: gate.modelProfile, resolvedModel: result.resolvedModel, requestId: request.request_id },
      redactions: payload.redactions,
    };
  }
}
