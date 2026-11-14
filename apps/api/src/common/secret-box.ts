/**
 * Field encryption for a secret a person typed (0.48: an AI provider key, a
 * PSA webhook signing secret). The same construction as the SMTP password
 * (email.service.ts): AES-256-GCM under ENCRYPTION_KEY, a fresh 12-byte IV
 * per value, and associated data naming what the value is — so a ciphertext
 * copied from one column to another does not decrypt there.
 *
 * Stored as `iv:tag:ciphertext`, hex. Decrypted only immediately before use.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

export type SecretPurpose = 'rem0te-ai-key-v1' | 'rem0te-psa-webhook-secret-v1';

function key(hex: string | undefined): Buffer {
  const k = Buffer.from(hex ?? '', 'hex');
  if (k.length !== 32) throw new Error('ENCRYPTION_KEY must be 32 bytes of hex');
  return k;
}

export function sealSecret(encKeyHex: string | undefined, purpose: SecretPurpose, text: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(encKeyHex), iv);
  c.setAAD(Buffer.from(purpose));
  const e = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return `${iv.toString('hex')}:${c.getAuthTag().toString('hex')}:${e.toString('hex')}`;
}

export function openSecret(encKeyHex: string | undefined, purpose: SecretPurpose, data: string): string {
  const [iv, tag, e] = data.split(':').map((h) => Buffer.from(h, 'hex'));
  const d = createDecipheriv('aes-256-gcm', key(encKeyHex), iv);
  d.setAAD(Buffer.from(purpose));
  d.setAuthTag(tag);
  return d.update(e).toString('utf8') + d.final('utf8');
}
