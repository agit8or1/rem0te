/**
 * The one place a hardware vendor's warranty API is called (0.56). Every
 * request goes through common/safe-https.ts (safeGet / safePost): the name
 * resolved and every address judged on every call, the connection made to the
 * checked address with SNI and certificate verification, redirects refused,
 * a 20 s bound and a 256 KB cap. Errors are short codes — never the vendor's
 * text, never a credential.
 *
 * What leaves: the computer's serial (Dell calls it the service tag), and the
 * vendor credential the Platform Admin entered for that vendor. Nothing else:
 * no name, hostname, business, user or address. `lookup` takes the serial
 * as a string and nothing that could carry more.
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
 * Not implemented (manual entry only):
 *   hp      TODO: HP's warranty API (developers.hp.com) is a batch job
 *           service — OAuth token, POST a job of serials, poll, fetch the
 *           result. Its request and response shapes are not published openly
 *           enough to implement it accurately here.
 *   others  HPE, Apple, Microsoft, ASUS and Acer publish no warranty API an
 *           MSP can sign up for.
 *
 * WARRANTY_TEST_BASE_URL replaces both fixed hosts only when NODE_ENV is
 * `test` and it is http://127.0.0.1:<port> (testLoopbackAllowed): that is the
 * e2e suite's stub. Nothing in the portal can set it.
 */
import { OutboundError, safeGet, safePost, testLoopbackAllowed } from '../common/safe-https';
import { cleanCoverage } from './vendors';

export const LOOKUP_VENDORS = ['dell', 'lenovo'] as const;
export type LookupVendor = (typeof LOOKUP_VENDORS)[number];

export const WARRANTY_TIMEOUT_MS = 20_000;
export const WARRANTY_MAX_RESPONSE = 256 * 1024;

const DELL_BASE = 'https://apigtwb2c.us.dell.com';
const LENOVO_BASE = 'https://supportapi.lenovo.com';

function testBase(): string | null {
  const v = process.env.WARRANTY_TEST_BASE_URL;
  return v && testLoopbackAllowed(v) ? v.replace(/\/$/, '') : null;
}

export interface Credentials { clientId: string | null; secret: string }
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

/** The newest-ending entitlement decides the end and the coverage; the earliest start is the start. */
function pick(entries: { start: Date | null; end: Date | null; text: unknown }[]): Found | null {
  const valid = entries.filter((e): e is { start: Date | null; end: Date; text: unknown } => !!e.end);
  if (!valid.length) return null;
  const last = valid.reduce((a, b) => (b.end > a.end ? b : a));
  const starts = valid.map((e) => e.start).filter((d): d is Date => !!d);
  const startsAt = starts.length ? starts.reduce((a, b) => (b < a ? b : a)) : null;
  return { startsAt, endsAt: last.end, coverage: cleanCoverage(last.text) };
}

async function dellToken(c: Credentials): Promise<{ ok: true; token: string } | LookupResult> {
  if (!c.clientId) return { ok: false, code: 'VENDOR_NOT_CONFIGURED', transient: false };
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: c.clientId, client_secret: c.secret }).toString();
  let res;
  try { res = await safePost(`${testBase() ? `${testBase()}/dell` : DELL_BASE}/auth/oauth/v2/token`, { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body, OPTS); }
  catch (e) { return failed(e); }
  if (res.status !== 200) return res.status === 400 ? { ok: false, code: 'VENDOR_AUTH_FAILED', transient: false } : statusFailure(res.status);
  let j: { access_token?: unknown } = {};
  try { j = JSON.parse(res.body.toString('utf8')); } catch { /* not JSON */ }
  return typeof j.access_token === 'string' && /^[\x21-\x7e]{8,4096}$/.test(j.access_token) ? { ok: true, token: j.access_token } : { ok: false, code: 'RESPONSE_INVALID', transient: true };
}

async function dell(c: Credentials, serial: string): Promise<LookupResult> {
  const t = await dellToken(c);
  if (!('token' in t)) return t;
  const url = `${testBase() ? `${testBase()}/dell` : DELL_BASE}/PROD/sbil/eapi/v5/asset-entitlements?servicetags=${encodeURIComponent(serial)}`;
  let res;
  try { res = await safeGet(url, { authorization: `Bearer ${t.token}`, accept: 'application/json' }, OPTS); }
  catch (e) { return failed(e); }
  if (res.status !== 200) return statusFailure(res.status);
  let j: unknown;
  try { j = JSON.parse(res.body.toString('utf8')); } catch { return { ok: false, code: 'RESPONSE_INVALID', transient: true }; }
  if (!Array.isArray(j)) return { ok: false, code: 'RESPONSE_INVALID', transient: true };
  const asset = j.find((a) => a && typeof a === 'object' && String((a as { serviceTag?: unknown }).serviceTag ?? '').toUpperCase() === serial.toUpperCase()) as
    { invalid?: unknown; entitlements?: unknown } | undefined;
  if (!asset || asset.invalid === true || !Array.isArray(asset.entitlements)) return { ok: false, code: 'NOT_FOUND', transient: false };
  const found = pick((asset.entitlements as Record<string, unknown>[]).slice(0, 200).map((e) => ({
    start: date(e?.startDate), end: date(e?.endDate), text: e?.serviceLevelDescription,
  })));
  return found ? { ok: true, found } : { ok: false, code: 'NOT_FOUND', transient: false };
}

async function lenovo(c: Credentials, serial: string): Promise<LookupResult> {
  const url = `${testBase() ? `${testBase()}/lenovo` : LENOVO_BASE}/v2.5/warranty?Serial=${encodeURIComponent(serial)}`;
  let res;
  try { res = await safeGet(url, { ClientID: c.secret, accept: 'application/json' }, OPTS); }
  catch (e) { return failed(e); }
  if (res.status !== 200) return statusFailure(res.status);
  let j: unknown;
  try { j = JSON.parse(res.body.toString('utf8')); } catch { return { ok: false, code: 'RESPONSE_INVALID', transient: true }; }
  const one = (Array.isArray(j) ? j[0] : j) as { Serial?: unknown; Warranty?: unknown } | undefined;
  if (!one || typeof one !== 'object') return { ok: false, code: 'RESPONSE_INVALID', transient: true };
  if (!Array.isArray(one.Warranty) || !one.Warranty.length) return { ok: false, code: 'NOT_FOUND', transient: false };
  const found = pick((one.Warranty as Record<string, unknown>[]).slice(0, 200).map((w) => ({
    start: date(w?.Start), end: date(w?.End), text: w?.Name ?? w?.Description,
  })));
  return found ? { ok: true, found } : { ok: false, code: 'NOT_FOUND', transient: false };
}

/** Ask one vendor about one serial. The serial is the only thing about the computer that leaves. */
export async function lookup(vendor: LookupVendor, creds: Credentials, serial: string): Promise<LookupResult> {
  return vendor === 'dell' ? dell(creds, serial) : lenovo(creds, serial);
}
