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
 *   node dist/approval-signer/main.js policy show
 *   node dist/approval-signer/main.js policy set --business <id>|default [--customer-signoff required|not_required] [--approval direct|signed]
 *   node dist/approval-signer/main.js pause list
 *   node dist/approval-signer/main.js pause set --global|--business <id> --reason '<why>'
 *   node dist/approval-signer/main.js pause clear --id <id> --reason '<why>'
 *   node dist/approval-signer/main.js patch-policy list
 *   node dist/approval-signer/main.js patch-policy revoke --id <id> --reason '<why>'
 *   node dist/approval-signer/main.js device-key list
 *   node dist/approval-signer/main.js device-key forget --endpoint <id> --reason '<why>'
 *   node dist/approval-signer/main.js script list
 *   node dist/approval-signer/main.js script revoke --id <id> --reason '<why>'
 *   node dist/approval-signer/main.js software list
 *   node dist/approval-signer/main.js software revoke --entry <catalogEntryId> --reason '<why>'
 *   node dist/approval-signer/main.js revocations show
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
import {
  approvalsOf, effectivePolicyStatus, effectiveScriptStatus, fingerprint, keysDocument, loadSigningKey, mergeRevocations, resultKeyFingerprint, revocationStatement,
  SOFTWARE_ENTRY_ID, verifyPolicy, type RosterMember,
} from './core';
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
    // The only writer of policy.json: no HTTP route on this process or the
    // portal changes it (§ 58). 0.40 adds the approval mode; every change is
    // appended to policy-changes.log, which nothing rewrites.
    const usage = 'policy show | policy set --business <id>|default [--customer-signoff required|not_required] [--approval direct|signed]';
    if (sub === 'show') { console.log(JSON.stringify(store.policy(), null, 2)); break; }
    if (sub !== 'set') die(usage);
    const b = arg('business') || die('--business is required (a business id, or default)');
    if (b !== 'default' && !/^[A-Za-z0-9_-]{8,64}$/.test(b)) die('--business must be a business id or default');
    const cs = arg('customer-signoff');
    const ap = arg('approval');
    if (cs === undefined && ap === undefined) die(usage);
    if (cs !== undefined && cs !== 'required' && cs !== 'not_required') die('--customer-signoff required|not_required');
    if (ap !== undefined && ap !== 'direct' && ap !== 'signed') die('--approval direct|signed');
    const p = store.policy();
    // A business with no entry of its own starts from the default's rules,
    // then takes what changed; the other setting is kept, not reset.
    const before = b === 'default' ? { ...p.default } : p.businesses[b] ? { ...p.businesses[b] } : null;
    const next = { ...(before ?? p.default) };
    if (cs !== undefined) next.customerSignoff = cs === 'required';
    if (ap !== undefined) next.approval = ap as 'direct' | 'signed';
    // Direct mode signs at admission; customer sign-off needs a customer to
    // approve before signing. They cannot both hold.
    if (next.customerSignoff && next.approval === 'direct') {
      die(ap === 'direct'
        ? `Refused: ${b === 'default' ? 'the default policy' : `business ${b}`} requires customer sign-off. Direct mode signs a plan as soon as it is requested, so nobody could sign off first. Set --customer-signoff not_required first, if that is what you mean.`
        : `Refused: ${b === 'default' ? 'the default policy' : `business ${b}`} is in direct mode, which signs a plan as soon as it is requested, so a customer could never sign off first. Set --approval signed first.`);
    }
    if (b === 'default') p.default = next; else p.businesses[b] = next;
    store.savePolicy(p);
    store.appendPolicyChange({ at: new Date().toISOString(), business: b, before, after: next, by: process.env.SUDO_USER || process.env.USER || 'unknown' });
    if (ap === 'direct') {
      console.error(`Direct mode is now ON for ${b === 'default' ? 'the default policy (every business without its own entry, and the script allowlist)' : `business ${b}`}: plans the portal requests are signed at once, with no approval. Anyone who fully controls the portal can then run catalog actions on these computers. Agents older than 0.40 refuse direct plans (bad_plan).`);
    }
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
  case 'device-key': {
    // v0.34. Pins are made when a policy naming a computer is first approved,
    // and the serving process never changes one. A computer that really has a
    // new key (its agent's state was lost, but not its enrolment) needs its
    // old pin removed here before a policy naming the new key can be signed
    // under: check the new fingerprint on the computer itself first.
    if (sub === 'list') {
      for (const p of store.devicePins().sort((a, b) => a.pinnedAt.localeCompare(b.pinnedAt))) {
        console.log(`${p.endpointId}  ${p.hostname}  ${resultKeyFingerprint(p.resultKey)}  pinned ${p.pinnedAt} by policy ${p.policyId}`);
      }
      break;
    }
    if (sub === 'forget') {
      const ep = arg('endpoint') || die('--endpoint is required');
      const reason = arg('reason') || die('--reason is required');
      const mine = store.devicePins().filter((p) => p.endpointId === ep);
      if (!mine.length) die(`no pinned key for ${ep}`);
      for (const p of mine) if (store.forgetDevicePin(p.identity)) console.log(`forgot ${p.hostname} ${resultKeyFingerprint(p.resultKey)} (pinned ${p.pinnedAt}): ${reason}`);
      break;
    }
    die('device-key list|forget --endpoint <id> --reason <why>');
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
  case 'software': {
    // v0.36. Archived software catalog entries: the portal asks for one when
    // an entry is archived. Entries archived before 0.36 were never sent, so
    // the operator revokes those here. Nothing un-revokes one.
    if (sub === 'list') {
      for (const id of store.softwareRevocations()) { const r = store.softwareRevocation(id)!; console.log(`${id}  revoked ${r.at} by ${r.by}: ${r.reason}`); }
      break;
    }
    if (sub === 'revoke') {
      const id = arg('entry') || die('--entry is required');
      if (!SOFTWARE_ENTRY_ID.test(id)) die('--entry is a catalog entry id');
      const reason = arg('reason') || die('--reason is required');
      if (store.softwareRevocation(id)) die(`${id} was already revoked`);
      if (!store.revokeSoftware(id, { at: new Date().toISOString(), by: 'operator', reason })) die(`${id} was revoked a moment ago`);
      console.log(`revoked ${id}`);
      break;
    }
    die('software list|revoke --entry <id> --reason <why>');
    break;
  }
  case 'revocations': {
    // v0.36. What the next signed statement will say (it is signed when the portal asks).
    if (sub !== 'show') die('revocations show');
    const st = revocationStatement(mergeRevocations(store.publishedRevocations(), { scripts: store.scriptRevocations(), software: store.softwareRevocations() }), new Date());
    console.log(JSON.stringify({ ...st, kid: loadSigningKey(store.keyPem()).kid }, null, 2));
    break;
  }
  default:
    die('usage: main.js serve|keygen|keys|roster list|roster add|roster disable|policy set|pause list|set|clear|patch-policy list|revoke|device-key list|forget|script list|revoke|software list|revoke|revocations show');
}
