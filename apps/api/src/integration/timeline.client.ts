import { randomUUID } from 'crypto';
import { CONTRACT, PeerCapabilities, TimelineInferenceRequest, TimelineInferenceResponse } from './contract';
import { GatewayError } from './gateway.client';
import type { Peer } from './peers';
import { signedGetCapabilities, signedPost, verifyPeerResponse } from './signer';
import { parseTimelineOutput, TIMELINE_INSTRUCTIONS_REF, TIMELINE_OUTPUT_SCHEMA, TIMELINE_TASK, type RedactionCounts, type TimelineSegment } from './timeline';

const CAPS_TIMEOUT_MS = Number(process.env.INTEGRATION_CAPABILITIES_TIMEOUT_MS ?? 5_000);
const TIMELINE_TIMEOUT_MS = Number(process.env.INTEGRATION_TIMELINE_TIMEOUT_MS ?? 60_000);
const MAX_CAPS_RESPONSE = 64 * 1024;
const MAX_RESPONSE = 64 * 1024;

/**
 * The peer's capabilities document (PROPOSED P12): which inference tasks its
 * gateway serves. Accepted only if signed by the peer over our nonce and
 * naming this peer — a document from somewhere else is not this peer's.
 */
export async function fetchPeerCapabilities(peer: Peer): Promise<PeerCapabilities> {
  let r;
  try {
    r = await signedGetCapabilities(peer, CAPS_TIMEOUT_MS, MAX_CAPS_RESPONSE);
  } catch (e) {
    throw new GatewayError('CAPABILITIES_UNREACHABLE', `ClientSt0r capabilities unreachable: ${(e as Error).name}`, true);
  }
  if (r.status !== 200) throw new GatewayError('CAPABILITIES_UNAVAILABLE', `ClientSt0r capabilities returned ${r.status}`, r.status >= 500 || r.status === 429);
  if (!verifyPeerResponse(peer, r)) throw new GatewayError('RESPONSE_SIGNATURE_INVALID', 'Capabilities response is not signed by the peer for this request', false);
  let json: unknown;
  try { json = JSON.parse(r.body.toString('utf8')); } catch { throw new GatewayError('RESPONSE_INVALID', 'Capabilities response is not JSON', false); }
  const parsed = PeerCapabilities.safeParse(json);
  if (!parsed.success) throw new GatewayError('RESPONSE_INVALID', 'Capabilities response does not match peer-capabilities', false);
  if (parsed.data.peer_id !== peer.id) throw new GatewayError('RESPONSE_MISMATCH', 'Capabilities document names a different peer', false);
  return parsed.data;
}

export interface TimelineResult {
  requestId: string;
  latencyMs: number;
  resolvedModel: string | null;
  usage: { input_tokens: number; output_tokens: number } | null;
  ok: boolean;
  summary: string | null;
  droppedUnknownFields: number;
  errorCode?: string;
}

/** Build the request body. Exported so the console's preview is the same object that is sent. */
export function timelineRequest(organizationId: string, profile: string, endpointId: string, segments: TimelineSegment[], redactions: RedactionCounts): TimelineInferenceRequest {
  return TimelineInferenceRequest.parse({
    contract: CONTRACT,
    request_id: randomUUID(),
    organization_id: organizationId,
    model_profile: profile,
    task: TIMELINE_TASK,
    output_schema: TIMELINE_OUTPUT_SCHEMA,
    max_output_tokens: 1200,
    input: { instructions_ref: TIMELINE_INSTRUCTIONS_REF, rem0te_endpoint_id: endpointId, untrusted_segments: segments, redactions },
  });
}

/**
 * One device-summary request to ClientSt0r's gateway (PROPOSED P11). Same
 * signing, same response check as ticket analysis: signed over our nonce,
 * and echoing this exact request, organization, profile and task.
 */
export async function requestTimeline(peer: Peer, request: TimelineInferenceRequest): Promise<TimelineResult> {
  const started = Date.now();
  let r;
  try {
    r = await signedPost(peer, 'inference', JSON.stringify(request), TIMELINE_TIMEOUT_MS, MAX_RESPONSE);
  } catch (e) {
    throw new GatewayError('GATEWAY_UNREACHABLE', `Inference gateway unreachable: ${(e as Error).name}`, true);
  }
  const latencyMs = Date.now() - started;
  if (r.status === 429 || r.status >= 500) throw new GatewayError('GATEWAY_UNAVAILABLE', `Inference gateway returned ${r.status}`, true);
  if (r.status !== 200) throw new GatewayError('GATEWAY_REFUSED', `Inference gateway returned ${r.status}`, false);
  if (!verifyPeerResponse(peer, r)) throw new GatewayError('RESPONSE_SIGNATURE_INVALID', 'Inference response is not signed by the peer for this request', false);
  let json: unknown;
  try { json = JSON.parse(r.body.toString('utf8')); } catch { throw new GatewayError('RESPONSE_INVALID', 'Inference response is not JSON', false); }
  const parsed = TimelineInferenceResponse.safeParse(json);
  if (!parsed.success) throw new GatewayError('RESPONSE_INVALID', 'Inference response does not match timeline-inference-response', false);
  const resp = parsed.data;
  if (resp.request_id !== request.request_id || resp.organization_id !== request.organization_id || resp.model_profile !== request.model_profile || resp.task !== request.task) {
    throw new GatewayError('RESPONSE_MISMATCH', 'Inference response is for a different request, organization, profile or task', false);
  }
  const base = { requestId: request.request_id, latencyMs, resolvedModel: resp.resolved_model, usage: resp.usage ?? null };
  if (resp.status !== 'ok') {
    return { ...base, ok: false, summary: null, droppedUnknownFields: 0, errorCode: resp.status === 'refused' ? 'MODEL_REFUSED' : (resp.error_code ?? 'MODEL_ERROR').replace(/[^A-Z0-9_]/gi, '').slice(0, 64) || 'MODEL_ERROR' };
  }
  const out = parseTimelineOutput(resp.output);
  if (!out.summary) return { ...base, ok: false, summary: null, droppedUnknownFields: 0, errorCode: 'OUTPUT_SCHEMA_INVALID' };
  return { ...base, ok: true, summary: out.summary, droppedUnknownFields: out.dropped };
}
