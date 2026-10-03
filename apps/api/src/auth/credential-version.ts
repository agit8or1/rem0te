import { createHmac, timingSafeEqual } from 'crypto';

export function credentialVersion(secret: string, passwordHash: string | null): string {
  return createHmac('sha256', secret).update(passwordHash ?? '').digest('hex');
}

export function matchesCredentialVersion(version: unknown, secret: string, passwordHash: string | null): boolean {
  if (typeof version !== 'string' || !/^[a-f0-9]{64}$/.test(version)) return false;
  return timingSafeEqual(Buffer.from(version, 'hex'), Buffer.from(credentialVersion(secret, passwordHash), 'hex'));
}
