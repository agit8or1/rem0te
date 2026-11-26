/**
 * ClientSt0r as the PSA (0.48). Offered only when the integration is
 * configured, the business is mapped to exactly one peer organization, no
 * `integration` pause covers it, and the peer's signed capabilities document
 * advertises `ticket_create_request_v1` (PROPOSED P16 — not agreed yet, so
 * today this is never ready). It has nothing to configure: the peers file
 * and the organization mapping are the configuration.
 */
import { BadRequestException } from '@nestjs/common';
import { activePause, pauseMessage } from '../../containment/pause';
import { loadTrust } from '../../integration/peers';
import { peerOffersTickets, sendTicketRequest, ticketRequestEvent } from '../../integration/ticket-request.client';
import type { DriverDeps, PsaDriver } from '../connector';
import { cleanUrl } from '../ticket';

async function target(customerId: string | null, deps: DriverDeps) {
  const trust = loadTrust();
  if (!trust || trust.peers.size === 0) return { ok: false as const, reason: 'The ClientSt0r integration is not configured on this server.' };
  if (!customerId) return { ok: false as const, reason: 'ClientSt0r tickets need the device to belong to a customer mapped to a ClientSt0r organization.' };
  const pause = await activePause(deps.prisma, 'integration', customerId);
  if (pause) return { ok: false as const, reason: pauseMessage(pause, 'integration') };
  const maps = (await deps.prisma.integrationOrgMapping.findMany({ where: { customerId, revokedAt: null } })).filter((m) => trust.peers.has(m.peerId));
  if (maps.length !== 1) return { ok: false as const, reason: maps.length ? 'This business is mapped to more than one ClientSt0r peer.' : 'This business is not mapped to a ClientSt0r organization.' };
  const peer = trust.peers.get(maps[0].peerId)!;
  if (!(await peerOffersTickets(peer))) return { ok: false as const, reason: 'Needs ClientSt0r support for ticket_create_request_v1: its capabilities do not list it yet.' };
  return { ok: true as const, peer, organizationId: maps[0].externalOrgId };
}

export const clientst0rDriver: PsaDriver = {
  kind: 'clientst0r',
  label: 'ClientSt0r',

  async parse() {
    if (!loadTrust()) throw new BadRequestException({ code: 'NOT_CONFIGURED', message: 'The ClientSt0r integration is not configured on this server (INTEGRATION_PEERS_FILE).' });
    return { emailRecipientId: null, webhookUrl: null, webhookSecretEnc: null, audit: {} };
  },

  async view() { return { integrationConfigured: !!loadTrust() }; },

  async ready(_row, deps, customerId) {
    const t = await target(customerId, deps);
    return t.ok ? { ok: true } : { ok: false, reason: t.reason };
  },

  async send(_row, draft, deps) {
    // The computer's business decides the organization, whichever scope the connector was set in.
    const t = await target(draft.business.id, deps);
    if (!t.ok) return { ok: false, status: 'not_offered' };
    const ev = ticketRequestEvent(t.peer, t.organizationId, { subject: draft.subject, body: draft.body, endpointId: draft.computer.id, computerName: draft.computer.name, sourceRef: draft.sourceRef });
    const r = await sendTicketRequest(t.peer, ev);
    return { ok: r.ok, status: r.status, ref: r.ref, url: cleanUrl(r.url) };
  },
};
