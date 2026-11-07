#!/usr/bin/env node
/**
 * Sign-in recovery, run on the server host when SSO or passkeys lock people
 * out (a provider misconfigured, an IdP outage, a lost authenticator).
 *
 * Password sign-in is never disabled by SSO or passkey configuration, so the
 * usual way back in is a password. This is for when that is not enough.
 * It talks to the database directly (DATABASE_URL), so it works with the API
 * down, and every change it makes is written to the audit log.
 *
 *   node scripts/auth-recovery.mjs --status
 *   node scripts/auth-recovery.mjs --disable-sso --yes
 *   node scripts/auth-recovery.mjs --remove-passkeys someone@example.com --yes
 *   node scripts/auth-recovery.mjs --unlink-sso someone@example.com --yes
 *   node scripts/auth-recovery.mjs --sign-out someone@example.com --yes
 *
 * Without --yes it prints what it would do and changes nothing.
 */
import { PrismaClient } from '@prisma/client';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const apply = has('--yes');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Load the API environment first, e.g.:\n  set -a && . /opt/reboot-remote/api/.env && set +a');
  process.exit(2);
}
const actions = ['--status', '--disable-sso', '--remove-passkeys', '--unlink-sso', '--sign-out'].filter(has);
if (!actions.length || has('--help')) {
  console.log(`Usage:
  --status                      list SSO providers and passkey counts
  --disable-sso                 disable every OIDC provider (password sign-in keeps working)
  --remove-passkeys <email>     delete that account's passkeys
  --unlink-sso <email>          remove that account's linked SSO identities
  --sign-out <email>            end every signed-in session of that account
  --yes                         actually do it (otherwise: dry run)`);
  process.exit(actions.length ? 0 : 2);
}

const prisma = new PrismaClient();
const audit = (action, meta, resourceId) => prisma.activityLog.create({
  data: { action, resource: resourceId ? 'user' : 'oidc_provider', resourceId: resourceId ?? null, actorAgent: 'auth-recovery.mjs', metadata: { recovery: true, ...meta } },
});
async function userBy(flag) {
  const email = val(flag)?.toLowerCase();
  if (!email) { console.error(`${flag} needs an email address`); process.exit(2); }
  const u = await prisma.user.findUnique({ where: { email }, select: { id: true, email: true, status: true } });
  if (!u) { console.error(`No account with email ${email}`); process.exit(1); }
  return u;
}

try {
  if (has('--status')) {
    const providers = await prisma.oidcProvider.findMany({ select: { id: true, name: true, issuer: true, enabled: true, allowProvisioning: true, _count: { select: { identities: true } } } });
    console.log('SSO providers:');
    if (!providers.length) console.log('  (none)');
    for (const p of providers) console.log(`  ${p.enabled ? 'ENABLED ' : 'disabled'}  ${p.name}  ${p.issuer}  linked=${p._count.identities}${p.allowProvisioning ? '  provisioning=on' : ''}`);
    console.log(`Passkeys registered: ${await prisma.userMfaMethod.count({ where: { type: 'WEBAUTHN', isActive: true } })}`);
  }
  if (has('--disable-sso')) {
    const n = await prisma.oidcProvider.count({ where: { enabled: true } });
    console.log(`${apply ? 'Disabling' : 'Would disable'} ${n} enabled SSO provider(s).`);
    if (apply && n) {
      await prisma.oidcProvider.updateMany({ where: { enabled: true }, data: { enabled: false } });
      await audit('SSO_PROVIDER_CHANGED', { op: 'disable_all', count: n });
    }
  }
  if (has('--remove-passkeys')) {
    const u = await userBy('--remove-passkeys');
    const n = await prisma.userMfaMethod.count({ where: { userId: u.id, type: 'WEBAUTHN' } });
    console.log(`${apply ? 'Removing' : 'Would remove'} ${n} passkey(s) from ${u.email}.`);
    if (apply && n) {
      await prisma.userMfaMethod.deleteMany({ where: { userId: u.id, type: 'WEBAUTHN' } });
      await audit('PASSKEY_REMOVED', { count: n }, u.id);
    }
  }
  if (has('--unlink-sso')) {
    const u = await userBy('--unlink-sso');
    const n = await prisma.externalIdentity.count({ where: { userId: u.id } });
    console.log(`${apply ? 'Unlinking' : 'Would unlink'} ${n} SSO identit${n === 1 ? 'y' : 'ies'} from ${u.email}.`);
    if (apply && n) {
      await prisma.externalIdentity.deleteMany({ where: { userId: u.id } });
      await audit('SSO_UNLINKED', { count: n }, u.id);
    }
  }
  if (has('--sign-out')) {
    const u = await userBy('--sign-out');
    console.log(`${apply ? 'Ending' : 'Would end'} every signed-in session of ${u.email}.`);
    if (apply) {
      // Rounded UP to the next whole second, as the API does
      // (src/auth/session-revocation.ts): JWT `iat` is in whole seconds.
      const at = new Date(Math.ceil(Date.now() / 1000) * 1000);
      await prisma.user.update({ where: { id: u.id }, data: { sessionsValidAfter: at } });
      await audit('USER_UPDATED', { op: 'sign_out_everywhere' }, u.id);
    }
  }
  if (!apply && actions.some((a) => a !== '--status')) console.log('\nDry run. Add --yes to apply.');
} finally {
  await prisma.$disconnect();
}
