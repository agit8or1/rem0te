/**
 * Integration peer trust — loaded from a root-owned FILE, never the database.
 *
 *   INTEGRATION_PEERS_FILE=/etc/reboot-remote/integration/peers.json
 *
 * Everything that decides whom rem0te believes and where it may send data is
 * here: peer public keys (request signing and delegation are separate keys),
 * the audiences, the only two URLs the worker may ever contact for a peer,
 * the allowed model profiles, and rem0te's own Ed25519 signing key. A
 * database compromise therefore cannot add a peer, swap a key, or point the
 * worker at an attacker's URL; a portal administrator cannot either, because
 * there is no route that writes this file.
 *
 * No file, or no peers in it → the integration routes answer 404 and the
 * worker idles. Fail closed.
 */
import { readFileSync } from 'fs';
import { createPrivateKey, createPublicKey, type KeyObject } from 'crypto';
import { z } from 'zod';
import { ed25519PublicKey } from './crypto';

const Pem = z.string().min(40).max(4096);
const KeyEntry = z.object({ kid: z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/), publicKeyPem: Pem }).strict();

const PeerFile = z.object({
  self: z.object({
    keyId: z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/),
    privateKeyFile: z.string().min(1),
    /** Retired public keys still advertised so in-flight events verify across a rotation. */
    previousKeys: z.array(KeyEntry).max(4).default([]),
  }).strict(),
  peers: z.array(z.object({
    id: z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/),
    enabled: z.boolean().default(true),
    /** What this rem0te is called by the peer: request-signature audience and delegation `aud`. */
    audience: z.string().min(1).max(256),
    /** What the peer is called: the audience rem0te signs its requests to it with. */
    peerAudience: z.string().min(1).max(256),
    requestKeys: z.array(KeyEntry).min(1).max(4),
    delegationKeys: z.array(KeyEntry).min(1).max(4),
    inferenceUrl: z.string().url(),
    eventsUrl: z.string().url(),
    modelProfiles: z.array(z.string().regex(/^[a-z0-9][a-z0-9._-]*$/).max(64)).min(1).max(10),
    /** Optional mTLS pin: SHA-256 fingerprints the fronting proxy must report. */
    clientCertSha256: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(4).default([]),
  }).strict()).max(8),
}).strict();

export interface PeerKey { kid: string; key: KeyObject }
export interface Peer {
  id: string;
  audience: string;
  peerAudience: string;
  requestKeys: PeerKey[];
  delegationKeys: PeerKey[];
  inferenceUrl: URL;
  eventsUrl: URL;
  modelProfiles: string[];
  clientCertSha256: string[];
}
export interface IntegrationTrust {
  self: { keyId: string; privateKey: KeyObject; publicKeyPem: string; previousKeys: { kid: string; publicKeyPem: string }[] };
  peers: Map<string, Peer>;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * A peer URL must be https, carry no credentials, no fragment, and no query.
 * Plain http is accepted for loopback only — the lab simulator — and never
 * for anything that leaves the host.
 */
export function validatePeerUrl(raw: string, label: string): URL {
  const u = new URL(raw);
  if (u.username || u.password) throw new Error(`${label}: credentials in URL`);
  if (u.hash || u.search) throw new Error(`${label}: query or fragment not allowed`);
  if (u.protocol === 'https:') return u;
  if (u.protocol === 'http:' && LOOPBACK.has(u.hostname)) return u;
  throw new Error(`${label}: must be https (http only for loopback)`);
}

export function parseTrust(json: unknown, readKey: (path: string) => string): IntegrationTrust {
  const f = PeerFile.parse(json);
  const privateKey = createPrivateKey(readKey(f.self.privateKeyFile));
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('self.privateKeyFile is not an Ed25519 key');
  const publicKeyPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
  const peers = new Map<string, Peer>();
  for (const p of f.peers) {
    if (!p.enabled) continue;
    if (peers.has(p.id)) throw new Error(`duplicate peer ${p.id}`);
    peers.set(p.id, {
      id: p.id,
      audience: p.audience,
      peerAudience: p.peerAudience,
      requestKeys: p.requestKeys.map((k) => ({ kid: k.kid, key: ed25519PublicKey(k.publicKeyPem) })),
      delegationKeys: p.delegationKeys.map((k) => ({ kid: k.kid, key: ed25519PublicKey(k.publicKeyPem) })),
      inferenceUrl: validatePeerUrl(p.inferenceUrl, `${p.id}.inferenceUrl`),
      eventsUrl: validatePeerUrl(p.eventsUrl, `${p.id}.eventsUrl`),
      modelProfiles: p.modelProfiles,
      clientCertSha256: p.clientCertSha256,
    });
  }
  return {
    self: {
      keyId: f.self.keyId, privateKey, publicKeyPem,
      previousKeys: f.self.previousKeys.map((k) => ({ kid: k.kid, publicKeyPem: k.publicKeyPem })),
    },
    peers,
  };
}

let cached: IntegrationTrust | null | undefined;

/** The loaded trust, or null when the integration is not configured. Read once per process. */
export function loadTrust(): IntegrationTrust | null {
  if (cached !== undefined) return cached;
  const file = process.env.INTEGRATION_PEERS_FILE;
  if (!file) { cached = null; return cached; }
  cached = parseTrust(JSON.parse(readFileSync(file, 'utf8')), (p) => readFileSync(p, 'utf8'));
  return cached;
}
