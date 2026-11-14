/**
 * The one place a model provider is called (0.48). Every request goes through
 * safePost (common/safe-https.ts): resolved and checked on every call,
 * connected to the checked address, certificate verified, no redirects, 60 s,
 * 256 KB. Errors are short codes, never the provider's text and never the key.
 */
import { OutboundError, safePost } from '../common/safe-https';
import { buildRequest, errorCode, parseAnswer, type ProviderAnswer, type ProviderConfig } from './providers';

export const AI_TIMEOUT_MS = 60_000;
export const AI_MAX_RESPONSE = 256 * 1024;

export type CallResult = { ok: true; answer: ProviderAnswer } | { ok: false; code: string };

export async function callProvider(cfg: ProviderConfig, key: string, system: string, user: string, maxTokens?: number): Promise<CallResult> {
  const req = buildRequest(cfg, key, system, user, maxTokens);
  let res;
  try {
    res = await safePost(req.url, req.headers, req.body, { timeoutMs: AI_TIMEOUT_MS, maxBytes: AI_MAX_RESPONSE });
  } catch (e) {
    return { ok: false, code: e instanceof OutboundError ? e.code : 'NETWORK' };
  }
  let json: unknown = null;
  try { json = JSON.parse(res.body.toString('utf8')); } catch { /* not JSON */ }
  if (res.status !== 200) return { ok: false, code: errorCode(res.status, json) };
  const a = parseAnswer(cfg.provider, json);
  return a ? { ok: true, answer: a } : { ok: false, code: 'RESPONSE_INVALID' };
}
