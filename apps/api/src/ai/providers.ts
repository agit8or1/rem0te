/**
 * The three provider shapes (0.48), as data: where a request goes, what it
 * carries and how the answer is read. Pure — no I/O, no key storage — so the
 * unit test builds exactly what the API sends. The only module allowed to
 * name a provider endpoint or key header (invariant §41).
 *
 *   anthropic          POST https://api.anthropic.com/v1/messages
 *                      x-api-key, anthropic-version: 2023-06-01
 *   openai             POST https://api.openai.com/v1/chat/completions, Bearer
 *   openai_compatible  POST {baseUrl}/chat/completions — Azure (v1 API),
 *                      OpenRouter, Groq, Mistral and others; Bearer, or an
 *                      `api-key` header for Azure. The base URL is a public
 *                      HTTPS name, checked on save and on every call
 *                      (common/safe-https.ts).
 *
 * AI_TEST_BASE_URL replaces the two fixed hosts only when NODE_ENV is `test`
 * and it is http://127.0.0.1:<port>: that is the e2e suite's stub.
 */
import { testLoopbackAllowed } from '../common/safe-https';

export const PROVIDERS = ['anthropic', 'openai', 'openai_compatible'] as const;
export type Provider = (typeof PROVIDERS)[number];
export const AUTH_STYLES = ['bearer', 'api-key'] as const;
export type AuthStyle = (typeof AUTH_STYLES)[number];

export const ANTHROPIC_BASE = 'https://api.anthropic.com';
export const OPENAI_BASE = 'https://api.openai.com/v1';
export const ANTHROPIC_VERSION = '2023-06-01';
export const ANTHROPIC_MODELS = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'] as const;
export const DEFAULT_MODEL: Record<Provider, string> = { anthropic: 'claude-sonnet-5-5', openai: 'gpt-5.1-mini', openai_compatible: '' };
export const PROVIDER_LABEL: Record<Provider, string> = { anthropic: 'Anthropic (Claude)', openai: 'OpenAI', openai_compatible: 'OpenAI-compatible' };

export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;
export const MAX_OUTPUT_TOKENS = 1024;

export interface ProviderConfig { provider: Provider; model: string; baseUrl: string | null; authStyle: AuthStyle }
export interface ProviderRequest { url: string; headers: Record<string, string>; body: string }
export interface ProviderAnswer { text: string; inputTokens: number; outputTokens: number; model: string | null }

function testBase(): string | null {
  const v = process.env.AI_TEST_BASE_URL;
  return v && testLoopbackAllowed(v) ? v.replace(/\/$/, '') : null;
}

/** The URL a request for this configuration goes to. */
export function endpointUrl(cfg: ProviderConfig): string {
  if (cfg.provider === 'anthropic') return `${testBase() ?? ANTHROPIC_BASE}/v1/messages`;
  if (cfg.provider === 'openai') return `${testBase() ? `${testBase()}/v1` : OPENAI_BASE}/chat/completions`;
  return `${(cfg.baseUrl ?? '').replace(/\/+$/, '')}/chat/completions`;
}

/** Build one request. `key` is the decrypted key; it goes only into a header here. */
export function buildRequest(cfg: ProviderConfig, key: string, system: string, user: string, maxTokens = MAX_OUTPUT_TOKENS): ProviderRequest {
  const url = endpointUrl(cfg);
  const json = { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'rem0te-ai/1' };
  if (cfg.provider === 'anthropic') {
    return {
      url,
      headers: { ...json, 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION },
      body: JSON.stringify({ model: cfg.model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
    };
  }
  const auth: Record<string, string> = cfg.provider === 'openai_compatible' && cfg.authStyle === 'api-key' ? { 'api-key': key } : { authorization: `Bearer ${key}` };
  // OpenAI's own API wants max_completion_tokens for its current models; most compatible servers still read max_tokens.
  const limit = cfg.provider === 'openai' ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens };
  return {
    url,
    headers: { ...json, ...auth },
    body: JSON.stringify({ model: cfg.model, ...limit, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
  };
}

/** Untyped JSON from a provider, read defensively. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;
const int = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const str = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : null);

/** Read the provider's answer. Returns null for a shape we do not recognise. */
export function parseAnswer(provider: Provider, json: unknown): ProviderAnswer | null {
  const j = json as Record<string, Loose> | null;
  if (!j || typeof j !== 'object') return null;
  if (provider === 'anthropic') {
    const parts = Array.isArray(j.content) ? j.content.filter((c: Loose) => c?.type === 'text' && typeof c.text === 'string').map((c: Loose) => c.text as string) : [];
    if (!parts.length) return null;
    return { text: parts.join('\n'), inputTokens: int(j.usage?.input_tokens), outputTokens: int(j.usage?.output_tokens), model: str(j.model, 128) };
  }
  const c = Array.isArray(j.choices) ? j.choices[0]?.message?.content : null;
  if (typeof c !== 'string' || !c) return null;
  return { text: c, inputTokens: int(j.usage?.prompt_tokens), outputTokens: int(j.usage?.completion_tokens), model: str(j.model, 128) };
}

/** A short, safe code for a provider's refusal: its error type if it gave one, never its text. */
export function errorCode(status: number, json: unknown): string {
  const j = json as Record<string, Loose> | null;
  const t = j?.error?.type ?? j?.error?.code ?? j?.type;
  const tag = typeof t === 'string' && /^[A-Za-z0-9_.-]{1,48}$/.test(t) ? t : null;
  return tag ? `HTTP_${status}_${tag}` : `HTTP_${status}`;
}

/** Display form of a key: the last four characters only. */
export const last4 = (key: string) => key.slice(-4);
