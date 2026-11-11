import { randomBytes, randomUUID } from 'crypto';
import { loadTrust, type Peer } from './peers';
import { alertEventSigningString, eventSigningString, HDR, requestSigningString, responseSigningString, sha256Hex, signEd25519, verifyEd25519 } from './crypto';

/** rem0te's own key, from the peers file. Used for events and outbound requests only. */
export function selfKey() {
  const t = loadTrust();
  if (!t) throw new Error('integration not configured');
  return t.self;
}

export function signEvent(event: unknown): { alg: 'Ed25519'; kid: string; sig: string } {
  const s = selfKey();
  return { alg: 'Ed25519', kid: s.keyId, sig: signEd25519(s.privateKey, eventSigningString(event)) };
}

export function signAlertEvent(event: unknown): { alg: 'Ed25519'; kid: string; sig: string } {
  const s = selfKey();
  return { alg: 'Ed25519', kid: s.keyId, sig: signEd25519(s.privateKey, alertEventSigningString(event)) };
}

export interface SignedFetchResult { status: number; body: Buffer; headers: Headers; nonce: string }

/**
 * POST to one of a peer's configured URLs, signed. With signedGetCapabilities
 * below, this is the ONLY outbound HTTP the integration has, and its target
 * is a `Peer` field from the peers file — callers cannot pass a URL.
 * Redirects are refused (a 3xx could otherwise send a signed body somewhere
 * else) and the response is read to a hard size cap.
 */
export async function signedPost(peer: Peer, which: 'inference' | 'events', body: string, timeoutMs: number, maxResponseBytes: number): Promise<SignedFetchResult> {
  const url = which === 'inference' ? peer.inferenceUrl : peer.eventsUrl;
  return send(peer, url, 'POST', body, timeoutMs, maxResponseBytes);
}

/**
 * v0.34: GET the peer's own capabilities document (PROPOSED P12), signed the
 * same way over an empty body. The URL is the peers file's optional
 * `capabilitiesUrl`; with none configured there is nothing to ask.
 */
export async function signedGetCapabilities(peer: Peer, timeoutMs: number, maxResponseBytes: number): Promise<SignedFetchResult> {
  const url = peer.capabilitiesUrl;
  if (!url) throw new Error('peer has no capabilitiesUrl');
  return send(peer, url, 'GET', '', timeoutMs, maxResponseBytes);
}

async function send(peer: Peer, url: URL, method: 'GET' | 'POST', body: string, timeoutMs: number, maxResponseBytes: number): Promise<SignedFetchResult> {
  const s = selfKey();
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(18).toString('base64url');
  const pathWithQuery = url.pathname + url.search;
  const sig = signEd25519(s.privateKey, requestSigningString({
    audience: peer.peerAudience, method, pathWithQuery, timestamp: ts, nonce, bodySha256: sha256Hex(body),
  }));
  const res = await fetch(url, {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
      [HDR.keyId]: `rem0te/${s.keyId}`,
      [HDR.timestamp]: ts,
      [HDR.nonce]: nonce,
      [HDR.signature]: sig,
      'x-request-id': randomUUID(),
    },
    body: method === 'POST' ? body : undefined,
  });
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > maxResponseBytes) { await res.body?.cancel(); throw new Error('response too large'); }
  const chunks: Buffer[] = []; let total = 0;
  if (res.body) {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength;
      if (total > maxResponseBytes) throw new Error('response too large');
      chunks.push(Buffer.from(chunk));
    }
  }
  return { status: res.status, body: Buffer.concat(chunks), headers: res.headers, nonce };
}

/** A peer's response must be signed by one of its request keys over (our nonce, body). */
export function verifyPeerResponse(peer: Peer, r: SignedFetchResult): boolean {
  const keyId = r.headers.get(HDR.keyId) ?? '';
  const sig = r.headers.get(HDR.responseSignature) ?? '';
  const m = /^([A-Za-z0-9._-]{1,64})\/([A-Za-z0-9._-]{1,64})$/.exec(keyId);
  if (!m || m[1] !== peer.id || !sig) return false;
  const key = peer.requestKeys.find((k) => k.kid === m[2]);
  if (!key) return false;
  return verifyEd25519(key.key, responseSigningString(r.nonce, sha256Hex(r.body)), sig);
}
