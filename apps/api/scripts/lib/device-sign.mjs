/**
 * TEST ONLY: what a 0.34 signed agent does when it signs a result or a scan
 * (tools/windows-installer/internal/devsig), in JavaScript, so the unit
 * suites can make genuine, forged, replayed and cross-device statements
 * without a Go build. The end-to-end suites use the real agent code (the
 * action simulator) instead.
 *
 * Nothing under apps/api/src may do this: the portal and the signer only
 * verify (actions/device-result.ts), and check-security-invariants §38
 * refuses the statement prefixes anywhere else in apps/api/src.
 */
import { generateKeyPairSync, sign } from 'node:crypto';

const PREFIX = { result: 'rem0te-device-result-v1\n', scan: 'rem0te-device-scan-v1\n' };

/** A computer's own key: the private half stays in the test, the public half is what a policy binds. */
export function deviceKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  return { privateKey, key: raw.toString('base64') };
}

/** Sign a statement as `dev` would. `claimKey` makes the envelope name another key (a forger claiming to be the computer). */
export function signStatement(dev, kind, statement, { claimKey, prefix } = {}) {
  const bytes = Buffer.from(JSON.stringify(statement), 'utf8');
  const sig = sign(null, Buffer.concat([Buffer.from(prefix ?? PREFIX[kind], 'utf8'), bytes]), dev.privateKey);
  return { schema: 'rem0te-device-signed/1', key: claimKey ?? dev.key, statement: bytes.toString('base64'), sig: sig.toString('base64') };
}

export const resultStatement = (over) => ({ schema: 'rem0te-action-result-statement/1', planSha256: '', outcome: 'succeeded', ...over });
export const scanStatement = (over) => ({ schema: 'rem0te-patch-scan-statement/1', error: false, rebootPending: false, offered: [], installed: [], ...over });
