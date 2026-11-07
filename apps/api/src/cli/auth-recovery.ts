/**
 * Sign-in and address recovery, run on the server host when SSO, passkeys or
 * the public address lock people out (a provider misconfigured, an IdP outage,
 * a lost authenticator, a mistyped address).
 *
 * It lives in src/ so it is compiled into dist/ and therefore present on every
 * deployed server: the deploy target carries dist/, never scripts/. (0.20.0
 * shipped it as scripts/auth-recovery.mjs, which the documented command could
 * not find on a real install.)
 *
 * Password sign-in is never disabled by SSO or passkey configuration, so the
 * usual way back in is a password. This is for when that is not enough. It
 * talks to the database directly (DATABASE_URL), so it works with the API
 * down, and every change it makes is written to the audit log.
 *
 *   sudo bash -c 'set -a; . /etc/reboot-remote/api.env; set +a; cd /opt/reboot-remote/api && node dist/cli/auth-recovery.js --status'
 *
 * Without --yes it prints what it would do and changes nothing.
 */
import { PrismaClient, type ActivityAction } from '@prisma/client';

const USAGE = `Usage: node dist/cli/auth-recovery.js <action> [--yes]
  --status                      SSO providers, passkey count, public address
  --disable-sso                 disable every OIDC provider (password sign-in keeps working)
  --remove-passkeys <email>     delete that account's passkeys
  --unlink-sso <email>          remove that account's linked SSO identities
  --sign-out <email>            end every signed-in session of that account
  --clear-public-url            clear the public address setting (falls back to FRONTEND_URL / PUBLIC_API_URL)
  --yes                         actually do it (otherwise: dry run)`;

const ACTIONS = ['--status', '--disable-sso', '--remove-passkeys', '--unlink-sso', '--sign-out', '--clear-public-url'];

async function main(argv: string[]): Promise<number> {
  const has = (f: string) => argv.includes(f);
  const val = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  const apply = has('--yes');

  const actions = ACTIONS.filter(has);
  if (!actions.length || has('--help')) {
    console.log(USAGE);
    return actions.length ? 0 : 2;
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set. Load the API environment first, e.g.:\n  sudo bash -c 'set -a; . /etc/reboot-remote/api.env; set +a; cd /opt/reboot-remote/api && node dist/cli/auth-recovery.js --status'");
    return 2;
  }

  const prisma = new PrismaClient();
  const audit = (action: ActivityAction, resource: string, meta: Record<string, unknown>, resourceId?: string) =>
    prisma.activityLog.create({
      data: { action, resource, resourceId: resourceId ?? null, actorAgent: 'auth-recovery', metadata: { recovery: true, ...meta } },
    });
  const userBy = async (flag: string) => {
    const email = val(flag)?.toLowerCase();
    if (!email || email.startsWith('--')) throw new UsageError(`${flag} needs an email address`);
    const u = await prisma.user.findUnique({ where: { email }, select: { id: true, email: true } });
    if (!u) throw new UsageError(`No account with email ${email}`, 1);
    return u;
  };

  try {
    if (has('--status')) {
      const providers = await prisma.oidcProvider.findMany({
        select: { name: true, issuer: true, enabled: true, allowProvisioning: true, _count: { select: { identities: true } } },
      });
      console.log('SSO providers:');
      if (!providers.length) console.log('  (none)');
      for (const p of providers) {
        console.log(`  ${p.enabled ? 'ENABLED ' : 'disabled'}  ${p.name}  ${p.issuer}  linked=${p._count.identities}${p.allowProvisioning ? '  provisioning=on' : ''}`);
      }
      console.log(`Passkeys registered: ${await prisma.userMfaMethod.count({ where: { type: 'WEBAUTHN', isActive: true } })}`);
      const s = await prisma.platformSettings.findUnique({ where: { id: 'singleton' }, select: { publicUrl: true } });
      console.log(`Public address: ${s?.publicUrl ? `${s.publicUrl} (setting)` : `not set; using FRONTEND_URL=${process.env.FRONTEND_URL ?? '(unset)'} PUBLIC_API_URL=${process.env.PUBLIC_API_URL ?? '(unset)'}`}`);
    }
    if (has('--disable-sso')) {
      const n = await prisma.oidcProvider.count({ where: { enabled: true } });
      console.log(`${apply ? 'Disabling' : 'Would disable'} ${n} enabled SSO provider(s).`);
      if (apply && n) {
        await prisma.oidcProvider.updateMany({ where: { enabled: true }, data: { enabled: false } });
        await audit('SSO_PROVIDER_CHANGED', 'oidc_provider', { op: 'disable_all', count: n });
      }
    }
    if (has('--remove-passkeys')) {
      const u = await userBy('--remove-passkeys');
      const n = await prisma.userMfaMethod.count({ where: { userId: u.id, type: 'WEBAUTHN' } });
      console.log(`${apply ? 'Removing' : 'Would remove'} ${n} passkey(s) from ${u.email}.`);
      if (apply && n) {
        await prisma.userMfaMethod.deleteMany({ where: { userId: u.id, type: 'WEBAUTHN' } });
        await audit('PASSKEY_REMOVED', 'user', { count: n }, u.id);
      }
    }
    if (has('--unlink-sso')) {
      const u = await userBy('--unlink-sso');
      const n = await prisma.externalIdentity.count({ where: { userId: u.id } });
      console.log(`${apply ? 'Unlinking' : 'Would unlink'} ${n} SSO identit${n === 1 ? 'y' : 'ies'} from ${u.email}.`);
      if (apply && n) {
        await prisma.externalIdentity.deleteMany({ where: { userId: u.id } });
        await audit('SSO_UNLINKED', 'user', { count: n }, u.id);
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
        await audit('USER_UPDATED', 'user', { op: 'sign_out_everywhere' }, u.id);
      }
    }
    if (has('--clear-public-url')) {
      const s = await prisma.platformSettings.findUnique({ where: { id: 'singleton' }, select: { publicUrl: true } });
      if (!s?.publicUrl) {
        console.log('The public address setting is not set; nothing to clear.');
      } else {
        console.log(`${apply ? 'Clearing' : 'Would clear'} the public address ${s.publicUrl}. The API then uses FRONTEND_URL / PUBLIC_API_URL (picked up within a minute, no restart needed).`);
        if (apply) {
          await prisma.platformSettings.update({ where: { id: 'singleton' }, data: { publicUrl: null } });
          await audit('PLATFORM_SETTINGS_UPDATED', 'platform_settings', { field: 'publicUrl', from: s.publicUrl, to: null }, 'singleton');
        }
      }
    }
    if (!apply && actions.some((a) => a !== '--status')) console.log('\nDry run. Add --yes to apply.');
    return 0;
  } catch (e) {
    if (e instanceof UsageError) { console.error(e.message); return e.exitCode; }
    throw e;
  } finally {
    await prisma.$disconnect();
  }
}

class UsageError extends Error {
  constructor(message: string, readonly exitCode = 2) { super(message); }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => { console.error(e); process.exit(1); },
  );
}
