import { createHash, randomBytes } from 'crypto';
import { z } from 'zod';

/**
 * Deployment keys (0.57, check-security-invariants §70): the pure part.
 *
 * A deployment key is 96 lowercase hex characters (48 random bytes). It is
 * accepted wherever a single-use claim token is — the same `token` field of
 * POST /enrollment/claim, the same `?token=` / path segment of the install
 * routes, and `rem0te-agent.exe install --token` — because every installer
 * already validates a token as 16–128 hex characters. A claim token is 64, so
 * the two never collide, and the server looks a token up as a claim token
 * first and as a deployment key only when it is not one.
 *
 * Only the SHA-256 is stored, and the last four characters as a hint; the key
 * itself is returned once, from create, and never again.
 */
export const KEY_BYTES = 48;
export const KEY_RE = /^[0-9a-f]{96}$/;
export const MAX_KEY_DAYS = 90;
export const MAX_KEY_USES = 10_000;
export const KEY_MODES = ['review', 'active'] as const;
export type KeyMode = (typeof KEY_MODES)[number];

export function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function newDeploymentKey(): { key: string; hash: string; hint: string } {
  const key = randomBytes(KEY_BYTES).toString('hex');
  return { key, hash: hashKey(key), hint: key.slice(-4) };
}

export type KeyState = 'usable' | 'revoked' | 'expired' | 'exhausted';

/** Whether a key may enrol one more computer now. */
export function keyState(k: { revokedAt: Date | null; expiresAt: Date; useCount: number; maxUses: number }, now: Date = new Date()): KeyState {
  if (k.revokedAt) return 'revoked';
  if (k.expiresAt.getTime() <= now.getTime()) return 'expired';
  if (k.useCount >= k.maxUses) return 'exhausted';
  return 'usable';
}

const id = z.string().regex(/^[a-z0-9]{20,40}$/, 'an id');

/** POST /adoption/deployment-keys. Review is the default; active is an explicit choice. */
export const KeyCreate = z.object({
  businessId: id,
  siteId: id.nullish(),
  endpointGroupId: id.nullish(),
  // Shown in lists and in the pool's "arrived via"; never part of a command line.
  // eslint-disable-next-line no-control-regex -- control characters are exactly what this refuses
  name: z.string().trim().min(1).max(80).regex(/^[^\x00-\x1f\x7f<>]+$/, 'printable text without < or >'),
  mode: z.enum(KEY_MODES).default('review'),
  accessMode: z.enum(['ASSIGNED_USERS', 'COMPANY_WIDE']).default('ASSIGNED_USERS'),
  maxUses: z.number().int().min(1).max(MAX_KEY_USES),
  expiresInDays: z.number().int().min(1).max(MAX_KEY_DAYS),
}).strict();
export type KeyCreateInput = z.infer<typeof KeyCreate>;
