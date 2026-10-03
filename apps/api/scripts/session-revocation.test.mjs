// pnpm --filter @reboot-remote/api build
// node apps/api/scripts/session-revocation.test.mjs
// Exercise the real strategy with in-memory Prisma responses. No database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JwtStrategy } from '../dist/auth/strategies/jwt.strategy.js';
import { credentialVersion } from '../dist/auth/credential-version.js';
const secret = 'offline-regression-key-not-for-production';
const config = { get: () => secret };
const token = (hash) => ({ sub: 'user-1', email: 'test@example.invalid',
  isPlatformAdmin: false, tenantId: null, roleType: null, mfaVerified: true,
  credentialVersion: credentialVersion(secret, hash) });
const setup = () => {
  const user = { id: 'user-1', passwordHash: 'old-hash', status: 'ACTIVE', isPlatformAdmin: false };
  const prisma = { user: { findUnique: async () => user }, membership: { findFirst: async () => null } };
  return { user, strategy: new JwtStrategy(config, prisma) };
};
test('old session is rejected after password reset, newly issued session succeeds', async () => {
  const { user, strategy } = setup();
  const old = token('old-hash');
  await strategy.validate(old);
  user.passwordHash = 'new-hash';
  await assert.rejects(strategy.validate(old), /Credentials changed/);
  await strategy.validate(token('new-hash'));
});
test('legacy full tokens require sign-in', async () => {
  const { strategy } = setup();
  const legacy = token('old-hash');
  delete legacy.credentialVersion;
  await assert.rejects(strategy.validate(legacy), /Credentials changed/);
});
test('partial MFA tokens remain unusable as sessions', async () => {
  const { strategy } = setup();
  await assert.rejects(strategy.validate({ ...token('old-hash'), partial: true }), /Multi-factor/);
});
test('suspended and deleted accounts remain unusable', async () => {
  const { user, strategy } = setup();
  user.status = 'SUSPENDED';
  await assert.rejects(strategy.validate(token('old-hash')), /suspended/);
  user.status = 'DELETED';
  await assert.rejects(strategy.validate(token('old-hash')), /not found/);
});
