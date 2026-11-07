/**
 * Browser side of passkeys, without a dependency: turn the server's JSON
 * options into what navigator.credentials expects, and the result back into
 * JSON. The server (@simplewebauthn/server) does all verification.
 */

const toBuf = (b64u: string): ArrayBuffer => {
  const b64 = b64u.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(b64u.length / 4) * 4, '=');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
};
const toB64u = (buf: ArrayBuffer | null | undefined): string | undefined => {
  if (!buf) return undefined;
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export function passkeysSupported(): boolean {
  return typeof window !== 'undefined' && !!window.PublicKeyCredential && !!navigator.credentials;
}

type Desc = { id: string; type?: string; transports?: string[] };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function createPasskey(options: any) {
  const publicKey: PublicKeyCredentialCreationOptions = {
    ...options,
    challenge: toBuf(options.challenge),
    user: { ...options.user, id: toBuf(options.user.id) },
    excludeCredentials: (options.excludeCredentials ?? []).map((c: Desc) => ({ type: 'public-key', id: toBuf(c.id), transports: c.transports as AuthenticatorTransport[] })),
  };
  const cred = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential | null;
  if (!cred) throw new Error('No passkey was created');
  const r = cred.response as AuthenticatorAttestationResponse;
  return {
    id: cred.id, rawId: toB64u(cred.rawId), type: cred.type,
    clientExtensionResults: cred.getClientExtensionResults(),
    authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
    response: {
      clientDataJSON: toB64u(r.clientDataJSON), attestationObject: toB64u(r.attestationObject),
      transports: typeof r.getTransports === 'function' ? r.getTransports() : [],
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getPasskey(options: any) {
  const publicKey: PublicKeyCredentialRequestOptions = {
    ...options,
    challenge: toBuf(options.challenge),
    allowCredentials: (options.allowCredentials ?? []).map((c: Desc) => ({ type: 'public-key', id: toBuf(c.id), transports: c.transports as AuthenticatorTransport[] })),
  };
  const cred = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null;
  if (!cred) throw new Error('No passkey was used');
  const r = cred.response as AuthenticatorAssertionResponse;
  return {
    id: cred.id, rawId: toB64u(cred.rawId), type: cred.type,
    clientExtensionResults: cred.getClientExtensionResults(),
    authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
    response: {
      clientDataJSON: toB64u(r.clientDataJSON), authenticatorData: toB64u(r.authenticatorData),
      signature: toB64u(r.signature), userHandle: toB64u(r.userHandle),
    },
  };
}

/** A readable message from an axios or WebAuthn error. */
export function errorMessage(e: unknown, fallback = 'Something went wrong'): string {
  const ax = e as { response?: { data?: { message?: string | string[] } } };
  const m = ax?.response?.data?.message;
  if (Array.isArray(m)) return m.join('; ');
  if (typeof m === 'string') return m;
  const name = (e as { name?: string })?.name;
  if (name === 'NotAllowedError') return 'The passkey prompt was dismissed or timed out.';
  return (e as Error)?.message || fallback;
}
