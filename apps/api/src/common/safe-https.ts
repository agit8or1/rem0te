/**
 * The one outbound HTTPS client for destinations a person typed (0.48): a
 * custom AI provider base URL and a PSA webhook — and, from 0.56, the fixed
 * hardware-vendor warranty APIs (warranty/client.ts), held to the same rule. Both are the shape of an
 * SSRF — the server POSTs where a portal administrator said — so the rule is
 * §42's for the SMTP relay, applied to HTTPS:
 *
 *   on save   the URL must be https, on a public DNS name (no IP literal, no
 *             `localhost`, no single-label or internal-suffix name), with no
 *             user info and no fragment (checkPublicHttpsUrl);
 *   on send   the name is resolved and EVERY address returned is checked
 *             (smtp-host.ts's checkResolved, with no local allowance); the
 *             connection is then made to that checked address with the name
 *             kept for SNI and certificate verification — what was checked is
 *             what is connected to, so DNS rebinding gets nothing;
 *   always    certificates verified (TLS 1.2+), redirects refused (a 3xx is an
 *             error, never followed), a bounded timeout, a response size cap,
 *             and no connection pooling.
 *
 * Plain http is allowed only to 127.0.0.1, and only when NODE_ENV is `test`:
 * that is how the e2e suite's loopback stubs are reached. Nothing in the
 * portal can switch it on.
 */
import { lookup } from 'dns/promises';
import * as http from 'http';
import * as https from 'https';
import { isIP } from 'net';
import { checkResolved, classifyAddress, isHostName } from '../email/smtp-host';

const INTERNAL_SUFFIX = /\.(local|internal|lan|home|corp|localdomain|localhost|intranet|private|arpa)$/;
const TEST_LOOPBACK = /^http:\/\/127\.0\.0\.1:[0-9]{2,5}(?:$|\/[A-Za-z0-9._~/-]{0,200}$)/;
/**
 * 0.56: an optional query in a narrow charset (the warranty stubs take ?servicetags= / ?Serial=).
 * 0.85: and up to 800 characters, with only the percent-escapes Google's own query parameters
 * need (a percent-encoded callbackUrl, signupUrlName, page token and `fields` list):
 * : / ? = & , ( ) +. Any other escape (`%3C`, `%25`, `%40`…) is still refused.
 */
const TEST_QUERY = /^(?:[A-Za-z0-9._~=&-]|%(?:3A|2F|3F|3D|26|2C|28|29|2B))*$/;
const TEST_QUERY_MAX = 800;

/** Only the e2e suites: NODE_ENV=test and http://127.0.0.1:<port>/… exactly. */
export function testLoopbackAllowed(raw: string): boolean {
  const q = raw.indexOf('?');
  const base = q < 0 ? raw : raw.slice(0, q);
  return process.env.NODE_ENV === 'test' && TEST_LOOPBACK.test(base) && (q < 0 || (raw.length - q - 1 <= TEST_QUERY_MAX && TEST_QUERY.test(raw.slice(q + 1))));
}

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

/** Check a typed URL before it is saved. */
export function checkPublicHttpsUrl(raw: unknown, what = 'The URL'): UrlCheck {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 2048) return { ok: false, reason: `${what} is required.` };
  const s = raw.trim();
  if (testLoopbackAllowed(s)) return { ok: true, url: new URL(s) };
  let u: URL;
  try { u = new URL(s); } catch { return { ok: false, reason: `${what} is not a valid URL.` }; }
  if (u.protocol !== 'https:') return { ok: false, reason: `${what} must start with https://.` };
  if (u.username || u.password) return { ok: false, reason: `${what} must not carry a user name or password.` };
  if (u.hash) return { ok: false, reason: `${what} must not have a #fragment.` };
  const h = u.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (isIP(h)) return { ok: false, reason: `${what} must use a DNS name, not an IP address: TLS checks the certificate against the name.` };
  if (!isHostName(h)) return { ok: false, reason: `${what} has an invalid host name.` };
  if (h === 'localhost' || h.endsWith('.localhost') || !h.includes('.') || INTERNAL_SUFFIX.test(h)) {
    return { ok: false, reason: `${what} must be on a public host name (no localhost, single-label or internal names).` };
  }
  return { ok: true, url: u };
}

export class OutboundError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'OutboundError'; }
}

export interface SafeResponse { status: number; body: Buffer; contentType: string }

/**
 * POST `body` to `rawUrl` under the rules above. Throws OutboundError with a
 * short code (never the server's text) for anything but an answer.
 */
export async function safePost(rawUrl: string, headers: Record<string, string>, body: string, opts: { timeoutMs: number; maxBytes: number }): Promise<SafeResponse> {
  return safeRequest('POST', rawUrl, headers, body, opts);
}

/**
 * GET `rawUrl` under the same rules (0.56: a hardware vendor's warranty
 * API, which answers a GET). No body is sent.
 */
export async function safeGet(rawUrl: string, headers: Record<string, string>, opts: { timeoutMs: number; maxBytes: number }): Promise<SafeResponse> {
  return safeRequest('GET', rawUrl, headers, null, opts);
}

/**
 * PATCH and DELETE (0.85, docs/own-mdm.md M3) under the same rules: the
 * Android Management API updates a policy with PATCH. DELETE exists for the
 * same client and has no caller yet (no `devices.delete`: §94).
 */
export async function safePatch(rawUrl: string, headers: Record<string, string>, body: string, opts: { timeoutMs: number; maxBytes: number }): Promise<SafeResponse> {
  return safeRequest('PATCH', rawUrl, headers, body, opts);
}

export async function safeDelete(rawUrl: string, headers: Record<string, string>, opts: { timeoutMs: number; maxBytes: number }): Promise<SafeResponse> {
  return safeRequest('DELETE', rawUrl, headers, null, opts);
}

async function safeRequest(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', rawUrl: string, headers: Record<string, string>, body: string | null, opts: { timeoutMs: number; maxBytes: number }): Promise<SafeResponse> {
  const chk = checkPublicHttpsUrl(rawUrl);
  if (!chk.ok) throw new OutboundError('URL_REFUSED', chk.reason);
  const u = chk.url;
  const plain = u.protocol === 'http:';
  const name = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  let address: string;
  if (plain) {
    address = '127.0.0.1'; // testLoopbackAllowed() pinned it
  } else {
    let addrs: string[];
    try { addrs = (await lookup(name, { all: true, verbatim: true })).map((x) => x.address); }
    catch { throw new OutboundError('UNRESOLVED', 'The host did not resolve.'); }
    const r = checkResolved(addrs, 'none');
    if (!r.ok) throw new OutboundError('ADDRESS_REFUSED', `The host resolved to a disallowed address (${addrs.map(classifyAddress).find((c) => c !== 'public') ?? 'blocked'}).`);
    address = r.address;
  }
  const payload = body === null ? null : Buffer.from(body, 'utf8');
  const reqHeaders: Record<string, string | number> = { ...headers, host: u.host, ...(payload ? { 'content-length': payload.length } : {}) };
  const common = {
    host: address, port: u.port ? Number(u.port) : plain ? 80 : 443, path: `${u.pathname}${u.search}`, method,
    headers: reqHeaders, agent: false as const, timeout: opts.timeoutMs,
  };
  return new Promise<SafeResponse>((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(timer); fn(); } };
    const onRes = (res: http.IncomingMessage) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) { res.destroy(); return done(() => reject(new OutboundError('REDIRECT_REFUSED', `The server answered ${status}; redirects are not followed.`))); }
      const declared = Number(res.headers['content-length'] ?? '0');
      if (declared > opts.maxBytes) { res.destroy(); return done(() => reject(new OutboundError('RESPONSE_TOO_LARGE', 'The response was too large.'))); }
      const chunks: Buffer[] = []; let total = 0;
      res.on('data', (c: Buffer) => {
        total += c.length;
        if (total > opts.maxBytes) { res.destroy(); done(() => reject(new OutboundError('RESPONSE_TOO_LARGE', 'The response was too large.'))); return; }
        chunks.push(c);
      });
      res.on('end', () => done(() => resolve({ status, body: Buffer.concat(chunks), contentType: String(res.headers['content-type'] ?? '') })));
      res.on('error', () => done(() => reject(new OutboundError('NETWORK', 'The connection failed.'))));
    };
    const req = plain
      ? http.request(common, onRes)
      : https.request({ ...common, servername: name, rejectUnauthorized: true, minVersion: 'TLSv1.2' }, onRes);
    const timer = setTimeout(() => { req.destroy(); done(() => reject(new OutboundError('TIMEOUT', 'The server did not answer in time.'))); }, opts.timeoutMs);
    req.on('timeout', () => { req.destroy(); done(() => reject(new OutboundError('TIMEOUT', 'The server did not answer in time.'))); });
    req.on('error', (e: NodeJS.ErrnoException) => done(() => reject(new OutboundError(/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(e.code ?? '') ? 'TLS_FAILED' : 'NETWORK', 'The connection failed.'))));
    if (payload) req.end(payload); else req.end();
  });
}
