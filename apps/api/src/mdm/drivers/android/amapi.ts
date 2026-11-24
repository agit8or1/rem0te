/**
 * The one Android Management API client (0.85 Mooring, docs/own-mdm.md M3,
 * §94). Google's two hosts are the constants below and appear nowhere else
 * in apps/api/src. Every call goes through common/safe-https (decision 17:
 * a public DNS name resolved and judged on every call, the checked address
 * with SNI, certificates verified, no redirects, bounded time and size).
 *
 *   token      a JWT signed with the sealed service-account key (opened in
 *              memory by MdmSetupService.openAndroidCredential), exchanged
 *              at the token endpoint for the androidmanagement scope. The
 *              access token is kept ONLY in memory, keyed by a SHA-256 of the
 *              credential, until five minutes before it expires.
 *   reads      enterprises.list (the connection test), devices.list (paged,
 *              asking only DEVICE_FIELDS), devices.operations.list.
 *   writes     signupUrls.create, enterprises.create, policies.patch (the
 *              default policy only), enrollmentTokens.create (one-time).
 *
 * There is no issueCommand and no devices.delete: Rem0te sends nothing to a
 * device in M3 (M4 and M5 add the lost-device and destructive commands).
 *
 * The stand-in: under NODE_ENV=test only, AMAPI_TEST_BASE_URL (exactly
 * http://127.0.0.1:<port>, through testLoopbackAllowed) replaces both hosts:
 * <base>/token and <base>/v1/…. Under NODE_ENV=test WITHOUT it, every call is
 * refused (`not_ready`), so no test stack can reach Google by accident.
 *
 * Errors are a short code (AmapiError), never Google's text.
 */
import { createHash, type KeyObject } from 'node:crypto';
import { checkPublicHttpsUrl, OutboundError, safeGet, safePatch, safePost, testLoopbackAllowed, type SafeResponse } from '../../../common/safe-https';
import {
  DEFAULT_POLICY, DEVICE_FIELDS, ENTERPRISE_ID_RE, ENTERPRISE_TOKEN_RE, PAGE_TOKEN_RE, POLICY_ID, SIGNUP_NAME_RE,
  enrollmentTokenBody, enterpriseIdOf, enrollmentTokenAnswer, googleStatus, policyVersionOf, query, signJwt, signupAnswer, type PersonalUsage,
} from './shape';

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const AMAPI_ORIGIN = 'https://androidmanagement.googleapis.com';
/** An OAuth scope identifier (never fetched). */
export const AMAPI_SCOPE = 'https://www.googleapis.com/auth/androidmanagement';

export const AMAPI_TIMEOUT_MS = 20_000;
/** A device page asks for 100 devices and only DEVICE_FIELDS; 4 MB is far above that. */
export const AMAPI_MAX_BYTES = 4 * 1024 * 1024;
export const DEVICE_PAGE_SIZE = 100;
const OPTS = { timeoutMs: AMAPI_TIMEOUT_MS, maxBytes: AMAPI_MAX_BYTES };

export interface AndroidCredential { projectId: string; clientEmail: string; privateKeyId: string; key: KeyObject }

export type AmapiCode = 'not_ready' | 'bad_key' | 'permission_denied' | 'not_found' | 'quota' | 'unreachable' | 'bad_response' | 'conflict';
export class AmapiError extends Error {
  constructor(readonly code: AmapiCode, readonly httpStatus: number | null, readonly googleStatus: string | null = null) { super(code); this.name = 'AmapiError'; }
}

/** The stand-in's base, or null. Read here and nowhere else. */
export function amapiTestBase(): string | null {
  const raw = (process.env.AMAPI_TEST_BASE_URL ?? '').replace(/\/+$/, '');
  return raw && testLoopbackAllowed(raw) ? raw : null;
}

function endpoints(): { token: string; api: string } {
  const t = amapiTestBase();
  if (t) return { token: `${t}/token`, api: t };
  if (process.env.NODE_ENV === 'test') throw new AmapiError('not_ready', null);
  return { token: GOOGLE_TOKEN_URL, api: AMAPI_ORIGIN };
}

// ── Access tokens: memory only ──────────────────────────────────────────────

const tokens = new Map<string, { token: string; until: number }>();
const tokenKey = (c: AndroidCredential) => createHash('sha256')
  .update(`${c.clientEmail}\n${c.privateKeyId}\n`).update(c.key.export({ type: 'pkcs8', format: 'der' })).digest('hex');
export function clearAmapiTokens(): void { tokens.clear(); }

async function token(c: AndroidCredential): Promise<{ token: string; cached: boolean }> {
  const key = tokenKey(c);
  const hit = tokens.get(key);
  if (hit && hit.until > Date.now()) return { token: hit.token, cached: true };
  const ep = endpoints();
  const assertion = signJwt(c, ep.token, AMAPI_SCOPE, Math.floor(Date.now() / 1000));
  let res: SafeResponse;
  try {
    res = await safePost(ep.token, { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      query({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }), OPTS);
  } catch (e) { throw new AmapiError('unreachable', null, e instanceof OutboundError ? e.code : null); }
  const j = json(res);
  if (res.status === 400 || res.status === 401) throw new AmapiError('bad_key', res.status, googleStatus(j));
  if (res.status !== 200) throw new AmapiError(res.status >= 500 ? 'unreachable' : 'bad_response', res.status, googleStatus(j));
  const o = j as { access_token?: unknown; expires_in?: unknown; token_type?: unknown } | null;
  const t = typeof o?.access_token === 'string' && /^[A-Za-z0-9._~+/=-]{10,4096}$/.test(o.access_token) ? o.access_token : null;
  if (!t) throw new AmapiError('bad_response', res.status);
  const secs = typeof o?.expires_in === 'number' && o.expires_in > 0 ? Math.min(o.expires_in, 3600) : 3600;
  if (secs > 360) tokens.set(key, { token: t, until: Date.now() + (secs - 300) * 1000 });
  return { token: t, cached: false };
}

function json(res: SafeResponse): unknown {
  try { return JSON.parse(res.body.toString('utf8')); } catch { return null; }
}

/** One AMAPI call. A 401 on a cached token drops it and tries once more. */
async function call(c: AndroidCredential, method: 'GET' | 'POST' | 'PATCH', path: string, q: Record<string, string | number | null | undefined>, body: unknown, again = true): Promise<unknown> {
  const ep = endpoints();
  const t = await token(c);
  const qs = query(q);
  const url = `${ep.api}${path}${qs ? `?${qs}` : ''}`;
  const headers = { authorization: `Bearer ${t.token}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) };
  let res: SafeResponse;
  try {
    res = method === 'GET' ? await safeGet(url, headers, OPTS)
      : method === 'PATCH' ? await safePatch(url, headers, JSON.stringify(body ?? {}), OPTS)
        : await safePost(url, headers, body === undefined ? '' : JSON.stringify(body), OPTS);
  } catch (e) { throw new AmapiError('unreachable', null, e instanceof OutboundError ? e.code : null); }
  const j = json(res);
  if (res.status === 401 && t.cached && again) { tokens.delete(tokenKey(c)); return call(c, method, path, q, body, false); }
  if (res.status >= 200 && res.status < 300) { if (j === null) throw new AmapiError('bad_response', res.status); return j; }
  const gs = googleStatus(j);
  if (res.status === 401) throw new AmapiError('bad_key', res.status, gs);
  if (res.status === 403) throw new AmapiError('permission_denied', res.status, gs);
  if (res.status === 404) throw new AmapiError('not_found', res.status, gs);
  if (res.status === 409) throw new AmapiError('conflict', res.status, gs);
  if (res.status === 429) throw new AmapiError('quota', res.status, gs);
  throw new AmapiError(res.status >= 500 ? 'unreachable' : 'bad_response', res.status, gs);
}

const eid = (id: string) => { if (!ENTERPRISE_ID_RE.test(id)) throw new AmapiError('bad_response', null); return id; };

// ── The calls ───────────────────────────────────────────────────────────────

/** The connection test: a token, then one read (enterprises.list for the key's project, one item). */
export async function probe(c: AndroidCredential): Promise<void> {
  await call(c, 'GET', '/v1/enterprises', { projectId: c.projectId, pageSize: 1, view: 'BASIC' }, undefined);
}

/**
 * signupUrls.create. Google appends `enterpriseToken` to the callback. The
 * URL handed to the admin's browser must be https on a public name (or the
 * stand-in's loopback).
 */
export async function createSignupUrl(c: AndroidCredential, callbackUrl: string): Promise<{ name: string; url: string }> {
  const a = signupAnswer(await call(c, 'POST', '/v1/signupUrls', { projectId: c.projectId, callbackUrl }, undefined));
  if (!a || !SIGNUP_NAME_RE.test(a.name) || !checkPublicHttpsUrl(a.url).ok) throw new AmapiError('bad_response', 200);
  return a;
}

/** enterprises.create with the sign-up's name and Google's one-time enterpriseToken. Returns the enterprise id. */
export async function createEnterprise(c: AndroidCredential, signupUrlName: string, enterpriseToken: string): Promise<string> {
  if (!SIGNUP_NAME_RE.test(signupUrlName) || !ENTERPRISE_TOKEN_RE.test(enterpriseToken)) throw new AmapiError('bad_response', null);
  const id = enterpriseIdOf(await call(c, 'POST', '/v1/enterprises', { projectId: c.projectId, signupUrlName, enterpriseToken }, {}));
  if (!id) throw new AmapiError('bad_response', 200);
  return id;
}

/** policies.patch of the one default policy, exactly DEFAULT_POLICY. Returns Google's version. */
export async function patchDefaultPolicy(c: AndroidCredential, enterpriseId: string): Promise<string> {
  const v = policyVersionOf(await call(c, 'PATCH', `/v1/enterprises/${eid(enterpriseId)}/policies/${POLICY_ID}`, {}, DEFAULT_POLICY));
  if (!v) throw new AmapiError('bad_response', 200);
  return v;
}

/** enrollmentTokens.create: one-time, at most an hour, for the default policy. */
export async function createEnrollmentToken(c: AndroidCredential, enterpriseId: string, usage: PersonalUsage, minutes: number) {
  const a = enrollmentTokenAnswer(await call(c, 'POST', `/v1/enterprises/${eid(enterpriseId)}/enrollmentTokens`, {}, enrollmentTokenBody(enterpriseId, usage, minutes)));
  if (!a) throw new AmapiError('bad_response', 200);
  return a;
}

/** devices.list, one page of at most 100, only DEVICE_FIELDS. */
export async function listDevices(c: AndroidCredential, enterpriseId: string, pageToken: string | null): Promise<{ devices: unknown[]; next: string | null }> {
  if (pageToken !== null && !PAGE_TOKEN_RE.test(pageToken)) throw new AmapiError('bad_response', null);
  const j = await call(c, 'GET', `/v1/enterprises/${eid(enterpriseId)}/devices`, { pageSize: DEVICE_PAGE_SIZE, pageToken, fields: DEVICE_FIELDS }, undefined) as { devices?: unknown; nextPageToken?: unknown };
  const devices = j && j.devices === undefined ? [] : j?.devices;
  if (!Array.isArray(devices) || devices.length > DEVICE_PAGE_SIZE) throw new AmapiError('bad_response', 200);
  const next = typeof j.nextPageToken === 'string' && j.nextPageToken ? j.nextPageToken : null;
  if (next !== null && !PAGE_TOKEN_RE.test(next)) throw new AmapiError('bad_response', 200);
  return { devices, next };
}

/**
 * devices.operations.list for one device, one page. Whether Google serves
 * this listing for AMAPI is unconfirmed: a 404 or 501 (UNIMPLEMENTED) is
 * read as "no operations", never as a failure.
 */
export async function listOperations(c: AndroidCredential, enterpriseId: string, deviceId: string): Promise<unknown[]> {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(deviceId)) throw new AmapiError('bad_response', null);
  let j: unknown;
  try {
    j = await call(c, 'GET', `/v1/enterprises/${eid(enterpriseId)}/devices/${deviceId}/operations`, { pageSize: 100 }, undefined);
  } catch (e) {
    if (e instanceof AmapiError && (e.code === 'not_found' || e.httpStatus === 501)) return [];
    throw e;
  }
  const ops = (j as { operations?: unknown })?.operations;
  if (ops === undefined) return [];
  if (!Array.isArray(ops) || ops.length > 100) throw new AmapiError('bad_response', 200);
  return ops;
}

/** The public base Google redirects the admin's browser back to: https, or the loopback test API. */
export function callbackBase(apiBase: string): string | null {
  const b = apiBase.replace(/\/+$/, '');
  // eslint-disable-next-line security/detect-unsafe-regex -- anchored, bounded, one group starting with a literal colon
  if (/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{2,5})?$/.test(b) && checkPublicHttpsUrl(b).ok) return b;
  return testLoopbackAllowed(b) ? b : null;
}
