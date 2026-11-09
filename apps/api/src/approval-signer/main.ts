/**
 * rem0te approval signer (v0.26) — entrypoint and operator CLI.
 *
 *   node dist/approval-signer/main.js serve
 *   node dist/approval-signer/main.js keygen
 *   node dist/approval-signer/main.js keys            # approval/keys.json for the TUF repository
 *   node dist/approval-signer/main.js roster list
 *   node dist/approval-signer/main.js roster add --export '<json from the approver's Passkeys page>' \
 *        --approve '*'|<businessId,...> [--customer <businessId,...>] --confirm-fingerprint XXXX-XXXX-XXXX-XXXX
 *   node dist/approval-signer/main.js roster disable --user <id>
 *   node dist/approval-signer/main.js policy set --business <id> --customer-signoff required|not_required
 *
 * Environment: APPROVAL_SIGNER_DIR, APPROVAL_ORIGIN, APPROVAL_RP_ID,
 * APPROVAL_PUBLIC_PORT (3201), APPROVAL_INTERNAL_PORT (3202).
 *
 * Runs as its own Unix user (rem0te-approver), not the portal's: the key, the
 * roster and the policy are files the portal cannot read or write. It does
 * not load Nest, Prisma or any portal module, and the security invariants
 * check that stays true.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import * as path from 'node:path';
import { fingerprint, keysDocument, loadSigningKey, type RosterMember } from './core';
import { SignerStore } from './store';
import { startSigner } from './server';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
const die = (m: string): never => { console.error(m); process.exit(2); };
const list = (v: string | undefined) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

const dir = process.env.APPROVAL_SIGNER_DIR || die('APPROVAL_SIGNER_DIR is not set');
const [cmd, sub] = process.argv.slice(2);
const store = new SignerStore(dir);

switch (cmd) {
  case 'serve': {
    const origin = process.env.APPROVAL_ORIGIN || die('APPROVAL_ORIGIN is not set (the approval pages\' own origin, e.g. https://approve.example.com)');
    const u = new URL(origin);
    if (u.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(u.hostname)) die('APPROVAL_ORIGIN must be https');
    const s = startSigner({
      dir, origin: u.origin, rpId: process.env.APPROVAL_RP_ID || u.hostname,
      publicPort: Number(process.env.APPROVAL_PUBLIC_PORT || 3201), internalPort: Number(process.env.APPROVAL_INTERNAL_PORT || 3202),
    });
    console.log(`[approval-signer] public :${process.env.APPROVAL_PUBLIC_PORT || 3201} (${u.origin}), internal 127.0.0.1:${process.env.APPROVAL_INTERNAL_PORT || 3202}`);
    const stop = () => { void s.close().then(() => process.exit(0)); };
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
    break;
  }
  case 'keygen': {
    const file = path.join(dir, 'signer.key');
    if (existsSync(file)) die(`${file} exists; refusing to overwrite a signing key`);
    const { privateKey } = generateKeyPairSync('ed25519');
    writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify(keysDocument([loadSigningKey(store.keyPem())]), null, 2));
    break;
  }
  case 'keys':
    console.log(JSON.stringify(keysDocument([loadSigningKey(store.keyPem())]), null, 2));
    break;
  case 'roster': {
    const r = store.roster();
    if (sub === 'list') {
      for (const m of r.members) console.log(`${m.disabled ? '(disabled) ' : ''}${m.name} <${m.userId}>  ${fingerprint(m)}  approve=${m.approve.join(',') || '-'} customer=${m.customer.join(',') || '-'}`);
      break;
    }
    if (sub === 'add') {
      let ex: { userId?: string; name?: string; credentialId?: string; publicKey?: string };
      try { ex = JSON.parse(arg('export') || die('--export is required')); } catch { die('--export is not JSON'); }
      if (!ex!.userId || !ex!.name || !ex!.credentialId || !ex!.publicKey) die('--export must carry userId, name, credentialId, publicKey');
      const m: RosterMember = {
        userId: ex!.userId!, name: ex!.name!.slice(0, 120), credentialId: ex!.credentialId!, publicKey: ex!.publicKey!, counter: 0,
        approve: list(arg('approve')), customer: list(arg('customer')), addedAt: new Date().toISOString(),
      };
      if (m.customer.includes('*')) die('customer sign-off is per business; "*" is not allowed');
      if (!m.approve.length && !m.customer.length) die('give --approve and/or --customer');
      const fp = fingerprint(m);
      if (arg('confirm-fingerprint') !== fp) die(`Fingerprint check failed. Ask ${m.name} to read the fingerprint shown on their own Passkeys page, and pass it as --confirm-fingerprint. This export's fingerprint is ${fp}.`);
      if (r.members.some((x) => x.credentialId === m.credentialId)) die('that passkey is already on the roster');
      r.members.push(m); store.saveRoster(r);
      console.log(`added ${m.name} ${fp}`);
      break;
    }
    if (sub === 'disable') {
      const u = arg('user') || die('--user is required');
      let n = 0; for (const m of r.members) if (m.userId === u) { m.disabled = true; n++; }
      store.saveRoster(r); console.log(`disabled ${n} passkey(s)`);
      break;
    }
    die('roster list|add|disable');
    break;
  }
  case 'policy': {
    if (sub !== 'set') die('policy set --business <id> --customer-signoff required|not_required');
    const b = arg('business') || die('--business is required');
    const v = arg('customer-signoff');
    if (v !== 'required' && v !== 'not_required') die('--customer-signoff required|not_required');
    const p = store.policy();
    if (b === 'default') p.default = { customerSignoff: v === 'required' }; else p.businesses[b] = { customerSignoff: v === 'required' };
    store.savePolicy(p);
    console.log(JSON.stringify(p, null, 2));
    break;
  }
  default:
    die('usage: main.js serve|keygen|keys|roster list|roster add|roster disable|policy set');
}
