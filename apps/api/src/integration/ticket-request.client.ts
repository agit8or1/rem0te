/**
 * "Create ticket" with ClientSt0r as the PSA (0.48, PROPOSED P16 —
 * INTEGRATION_COORDINATION.md §5C). Not agreed by ClientSt0r: nothing is sent
 * until the peer's own signed capabilities document lists
 * `ticket_create_request_v1`, so against today's ClientSt0r this connector is
 * never offered.
 *
 * The event goes to the peer's events URL through signer.signedPost (the
 * integration's one outbound call site), signed as data under
 * `rem0te-ticket-request-v1\n`; the response must be signed by the peer over
 * our nonce and echo the event id. The body is redactForPeer()'d, as
 * everything sent to ClientSt0r is.
 */
import { randomUUID } from 'crypto';
import { CONTRACT, TICKET_REQUEST_FEATURE, TicketCreateRequestEvent, TicketCreateRequestResponse } from './contract';
import type { Peer } from './peers';
import { signedPost, signTicketRequest, verifyPeerResponse } from './signer';
import { fetchPeerCapabilities } from './timeline.client';
import { redactForPeer } from './timeline';

const TIMEOUT_MS = 15_000;
const MAX_RESPONSE = 16 * 1024;

export async function peerOffersTickets(peer: Peer): Promise<boolean> {
  if (!peer.capabilitiesUrl) return false;
  try { return (await fetchPeerCapabilities(peer)).features?.includes(TICKET_REQUEST_FEATURE) ?? false; } catch { return false; }
}

export function ticketRequestEvent(peer: Peer, organizationId: string, t: { subject: string; body: string; endpointId: string; computerName: string; sourceRef: string }): TicketCreateRequestEvent {
  return TicketCreateRequestEvent.parse({
    contract: CONTRACT, event_id: randomUUID(), type: 'ticket.create_request', occurred_at: new Date().toISOString(),
    peer_id: peer.id, organization_id: organizationId,
    ticket: {
      subject: redactForPeer(t.subject).text.slice(0, 200) || 'Ticket from rem0te', body: redactForPeer(t.body).text.slice(0, 12000),
      rem0te_endpoint_id: t.endpointId, computer_name: t.computerName.slice(0, 128), source_ref: t.sourceRef, requested_by_role: 'staff',
    },
  });
}

export async function sendTicketRequest(peer: Peer, ev: TicketCreateRequestEvent): Promise<{ ok: boolean; status: string; ref: string | null; url: string | null }> {
  let r;
  try { r = await signedPost(peer, 'events', JSON.stringify({ ticket_request: ev, signature: signTicketRequest(ev) }), TIMEOUT_MS, MAX_RESPONSE); }
  catch (e) { return { ok: false, status: (e as Error).name || 'network error', ref: null, url: null }; }
  if (r.status < 200 || r.status >= 300) return { ok: false, status: `HTTP ${r.status}`, ref: null, url: null };
  if (!verifyPeerResponse(peer, r)) return { ok: false, status: 'RESPONSE_SIGNATURE_INVALID', ref: null, url: null };
  let j: unknown; try { j = JSON.parse(r.body.toString('utf8')); } catch { return { ok: false, status: 'RESPONSE_INVALID', ref: null, url: null }; }
  const p = TicketCreateRequestResponse.safeParse(j);
  if (!p.success || p.data.event_id !== ev.event_id) return { ok: false, status: 'RESPONSE_INVALID', ref: null, url: null };
  if (p.data.status !== 'created') return { ok: false, status: `refused ${(p.data.error_code ?? '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 64)}`.trim(), ref: null, url: null };
  return { ok: true, status: 'created', ref: p.data.ticket_id ?? null, url: p.data.ticket_url ?? null };
}
