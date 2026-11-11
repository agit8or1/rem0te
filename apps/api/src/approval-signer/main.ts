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
 *   node dist/approval-signer/main.js pause list
 *   node dist/approval-signer/main.js pause set --global|--business <id> --reason '<why>'
 *   node dist/approval-signer/main.js pause clear --id <id> --reason '<why>'
 *   node dist/approval-signer/main.js patch-policy list
 *   node dist/approval-signer/main.js patch-policy revoke --id <id> --reason '<why>'
 *   node dist/approval-signer/main.js script list
 *   node dist/approval-signer/main.js script revoke --id <id> --reason '<why>'
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
import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import * as path from 'node:path';
import { approvalsOf, effectivePolicyStatus, effectiveScriptStatus, fingerprint, keysDocument, loadSigningKey, verifyPolicy, type RosterMember } from './core';
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
  case 'pause': {
    // v0.28. The portal can ask this process to pause; only this CLI lifts one.
    if (sub === 'list') {
      for (const p of store.pauses().sort((a, b) => a.at.localeCompare(b.at))) {
        console.log(`${p.id}  ${p.clearedAt ? `cleared ${p.clearedAt}` : 'ACTIVE'}  ${p.scope}${p.businessId ? ` ${p.businessId}` : ''}  by ${p.setBy}${p.ref ? ` (${p.ref})` : ''} at ${p.at}: ${p.reason}`);
      }
      break;
    }
    if (sub === 'set') {
      const business = arg('business');
      if (!process.argv.includes('--global') && !business) die('pause set --global|--business <id> --reason <why>');
      const reason = arg('reason') || die('--reason is required');
      const p = store.addPause({ scope: business ? 'business' : 'global', ...(business ? { businessId: business } : {}), reason, setBy: 'operator', at: new Date().toISOString() });
      console.log(`paused ${p.id}`);
      break;
    }
    if (sub === 'clear') {
      const id = arg('id') || die('--id is required');
      const reason = arg('reason') || die('--reason is required');
      const p = store.pauses().find((x) => x.id === id) || die(`no pause ${id}`);
      if (p.clearedAt) die(`${id} was already cleared at ${p.clearedAt}`);
      store.savePause({ ...p, clearedAt: new Date().toISOString(), clearReason: reason });
      console.log(`cleared ${id}`);
      break;
    }
    die('pause list|set|clear');
    break;
  }
  case 'patch-policy': {
    // v0.32. The portal proposes and may revoke; approval is on the public
    // page with passkeys. The operator can list and revoke. Nothing — here or
    // over HTTP — reactivates a revoked policy: approve a new one instead.
    if (sub === 'list') {
      const now = new Date();
      for (const id of store.patchPolicies()) {
        const r = store.patchPolicy(id)!;
        const ok = verifyPolicy(r, createPublicKey(loadSigningKey(store.keyPem()).key));
        console.log(`${r.policyId}  ${effectivePolicyStatus(r, now)}  ${!r.signature ? 'unsigned' : ok ? 'signature ok' : 'SIGNATURE DOES NOT VERIFY'}  ${r.doc.businessId}  "${r.doc.name}"  expires ${r.doc.expiresAt}  approvals=${approvalsOf(r).map((a) => a.name).join(',') || '-'}  plans=${r.ledger.length}${r.revokedAt ? `  revoked ${r.revokedAt} by ${r.revokedBy}: ${r.revokeReason}` : ''}`);
        for (const f of r.refusals.slice(-3)) console.log(`    refused ${f.at} ${f.jobId}: ${f.code} — ${f.message}`);
      }
      break;
    }
    if (sub === 'revoke') {
      const id = arg('id') || die('--id is required');
      const reason = arg('reason') || die('--reason is required');
      const r = store.patchPolicy(id) || die(`no policy ${id}`);
      if (r.revokedAt) die(`${id} was already revoked at ${r.revokedAt}`);
      if (!store.revokePatchPolicy(id, { at: new Date().toISOString(), by: 'operator', reason })) die(`${id} was revoked a moment ago`);
      console.log(`revoked ${id}`);
      break;
    }
    die('patch-policy list|revoke --id <id> --reason <why>');
    break;
  }
  case 'script': {
    // v0.34. The script allowlist: the portal proposes and may revoke;
    // approvers add an entry on the public page with passkeys. The operator
    // can list and revoke. Nothing — here or over HTTP — adds, edits or
    // un-revokes one: a revoked content hash is refused for good.
    if (sub === 'list') {
      for (const id of store.scriptEntries()) {
        const r = store.scriptEntry(id)!;
        console.log(`${r.id}  ${effectiveScriptStatus(r)}  ${r.contentSha256}  "${r.proposal.name}" v${r.proposal.version}  ${r.proposal.businessId ?? 'global'}  approvals=${r.decisions.filter((d) => d.decision === 'approve').map((d) => d.name).join(',') || '-'}${r.revokedAt ? `  revoked ${r.revokedAt} by ${r.revokedBy}: ${r.revokeReason}` : ''}`);
      }
      break;
    }
    if (sub === 'revoke') {
      const id = arg('id') || die('--id is required');
      const reason = arg('reason') || die('--reason is required');
      const r = store.scriptEntry(id) || die(`no script entry ${id}`);
      if (r.revokedAt) die(`${r.contentSha256} was already revoked at ${r.revokedAt}`);
      if (!store.revokeScript(r.contentSha256, { at: new Date().toISOString(), by: 'operator', reason })) die(`${r.contentSha256} was revoked a moment ago`);
      console.log(`revoked ${r.contentSha256}`);
      break;
    }
    die('script list|revoke --id <id> --reason <why>');
    break;
  }
  default:
    die('usage: main.js serve|keygen|keys|roster list|roster add|roster disable|policy set|pause list|set|clear|patch-policy list|revoke|script list|revoke');
}
