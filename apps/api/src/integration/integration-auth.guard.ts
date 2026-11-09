import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { loadTrust, type Peer } from './peers';
import { HDR, requestSigningString, sha256Hex, verifyEd25519, constantTimeEqualHex } from './crypto';
import { E } from './errors';
import { ReplayGuardService } from './replay-guard.service';
import { MAX_REQUEST_BYTES } from './contract';

export const MAX_CLOCK_SKEW_S = 120;
const NONCE_TTL_MS = 2 * (MAX_CLOCK_SKEW_S + 60) * 1000;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export interface IntegrationRequest extends Request {
  rawBody?: Buffer;
  integrationPeer?: Peer;
}

/**
 * Service authentication for every /api/integration/v1 route.
 *
 * The peer signs (audience, method, path+query, timestamp, nonce,
 * sha256(body)) with an Ed25519 key listed for it in the peers FILE. The
 * nonce is recorded only after the signature verifies — an unauthenticated
 * caller cannot fill the table — and the record outlives the clock-skew
 * window, so a captured request cannot be replayed, including after a
 * restart.
 *
 * When the peer has `clientCertSha256` pins, the request must also arrive
 * from the same-host proxy (loopback socket) carrying a matching client
 * certificate fingerprint header. The header is ignored from anywhere else,
 * so it cannot be supplied by a client.
 *
 * This authenticates the SERVICE. It says nothing about which technician is
 * acting — that is the delegation token's job (DelegationService).
 */
@Injectable()
export class IntegrationAuthGuard implements CanActivate {
  constructor(private readonly replay: ReplayGuardService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const trust = loadTrust();
    if (!trust || trust.peers.size === 0) throw E.notConfigured();
    const req = ctx.switchToHttp().getRequest<IntegrationRequest>();

    const keyId = String(req.headers[HDR.keyId] ?? '');
    const ts = String(req.headers[HDR.timestamp] ?? '');
    const nonce = String(req.headers[HDR.nonce] ?? '');
    const sig = String(req.headers[HDR.signature] ?? '');
    const m = /^([A-Za-z0-9._-]{1,64})\/([A-Za-z0-9._-]{1,64})$/.exec(keyId);
    if (!m || !/^\d{9,11}$/.test(ts) || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce) || !sig) throw E.unauthenticated('Missing or malformed signature headers');

    const peer = trust.peers.get(m[1]);
    const key = peer?.requestKeys.find((k) => k.kid === m[2]);
    if (!peer || !key) throw E.unauthenticated('Unknown key');

    const skew = Math.abs(Math.floor(Date.now() / 1000) - Number(ts));
    if (skew > MAX_CLOCK_SKEW_S) throw E.unauthenticated('Timestamp outside the allowed window');

    const body = req.rawBody ?? Buffer.alloc(0);
    if (body.length > MAX_REQUEST_BYTES) throw E.tooLarge();
    const signingString = requestSigningString({
      audience: peer.audience, method: req.method, pathWithQuery: req.originalUrl,
      timestamp: ts, nonce, bodySha256: sha256Hex(body),
    });
    if (!verifyEd25519(key.key, signingString, sig)) throw E.unauthenticated();

    if (peer.clientCertSha256.length > 0) {
      const fromProxy = LOOPBACK.has(req.socket.remoteAddress ?? '');
      const header = String(req.headers[(process.env.INTEGRATION_CLIENT_CERT_HEADER ?? 'x-client-cert-sha256').toLowerCase()] ?? '')
        .toLowerCase().replace(/:/g, '');
      if (!fromProxy || !peer.clientCertSha256.some((fp) => constantTimeEqualHex(fp, header.padEnd(64, '0').slice(0, 64)) && header.length === 64)) {
        throw E.unauthenticated('Client certificate not presented or not pinned');
      }
    }

    if (!(await this.replay.consume(`${peer.id}:nonce:${nonce}`, new Date(Date.now() + NONCE_TTL_MS)))) {
      throw E.replay('Nonce already used');
    }
    req.integrationPeer = peer;
    return true;
  }
}
