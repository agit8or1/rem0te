/**
 * The loopback stand-in provider (0.81): the ONLY backup driver in this
 * release. It exists so the e2e suites can prove the pull path end to end.
 *
 * It reaches nothing but BACKUP_TEST_BASE_URL, which is honoured only through
 * testLoopbackAllowed: NODE_ENV=test and http://127.0.0.1:<port>. Anywhere
 * else it is unavailable (`STANDIN_TEST_ONLY`) and no request is made. The
 * request goes through safePost like every other outbound call, with a bound
 * and a size cap, and carries the connection's sealed credential as a bearer
 * token (so the sealing path is exercised) and nothing about any computer.
 */
import { OutboundError, safePost, testLoopbackAllowed } from '../../common/safe-https';
import { openSecret } from '../../common/secret-box';
import type { BackupDriver } from '../driver';
import { FEED_LIMITS, parseFeed } from '../model';

export const BACKUP_TIMEOUT_MS = 20_000;

function testBase(): string | null {
  const v = process.env.BACKUP_TEST_BASE_URL;
  return v && testLoopbackAllowed(v) ? v.replace(/\/$/, '') : null;
}

export const standinDriver: BackupDriver = {
  kind: 'standin',
  available() {
    return testBase() ? { ok: true } : { ok: false, code: 'STANDIN_TEST_ONLY' };
  },
  async fetch(conn, deps) {
    const base = testBase();
    if (!base) return { ok: false, code: 'STANDIN_TEST_ONLY' };
    if (!conn.credentialEnc) return { ok: false, code: 'NO_CREDENTIAL' };
    let token: string;
    try { token = openSecret(deps.encKey, 'rem0te-backup-credential-v1', conn.credentialEnc); } catch { return { ok: false, code: 'CREDENTIAL_UNREADABLE' }; }
    let res;
    try {
      res = await safePost(`${base}/backups/v1/feed`, { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, '{}', { timeoutMs: BACKUP_TIMEOUT_MS, maxBytes: FEED_LIMITS.bytes });
    } catch (e) {
      return { ok: false, code: e instanceof OutboundError ? e.code : 'UNREACHABLE' };
    }
    if (res.status === 401 || res.status === 403) return { ok: false, code: 'PROVIDER_REFUSED' };
    if (res.status !== 200) return { ok: false, code: 'PROVIDER_ERROR' };
    let raw: unknown;
    try { raw = JSON.parse(res.body.toString('utf8')); } catch { return { ok: false, code: 'BAD_FEED' }; }
    const f = parseFeed(raw);
    return f.ok ? { ok: true, feed: f.feed } : { ok: false, code: 'BAD_FEED' };
  },
};
