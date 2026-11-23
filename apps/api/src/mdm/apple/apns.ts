/**
 * The APNs client (0.84 Harbor, docs/own-mdm.md M2, §93): the one place
 * Rem0te wakes an Apple device, and the only caller of common/safe-h2.ts.
 *
 * A push carries no command. It only makes the device connect to ServerURL,
 * where Rem0te's queue hands it what is waiting. The body is exactly
 * `{"mdm":"<PushMagic>"}`, with no `aps` key (Apple: "Sending MDM commands to
 * a device"), and APNs keeps only the last of several pushes.
 *
 * The host is a constant. Push certificates from Apple's push certificates
 * portal are production only, so there is no development host (Apple: MDM
 * payload, UseDevelopmentAPNS). HTTP/2, TLS 1.2+, port 443 (Apple: "Sending
 * notification requests to APNs"), the push certificate as the TLS client
 * certificate.
 *
 * Under NODE_ENV=test, and only then, APNS_TEST_BASE_URL may name a loopback
 * HTTP/2 stub (https://127.0.0.1:<port>), verified against the CA in
 * APNS_TEST_CA_FILE. Both are read in apnsTarget() and nowhere else.
 *
 * NO REAL APNs CALL HAS BEEN MADE from this code: it has run only against
 * the e2e suite's stub.
 */
import { readFileSync } from 'node:fs';
import type { KeyObject } from 'node:crypto';
import { openSafeH2, testLoopbackH2Allowed, type SafeH2Session } from '../../common/safe-h2';
import { OutboundError } from '../../common/safe-https';
import { PUSH_MAGIC_RE, PUSH_TOKEN_RE, TOPIC_RE } from './protocol';

export const APNS_ORIGIN = 'https://api.push.apple.com';
export const APNS_TIMEOUT_MS = 15_000;
export const APNS_MAX_BYTES = 4_096;

/** What a push came to. `retry` means try again later; the others stop pushing this device or this pass. */
export type PushOutcome =
  | { result: 'ok'; apnsId: string | null }
  | { result: 'unregistered' | 'bad_token' | 'topic_refused' | 'certificate_refused' | 'retry' | 'refused'; status: number; reason: string | null };

export function apnsTarget(): { origin: string; testCaPem?: string } {
  const test = (process.env.APNS_TEST_BASE_URL ?? '').replace(/\/+$/, '');
  if (test && testLoopbackH2Allowed(test)) {
    const file = process.env.APNS_TEST_CA_FILE;
    return { origin: test, testCaPem: file ? readFileSync(file, 'utf8') : undefined };
  }
  return { origin: APNS_ORIGIN };
}

/** The push body, exactly. */
export const pushBody = (pushMagic: string) => JSON.stringify({ mdm: pushMagic });

/** Apple's documented reasons map onto what Rem0te does next. */
export function classify(status: number, reason: string | null): PushOutcome {
  if (status === 410 || reason === 'Unregistered') return { result: 'unregistered', status, reason };
  if (reason === 'BadDeviceToken' || reason === 'DeviceTokenNotForTopic') return { result: 'bad_token', status, reason };
  if (reason === 'TopicDisallowed' || reason === 'BadTopic' || reason === 'MissingTopic') return { result: 'topic_refused', status, reason };
  if (status === 403 || reason === 'BadCertificate' || reason === 'BadCertificateEnvironment' || reason === 'ExpiredProviderToken') return { result: 'certificate_refused', status, reason };
  if (status === 429 || status >= 500) return { result: 'retry', status, reason };
  return { result: 'refused', status, reason };
}

/** One APNs connection for one sweep pass. */
export class ApnsClient {
  private constructor(private readonly h2: SafeH2Session, private readonly topic: string) {}

  static async open(identity: { key: KeyObject; certPem: string; topic: string }): Promise<ApnsClient> {
    if (!TOPIC_RE.test(identity.topic)) throw new OutboundError('BAD_TOPIC', 'The push topic is not valid.');
    const t = apnsTarget();
    const h2 = await openSafeH2(t.origin, { key: identity.key, certPem: identity.certPem }, { timeoutMs: APNS_TIMEOUT_MS, maxBytes: APNS_MAX_BYTES, testCaPem: t.testCaPem });
    return new ApnsClient(h2, identity.topic);
  }

  get usable() { return this.h2.usable; }

  async push(token: string, pushMagic: string): Promise<PushOutcome> {
    if (!PUSH_TOKEN_RE.test(token)) return { result: 'bad_token', status: 0, reason: null };
    if (!PUSH_MAGIC_RE.test(pushMagic)) return { result: 'refused', status: 0, reason: null };
    const res = await this.h2.request('POST', `/3/device/${token}`, {
      'apns-topic': this.topic, 'apns-push-type': 'mdm', 'apns-priority': '10', 'content-type': 'application/json',
    }, Buffer.from(pushBody(pushMagic), 'utf8'));
    if (res.status === 200) {
      const id = res.headers['apns-id'];
      return { result: 'ok', apnsId: id && /^[A-Fa-f0-9-]{36}$/.test(id) ? id : null };
    }
    let reason: string | null = null;
    try { const j = JSON.parse(res.body.toString('utf8')) as { reason?: unknown }; reason = typeof j.reason === 'string' && /^[A-Za-z]{1,40}$/.test(j.reason) ? j.reason : null; } catch { /* no JSON */ }
    return classify(res.status, reason);
  }

  close() { this.h2.close(); }
}
