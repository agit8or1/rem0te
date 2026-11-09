import { randomUUID } from 'crypto';
import { CONTRACT, InferenceRequest, InferenceResponse } from './contract';
import type { Peer } from './peers';
import { signedPost, verifyPeerResponse } from './signer';
import type { Segment } from './analysis';
import { parseModelOutput, type ParsedRun } from './analysis';

export class GatewayError extends Error {
  constructor(public readonly code: string, message: string, public readonly transient: boolean) { super(message); }
}

const TIMEOUT_MS = Number(process.env.INTEGRATION_INFERENCE_TIMEOUT_MS ?? 90_000);
const MAX_RESPONSE = 256 * 1024;

/**
 * ClientSt0r's restricted inference gateway. rem0te holds no provider key and
 * names no model: it names a *profile* the peer offers, and the peer decides
 * which model, which key, which limits. The response is accepted only if it
 * is signed by the peer over our request nonce and echoes this exact job,
 * organization, profile and request id — so a result for another tenant, or
 * a replay of an earlier result, is refused.
 */
export async function infer(peer: Peer, job: { id: string; externalOrgId: string }, profile: string, segments: Segment[], refs: string[]): Promise<ParsedRun & { requestId: string; latencyMs: number }> {
  const request: InferenceRequest = InferenceRequest.parse({
    contract: CONTRACT,
    request_id: randomUUID(),
    job_id: job.id,
    organization_id: job.externalOrgId,
    model_profile: profile,
    task: 'ticket_triage_v1',
    output_schema: 'analysis-output.v1',
    max_output_tokens: 2000,
    input: { instructions_ref: 'rem0te/ticket-triage/v1', untrusted_segments: segments, evidence_refs: refs },
  });
  const started = Date.now();
  let r;
  try {
    r = await signedPost(peer, 'inference', JSON.stringify(request), TIMEOUT_MS, MAX_RESPONSE);
  } catch (e) {
    throw new GatewayError('GATEWAY_UNREACHABLE', `Inference gateway unreachable: ${(e as Error).name}`, true);
  }
  const latencyMs = Date.now() - started;
  if (r.status === 429 || r.status >= 500) throw new GatewayError('GATEWAY_UNAVAILABLE', `Inference gateway returned ${r.status}`, true);
  if (r.status !== 200) throw new GatewayError('GATEWAY_REFUSED', `Inference gateway returned ${r.status}`, false);
  if (!verifyPeerResponse(peer, r)) throw new GatewayError('RESPONSE_SIGNATURE_INVALID', 'Inference response is not signed by the peer for this request', false);

  let json: unknown;
  try { json = JSON.parse(r.body.toString('utf8')); } catch { throw new GatewayError('RESPONSE_INVALID', 'Inference response is not JSON', false); }
  const parsed = InferenceResponse.safeParse(json);
  if (!parsed.success) throw new GatewayError('RESPONSE_INVALID', 'Inference response does not match inference-response schema', false);
  const resp = parsed.data;
  if (resp.request_id !== request.request_id || resp.job_id !== job.id || resp.organization_id !== job.externalOrgId || resp.model_profile !== profile) {
    throw new GatewayError('RESPONSE_MISMATCH', 'Inference response is for a different request, job, organization or profile', false);
  }
  const base = { model_profile: profile, resolved_model: resp.resolved_model, usage: resp.usage ?? null, requestId: request.request_id, latencyMs };
  if (resp.status !== 'ok') {
    return { ...base, ok: false, output: null, dropped_unknown_fields: 0, error: { code: resp.status === 'refused' ? 'MODEL_REFUSED' : (resp.error_code ?? 'MODEL_ERROR').slice(0, 64), message: `Gateway reported ${resp.status}` } };
  }
  const out = parseModelOutput(resp.output);
  if (!out.output) return { ...base, ok: false, output: null, dropped_unknown_fields: 0, error: { code: 'OUTPUT_SCHEMA_INVALID', message: out.error ?? 'invalid output' } };
  return { ...base, ok: true, output: out.output, dropped_unknown_fields: out.dropped };
}
