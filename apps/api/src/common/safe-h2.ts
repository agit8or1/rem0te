/**
 * HTTP/2 with a TLS client certificate, under safe-https's rules (0.84
 * Harbor, docs/own-mdm.md "Outbound calls and safe-https", §93).
 *
 * APNs needs two things safe-https does not do: HTTP/2, and the push
 * certificate presented as the TLS client certificate ("Device management
 * doesn't support the token based push process"). This is the only module
 * in the API that presents a client certificate, and mdm/apple/apns.ts is
 * its only caller (§93). Every safe-https rule holds:
 *
 *   - the URL is https on a public DNS name (checkPublicHttpsUrl), never an
 *     IP literal, localhost or an internal name;
 *   - the name is resolved and EVERY address returned is judged
 *     (smtp-host.ts checkResolved, no local allowance); the connection is
 *     made to that checked address with the name kept for SNI and
 *     certificate verification, so DNS rebinding gets nothing;
 *   - TLS 1.2 or later, certificates verified, ALPN must agree on h2;
 *   - no redirect is followed (a 3xx is an error), every request has a
 *     timeout, every response a size cap.
 *
 * Two differences, both on purpose:
 *   - it PRESENTS A CLIENT CERTIFICATE: the caller hands it the key and
 *     certificate, opened from secret-box in memory for this one session;
 *     the key is exported to PEM in memory for the TLS context only;
 *   - it KEEPS ONE CONNECTION OPEN for the session (one MDM sweep pass)
 *     instead of one per request, because Apple asks providers to keep APNs
 *     connections open across notifications (Apple: "Sending notification
 *     requests to APNs").
 *
 * Test mode: under NODE_ENV=test, and only then, `https://127.0.0.1:<port>`
 * is admitted (the e2e suite's loopback HTTP/2 stub), verified against the
 * stub's own CA passed in by the caller. Nothing in the portal can switch
 * it on.
 */
import { lookup } from 'dns/promises';
import * as http2 from 'http2';
import * as tls from 'tls';
import type { KeyObject } from 'crypto';
import { checkResolved, classifyAddress } from '../email/smtp-host';
import { checkPublicHttpsUrl, OutboundError } from './safe-https';

const TEST_H2 = /^https:\/\/127\.0\.0\.1:[0-9]{2,5}$/;

/** Only the e2e suites: NODE_ENV=test and https://127.0.0.1:<port> exactly. */
export function testLoopbackH2Allowed(raw: string): boolean {
  return process.env.NODE_ENV === 'test' && TEST_H2.test(raw);
}

export interface H2Response { status: number; headers: Record<string, string>; body: Buffer }
export interface ClientIdentity { key: KeyObject; certPem: string }

export class SafeH2Session {
  private closed = false;
  constructor(private readonly session: http2.ClientHttp2Session, private readonly maxBytes: number, private readonly timeoutMs: number) {
    session.on('error', () => { this.closed = true; });
    session.on('goaway', () => { this.closed = true; });
    session.on('close', () => { this.closed = true; });
  }

  get usable(): boolean { return !this.closed && !this.session.destroyed && !this.session.closed; }

  /** One request on the open connection. Throws OutboundError with a short code, never the server's text. */
  request(method: 'POST' | 'GET', path: string, headers: Record<string, string>, body: Buffer | null): Promise<H2Response> {
    if (!this.usable) return Promise.reject(new OutboundError('NETWORK', 'The connection is closed.'));
    if (!/^\/[A-Za-z0-9._~/-]{0,300}$/.test(path)) return Promise.reject(new OutboundError('URL_REFUSED', 'Bad request path.'));
    return new Promise<H2Response>((resolve, reject) => {
      let settled = false;
      const done = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(timer); fn(); } };
      const stream = this.session.request({ ':method': method, ':path': path, ...headers, ...(body ? { 'content-length': String(body.length) } : {}) });
      const timer = setTimeout(() => { stream.close(http2.constants.NGHTTP2_CANCEL); done(() => reject(new OutboundError('TIMEOUT', 'The server did not answer in time.'))); }, this.timeoutMs);
      let status = 0; const hdrs: Record<string, string> = {};
      const chunks: Buffer[] = []; let total = 0;
      stream.on('response', (h) => {
        status = Number(h[':status'] ?? 0);
        for (const [k, v] of Object.entries(h)) if (!k.startsWith(':') && v !== undefined) hdrs[k] = Array.isArray(v) ? v.join(', ') : String(v);
        if (status >= 300 && status < 400) { stream.close(http2.constants.NGHTTP2_CANCEL); done(() => reject(new OutboundError('REDIRECT_REFUSED', `The server answered ${status}; redirects are not followed.`))); }
      });
      stream.on('data', (c: Buffer) => {
        total += c.length;
        if (total > this.maxBytes) { stream.close(http2.constants.NGHTTP2_CANCEL); done(() => reject(new OutboundError('RESPONSE_TOO_LARGE', 'The response was too large.'))); return; }
        chunks.push(c);
      });
      stream.on('end', () => done(() => resolve({ status, headers: hdrs, body: Buffer.concat(chunks) })));
      stream.on('error', () => done(() => reject(new OutboundError('NETWORK', 'The request failed.'))));
      if (body) stream.end(body); else stream.end();
    });
  }

  close(): void {
    this.closed = true;
    try { this.session.close(); } catch { /* already closed */ }
  }
}

/**
 * Open one HTTP/2 connection to `origin` (https://name[:port], nothing
 * else), presenting `identity` as the client certificate.
 */
export async function openSafeH2(origin: string, identity: ClientIdentity, opts: { timeoutMs: number; maxBytes: number; testCaPem?: string }): Promise<SafeH2Session> {
  const test = testLoopbackH2Allowed(origin);
  let host: string, port: number, servername: string | undefined, address: string;
  if (test) {
    const u = new URL(origin);
    host = '127.0.0.1'; port = Number(u.port); address = '127.0.0.1'; servername = undefined;
  } else {
    const chk = checkPublicHttpsUrl(origin);
    if (!chk.ok || chk.url.protocol !== 'https:' || chk.url.pathname !== '/' || chk.url.search) throw new OutboundError('URL_REFUSED', chk.ok ? 'Only an origin is accepted.' : chk.reason);
    host = chk.url.hostname.toLowerCase();
    port = chk.url.port ? Number(chk.url.port) : 443;
    servername = host;
    let addrs: string[];
    try { addrs = (await lookup(host, { all: true, verbatim: true })).map((x) => x.address); }
    catch { throw new OutboundError('UNRESOLVED', 'The host did not resolve.'); }
    const r = checkResolved(addrs, 'none');
    if (!r.ok) throw new OutboundError('ADDRESS_REFUSED', `The host resolved to a disallowed address (${addrs.map(classifyAddress).find((c) => c !== 'public') ?? 'blocked'}).`);
    address = r.address;
  }
  const keyPem = identity.key.export({ type: 'pkcs8', format: 'pem' }) as string;
  const socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
    let settled = false;
    const s = tls.connect({
      host: address, port, ...(servername ? { servername } : {}),
      key: keyPem, cert: identity.certPem,
      ...(test && opts.testCaPem ? { ca: opts.testCaPem } : {}),
      rejectUnauthorized: true, minVersion: 'TLSv1.2', ALPNProtocols: ['h2'],
      ...(servername ? {} : { checkServerIdentity: (_h: string, cert: tls.PeerCertificate) => tls.checkServerIdentity(host, cert) }),
    });
    const timer = setTimeout(() => { if (!settled) { settled = true; s.destroy(); reject(new OutboundError('TIMEOUT', 'The server did not answer in time.')); } }, opts.timeoutMs);
    s.once('secureConnect', () => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (s.alpnProtocol !== 'h2') { s.destroy(); reject(new OutboundError('PROTOCOL', 'The server does not speak HTTP/2.')); return; }
      resolve(s);
    });
    s.once('error', (e: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      reject(new OutboundError(/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|HOSTNAME|ALTNAME/i.test(`${e.code ?? ''} ${e.message}`) ? 'TLS_FAILED' : 'NETWORK', 'The connection failed.'));
    });
  });
  const authority = test ? `https://127.0.0.1:${port}` : `https://${host}${port === 443 ? '' : `:${port}`}`;
  const session = http2.connect(authority, { createConnection: () => socket });
  session.on('error', () => { /* SafeH2Session marks itself closed */ });
  return new SafeH2Session(session, opts.maxBytes, opts.timeoutMs);
}
