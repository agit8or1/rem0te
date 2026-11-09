// A software WebAuthn authenticator for tests (ES256). It produces exactly
// what a browser sends after navigator.credentials.get(), so the approval
// signer's real verifyAuthenticationResponse() checks it: origin, RP ID hash,
// the user-verified flag, the counter, the challenge and the signature.
//
// Test-only. It exists so every refusal path can be driven without a person
// touching a security key; it proves nothing about a real authenticator.

import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

const b64u = (b) => Buffer.from(b).toString('base64url');

export function syntheticPasskey({ userId, name }) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const x = Buffer.from(jwk.x, 'base64url');
  const y = Buffer.from(jwk.y, 'base64url');
  // COSE_Key {1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y}
  const cose = Buffer.concat([
    Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]), x,
    Buffer.from([0x22, 0x58, 0x20]), y,
  ]);
  const credentialId = b64u(randomBytes(16));
  let counter = 0;
  return {
    userId, name, credentialId,
    publicKey: b64u(cose),
    /** The JSON the approver's Passkeys page offers for the roster ceremony. */
    export: () => JSON.stringify({ userId, name, credentialId, publicKey: b64u(cose) }),
    /**
     * Answer a challenge. Overrides let a test forge each field a browser or
     * authenticator would set: origin, rpId, flags, counter, challenge.
     */
    assert(options, { origin, rpId = options.rpId, uv = true, up = true, counterDelta = 1, counterAbs, challenge = options.challenge, type = 'webauthn.get', id = credentialId } = {}) {
      if (counterAbs === undefined) counter += counterDelta;
      const clientDataJSON = Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
      const flags = (up ? 0x01 : 0) | (uv ? 0x04 : 0);
      const ctr = Buffer.alloc(4); ctr.writeUInt32BE(counterAbs ?? counter);
      const authData = Buffer.concat([createHash('sha256').update(rpId).digest(), Buffer.from([flags]), ctr]);
      const sig = sign('sha256', Buffer.concat([authData, createHash('sha256').update(clientDataJSON).digest()]), privateKey);
      return {
        id, rawId: id, type: 'public-key', clientExtensionResults: {},
        response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData), signature: b64u(sig), userHandle: b64u(Buffer.from(userId)) },
      };
    },
  };
}
