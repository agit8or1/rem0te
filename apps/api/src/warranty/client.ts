/**
 * The one place a hardware vendor's warranty API is called (0.56; HP and
 * Apple 0.61). Every request goes through common/safe-https.ts (safeGet /
 * safePost): the name resolved and every address judged on every call, the
 * connection made to the checked address with SNI and certificate
 * verification, redirects refused, a 20 s bound and a 256 KB cap. Errors are
 * short codes — never the vendor's text, never a credential.
 *
 * What leaves: the computer's serial (Dell calls it the service tag), and the
 * vendor credential the Platform Admin entered for that vendor. Nothing else:
 * no name, hostname, business, user, address or model. `lookup` takes the
 * serial as a string and nothing that could carry more. (HP's API also takes
 * an optional product number; the agent's inventory does not collect one, so
 * none is sent.)
 *
 * Implemented:
 *   dell    Dell TechDirect warranty API (v5). OAuth 2 client credentials
 *           from TechDirect (client id + client secret, approved for the
 *           warranty API), a bearer token from
 *           apigtwb2c.us.dell.com/auth/oauth/v2/token, then
 *           GET …/PROD/sbil/eapi/v5/asset-entitlements?servicetags=<tag>.
 *   lenovo  Lenovo warranty API (v2.5). A ClientID token issued by Lenovo
 *           (a partner or account-representative request), sent as the
 *           ClientID header on GET supportapi.lenovo.com/v2.5/warranty?Serial=<serial>.
 *   hp      HP Inc. Warranty API (developers.hp.com, after HP approves the
 *           CSS API enrolment). OAuth 2 client credentials — the app's API key
 *           and secret as HTTP Basic — at warranty.api.hp.com/oauth/v1/token,
 *           then the batch-job API, one serial per job:
 *             POST /productwarranty/v2/jobs  [{"sn":"<serial>"}]  → {jobId, estimatedTime}
 *             GET  /productwarranty/v2/jobs/<jobId>               → {status}   (polled, bounded)
 *             GET  /productwarranty/v2/jobs/<jobId>/results       → [{product, offers:[…]}]
 *           A job not finished within the poll bound is VENDOR_PENDING and is
 *           asked again within a day. HP's v2 /queries (synchronous) endpoint
 *           is described as deprecated in favour of jobs, so it is not used.
 *   apple   Apple Business Manager API (AppleCare coverage). An API account
 *           made in Apple Business Manager: its client id, key id and EC P-256
 *           private key. Each token request carries a short-lived ES256 client
 *           assertion signed here; the token comes from
 *           account.apple.com/auth/oauth2/token (scope business.api), then
 *           GET api-business.apple.com/v1/orgDevices/<serial>/appleCareCoverage.
 *           Only devices in the organisation's Apple Business Manager are known
 *           to it; any other serial is NOT_FOUND.
 *
 * NONE of HP, Apple — nor, since 0.56, Dell or Lenovo — has been called from
 * this server: every path here has been exercised only against the e2e
 * suites' loopback stand-ins, which follow the vendors' published examples.
 *
 * Not implemented (manual entry only), with the reasons in vendors.ts
 * NO_LOOKUP_REASON: HPE, Microsoft Surface, ASUS and Acer.
 *
 * Bearer tokens (HP, Apple) are kept in memory for their lifetime less five
 * minutes, keyed by a hash of the credential, so a changed credential never
 * reuses an old token. They are never stored, logged or returned.
 *
 * WARRANTY_TEST_BASE_URL replaces every fixed host only when NODE_ENV is
 * `test` and it is http://127.0.0.1:<port> (testLoopbackAllowed): that is the
 * e2e suite's stub. Nothing in the portal can set it.
 */
import { createHash, createPrivateKey, randomUUID, sign } from 'node:crypto';
import { OutboundError, safeGet, safePost, testLoopbackAllowed } from '../common/safe-https';
import { cleanCoverage, LOOKUP_VENDORS, type LookupVendor } from './vendors';

export { LOOKUP_VENDORS, type LookupVendor };

export const WARRANTY_TIMEOUT_MS = 20_000;
export const WARRANTY_MAX_RESPONSE = 256 * 1024;

const DELL_BASE = 'https://apigtwb2c.us.dell.com';
const LENOVO_BASE = 'https://supportapi.lenovo.com';
const HP_BASE = 'https://warranty.api.hp.com';
const APPLE_AUTH_BASE = 'https://account.apple.com';
const APPLE_API_BASE = 'https://api-business.apple.com';
/** The audience Apple's token endpoint expects in a client assertion (a name, never requested). */
const APPLE_AUDIENCE = 'https://account.apple.com/auth/oauth2/v2/token';
/** Every host a warranty lookup may reach. §69/§74 check every https URL in this file is one of them. */
export const LOOKUP_HOSTS = ['apigtwb2c.us.dell.com', 'supportapi.lenovo.com', 'warranty.api.hp.com', 'account.apple.com', 'api-business.apple.com'] as const;

/** HP's job API: at most this many status polls per lookup, this far apart (a few ms against the test stub). */
export const HP_MAX_POLLS = 6;
const HP_POLL_MS = 5_000;

function testBase(): string | null {
  const v = process.env.WARRANTY_TEST_BASE_URL;
  return v && testLoopbackAllowed(v) ? v.replace(/\/$/, '') : null;
}
/** The vendor's fixed base, or the stub's path for it under test. */
function base(real: string, stub: string): string {
  const t = testBase();
  return t ? `${t}/${stub}` : real;
}

export interface Credentials { clientId: string | null; keyId?: string | null; secret: string }
export interface Found { startsAt: Date | null; endsAt: Date; coverage: string | null }
export type LookupResult = { ok: true; found: Found } | { ok: false; code: string; transient: boolean };

const OPTS = { timeoutMs: WARRANTY_TIMEOUT_MS, maxBytes: WARRANTY_MAX_RESPONSE };

const date = (v: unknown): Date | null => {
  if (typeof v !== 'string' || v.length > 40) return null;
  const d = new Date(v);
  const t = d.getTime();
  // Plausible warranty dates only: 1990 to 2100.
  return Number.isFinite(t) && t > 631_152_000_000 && t < 4_102_444_800_000 ? d : null;
};

function failed(e: unknown): LookupResult {
  const code = e instanceof OutboundError ? e.code : 'NETWORK';
  return { ok: false, code, transient: code !== 'URL_REFUSED' && code !== 'REDIRECT_REFUSED' };
}

function statusFailure(status: number): LookupResult {
  if (status === 401 || status === 403) return { ok: false, code: 'VENDOR_AUTH_FAILED', transient: false };
  if (status === 404) return { ok: false, code: 'NOT_FOUND', transient: false };
  if (status === 429) return { ok: false, code: 'VENDOR_RATE_LIMITED', transient: true };
  return { ok: false, code: `VENDOR_HTTP_${status >= 500 ? '5XX' : status}`, transient: status >= 500 };
}
const INVALID: LookupResult = { ok: false, code: 'RESPONSE_INVALID', transient: true };
const NOT_FOUND: LookupResult = { ok: false, code: 'NOT_FOUND', transient: false };
const NOT_CONFIGURED: LookupResult = { ok: false, code: 'VENDOR_NOT_CONFIGURED', transient: false };

function json(body: Buffer): unknown {
  try { return JSON.parse(body.toString('utf8')); } catch { return undefined; }
}

/** The newest-ending entitlement decides the end and the coverage; the earliest start is the start. */
function pick(entries: { start: Date | null; end: Date | null; text: unknown }[]): Found | null {
  const valid = entries.filter((e): e is { start: Date | null; end: Date; text: unknown } => !!e.end);
  if (!valid.length) return null;
  const last = valid.reduce((a, b) => (b.end > a.end ? b : a));
  const starts = valid.map((e) => e.start).filter((d): d is Date => !!d);
  const startsAt = starts.length ? starts.reduce((a, b) => (b < a ? b : a)) : null;
  return { startsAt, endsAt: last.end, coverage: cleanCoverage(last.text) };
}

// ── Bearer tokens (HP, Apple) ───────────────────────────────────────────────

const tokens = new Map<string, { token: string; until: number }>();
const tokenKey = (vendor: LookupVendor, c: Credentials) =>
  `${vendor}:${createHash('sha256').update(`${c.clientId ?? ''}\n${c.keyId ?? ''}\n${c.secret}`).digest('hex')}`;
/** Forget every cached token (tests, and nothing else). */
export function clearTokenCache(): void { tokens.clear(); }

const TOKEN_RE = /^[\x21-\x7e]{8,4096}$/;
type TokenResult = { ok: true; token: string; cached?: boolean } | LookupResult;

/** Read a token response; remember it for its lifetime (at most an hour) less five minutes. */
function tokenFrom(res: { status: number; body: Buffer }, key: string | null): TokenResult {
  if (res.status !== 200) return res.status === 400 ? { ok: false, code: 'VENDOR_AUTH_FAILED', transient: false } : statusFailure(res.status);
  const j = json(res.body) as { access_token?: unknown; expires_in?: unknown } | undefined;
  if (!j || typeof j.access_token !== 'string' || !TOKEN_RE.test(j.access_token)) return INVALID;
  if (key) {
    const secs = Math.min(3600, Number(j.expires_in) || 0);
    if (secs > 360) tokens.set(key, { token: j.access_token, until: Date.now() + (secs - 300) * 1000 });
  }
  return { ok: true, token: j.access_token };
}

// ── Dell ────────────────────────────────────────────────────────────────────

async function dellToken(c: Credentials): Promise<TokenResult> {
  if (!c.clientId) return NOT_CONFIGURED;
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: c.clientId, client_secret: c.secret }).toString();
  let res;
  try { res = await safePost(`${base(DELL_BASE, 'dell')}/auth/oauth/v2/token`, { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body, OPTS); }
  catch (e) { return failed(e); }
  return tokenFrom(res, null);
}

async function dell(c: Credentials, serial: string): Promise<LookupResult> {
  const t = await dellToken(c);
  if (!('token' in t)) return t;
  const url = `${base(DELL_BASE, 'dell')}/PROD/sbil/eapi/v5/asset-entitlements?servicetags=${encodeURIComponent(serial)}`;
  let res;
  try { res = await safeGet(url, { authorization: `Bearer ${t.token}`, accept: 'application/json' }, OPTS); }
  catch (e) { return failed(e); }
  if (res.status !== 200) return statusFailure(res.status);
  const j = json(res.body);
  if (!Array.isArray(j)) return INVALID;
  const asset = j.find((a) => a && typeof a === 'object' && String((a as { serviceTag?: unknown }).serviceTag ?? '').toUpperCase() === serial.toUpperCase()) as
    { invalid?: unknown; entitlements?: unknown } | undefined;
  if (!asset || asset.invalid === true || !Array.isArray(asset.entitlements)) return NOT_FOUND;
  const found = pick((asset.entitlements as Record<string, unknown>[]).slice(0, 200).map((e) => ({
    start: date(e?.startDate), end: date(e?.endDate), text: e?.serviceLevelDescription,
  })));
  return found ? { ok: true, found } : NOT_FOUND;
}

// ── Lenovo ──────────────────────────────────────────────────────────────────

async function lenovo(c: Credentials, serial: string): Promise<LookupResult> {
  const url = `${base(LENOVO_BASE, 'lenovo')}/v2.5/warranty?Serial=${encodeURIComponent(serial)}`;
  let res;
  try { res = await safeGet(url, { ClientID: c.secret, accept: 'application/json' }, OPTS); }
  catch (e) { return failed(e); }
  if (res.status !== 200) return statusFailure(res.status);
  const j = json(res.body);
  const one = (Array.isArray(j) ? j[0] : j) as { Serial?: unknown; Warranty?: unknown } | undefined;
  if (!one || typeof one !== 'object') return INVALID;
  if (!Array.isArray(one.Warranty) || !one.Warranty.length) return NOT_FOUND;
  const found = pick((one.Warranty as Record<string, unknown>[]).slice(0, 200).map((w) => ({
    start: date(w?.Start), end: date(w?.End), text: w?.Name ?? w?.Description,
  })));
  return found ? { ok: true, found } : NOT_FOUND;
}

// ── HP Inc. ─────────────────────────────────────────────────────────────────

async function hpToken(c: Credentials): Promise<TokenResult> {
  if (!c.clientId) return NOT_CONFIGURED;
  const key = tokenKey('hp', c);
  const hit = tokens.get(key);
  if (hit && hit.until > Date.now()) return { ok: true, token: hit.token, cached: true };
  const basic = Buffer.from(`${c.clientId}:${c.secret}`, 'utf8').toString('base64');
  let res;
  try { res = await safePost(`${base(HP_BASE, 'hp')}/oauth/v1/token`, { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, 'grant_type=client_credentials', OPTS); }
  catch (e) { return failed(e); }
  return tokenFrom(res, key);
}

const JOB_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const HP_DONE = 'COMPLETED';
const HP_FAILED = new Set(['FAILED', 'ERROR', 'CANCELLED', 'CANCELED', 'EXPIRED']);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function hp(c: Credentials, serial: string, again = true): Promise<LookupResult> {
  const t = await hpToken(c);
  if (!('token' in t)) return t;
  const jobs = `${base(HP_BASE, 'hp')}/productwarranty/v2/jobs`;
  const h = { authorization: `Bearer ${t.token}`, accept: 'application/json' };
  let res;
  // The serial, and nothing else: no product number (not collected), no country.
  try { res = await safePost(jobs, { ...h, 'content-type': 'application/json' }, JSON.stringify([{ sn: serial }]), OPTS); }
  catch (e) { return failed(e); }
  // A remembered token the vendor no longer accepts: forget it and ask once more with a new one.
  if (res.status === 401) { tokens.delete(tokenKey('hp', c)); if (t.cached && again) return hp(c, serial, false); }
  if (res.status !== 200 && res.status !== 201 && res.status !== 202) return statusFailure(res.status);
  const job = json(res.body) as { jobId?: unknown; estimatedTime?: unknown } | undefined;
  if (!job || typeof job.jobId !== 'string' || !JOB_ID_RE.test(job.jobId)) return INVALID;
  const id = encodeURIComponent(job.jobId);
  const stub = testBase() !== null;
  // estimatedTime is in seconds in HP's examples; it only shapes the first wait, within 2–10 s.
  const first = Math.min(10_000, Math.max(2_000, (Number(job.estimatedTime) || 0) * 1000));
  let done = false;
  for (let i = 0; i < HP_MAX_POLLS && !done; i++) {
    await pause(stub ? 20 : i === 0 ? first : HP_POLL_MS);
    try { res = await safeGet(`${jobs}/${id}`, h, OPTS); }
    catch (e) { return failed(e); }
    if (res.status !== 200) return statusFailure(res.status);
    const s = json(res.body) as { status?: unknown } | undefined;
    const status = typeof s?.status === 'string' ? s.status.trim().toUpperCase() : '';
    if (status === HP_DONE) done = true;
    else if (HP_FAILED.has(status)) return { ok: false, code: 'VENDOR_JOB_FAILED', transient: true };
  }
  if (!done) return { ok: false, code: 'VENDOR_PENDING', transient: true };
  try { res = await safeGet(`${jobs}/${id}/results`, h, OPTS); }
  catch (e) { return failed(e); }
  if (res.status !== 200) return statusFailure(res.status);
  const j = json(res.body);
  if (!Array.isArray(j)) return INVALID;
  const rows = j.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object');
  const sn = (r: Record<string, unknown>) => {
    const p = r.product as { serialNumber?: unknown } | undefined;
    return String(p?.serialNumber ?? r.sn ?? '').toUpperCase();
  };
  const row = rows.find((r) => sn(r) === serial.toUpperCase()) ?? (rows.length === 1 && !sn(rows[0]) ? rows[0] : undefined);
  if (!row || !Array.isArray(row.offers) || !row.offers.length) return NOT_FOUND;
  const found = pick((row.offers as Record<string, unknown>[]).slice(0, 200).map((o) => ({
    start: date(o?.serviceObligationLineItemStartDate), end: date(o?.serviceObligationLineItemEndDate), text: o?.offerDescription,
  })));
  return found ? { ok: true, found } : NOT_FOUND;
}

// ── Apple (Apple Business Manager) ──────────────────────────────────────────

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/**
 * An Apple Business Manager private key as pasted (PEM, PKCS#8 or SEC1),
 * returned as PKCS#8 PEM — or null unless it is an EC P-256 private key.
 */
export function normaliseApplePrivateKey(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length > 4096 || !/-----BEGIN (EC )?PRIVATE KEY-----/.test(raw)) return null;
  try {
    const k = createPrivateKey({ key: raw.trim(), format: 'pem' });
    if (k.asymmetricKeyType !== 'ec' || k.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return null;
    return k.export({ type: 'pkcs8', format: 'pem' }).toString();
  } catch { return null; }
}

/** A client assertion for one token request: ES256, five minutes, a fresh jti. */
function appleAssertion(c: Credentials & { clientId: string; keyId: string }): string | null {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'ES256', kid: c.keyId, typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: c.clientId, sub: c.clientId, aud: APPLE_AUDIENCE, iat: now, exp: now + 300, jti: randomUUID() }));
  try {
    const sig = sign('sha256', Buffer.from(`${head}.${claims}`), { key: createPrivateKey(c.secret), dsaEncoding: 'ieee-p1363' });
    return `${head}.${claims}.${b64url(sig)}`;
  } catch { return null; }
}

async function appleToken(c: Credentials): Promise<TokenResult> {
  if (!c.clientId || !c.keyId) return NOT_CONFIGURED;
  const key = tokenKey('apple', c);
  const hit = tokens.get(key);
  if (hit && hit.until > Date.now()) return { ok: true, token: hit.token, cached: true };
  const assertion = appleAssertion({ ...c, clientId: c.clientId, keyId: c.keyId });
  if (!assertion) return NOT_CONFIGURED;
  const body = new URLSearchParams({
    grant_type: 'client_credentials', client_id: c.clientId, client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: assertion, scope: 'business.api',
  }).toString();
  let res;
  try { res = await safePost(`${base(APPLE_AUTH_BASE, 'apple-auth')}/auth/oauth2/token`, { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body, OPTS); }
  catch (e) { return failed(e); }
  return tokenFrom(res, key);
}

async function apple(c: Credentials, serial: string, again = true): Promise<LookupResult> {
  const t = await appleToken(c);
  if (!('token' in t)) return t;
  let res;
  try { res = await safeGet(`${base(APPLE_API_BASE, 'apple')}/v1/orgDevices/${encodeURIComponent(serial)}/appleCareCoverage`, { authorization: `Bearer ${t.token}`, accept: 'application/json' }, OPTS); }
  catch (e) { return failed(e); }
  if (res.status === 401) { tokens.delete(tokenKey('apple', c)); if (t.cached && again) return apple(c, serial, false); }
  if (res.status !== 200) return statusFailure(res.status);
  const j = json(res.body) as { data?: unknown } | undefined;
  if (!j || !Array.isArray(j.data)) return INVALID;
  const found = pick((j.data as { attributes?: Record<string, unknown> }[]).slice(0, 200)
    .map((d) => d?.attributes ?? {})
    .filter((a) => a.isCanceled !== true)
    .map((a) => ({ start: date(a.startDateTime), end: date(a.endDateTime), text: a.description })));
  return found ? { ok: true, found } : NOT_FOUND;
}

/** Ask one vendor about one serial. The serial is the only thing about the computer that leaves. */
export async function lookup(vendor: LookupVendor, creds: Credentials, serial: string): Promise<LookupResult> {
  switch (vendor) {
    case 'dell': return dell(creds, serial);
    case 'lenovo': return lenovo(creds, serial);
    case 'hp': return hp(creds, serial);
    case 'apple': return apple(creds, serial);
  }
}
