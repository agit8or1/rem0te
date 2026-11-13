#!/usr/bin/env node
// Tests for the approval signer (src/approval-signer), run against dist:
//
//   node apps/api/scripts/unit-approval-signer.mjs
//
// It starts the signer in-process on loopback with a scratch directory, and
// approves with synthetic passkeys (scripts/lib/synthetic-passkey.mjs) that the
// signer's real WebAuthn verification checks. No database, no portal: the
// point of the signer is that it needs neither to decide.

import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { generateKeyPairSync, verify, createPublicKey, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { syntheticPasskey } from './lib/synthetic-passkey.mjs';
import { deviceKey, signStatement, resultStatement, scanStatement } from './lib/device-sign.mjs';
import { createHash } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const dist = join(here, '..', 'dist');
const { startSigner } = require(join(dist, 'approval-signer', 'server.js'));
const core = require(join(dist, 'approval-signer', 'core.js'));
const { canonicalJson } = require(join(dist, 'integration', 'crypto.js'));

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => { if (ok) passed++; else failures.push(`${name}${detail ? ` — ${detail}` : ''}`); };

// ── fixtures ────────────────────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'rem0te-signer-'));
const { privateKey } = generateKeyPairSync('ed25519');
writeFileSync(join(dir, 'signer.key'), privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });

const BIZ_A = 'biz_acme_0001', BIZ_B = 'biz_birch_0001';
const people = {
  requester: syntheticPasskey({ userId: 'user_requester', name: 'Dana (L2)' }),
  olivia: syntheticPasskey({ userId: 'user_olivia01', name: 'Olivia' }),
  quinn: syntheticPasskey({ userId: 'user_quinn001', name: 'Quinn' }),
  owen: syntheticPasskey({ userId: 'user_owen0001', name: 'Owen (Acme owner)' }),
  birchOnly: syntheticPasskey({ userId: 'user_birch001', name: 'Bea (Birch only)' }),
  gone: syntheticPasskey({ userId: 'user_gone0001', name: 'Former approver' }),
  stranger: syntheticPasskey({ userId: 'user_strange1', name: 'Not on roster' }),
};
const member = (p, approve, customer = [], extra = {}) => ({ userId: p.userId, name: p.name, credentialId: p.credentialId, publicKey: p.publicKey, counter: 0, approve, customer, addedAt: new Date().toISOString(), ...extra });
writeFileSync(join(dir, 'roster.json'), JSON.stringify({ members: [
  member(people.requester, ['*']), // a requester who is ALSO an approver: must still not approve their own
  member(people.olivia, ['*']),
  member(people.quinn, [BIZ_A]),
  member(people.owen, [], [BIZ_A]),
  member(people.birchOnly, [BIZ_B]),
  member(people.gone, ['*'], [], { disabled: true }),
] }));
writeFileSync(join(dir, 'policy.json'), JSON.stringify({ default: { customerSignoff: false }, businesses: { [BIZ_B]: { customerSignoff: true } } }));
const rosterBefore = readFileSync(join(dir, 'roster.json'), 'utf8');

const ORIGIN = 'http://127.0.0.1:39201';
const s = startSigner({ dir, origin: ORIGIN, rpId: '127.0.0.1', publicPort: 0, internalPort: 0 });
await Promise.all([s.internal, s.pub].map((x) => new Promise((r) => (x.listening ? r() : x.once('listening', r)))));
const INTERNAL = `http://127.0.0.1:${s.internal.address().port}`;
const PUBLIC = `http://127.0.0.1:${s.pub.address().port}`;

const jobId = () => randomBytes(16).toString('hex');
const UPD_ID = { updateId: '5a1b2c3d-0000-4000-8000-000000000001', revision: 201 };
const AGENT_SHA = 'a'.repeat(64);
function plan({ biz = BIZ_A, deviceClass = 'WORKSTATION', customerSignoff = false, risk, approvalsRequired, hours = 4, origin = { kind: 'technician', ticketRef: null }, ...over } = {}) {
  const now = Date.now();
  risk ??= deviceClass === 'WORKSTATION' ? 'low' : 'high';
  approvalsRequired ??= risk === 'low' ? 1 : 2;
  return {
    schema: 'rem0te-action-plan/1', jobId: jobId(),
    action: { id: 'windows.service.start', version: 1 },
    artifact: { target: 'windows/rem0te-agent.exe', sha256: AGENT_SHA },
    params: { service: 'Spooler' },
    targets: [{ endpointId: 'ep_frontdesk_a', businessId: biz, businessName: biz === BIZ_A ? 'Acme' : 'Birch', hostname: 'FRONTDESK', deviceClass, rustdeskId: '123456789', deviceSecretSha256: 'b'.repeat(64) }],
    requestedBy: { userId: people.requester.userId, name: people.requester.name, via: 'portal' },
    origin, reason: 'Print queue stuck; spooler stopped',
    policy: { risk, approvalsRequired, customerSignoff },
    window: { notBefore: new Date(now - 60_000).toISOString(), notAfter: new Date(now + hours * 3_600_000).toISOString() },
    createdAt: new Date(now).toISOString(), approvers: [], signedAt: null, ...over,
  };
}
const j = async (url, init = {}) => { const r = await fetch(url, init); let b = null; try { b = await r.json(); } catch { /* not JSON */ } return { status: r.status, body: b }; };
const submit = (p) => j(`${INTERNAL}/internal/v1/plans`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plan: p }) });
const pubPost = (id, path, body, origin = ORIGIN) => j(`${PUBLIC}/approve/${id}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });
async function decide(id, who, { decision = 'approve', role = 'approver', forge = {}, origin = ORIGIN } = {}) {
  const c = await pubPost(id, '/challenge', { decision, role }, origin);
  if (c.status !== 200) return c;
  const assertion = who.assert(c.body.options, { origin: ORIGIN, ...forge });
  return pubPost(id, '/decide', { challengeId: c.body.challengeId, assertion }, origin);
}
const keysDoc = (await j(`${INTERNAL}/internal/v1/keys`)).body;
function verifyEnvelope(env) {
  if (!env) return null;
  const k = keysDoc.keys.find((x) => x.kid === env.kid);
  if (!k) return null;
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(k.ed25519, 'base64')]);
  const pub = createPublicKey({ key: spki, format: 'der', type: 'spki' });
  const bytes = Buffer.from(env.plan, 'base64');
  const ok = verify(null, Buffer.concat([Buffer.from('rem0te-action-plan-v1\n'), bytes]), pub, Buffer.from(env.sig, 'base64'));
  return ok ? JSON.parse(bytes.toString('utf8')) : null;
}

// 0.34: a software plan, as the portal builds one from a catalog entry.
const SW = { packageId: '7zip.7zip', version: '24.08', installerSha256: 'e'.repeat(64), scope: 'machine', detection: { kind: 'display_name', name: '7-Zip', match: 'prefix', compare: 'gte', version: '24.08' } };
const swDisplay = { updates: [], deployment: null, software: { name: '7-Zip', publisher: 'Igor Pavlov', hashSource: 'winget_pkgs', manifestSha256: 'f'.repeat(64), entryId: 'entry_7zip_0001', entryRevision: 1 } };
const swTarget = { endpointId: 'ep_frontdesk_a', businessId: BIZ_A, businessName: 'Acme', hostname: 'FRONTDESK', deviceClass: 'WORKSTATION', rustdeskId: '123456789', deviceSecretSha256: 'b'.repeat(64) };
const swPlan = (over = {}) => plan({ action: { id: 'windows.software.install', version: 1 }, params: SW, risk: 'high', display: swDisplay, ...over });

// ── admission: the portal's claims about policy are re-derived ─────────────
check('keys document lists one 16-hex kid', keysDoc.schema === 'rem0te-approval-keys/1' && /^[0-9a-f]{16}$/.test(keysDoc.keys[0]?.kid));
for (const [name, p, code] of [
  ['understated risk (server as low)', plan({ deviceClass: 'SERVER', risk: 'low', approvalsRequired: 1 }), 'risk_mismatch'],
  ['understated approvals', plan({ deviceClass: 'SERVER', risk: 'high', approvalsRequired: 1 }), 'too_few_approvals_required'],
  ['customer sign-off dropped for a business that requires it', plan({ biz: BIZ_B, customerSignoff: false }), 'policy_mismatch'],
  ['pre-filled approvers', plan({ approvers: [{ userId: 'user_olivia01', name: 'Olivia', role: 'approver', credentialSha256: 'c'.repeat(64), at: new Date().toISOString() }] }), 'invalid_plan'],
  ['another service', plan({ params: { service: 'WinDefend' } }), null],
  ['a command parameter', plan({ params: { service: 'Spooler', command: 'whoami' } }), null],
  ['an unknown action', plan({ action: { id: 'windows.shell.run', version: 1 } }), null],
  ['window already closed', plan({ hours: -1, window: { notBefore: new Date(Date.now() - 7_200_000).toISOString(), notAfter: new Date(Date.now() - 1000).toISOString() } }), 'window_closed'],
  ['an extra top-level field', { ...plan(), command: 'whoami' }, 'invalid_plan'],
  // 0.32 maintenance actions: high impact on any computer, closed params.
  ['a service restart on a workstation claimed as low risk', plan({ action: { id: 'windows.service.restart', version: 1 }, params: { service: 'wuauserv' } }), 'risk_mismatch'],
  ['a restart of a service off the allowlist (WinDefend)', plan({ action: { id: 'windows.service.restart', version: 1 }, params: { service: 'WinDefend' }, risk: 'high' }), null],
  ['a restart of a service off the allowlist (lsass)', plan({ action: { id: 'windows.service.restart', version: 1 }, params: { service: 'lsass' }, risk: 'high' }), null],
  ['an immediate restart (delay 0)', plan({ action: { id: 'windows.reboot.schedule', version: 1 }, params: { delayMinutes: 0 }, risk: 'high' }), null],
  ['a restart under five minutes', plan({ action: { id: 'windows.reboot.schedule', version: 1 }, params: { delayMinutes: 4 }, risk: 'high' }), null],
  ['a restart with a custom message', plan({ action: { id: 'windows.reboot.schedule', version: 1 }, params: { delayMinutes: 30, message: 'click this link' }, risk: 'high' }), null],
  ['a restart plan with a window over 2 hours', plan({ action: { id: 'windows.reboot.schedule', version: 1 }, params: { delayMinutes: 30 }, risk: 'high', hours: 3 }), null],
  ['a log collection naming a path', plan({ action: { id: 'windows.logs.collect', version: 1 }, params: { log: 'C:\\Windows\\System32\\config\\SAM' }, risk: 'high' }), null],
  ['a restart cancel with parameters', plan({ action: { id: 'windows.reboot.cancel', version: 1 }, params: { all: true }, risk: 'high' }), null],
  // 0.34: an update plan's restart rule is one of two fixed strings, with nothing beside it.
  ...[['always'], ['if_required'], [''], [true], [{ delayMinutes: 5 }]].map(([rb]) => [`an update plan with restart rule ${JSON.stringify(rb)}`, plan({ action: { id: 'windows.update.install', version: 1 }, params: { updates: [UPD_ID], reboot: rb }, risk: 'high' }), null]),
  ['an update plan with a restart delay beside the rule', plan({ action: { id: 'windows.update.install', version: 1 }, params: { updates: [UPD_ID], reboot: 'if_required_in_window', delayMinutes: 1 }, risk: 'high' }), null],
  ['an update plan with a restart message beside the rule', plan({ action: { id: 'windows.update.install', version: 1 }, params: { updates: [UPD_ID], reboot: 'if_required_in_window', message: 'click here' }, risk: 'high' }), null],
  ['an update plan with no restart rule', plan({ action: { id: 'windows.update.install', version: 1 }, params: { updates: [UPD_ID] }, risk: 'high' }), null],
  // 0.34 software: closed params, charset-checked, high impact, at most 25 computers.
  ['a software install claimed as low risk', swPlan({ risk: 'low', approvalsRequired: 1 }), 'risk_mismatch'],
  ['a software install with one approval', swPlan({ approvalsRequired: 1 }), 'too_few_approvals_required'],
  ['a software install with a shell separator in the package id', swPlan({ params: { ...SW, packageId: '7zip.7zip;calc' } }), null],
  ['a software install whose package id is a flag', swPlan({ params: { ...SW, packageId: '--override.x' } }), null],
  ['a software install whose version is a flag', swPlan({ params: { ...SW, version: '--force' } }), null],
  ['a software install with an upper-case hash', swPlan({ params: { ...SW, installerSha256: SW.installerSha256.toUpperCase() } }), null],
  ['a software install for one user', swPlan({ params: { ...SW, scope: 'user' } }), null],
  ['a software install with installer arguments', swPlan({ params: { ...SW, args: '/S /D=C:\\evil' } }), null],
  ['a software install with no detection rule', swPlan({ params: { packageId: SW.packageId, version: SW.version, installerSha256: SW.installerSha256, scope: 'machine' } }), null],
  ['a software install whose detection file leaves Program Files', swPlan({ params: { ...SW, detection: { kind: 'file_version', base: 'ProgramFiles', file: '..\\Windows\\cmd.exe', compare: 'gte', version: '1' } } }), null],
  ['a software install whose detection runs something', swPlan({ params: { ...SW, detection: { kind: 'script', script: 'Get-Item' } } }), null],
  ['a software uninstall on 26 computers', swPlan({ action: { id: 'windows.software.uninstall', version: 1 }, targets: Array.from({ length: 26 }, (_, i) => ({ ...swTarget, endpointId: `ep_ring_${String(i).padStart(4, '0')}`, rustdeskId: String(100000000 + i) })) }), null],
]) {
  const r = await submit(p);
  check(`admission refuses ${name}`, r.status === 409 && (!code || r.body?.error === code), JSON.stringify(r.body));
}

// ── 0.34: an update plan that restarts in its window is admitted and says so ──
{
  const pu = plan({ action: { id: 'windows.update.install', version: 1 }, params: { updates: [UPD_ID], reboot: 'if_required_in_window' }, risk: 'high' });
  const su = await submit(pu);
  check('an update plan with the in-window restart rule (high, two approvals) is admitted', su.status === 201, JSON.stringify(su.body));
  const html = await (await fetch(`${PUBLIC}/approve/${pu.jobId}`)).text();
  check('its approval page says it restarts if required, with the fixed warning, and that this has not run on real Windows',
    /restarting if Windows requires it/.test(html) && /15-minute warning/.test(html) && /not yet run on a real Windows computer/.test(html) && !/never restarting/.test(html));
  const pn = plan({ action: { id: 'windows.update.install', version: 1 }, params: { updates: [UPD_ID], reboot: 'never' }, risk: 'high' });
  check('a never-restart update plan is admitted', (await submit(pn)).status === 201);
  check('and its page says never restarting', /never restarting/.test(await (await fetch(`${PUBLIC}/approve/${pn.jobId}`)).text()));
  check('an update plan under-stated as low risk is refused (installs are high on any computer)', (await submit(plan({ action: { id: 'windows.update.install', version: 1 }, params: { updates: [UPD_ID], reboot: 'if_required_in_window' } }))).body?.error === 'risk_mismatch');
}

// ── 0.32: a scheduled restart needs two distinct approvers, even on a workstation ──
{
  const pr = plan({ action: { id: 'windows.reboot.schedule', version: 1 }, params: { delayMinutes: 30 }, risk: 'high', hours: 1.5 });
  const sr = await submit(pr);
  check('a restart schedule (high, two approvals, 90-minute window) is admitted', sr.status === 201, JSON.stringify(sr.body));
  const html2 = await (await fetch(`${PUBLIC}/approve/${pr.jobId}`)).text();
  check('its approval page shows the fixed restart warning and the delay', /closed without saving/.test(html2) && /Your IT support provider has scheduled a restart/.test(html2) && /delayMinutes/.test(html2));
  let d = await decide(pr.jobId, people.olivia);
  check('one approval does not sign a restart on a workstation', d.status === 200 && d.body.status === 'AWAITING_APPROVAL', JSON.stringify(d.body));
  d = await decide(pr.jobId, people.olivia);
  check('the same approver cannot count twice for a restart', d.status === 409, JSON.stringify(d.body));
  d = await decide(pr.jobId, people.quinn);
  const signedPlan = verifyEnvelope(d.body?.envelope ?? (await j(`${INTERNAL}/internal/v1/plans/${pr.jobId}`)).body?.envelope);
  check('a second, different approver signs it; the envelope carries the delay and both approvers',
    d.body?.status === 'SIGNED' && signedPlan?.params?.delayMinutes === 30 && signedPlan.approvers.length === 2, JSON.stringify(d.body).slice(0, 200));
}

// ── 0.34: a software install needs two distinct approvers; the page shows the pin ──
{
  const pr = swPlan();
  const sr = await submit(pr);
  check('a software install (high, two approvals, closed params) is admitted', sr.status === 201, JSON.stringify(sr.body));
  const html3 = await (await fetch(`${PUBLIC}/approve/${pr.jobId}`)).text();
  check('its approval page shows the package, version, pinned SHA-256, where it came from and the detection rule',
    html3.includes('7zip.7zip') && html3.includes('24.08') && html3.includes('e'.repeat(64)) && /read from the winget-pkgs manifest/.test(html3) && /Detection rule/.test(html3) && /Igor Pavlov/.test(html3));
  const pasted = swPlan({ display: { ...swDisplay, software: { ...swDisplay.software, hashSource: 'admin_pasted', manifestSha256: null } } });
  await submit(pasted);
  const html4 = await (await fetch(`${PUBLIC}/approve/${pasted.jobId}`)).text();
  check('a pasted hash is shown as typed in by the catalog\'s editor', /typed in by the catalog(&#39;|')s editor/.test(html4));
  let d = await decide(pr.jobId, people.olivia);
  check('one approval does not sign a software install', d.status === 200 && d.body.status === 'AWAITING_APPROVAL', JSON.stringify(d.body));
  d = await decide(pr.jobId, people.olivia);
  check('the same approver cannot count twice for a software install', d.status === 409, JSON.stringify(d.body));
  d = await decide(pr.jobId, people.quinn);
  const signedPlan = verifyEnvelope(d.body?.envelope ?? (await j(`${INTERNAL}/internal/v1/plans/${pr.jobId}`)).body?.envelope);
  check('a second, different approver signs it; the envelope carries exactly the closed params and both approvers',
    d.body?.status === 'SIGNED' && canonicalJson(signedPlan?.params ?? null) === canonicalJson(SW) && signedPlan.approvers.length === 2, JSON.stringify(d.body).slice(0, 200));
  const ring = swPlan({ action: { id: 'windows.software.uninstall', version: 1 }, targets: Array.from({ length: 25 }, (_, i) => ({ ...swTarget, endpointId: `ep_ring_${String(i).padStart(4, '0')}`, rustdeskId: String(100000000 + i) })) });
  const rr = await submit(ring);
  check('a software uninstall ring of 25 computers is admitted', rr.status === 201, JSON.stringify(rr.body));
}

// ── low risk: one roster approver, not the requester ───────────────────────
const p1 = plan();
const sub1 = await submit(p1);
check('a valid plan is admitted awaiting approval', sub1.status === 201 && sub1.body.status === 'AWAITING_APPROVAL' && sub1.body.approvalUrl === `${ORIGIN}/approve/${p1.jobId}`, JSON.stringify(sub1.body));
check('admission returns the digest the portal computed', sub1.body.digest === core.planDigest(p1));
const resubmit = await submit({ ...p1, reason: 'changed after the fact' });
check('a job id cannot be reused for a different plan', resubmit.status === 409 && resubmit.body.error === 'job_id_reused');

const page = await fetch(`${PUBLIC}/approve/${p1.jobId}`);
const html = await page.text();
check('approval page has a nonce CSP and no framing', /script-src 'nonce-/.test(page.headers.get('content-security-policy') || '') && page.headers.get('x-frame-options') === 'DENY');
check('approval page shows the warning about queued documents', /waiting in the print queue may print immediately/i.test(html) && /cannot be recalled/i.test(html), html.slice(0, 200));
check('approval page shows the digest and the target', html.includes(sub1.body.digest) && html.includes('FRONTDESK') && html.includes('Acme'));

let r = await decide(p1.jobId, people.requester);
check('the requester cannot approve their own plan, even when on the roster', r.status === 403 && r.body.error === 'requester_cannot_approve', JSON.stringify(r.body));
r = await decide(p1.jobId, people.stranger);
check('a passkey not on the roster is refused', r.status === 403 && r.body.error === 'not_authorized');
r = await decide(p1.jobId, people.gone);
check('a disabled roster member is refused', r.status === 403 && r.body.error === 'not_authorized');
r = await decide(p1.jobId, people.birchOnly);
check('an approver for another business is refused', r.status === 403 && r.body.error === 'not_authorized');
r = await decide(p1.jobId, people.olivia, { forge: { origin: 'https://portal.example.com' } });
check('an assertion made for another origin is refused (phishing resistance)', r.status === 403 && /origin/i.test(r.body.message), JSON.stringify(r.body));
r = await decide(p1.jobId, people.olivia, { forge: { rpId: 'portal.example.com' } });
check('an assertion for another RP ID is refused', r.status === 403);
r = await decide(p1.jobId, people.olivia, { forge: { uv: false } });
check('an assertion without user verification is refused', r.status === 403 && /verif/i.test(r.body.message), JSON.stringify(r.body));
r = await decide(p1.jobId, people.olivia, { forge: { challenge: Buffer.from('a-challenge-for-something-else').toString('base64url') } });
check('an assertion over a different challenge is refused', r.status === 403);
r = await pubPost(p1.jobId, '/challenge', { decision: 'approve', role: 'approver' }, 'https://evil.example.com');
check('a cross-origin challenge request is refused', r.status === 403);
r = await pubPost(p1.jobId, '/challenge', { decision: 'approve', role: 'approver' }, null);
check('a challenge request with no Origin is refused', r.status === 403);

// Single use: the challenge is consumed even by a failed attempt.
let c = await pubPost(p1.jobId, '/challenge', { decision: 'approve', role: 'approver' });
await pubPost(p1.jobId, '/decide', { challengeId: c.body.challengeId, assertion: people.stranger.assert(c.body.options, { origin: ORIGIN }) });
r = await pubPost(p1.jobId, '/decide', { challengeId: c.body.challengeId, assertion: people.olivia.assert(c.body.options, { origin: ORIGIN }) });
check('a challenge is single-use, even after a failed attempt', r.status === 409 && r.body.error === 'challenge_used');
// A challenge issued for "reject" cannot carry an approval: its hash names the decision.
c = await pubPost(p1.jobId, '/challenge', { decision: 'reject', role: 'approver' });
const approveChallenge = core.webauthnChallenge({ id: c.body.challengeId, digest: sub1.body.digest, decision: 'approve', role: 'approver' });
r = await pubPost(p1.jobId, '/decide', { challengeId: c.body.challengeId, assertion: people.olivia.assert(c.body.options, { origin: ORIGIN, challenge: approveChallenge }) });
check('the passkey signs over the decision and digest, not just a random id', r.status === 403, JSON.stringify(r.body));
check('the WebAuthn challenge is derived from the plan digest', c.body.options.challenge === core.webauthnChallenge({ id: c.body.challengeId, digest: sub1.body.digest, decision: 'reject', role: 'approver' }));

r = await decide(p1.jobId, people.olivia);
check('one roster approver signs a low-risk workstation plan', r.status === 200 && r.body.status === 'SIGNED', JSON.stringify(r.body));
const st1 = (await j(`${INTERNAL}/internal/v1/plans/${p1.jobId}`)).body;
const signed1 = verifyEnvelope(st1.envelope);
check('the envelope verifies with the published approval key', !!signed1);
check('the signed bytes are the canonical plan', signed1 && Buffer.from(st1.envelope.plan, 'base64').toString('utf8') === canonicalJson(signed1));
check('the signed plan names the approver and their credential, not the requester', signed1?.approvers?.length === 1 && signed1.approvers[0].userId === people.olivia.userId && signed1.approvers[0].credentialSha256 === core.credentialSha256(people.olivia));
check('the signed plan is the admitted plan plus approvals', signed1 && core.planDigest(signed1) === sub1.body.digest);
r = await decide(p1.jobId, people.quinn);
check('a signed plan takes no further decisions', r.status === 409 && r.body.error === 'not_awaiting');
check('the serving process never rewrote the roster', readFileSync(join(dir, 'roster.json'), 'utf8') === rosterBefore);
check('the passkey counter is persisted apart from the roster', existsSync(join(dir, 'counters', `${core.credentialSha256(people.olivia)}.json`)));

// Counter regression: an authenticator clone replays an old counter.
const p1b = plan();
await submit(p1b);
r = await decide(p1b.jobId, people.olivia, { forge: { counterAbs: 1 } });
check('a passkey whose counter went backwards is refused (cloned authenticator)', r.status === 403, JSON.stringify(r.body));

// ── high risk: two distinct approvers ──────────────────────────────────────
const p2 = plan({ deviceClass: 'SERVER' });
await submit(p2);
r = await decide(p2.jobId, people.olivia);
check('a server plan is not signed after one approval', r.status === 200 && r.body.status === 'AWAITING_APPROVAL');
r = await decide(p2.jobId, people.olivia);
check('the same person cannot approve twice', r.status === 409 && r.body.error === 'already_decided');
r = await decide(p2.jobId, people.owen, { role: 'approver' });
check('a customer-only member cannot count as an approver', r.status === 403);
r = await decide(p2.jobId, people.quinn);
check('a second distinct approver signs a server plan', r.status === 200 && r.body.status === 'SIGNED');
const signed2 = verifyEnvelope((await j(`${INTERNAL}/internal/v1/plans/${p2.jobId}`)).body.envelope);
check('the server envelope carries both approvers', signed2?.approvers?.length === 2 && signed2.policy.approvalsRequired === 2);

// ── customer sign-off where policy requires it ─────────────────────────────
const p3 = plan({ biz: BIZ_B, customerSignoff: true });
const sub3 = await submit(p3);
check('a Birch plan with customer sign-off is admitted', sub3.status === 201, JSON.stringify(sub3.body));
r = await decide(p3.jobId, people.birchOnly);
check('an approver alone does not sign when the customer must sign off', r.status === 200 && r.body.status === 'AWAITING_APPROVAL');
r = await decide(p3.jobId, people.owen, { role: 'customer' });
check('Acme\'s owner cannot sign off for Birch', r.status === 403);
const owenAcme = plan({ customerSignoff: false });
// Policy change for Acme: require sign-off, from the operator side.
writeFileSync(join(dir, 'policy.json'), JSON.stringify({ default: { customerSignoff: false }, businesses: { [BIZ_B]: { customerSignoff: true }, [BIZ_A]: { customerSignoff: true } } }));
r = await submit(owenAcme);
check('a policy change on the signer applies to the next plan, whatever the portal believed', r.status === 409 && r.body.error === 'policy_mismatch');
const p4 = plan({ customerSignoff: true });
await submit(p4);
await decide(p4.jobId, people.olivia);
r = await decide(p4.jobId, people.owen, { role: 'customer' });
check('approver plus a distinct customer sign-off signs', r.status === 200 && r.body.status === 'SIGNED', JSON.stringify(r.body));
const signed4 = verifyEnvelope((await j(`${INTERNAL}/internal/v1/plans/${p4.jobId}`)).body.envelope);
check('the envelope records the customer sign-off role', signed4?.approvers?.some((a) => a.role === 'customer' && a.userId === people.owen.userId));

// ── AI suggestion: same quorum, labelled ───────────────────────────────────
writeFileSync(join(dir, 'policy.json'), JSON.stringify({ default: { customerSignoff: false }, businesses: { [BIZ_B]: { customerSignoff: true } } }));
const p5 = plan({ origin: { kind: 'ai_suggestion', ticketRef: 'ticket-42' } });
await submit(p5);
const html5 = await (await fetch(`${PUBLIC}/approve/${p5.jobId}`)).text();
check('an AI-suggested plan is labelled as one on the approval page', /AI suggestion/.test(html5) && html5.includes('ticket-42'));
r = await decide(p5.jobId, people.olivia);
check('an AI suggestion still needs a human passkey approval, and gets nothing extra', r.status === 200 && r.body.status === 'SIGNED');

// ── reject, cancel, expiry ─────────────────────────────────────────────────
const p6 = plan();
await submit(p6);
r = await decide(p6.jobId, people.olivia, { decision: 'reject' });
check('a rejection is final', r.status === 200 && r.body.status === 'REJECTED');
r = await decide(p6.jobId, people.quinn);
check('a rejected plan cannot then be approved', r.status === 409);
const p7 = plan();
await submit(p7);
const cancel = await j(`${INTERNAL}/internal/v1/plans/${p7.jobId}/cancel`, { method: 'POST' });
check('the portal can cancel a plan awaiting approval', cancel.body.status === 'CANCELED');
r = await decide(p7.jobId, people.olivia);
check('a canceled plan cannot be approved', r.status === 409);
const cancelSigned = await j(`${INTERNAL}/internal/v1/plans/${p1.jobId}/cancel`, { method: 'POST' });
check('canceling a signed plan does not unsign it (the portal stops delivery instead)', cancelSigned.body.status === 'SIGNED');

// ── 0.34: the script allowlist, and runs against it ────────────────────────
{
  const sr = require(join(dist, 'actions', 'script-run.js'));
  const hex32 = () => randomBytes(16).toString('hex');
  const CONTENT = 'param([Parameter(Mandatory)][string]$Name, [int]$Count = 1)\nfor ($i = 0; $i -lt $Count; $i++) { Write-Output "hello $Name" }\n';
  const DECLS = [
    { name: 'Name', type: 'string', required: true, charset: 'identifier', maxLength: 32 },
    { name: 'Count', type: 'integer', required: false, min: 1, max: 5 },
  ];
  const AUTHOR = { userId: 'user_author01', name: 'Ann (author)' };
  const REVIEWER = { userId: 'user_review01', name: 'Rob (library reviewer)' };
  function proposal({ content = CONTENT, biz = BIZ_A, contributors = [AUTHOR], proposedBy = { userId: people.requester.userId, name: people.requester.name }, ...over } = {}) {
    return {
      allowlistId: hex32(), scriptId: 'scr_' + hex32().slice(0, 12), versionId: 'ver_' + hex32().slice(0, 12), name: 'Say hello', version: 1, description: 'Greets',
      businessId: biz, businessName: biz ? (biz === BIZ_A ? 'Acme' : 'Birch') : null, language: 'powershell', targetOs: 'windows', risk: 'medium',
      parameters: DECLS, contentSha256: sr.sha256Hex(content), content, contributors,
      reviewedBy: { ...REVIEWER, at: new Date().toISOString() }, proposedBy, ...over,
    };
  }
  const propose = (p) => j(`${INTERNAL}/internal/v1/scripts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ proposal: p }) });
  const scrPost = (id, path, b, origin = ORIGIN) => j(`${PUBLIC}/approve/script/${id}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(b) });
  async function decideScript(id, who, decision = 'approve') {
    const c = await scrPost(id, '/challenge', { decision });
    if (c.status !== 200) return c;
    return scrPost(id, '/decide', { challengeId: c.body.challengeId, assertion: who.assert(c.body.options, { origin: ORIGIN }) });
  }
  function runPlan(prop, { args = { Name: 'world' }, timeoutMinutes = 5, block, biz = BIZ_A, ...over } = {}) {
    const b = block ?? sr.scriptBlockOf(prop);
    return plan({
      biz, deviceClass: 'WORKSTATION', risk: 'high', approvalsRequired: 2,
      action: { id: 'windows.script.run', version: 1 },
      params: { scriptVersionId: prop.versionId, sha256: b.contentSha256, parameters: args, timeoutMinutes },
      script: b, ...over,
    });
  }

  // Proposal: the signer hashes the content itself.
  const bad = proposal();
  bad.contentSha256 = sr.sha256Hex('Write-Output "something else"');
  let r = await propose(bad);
  check('a proposal whose content does not hash to the named SHA-256 is refused', r.status === 409 && r.body?.error === 'hash_mismatch', JSON.stringify(r.body));
  r = await propose({ ...proposal(), status: 'ACTIVE' });
  check('a proposal cannot carry its own status (strict schema)', r.status === 409 && r.body?.error === 'invalid_script', JSON.stringify(r.body));
  r = await propose(proposal({ contributors: [AUTHOR, REVIEWER] }));
  check('a proposal whose library reviewer is a contributor is refused', r.status === 409 && r.body?.error === 'invalid_script', JSON.stringify(r.body));

  const pa = proposal();
  r = await propose(pa);
  check('a valid proposal is admitted awaiting two approvals, with the signer-computed hash', r.status === 201 && r.body.status === 'AWAITING_APPROVAL' && r.body.contentSha256 === sr.sha256Hex(CONTENT) && r.body.approvalUrl === `${ORIGIN}/approve/script/${pa.allowlistId}`, JSON.stringify(r.body));
  r = await propose(pa);
  check('the same proposal again returns the same entry', r.status === 201 && r.body.id === pa.allowlistId);
  r = await propose({ ...pa, content: CONTENT + '# edited\n', contentSha256: sr.sha256Hex(CONTENT + '# edited\n') });
  check('the portal cannot edit an entry by re-proposing under its id', r.status === 409 && r.body?.error === 'script_id_reused', JSON.stringify(r.body));
  for (const [m, path] of [['POST', '/approve'], ['POST', '/activate'], ['PUT', ''], ['PATCH', ''], ['DELETE', '']]) {
    r = await j(`${INTERNAL}/internal/v1/scripts/${pa.allowlistId}${path}`, { method: m, headers: { 'content-type': 'application/json' }, body: m === 'DELETE' ? undefined : JSON.stringify({ status: 'ACTIVE' }) });
    check(`the internal listener has no ${m} ${path || '/'} that changes an entry`, r.status === 405 || r.status === 404, `${r.status}`);
  }
  check('nothing on the internal listener activated it', (await j(`${INTERNAL}/internal/v1/scripts/${pa.allowlistId}`)).body.status === 'AWAITING_APPROVAL');

  const pageRes = await fetch(`${PUBLIC}/approve/script/${pa.allowlistId}`);
  const spage = await pageRes.text();
  check('the allowlist page shows the content and the signer-computed hash, under a nonce CSP',
    spage.includes('hello $Name') && spage.includes(sr.sha256Hex(CONTENT)) && /script-src 'nonce-/.test(pageRes.headers.get('content-security-policy') || ''), spage.slice(0, 200));

  // A run before the entry is ACTIVE.
  r = await submit(runPlan(pa));
  check('a run of a script awaiting allowlist approval is refused', r.status === 409 && r.body?.error === 'script_not_allowlisted', JSON.stringify(r.body));
  r = await submit(runPlan(proposal()));
  check('a run of a script never proposed is refused', r.status === 409 && r.body?.error === 'script_not_allowlisted', JSON.stringify(r.body));

  r = await decideScript(pa.allowlistId, people.requester);
  check('the proposer cannot approve the allowlist entry', r.status === 403 && r.body?.error === 'requester_cannot_approve', JSON.stringify(r.body));
  r = await decideScript(pa.allowlistId, people.birchOnly);
  check('an approver for another business cannot approve the entry', r.status === 403 && r.body?.error === 'not_authorized', JSON.stringify(r.body));
  r = await scrPost(pa.allowlistId, '/challenge', { decision: 'approve' }, 'https://evil.example.com');
  check('a cross-origin allowlist challenge is refused', r.status === 403);
  r = await decideScript(pa.allowlistId, people.olivia);
  check('one approval does not add a script to the allowlist', r.status === 200 && r.body.status === 'AWAITING_APPROVAL', JSON.stringify(r.body));
  r = await decideScript(pa.allowlistId, people.olivia);
  check('the same approver cannot count twice for an allowlist entry', r.status === 409, JSON.stringify(r.body));
  r = await decideScript(pa.allowlistId, people.quinn);
  check('a second, different approver makes the entry ACTIVE', r.status === 200 && r.body.status === 'ACTIVE', JSON.stringify(r.body));
  check('the entry is on disk in the signer\'s own directory', existsSync(join(dir, 'scripts', `${pa.allowlistId}.json`)));

  // Contributors cannot approve the entry.
  const pc = proposal({ contributors: [{ userId: people.quinn.userId, name: people.quinn.name }] });
  await propose(pc);
  r = await decideScript(pc.allowlistId, people.quinn);
  check('a contributor cannot approve the allowlist entry for their own script', r.status >= 400 && r.body?.error === 'contributor_cannot_approve', JSON.stringify(r.body));

  // A global script needs approvers for every business.
  const pg = proposal({ biz: null });
  await propose(pg);
  r = await decideScript(pg.allowlistId, people.quinn);
  check('an approver for one business cannot add a global script', r.status === 403 && r.body?.error === 'not_authorized', JSON.stringify(r.body));

  // Runs of the ACTIVE entry.
  for (const [name, p, code] of [
    ['a block that is not the allowlisted one (contributors dropped)', runPlan(pa, { block: { ...sr.scriptBlockOf(pa), contributors: ['user_someone1'] } }), 'script_mismatch'],
    ['a block with a hash for other content', runPlan(pa, { block: (() => { const b = sr.scriptBlockOf(pa); const h = sr.sha256Hex('other'); return { ...b, contentSha256: h, definitionSha256: sr.definitionSha256({ ...b, contentSha256: h }) }; })() }), null],
    ['parameters widened in the block', runPlan(pa, { block: (() => { const b = sr.scriptBlockOf(pa); const parameters = [{ ...DECLS[0], charset: 'safe_text' }, DECLS[1]]; return { ...b, parameters, definitionSha256: sr.definitionSha256({ ...b, parameters }) }; })() }), 'script_mismatch'],
    ['an argument outside its charset (injection)', runPlan(pa, { args: { Name: 'x"; Remove-Item C:\\ -Recurse; "' } }), 'arguments_not_allowed'],
    ['an undeclared argument', runPlan(pa, { args: { Name: 'world', Command: 'whoami' } }), 'arguments_not_allowed'],
    ['a missing required argument', runPlan(pa, { args: { Count: 2 } }), 'arguments_not_allowed'],
    ['an integer passed as a string', runPlan(pa, { args: { Name: 'world', Count: '2' } }), null],
    ['an integer out of range', runPlan(pa, { args: { Name: 'world', Count: 99 } }), 'arguments_not_allowed'],
    ['a timeout off the list', runPlan(pa, { timeoutMinutes: 45 }), null],
    ['a business script on another business\'s computer', runPlan(pa, { biz: BIZ_B }), null],
    ['a run claimed as low risk with one approver', runPlan(pa, { risk: 'low', approvalsRequired: 1 }), 'risk_mismatch'],
    ['a run with no script block', (() => { const p = runPlan(pa); delete p.script; return p; })(), null],
    ['a script block on another action', plan({ script: sr.scriptBlockOf(pa) }), null],
  ]) {
    r = await submit(p);
    check(`a script run is refused for ${name}`, r.status === 409 && (!code || r.body?.error === code), JSON.stringify(r.body));
  }

  const run1 = runPlan(pa, { args: { Name: 'world', Count: 2 } });
  r = await submit(run1);
  check('a run of the ACTIVE entry with conforming arguments is admitted', r.status === 201 && r.body.status === 'AWAITING_APPROVAL', JSON.stringify(r.body));
  const rhtml = await (await fetch(`${PUBLIC}/approve/${run1.jobId}`)).text();
  check('the run approval page shows the script content from the signer\'s allowlist and its hash', rhtml.includes('hello $Name') && rhtml.includes(sr.sha256Hex(CONTENT)) && /SYSTEM/.test(rhtml));
  r = await decide(run1.jobId, people.olivia);
  check('one approval does not sign a script run', r.status === 200 && r.body.status === 'AWAITING_APPROVAL', JSON.stringify(r.body));
  r = await decide(run1.jobId, people.quinn);
  const signedRun = verifyEnvelope(r.body?.envelope ?? (await j(`${INTERNAL}/internal/v1/plans/${run1.jobId}`)).body?.envelope);
  check('two distinct approvers sign it; the envelope carries the script block, its hash and the arguments',
    r.body?.status === 'SIGNED' && signedRun?.script?.contentSha256 === sr.sha256Hex(CONTENT) && signedRun.params.parameters.Count === 2 && signedRun.script.contributors[0] === AUTHOR.userId && signedRun.approvers.length === 2, JSON.stringify(r.body).slice(0, 200));

  // A contributor cannot approve a run of their script.
  const pq = proposal({ content: CONTENT + '# quinn\'s copy\n', contributors: [{ userId: people.quinn.userId, name: people.quinn.name }], proposedBy: { userId: 'user_portal01', name: 'Portal' } });
  await propose(pq);
  await decideScript(pq.allowlistId, people.olivia);
  r = await decideScript(pq.allowlistId, people.requester);
  check('(an entry for quinn\'s script is ACTIVE)', r.body?.status === 'ACTIVE', JSON.stringify(r.body));
  const run2 = runPlan(pq);
  await submit(run2);
  r = await decide(run2.jobId, people.quinn);
  check('the script\'s author cannot approve a run of it (SAME_PERSON)', r.status >= 400 && r.body?.error === 'contributor_cannot_approve', JSON.stringify(r.body));

  // Revocation is one-way.
  const run3 = runPlan(pa);
  await submit(run3);
  await decide(run3.jobId, people.olivia);
  r = await j(`${INTERNAL}/internal/v1/scripts/${pa.allowlistId}/revoke`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
  check('a revocation needs a reason', r.status === 409 || r.status === 400, `${r.status}`);
  r = await j(`${INTERNAL}/internal/v1/scripts/${pa.allowlistId}/revoke`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'found a bug' }) });
  check('the portal can revoke an entry', r.status === 200 && r.body.status === 'REVOKED', JSON.stringify(r.body));
  r = await decide(run3.jobId, people.quinn);
  check('a run admitted before the revocation is not signed after it', r.status === 409 && r.body?.error === 'script_revoked', JSON.stringify(r.body));
  r = await submit(runPlan(pa));
  check('a new run of a revoked script is refused', r.status === 409 && r.body?.error === 'script_revoked', JSON.stringify(r.body));
  r = await propose(proposal());
  check('the same content cannot be proposed again under a new id after revocation', r.status === 409 && r.body?.error === 'script_revoked', JSON.stringify(r.body));
  check('the revocation is a write-once file keyed by content hash', existsSync(join(dir, 'script-revocations', `${sr.sha256Hex(CONTENT)}.json`)));
  r = await scrPost(pa.allowlistId, '/challenge', { decision: 'approve' });
  check('a revoked entry takes no further decisions', r.status === 409 && r.body?.error === 'not_awaiting', JSON.stringify(r.body));
  check('the run that was already signed stays signed (the portal stops delivery; the agent re-checks the hash)', (await j(`${INTERNAL}/internal/v1/plans/${run1.jobId}`)).body.status === 'SIGNED');

  // The CLI lists and revokes, from the signer's host.
  const cliS = (args) => spawnSync(process.execPath, [join(dist, 'approval-signer', 'main.js'), ...args], { encoding: 'utf8', env: { ...process.env, APPROVAL_SIGNER_DIR: dir } });
  let o = cliS(['script', 'list']);
  check('`script list` shows each entry with its status and hash', o.status === 0 && o.stdout.includes(pq.allowlistId) && /REVOKED/.test(o.stdout) && /ACTIVE/.test(o.stdout) && o.stdout.includes(sr.sha256Hex(CONTENT)), o.stderr || o.stdout.slice(0, 300));
  o = cliS(['script', 'revoke', '--id', pq.allowlistId, '--reason', 'operator test']);
  check('`script revoke` on the signer host revokes', o.status === 0 && JSON.parse(readFileSync(join(dir, 'scripts', `${pq.allowlistId}.json`), 'utf8')) && (await j(`${INTERNAL}/internal/v1/scripts/${pq.allowlistId}`)).body.status === 'REVOKED', o.stderr);
}

// ── 0.36: the signed revocation statement and software revocation ─────────
{
  const post = (path, body) => j(`${INTERNAL}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const pubOf = (kid) => { const k = keysDoc.keys.find((x) => x.kid === kid); return k ? createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(k.ed25519, 'base64')]), format: 'der', type: 'spki' }) : null; };
  const statement = async () => {
    const r = await j(`${INTERNAL}/internal/v1/revocations`);
    const st = r.status === 200 ? core.verifyRevocations(r.body, { kid: r.body.kid, publicKey: pubOf(r.body.kid) }) : null;
    return { r, st };
  };
  const t0 = Date.now();
  let { r, st } = await statement();
  const revokedScripts = readdirSync(join(dir, 'script-revocations')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
  check('GET /internal/v1/revocations: an envelope signed with the job-approval key (kid from keys.json)', r.status === 200 && r.body.schema === 'rem0te-revocations-envelope/1' && r.body.kid === keysDoc.keys[0].kid && !!st, JSON.stringify(r.body).slice(0, 200));
  check('it lists every revoked script content hash, and seq counts them', st && st.schema === 'rem0te-revocations/1' && JSON.stringify(st.scripts) === JSON.stringify(revokedScripts) && revokedScripts.length >= 2 && st.software.length === 0 && st.seq === revokedScripts.length, JSON.stringify(st));
  check('asOf is this process\'s clock, now', st && Math.abs(Date.parse(st.asOf) - t0) < 5000, st?.asOf);
  {
    const bytes = Buffer.from(r.body.statement, 'base64');
    const asPlan = verify(null, Buffer.concat([Buffer.from('rem0te-action-plan-v1\n'), bytes]), pubOf(r.body.kid), Buffer.from(r.body.sig, 'base64'));
    const asRev = verify(null, Buffer.concat([Buffer.from('rem0te-revocations-v1\n'), bytes]), pubOf(r.body.kid), Buffer.from(r.body.sig, 'base64'));
    check('it is signed under its own domain prefix: never valid as a plan signature', asRev && !asPlan);
    const forged = { ...r.body, statement: Buffer.from(JSON.stringify({ ...st, scripts: [], seq: 0 })).toString('base64') };
    check('an edited statement (revocations dropped) does not verify', core.verifyRevocations(forged, { kid: r.body.kid, publicKey: pubOf(r.body.kid) }) === null);
    const other = generateKeyPairSync('ed25519').publicKey;
    check('nor under another key', core.verifyRevocations(r.body, { kid: r.body.kid, publicKey: other }) === null);
  }
  const seq0 = st.seq, asOf0 = st.asOf;

  // A software plan must name its catalog entry.
  const bare = swPlan({ display: { updates: [], deployment: null } });
  r = await submit(bare);
  check('a software plan that names no catalog entry is refused (software_entry_missing)', r.status === 409 && r.body?.error === 'software_entry_missing', JSON.stringify(r.body));
  // An install half-approved before its entry is revoked.
  const halfDisplay = { ...swDisplay, software: { ...swDisplay.software, entryId: 'entry_half_0001' } };
  const half = swPlan({ display: halfDisplay });
  r = await submit(half);
  const d1 = await decide(half.jobId, people.olivia);
  check('(an install from entry_half_0001 is admitted and approved once)', r.status === 201 && d1.body?.status === 'AWAITING_APPROVAL', JSON.stringify([r.body, d1.body]));
  r = await post('/internal/v1/software/entry_half_0001/revoke', {});
  check('a software revocation needs a reason', r.status === 409 && r.body?.error === 'bad_request', JSON.stringify(r.body));
  r = await post('/internal/v1/software/..%2Fpolicy/revoke', { reason: 'path games' });
  check('an id that is not a catalog entry id → 404', r.status === 404, JSON.stringify(r.body));
  r = await post('/internal/v1/software/entry_half_0001/revoke', { reason: 'archived: vendor withdrew 24.08' });
  check('the portal can revoke a software catalog entry', r.status === 200 && r.body.status === 'REVOKED' && !!r.body.revokedAt, JSON.stringify(r.body));
  const firstAt = r.body.revokedAt;
  r = await post('/internal/v1/software/entry_half_0001/revoke', { reason: 'again' });
  check('revoking again changes nothing: the first revocation stands', r.status === 200 && r.body.revokedAt === firstAt && JSON.parse(readFileSync(join(dir, 'software-revocations', 'entry_half_0001.json'), 'utf8')).reason === 'archived: vendor withdrew 24.08');
  r = await decide(half.jobId, people.quinn);
  check('an install approved halfway before the revocation is not signed after it (software_revoked)', r.status === 409 && r.body?.error === 'software_revoked', JSON.stringify(r.body));
  r = await submit(swPlan({ display: halfDisplay }));
  check('a new install from the revoked entry is refused at admission', r.status === 409 && r.body?.error === 'software_revoked', JSON.stringify(r.body));
  const un = swPlan({ action: { id: 'windows.software.uninstall', version: 1 }, display: halfDisplay });
  r = await submit(un);
  check('an uninstall from it is still admitted (removing a withdrawn package is what an archive is for)', r.status === 201, JSON.stringify(r.body));

  ({ st } = await statement());
  check('the next statement lists the entry, seq up by one, asOf later', st && st.software.includes('entry_half_0001') && st.seq === seq0 + 1 && Date.parse(st.asOf) >= Date.parse(asOf0), JSON.stringify(st));
  // Nothing on disk can shrink it: a revocation file that disappears stays published.
  const victim = join(dir, 'script-revocations', `${revokedScripts[0]}.json`);
  const kept = readFileSync(victim, 'utf8');
  rmSync(victim);
  ({ st } = await statement());
  check('a revocation file removed from disk is still in the statement (revocations.json only grows)', st && st.scripts.includes(revokedScripts[0]) && st.seq === seq0 + 1, JSON.stringify(st));
  writeFileSync(victim, kept, { mode: 0o600 });
  r = await j(`${INTERNAL}/internal/v1/capabilities`);
  check('capabilities say the signer publishes revocations', r.body?.revocations === 1, JSON.stringify(r.body));

  // The CLI, on the signer's host: entries archived before 0.36 are revoked here.
  const cliR = (args) => spawnSync(process.execPath, [join(dist, 'approval-signer', 'main.js'), ...args], { encoding: 'utf8', env: { ...process.env, APPROVAL_SIGNER_DIR: dir } });
  let o = cliR(['software', 'revoke', '--entry', 'entry_old_00001']);
  check('`software revoke` needs a reason', o.status !== 0);
  o = cliR(['software', 'revoke', '--entry', 'entry_old_00001', '--reason', 'archived in 0.35']);
  check('`software revoke` revokes an entry archived before 0.36', o.status === 0 && existsSync(join(dir, 'software-revocations', 'entry_old_00001.json')), o.stderr);
  o = cliR(['software', 'revoke', '--entry', 'entry_old_00001', '--reason', 'twice']);
  check('and refuses to do it twice', o.status !== 0);
  o = cliR(['software', 'list']);
  check('`software list` shows both, with who revoked them', o.status === 0 && /entry_half_0001 {2}revoked .* by portal/.test(o.stdout) && /entry_old_00001 {2}revoked .* by operator/.test(o.stdout), o.stdout);
  o = cliR(['revocations', 'show']);
  const shown = o.status === 0 ? JSON.parse(o.stdout) : null;
  check('`revocations show` prints what the next statement will list', shown?.seq === seq0 + 2 && shown.software.includes('entry_old_00001') && shown.kid === keysDoc.keys[0].kid, o.stdout + o.stderr);
}

// ── restart: state survives, a used challenge stays used ───────────────────
const p8 = plan();
await submit(p8);
const c8 = await pubPost(p8.jobId, '/challenge', { decision: 'approve', role: 'approver' });
const a8 = people.olivia.assert(c8.body.options, { origin: ORIGIN });
r = await pubPost(p8.jobId, '/decide', { challengeId: c8.body.challengeId, assertion: a8 });
check('the decision before the restart is accepted', r.status === 200, `${r.status} ${JSON.stringify(r.body)}`);
await s.close();
const s2 = startSigner({ dir, origin: ORIGIN, rpId: '127.0.0.1', publicPort: 0, internalPort: 0 });
await Promise.all([s2.internal, s2.pub].map((x) => new Promise((res) => (x.listening ? res() : x.once('listening', res)))));
const PUB2 = `http://127.0.0.1:${s2.pub.address().port}`;
const INT2 = `http://127.0.0.1:${s2.internal.address().port}`;
const replay = await j(`${PUB2}/approve/${p8.jobId}/decide`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ challengeId: c8.body.challengeId, assertion: a8 }) });
check('a replayed decision after a restart is refused', replay.status === 409 && replay.body.error === 'challenge_used', JSON.stringify(replay.body));
check('signed state survives a restart', (await j(`${INT2}/internal/v1/plans/${p1.jobId}`)).body.status === 'SIGNED');
await s2.close();

// ── the roster ceremony ────────────────────────────────────────────────────
const cli = (args, env = {}) => spawnSync(process.execPath, [join(dist, 'approval-signer', 'main.js'), ...args], { encoding: 'utf8', env: { ...process.env, APPROVAL_SIGNER_DIR: dir, ...env } });
const newbie = syntheticPasskey({ userId: 'user_newbie01', name: 'New approver' });
let out = cli(['roster', 'add', '--export', newbie.export(), '--approve', BIZ_A, '--confirm-fingerprint', '0000-0000-0000-0000']);
check('roster add refuses a fingerprint that was not read back', out.status !== 0 && /Fingerprint check failed/.test(out.stderr));
out = cli(['roster', 'add', '--export', newbie.export(), '--customer', '*', '--confirm-fingerprint', core.fingerprint(newbie)]);
check('roster add refuses a customer sign-off for every business', out.status !== 0);
out = cli(['roster', 'add', '--export', newbie.export(), '--approve', BIZ_A, '--confirm-fingerprint', core.fingerprint(newbie)]);
check('roster add accepts the fingerprint the approver reads from their Passkeys page', out.status === 0, out.stderr);
out = cli(['roster', 'disable', '--user', newbie.userId]);
check('roster disable takes effect in the file the server reads', out.status === 0 && JSON.parse(readFileSync(join(dir, 'roster.json'), 'utf8')).members.find((m) => m.userId === newbie.userId)?.disabled === true);
out = cli(['keygen']);
check('keygen refuses to overwrite a signing key', out.status !== 0 && /refusing to overwrite/.test(out.stderr));

// ── 0.34: device result keys — pinned on approval, verified before a later ring ──
{
  const s3 = startSigner({ dir, origin: ORIGIN, rpId: '127.0.0.1', publicPort: 0, internalPort: 0 });
  await Promise.all([s3.internal, s3.pub].map((x) => new Promise((r) => (x.listening ? r() : x.once('listening', r)))));
  const INTERNAL = `http://127.0.0.1:${s3.internal.address().port}`;
  const PUBLIC = `http://127.0.0.1:${s3.pub.address().port}`;
  const P = require(join(dist, 'actions', 'patch-policy.js'));
  const sha = (x) => createHash('sha256').update(x).digest('hex');
  const hhmm = (t) => `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`;
  const t0 = new Date();
  const SEC = '0fa1201d-4330-4fa8-8ae9-b877473b6441';
  const CU = { updateId: '5a1b2c3d-0000-4000-8000-000000000001', revision: 201, kb: 'KB5044284', title: '2026-11 Cumulative Update', className: 'Security Updates', severity: 'Critical' };
  const dev = { canary: deviceKey(), r1: deviceKey(), forger: deviceKey() };
  const computer = (name, rid, k) => ({ endpointId: `ep_${name}_0001`, hostname: name.toUpperCase(), rustdeskId: rid, deviceSecretSha256: sha(name), resultKey: k.key });
  const CANARY = computer('canary', '210000001', dev.canary), R1 = computer('ringone', '210000002', dev.r1);
  const author = { userId: people.requester.userId, name: people.requester.name };
  const window = { days: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'], start: hhmm(new Date(t0.getTime() - 3600_000)), end: hhmm(new Date(t0.getTime() + 3 * 3600_000)), timezone: 'UTC' };
  const mkDoc = (rings) => ({
    schema: 'rem0te-patch-policy/1', policyId: randomBytes(16).toString('hex'), name: 'Acme nightly', businessId: BIZ_A, businessName: 'Acme',
    rings, allow: { classifications: [SEC] }, soakHours: 0, failureThreshold: 0, window, reboot: 'never',
    createdAt: t0.toISOString(), expiresAt: new Date(t0.getTime() + 7 * 86_400_000).toISOString(), createdBy: author, reason: 'signed results test',
  });
  const propose = (doc) => j(`${INTERNAL}/internal/v1/policies`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ policy: doc }) });
  const approvePolicy = async (id, who) => {
    const c = await j(`${PUBLIC}/approve/policy/${id}/challenge`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ decision: 'approve', role: 'approver' }) });
    if (c.status !== 200) return c;
    return j(`${PUBLIC}/approve/policy/${id}/decide`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ challengeId: c.body.challengeId, assertion: who.assert(c.body.options, { origin: ORIGIN }) }) });
  };
  const ringPlan = (doc, digest, ring, computers, dep) => ({
    schema: 'rem0te-action-plan/1', jobId: jobId(), action: { id: 'windows.update.install', version: 1 },
    artifact: { target: 'windows/rem0te-agent.exe', sha256: AGENT_SHA },
    params: { updates: [{ updateId: CU.updateId, revision: CU.revision }], reboot: 'never', allow: P.allowParams(doc.allow) },
    targets: computers.map((c) => ({ endpointId: c.endpointId, businessId: BIZ_A, businessName: 'Acme', hostname: c.hostname, deviceClass: 'WORKSTATION', rustdeskId: c.rustdeskId, deviceSecretSha256: c.deviceSecretSha256 })),
    requestedBy: { ...author, via: 'portal' }, origin: { kind: 'technician', ticketRef: null }, reason: `ring ${ring}`,
    policy: { risk: 'high', approvalsRequired: 2, customerSignoff: false },
    // A later ring starts after the ring before it was signed.
    window: { notBefore: new Date(Date.now() + (ring ? 2000 : -1000)).toISOString(), notAfter: new Date(Date.now() + 3600_000).toISOString() },
    display: { updates: [CU], deployment: { id: dep, name: 'Acme nightly', ring, rings: doc.rings.length }, policy: { id: doc.policyId, name: doc.name, digest } },
    createdAt: new Date().toISOString(), approvers: [], signedAt: null,
  });
  const underPolicy = (id, body) => j(`${INTERNAL}/internal/v1/policies/${id}/plans`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  const doc1 = mkDoc([[CANARY], [R1]]);
  const unkeyed = mkDoc([[{ ...CANARY, resultKey: undefined }], [R1]]);
  delete unkeyed.rings[0][0].resultKey;
  let r = await propose(unkeyed);
  check('the signer refuses a policy whose canary has no result key (a pre-0.34 agent) → result_key_missing', r.status === 409 && r.body?.error === 'result_key_missing', JSON.stringify(r.body));
  r = await propose(doc1);
  check('a policy naming each computer\'s result key is accepted for approval', r.status === 201, JSON.stringify(r.body));
  const digest1 = r.body.digest;
  const page = await (await fetch(`${PUBLIC}/approve/policy/${doc1.policyId}`)).text();
  check('the approval page shows each computer\'s result-key fingerprint, as first seen here, with how to check it',
    page.includes(core.resultKeyFingerprint(CANARY.resultKey)) && page.includes(core.resultKeyFingerprint(R1.resultKey)) && /first time this signer sees it/.test(page) && /rem0te-agent\.exe status/.test(page));
  check('nothing is pinned before the policy is approved', !existsSync(join(dir, 'device-keys', `${core.deviceIdentity(CANARY)}.json`)));
  await approvePolicy(doc1.policyId, people.olivia);
  r = await approvePolicy(doc1.policyId, people.quinn);
  check('two approvers make the policy active', r.status === 200 && r.body.status === 'ACTIVE', JSON.stringify(r.body).slice(0, 200));
  const pinFile = join(dir, 'device-keys', `${core.deviceIdentity(CANARY)}.json`);
  check('approving it pins each computer\'s key to its enrolled identity, on the signer\'s disk', existsSync(pinFile) && JSON.parse(readFileSync(pinFile, 'utf8')).resultKey === CANARY.resultKey);
  const page2 = await (await fetch(`${PUBLIC}/approve/policy/${doc1.policyId}`)).text();
  check('the page then says the key is pinned', /— pinned /.test(page2));

  // A compromised portal proposes a second policy for the same canary, with a key of its own.
  const swapped = mkDoc([[{ ...CANARY, resultKey: dev.forger.key }], [R1]]);
  r = await propose(swapped);
  check('a later policy naming another key for a pinned computer is refused at proposal → device_key_changed', r.status === 409 && r.body?.error === 'device_key_changed' && /device-key forget/.test(r.body.message), JSON.stringify(r.body));

  // The canary under the approved policy; the ledger records the plan's hash.
  const dep = `dep_${randomBytes(4).toString('hex')}`;
  const p0 = ringPlan(doc1, digest1, 0, [CANARY], dep);
  r = await underPolicy(doc1.policyId, { plan: p0, policyDigest: digest1, evidence: null });
  check('the canary is signed under the policy', r.status === 201, JSON.stringify(r.body));
  const env0 = (await j(`${INTERNAL}/internal/v1/plans/${p0.jobId}`)).body.envelope;
  const planSha = sha(Buffer.from(env0.plan, 'base64'));
  const rec = JSON.parse(readFileSync(join(dir, 'policies', `${doc1.policyId}.json`), 'utf8'));
  check('the signer\'s ledger records the sha256 of the exact plan bytes it signed', rec.ledger[0].planSha256 === planSha);

  const resultAt = new Date(Date.now() - 1000);
  const genuine = signStatement(dev.canary, 'result', resultStatement({ jobId: p0.jobId, planSha256: planSha, rustdeskId: CANARY.rustdeskId, deviceSecretSha256: CANARY.deviceSecretSha256, outcome: 'succeeded', completedAt: resultAt.toISOString(), updates: [{ updateId: CU.updateId, revision: CU.revision, state: 'installed' }] }));
  const scan = (k) => signStatement(k, 'scan', scanStatement({ rustdeskId: CANARY.rustdeskId, deviceSecretSha256: CANARY.deviceSecretSha256, scannedAt: new Date(resultAt.getTime() + 500).toISOString(), installed: [`${CU.updateId}@${CU.revision}`] }));
  const target = (res, sc) => ({ endpointId: CANARY.endpointId, status: 'SUCCEEDED', statusReason: null, reconciled: false, resultAt: resultAt.toISOString(),
    result: { outcome: 'succeeded', updates: [{ updateId: CU.updateId, revision: CU.revision, state: 'installed' }] },
    scan: { scannedAt: new Date(resultAt.getTime() + 500).toISOString(), error: false, rebootPending: false, offered: [], installed: [`${CU.updateId}@${CU.revision}`] },
    ...(res ? { signedResult: res } : {}), ...(sc ? { signedScan: sc } : {}) });
  const ev = (t) => ({ previousJobId: p0.jobId, jobStatus: 'SUCCEEDED', targets: [t] });
  r = await underPolicy(doc1.policyId, { plan: ringPlan(doc1, digest1, 1, [R1], dep), policyDigest: digest1, evidence: ev(target(null, null)) });
  check('ring 1 on the portal\'s word alone (no device signature) → 409 result_signature_missing', r.status === 409 && r.body?.error === 'result_signature_missing', JSON.stringify(r.body));
  const forgedRes = signStatement(dev.forger, 'result', JSON.parse(Buffer.from(genuine.statement, 'base64').toString('utf8')));
  r = await underPolicy(doc1.policyId, { plan: ringPlan(doc1, digest1, 1, [R1], dep), policyDigest: digest1, evidence: ev(target(forgedRes, scan(dev.forger))) });
  check('ring 1 on a canary success the portal signed itself → 409 result_wrong_device', r.status === 409 && r.body?.error === 'result_wrong_device', JSON.stringify(r.body));
  const replayed = signStatement(dev.canary, 'result', resultStatement({ ...JSON.parse(Buffer.from(genuine.statement, 'base64').toString('utf8')), jobId: jobId() }));
  r = await underPolicy(doc1.policyId, { plan: ringPlan(doc1, digest1, 1, [R1], dep), policyDigest: digest1, evidence: ev(target(replayed, scan(dev.canary))) });
  check('ring 1 on the canary\'s genuine result about another job → 409 result_wrong_plan', r.status === 409 && r.body?.error === 'result_wrong_plan', JSON.stringify(r.body));
  r = await underPolicy(doc1.policyId, { plan: ringPlan(doc1, digest1, 1, [R1], dep), policyDigest: digest1, evidence: ev(target(genuine, scan(dev.canary))) });
  check('ring 1 on the canary\'s genuine signed success and scan → signed', r.status === 201, JSON.stringify(r.body));
  const st = await j(`${INTERNAL}/internal/v1/policies/${doc1.policyId}`);
  check('each refusal is kept with the policy, by code', ['result_signature_missing', 'result_wrong_device', 'result_wrong_plan'].every((c) => st.body.refusals.some((x) => x.code === c)), JSON.stringify(st.body.refusals.map((x) => x.code)));

  // The pin is write-once for the serving process, and only the operator CLI removes it.
  const { SignerStore } = require(join(dist, 'approval-signer', 'store.js'));
  const store = new SignerStore(dir);
  check('the store will not overwrite a pin', store.pinDeviceKey({ ...JSON.parse(readFileSync(pinFile, 'utf8')), resultKey: dev.forger.key }) === false && JSON.parse(readFileSync(pinFile, 'utf8')).resultKey === CANARY.resultKey);
  const cli = (args) => spawnSync(process.execPath, [join(dist, 'approval-signer', 'main.js'), ...args], { encoding: 'utf8', env: { ...process.env, APPROVAL_SIGNER_DIR: dir } });
  let out = cli(['device-key', 'list']);
  check('device-key list shows each pinned computer with its fingerprint', out.status === 0 && out.stdout.includes(CANARY.endpointId) && out.stdout.includes(core.resultKeyFingerprint(CANARY.resultKey)), out.stdout + out.stderr);
  out = cli(['device-key', 'forget', '--endpoint', CANARY.endpointId]);
  check('device-key forget needs a reason', out.status !== 0);
  out = cli(['device-key', 'forget', '--endpoint', CANARY.endpointId, '--reason', 'agent state lost; new fingerprint read from the computer']);
  check('device-key forget removes the pin', out.status === 0 && !existsSync(pinFile), out.stderr);
  r = await propose(swapped);
  check('after the operator forgets the pin, a policy naming the new key may be proposed (and needs two approvals again)', r.status === 201 && r.body.status === 'AWAITING_APPROVAL', JSON.stringify(r.body));
  await s3.close();

  // ── 0.39: direct mode ───────────────────────────────────────────────────
  // Its own signer and directory, so the policy can be changed under it.
  {
    const sr = require(join(dist, 'actions', 'script-run.js'));
    const d4 = mkdtempSync(join(tmpdir(), 'rem0te-signer-direct-'));
    writeFileSync(join(d4, 'signer.key'), generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    writeFileSync(join(d4, 'roster.json'), JSON.stringify({ members: [member(people.requester, ['*']), member(people.olivia, ['*']), member(people.quinn, ['*'])] }));
    const cli4 = (args) => spawnSync(process.execPath, [join(dist, 'approval-signer', 'main.js'), ...args], { encoding: 'utf8', env: { ...process.env, APPROVAL_SIGNER_DIR: d4 } });
    const pol4 = () => JSON.parse(readFileSync(join(d4, 'policy.json'), 'utf8'));
    const log4 = () => (existsSync(join(d4, 'policy-changes.log')) ? readFileSync(join(d4, 'policy-changes.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);

    // The CLI is the only writer; absent means signed.
    let o = cli4(['policy', 'show']);
    check('direct: a fresh signer has no approval mode set (absent is signed)', o.status === 0 && JSON.parse(o.stdout).default.approval === undefined && core.policyFor(JSON.parse(o.stdout), BIZ_A).approval === 'signed', o.stderr);
    o = cli4(['policy', 'set', '--business', BIZ_A, '--approval', 'yes']);
    check('direct: policy set refuses an approval value other than direct / signed', o.status === 2 && !existsSync(join(d4, 'policy.json')), o.stderr);
    o = cli4(['policy', 'set', '--business', 'short', '--approval', 'direct']);
    check('direct: policy set refuses something that is not a business id or default', o.status === 2, o.stderr);
    cli4(['policy', 'set', '--business', BIZ_B, '--customer-signoff', 'required']);
    o = cli4(['policy', 'set', '--business', BIZ_B, '--approval', 'direct']);
    check('direct: refused for a business that requires customer sign-off, saying why', o.status === 2 && /requires customer sign-off/.test(o.stderr) && /nobody could sign off first/.test(o.stderr) && pol4().businesses[BIZ_B].approval === undefined, o.stderr);
    o = cli4(['policy', 'set', '--business', BIZ_A, '--approval', 'direct']);
    check('direct: policy set --approval direct is written for that business only, with a warning of what it gives up', o.status === 0 && pol4().businesses[BIZ_A].approval === 'direct' && pol4().default.approval === undefined && /Anyone who fully controls the portal/.test(o.stderr), o.stderr);
    o = cli4(['policy', 'set', '--business', BIZ_A, '--customer-signoff', 'required']);
    check('direct: turning customer sign-off on while direct is refused, saying why', o.status === 2 && /is in direct mode/.test(o.stderr) && pol4().businesses[BIZ_A].customerSignoff === false, o.stderr);
    const lg = log4();
    check('direct: every accepted policy change is appended to policy-changes.log, refusals are not', lg.length === 2 && lg[1].business === BIZ_A && lg[1].before === null && lg[1].after.approval === 'direct' && lg[0].after.customerSignoff === true, JSON.stringify(lg));
    check('direct: policyFor treats a hand-edited direct + customer sign-off as signed (the stricter)', core.policyFor({ default: { customerSignoff: true, approval: 'direct' }, businesses: {} }, BIZ_A).approval === 'signed'
      && core.policyFor({ default: { customerSignoff: false, approval: 'Direct' }, businesses: {} }, BIZ_A).approval === 'signed');

    const s4 = startSigner({ dir: d4, origin: ORIGIN, rpId: '127.0.0.1', publicPort: 0, internalPort: 0 });
    await Promise.all([s4.internal, s4.pub].map((x) => new Promise((rr) => (x.listening ? rr() : x.once('listening', rr)))));
    const IN4 = `http://127.0.0.1:${s4.internal.address().port}`, PUB4 = `http://127.0.0.1:${s4.pub.address().port}`;
    const post4 = (p, body) => j(`${IN4}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const keys4 = (await j(`${IN4}/internal/v1/keys`)).body;
    const open4 = (env) => {
      const k = keys4.keys.find((x) => x.kid === env?.kid);
      if (!k) return null;
      const pub = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(k.ed25519, 'base64')]), format: 'der', type: 'spki' });
      const bytes = Buffer.from(env.plan, 'base64');
      return verify(null, Buffer.concat([Buffer.from('rem0te-action-plan-v1\n'), bytes]), pub, Buffer.from(env.sig, 'base64')) ? JSON.parse(bytes.toString('utf8')) : null;
    };
    const directPlan = (o2 = {}) => { const p = plan({ ...o2 }); p.policy = { risk: p.policy.risk, approvalsRequired: 0, customerSignoff: false, approval: 'direct' }; return p; };

    // Read only over HTTP.
    let r = await j(`${IN4}/internal/v1/policy/${BIZ_A}`);
    check('direct: the portal reads a business\'s approval mode from the signer', r.status === 200 && r.body.approval === 'direct' && r.body.customerSignoff === false, JSON.stringify(r.body));
    r = await j(`${IN4}/internal/v1/policy/default`);
    check('direct: the default policy (which governs the allowlist) reads as signed', r.status === 200 && r.body.approval === 'signed', JSON.stringify(r.body));
    const before = readFileSync(join(d4, 'policy.json'), 'utf8');
    const writes = await Promise.all(['POST', 'PUT', 'PATCH', 'DELETE'].map((method) => j(`${IN4}/internal/v1/policy/${BIZ_B}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approval: 'direct' }) })));
    const pubW = await j(`${PUB4}/internal/v1/policy/${BIZ_B}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ approval: 'direct' }) });
    check('direct: no method on either listener changes the policy', writes.every((w) => w.status === 404 || w.status === 405) && pubW.status === 404 && readFileSync(join(d4, 'policy.json'), 'utf8') === before, writes.map((w) => w.status).join(','));
    r = await j(`${IN4}/internal/v1/capabilities`);
    check('direct: capabilities report the default mode and a count of direct businesses', r.body?.direct === 1 && r.body?.approval?.default === 'signed' && r.body.approval.directBusinesses === 1, JSON.stringify(r.body?.approval));

    // Admission: the plan says direct exactly when the policy does.
    for (const [name, p, code] of [
      ['a plan for a direct business that does not say so', plan({ biz: BIZ_A }), 'policy_mismatch'],
      ['a direct plan for a business in signed mode', directPlan({ biz: 'biz_other_0001' }), 'policy_mismatch'],
      ['a direct plan asking for approvals', (() => { const p = directPlan(); p.policy.approvalsRequired = 1; return p; })(), 'policy_mismatch'],
      ['a direct plan asking for customer sign-off', (() => { const p = directPlan(); p.policy.customerSignoff = true; return p; })(), 'direct_with_customer_signoff'],
      ['approval: "signed" (only "direct" is a value)', (() => { const p = plan({ biz: 'biz_other_0001' }); p.policy.approval = 'signed'; return p; })(), 'invalid_plan'],
      ['a plan carrying approvers', (() => { const p = directPlan(); p.approvers = [{ userId: people.olivia.userId, name: 'O', role: 'approver', credentialSha256: 'c'.repeat(64), at: new Date().toISOString() }]; return p; })(), 'invalid_plan'],
      ['zero approvals without direct', (() => { const p = plan({ biz: 'biz_other_0001' }); p.policy.approvalsRequired = 0; return p; })(), 'too_few_approvals_required'],
    ]) {
      const x = await post4('/internal/v1/plans', { plan: p });
      check(`direct: admission refuses ${name}`, x.status === 409 && x.body?.error === code, JSON.stringify(x.body));
    }

    // Signed at admission, workstation and server, with no approvers.
    for (const [what, p] of [['a workstation (low)', directPlan()], ['a server (high)', directPlan({ deviceClass: 'SERVER' })]]) {
      const a = await post4('/internal/v1/plans', { plan: p });
      const env = (await j(`${IN4}/internal/v1/plans/${p.jobId}`)).body?.envelope;
      const signed = open4(env);
      check(`direct: ${what} plan is signed at admission, carrying the signed direct field and no approvers`,
        a.status === 201 && a.body.status === 'SIGNED' && a.body.direct === true && signed?.policy?.approval === 'direct' && signed.approvers.length === 0 && signed.requestedBy.userId === people.requester.userId && !!signed.signedAt, JSON.stringify(a.body));
      const again = await post4('/internal/v1/plans', { plan: p });
      check(`direct: the same ${what} plan again is the same signed job`, again.status === 201 && again.body.status === 'SIGNED' && JSON.stringify((await j(`${IN4}/internal/v1/plans/${p.jobId}`)).body.envelope) === JSON.stringify(env));
    }
    // A direct job has no decision to take.
    {
      const p = directPlan();
      await post4('/internal/v1/plans', { plan: p });
      const c = await j(`${PUB4}/approve/${p.jobId}/challenge`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ decision: 'reject', role: 'approver' }) });
      check('direct: a signed direct job cannot be decided on the approval page', c.status === 409 && c.body?.error === 'not_awaiting', JSON.stringify(c.body));
    }
    // Every other check still applies first.
    {
      const ps = cli4(['pause', 'set', '--business', BIZ_A, '--reason', 'incident 12']);
      const p = directPlan();
      const x = await post4('/internal/v1/plans', { plan: p });
      check('direct: a pause still refuses the plan — nothing is signed', x.status === 409 && x.body?.error === 'paused' && !(await j(`${IN4}/internal/v1/plans/${p.jobId}`)).body?.envelope, JSON.stringify(x.body));
      const pid = (ps.stdout.match(/[A-Za-z0-9_-]{8,}/) ?? [''])[0];
      const cl = cli4(['pause', 'clear', '--id', pid, '--reason', 'incident 12 over']);
      if (cl.status !== 0) throw new Error(`pause clear: ${ps.stdout} ${cl.stderr}`);
      const off = directPlan({ params: { service: 'WinDefend' } });
      const y = await post4('/internal/v1/plans', { plan: off });
      check('direct: parameters outside the catalog are still refused', y.status === 409 && y.body?.error === 'params_not_allowed', JSON.stringify(y.body));
    }
    // Signed mode is untouched beside it.
    {
      const p = plan({ biz: 'biz_other_0001' });
      const x = await post4('/internal/v1/plans', { plan: p });
      check('direct: a business in signed mode still waits for approval', x.status === 201 && x.body.status === 'AWAITING_APPROVAL' && x.body.direct === false, JSON.stringify(x.body));
    }

    // Patch policies: active at admission in direct mode; ring plans carry the flag.
    {
      const dk = deviceKey();
      const C = { endpointId: 'ep_directcanary', hostname: 'DCANARY', rustdeskId: '210000009', deviceSecretSha256: sha('dcanary'), resultKey: dk.key };
      const doc = mkDoc([[C]]);
      r = await post4('/internal/v1/policies', { policy: doc });
      check('direct: a patch policy is ACTIVE at admission, recorded as direct, with no approvals', r.status === 201 && r.body.status === 'ACTIVE' && r.body.direct === true, JSON.stringify(r.body));
      const st = await j(`${IN4}/internal/v1/policies/${doc.policyId}`);
      check('direct: its status says direct and lists no approvals; the computer\'s key is pinned', st.body.direct === true && st.body.approvals.length === 0 && existsSync(join(d4, 'device-keys', `${core.deviceIdentity(C)}.json`)), JSON.stringify(st.body).slice(0, 200));
      const dep = `dep_${randomBytes(4).toString('hex')}`;
      const rp = ringPlan(doc, r.body.digest, 0, [C], dep);
      const signedRp = await post4(`/internal/v1/policies/${doc.policyId}/plans`, { plan: rp, policyDigest: r.body.digest, evidence: null });
      check('direct: a ring plan that does not say direct is refused under a direct business', signedRp.status === 409 && signedRp.body?.error === 'policy_mismatch', JSON.stringify(signedRp.body));
      const rp2 = ringPlan(doc, r.body.digest, 0, [C], dep);
      rp2.policy = { risk: 'high', approvalsRequired: 0, customerSignoff: false, approval: 'direct' };
      const ok = await post4(`/internal/v1/policies/${doc.policyId}/plans`, { plan: rp2, policyDigest: r.body.digest, evidence: null });
      const env = open4((await j(`${IN4}/internal/v1/plans/${rp2.jobId}`)).body?.envelope);
      check('direct: the canary ring is signed under the direct policy and carries the direct field', ok.status === 201 && env?.policy?.approval === 'direct' && env.approvers.length === 0, JSON.stringify(ok.body));
      // The business leaves direct mode: a policy activated with no approvals stops counting.
      cli4(['policy', 'set', '--business', BIZ_A, '--approval', 'signed']);
      const rp3 = ringPlan(doc, r.body.digest, 0, [C], `dep_${randomBytes(4).toString('hex')}`);
      const no = await post4(`/internal/v1/policies/${doc.policyId}/plans`, { plan: rp3, policyDigest: r.body.digest, evidence: null });
      check('direct: once the business is back to signed, a direct-activated policy signs nothing (policy_not_approved)', no.status === 409 && no.body?.error === 'policy_not_approved', JSON.stringify(no.body));
      const doc2 = mkDoc([[{ ...C }]]);
      r = await post4('/internal/v1/policies', { policy: doc2 });
      check('direct: in signed mode a new policy waits for approvals, as before', r.status === 201 && r.body.status === 'AWAITING_APPROVAL' && r.body.direct === false, JSON.stringify(r.body));
      cli4(['policy', 'set', '--business', BIZ_A, '--approval', 'direct']);
    }

    // The allowlist follows the default mode.
    {
      const AUTH = { userId: people.requester.userId, name: people.requester.name };
      const content = 'param([string]$Name)\nWrite-Output "hi $Name"\n';
      const prop = () => ({
        allowlistId: randomBytes(16).toString('hex'), scriptId: 'scr_direct00001', versionId: 'ver_' + randomBytes(6).toString('hex'), name: 'Hi', version: 1, description: 'Greets',
        businessId: BIZ_A, businessName: 'Acme', language: 'powershell', targetOs: 'windows', risk: 'medium',
        parameters: [{ name: 'Name', type: 'string', required: true, charset: 'identifier', maxLength: 32 }], contentSha256: sr.sha256Hex(content), content,
        contributors: [AUTH], reviewedBy: { ...AUTH, at: new Date().toISOString() }, proposedBy: AUTH,
      });
      r = await post4('/internal/v1/scripts', { proposal: prop() });
      check('direct: with the default policy signed, an entry reviewed by its own author is refused, even for a direct business', r.status === 409 && r.body?.error === 'invalid_script', JSON.stringify(r.body));
      const reviewed = { ...prop(), reviewedBy: { userId: 'user_review01', name: 'Rob', at: new Date().toISOString() } };
      r = await post4('/internal/v1/scripts', { proposal: reviewed });
      check('direct: with the default policy signed, an entry waits for two approvals, even for a direct business', r.status === 201 && r.body.status === 'AWAITING_APPROVAL' && r.body.direct === false, JSON.stringify(r.body));
      cli4(['policy', 'set', '--business', 'default', '--approval', 'direct']);
      const p1 = prop();
      r = await post4('/internal/v1/scripts', { proposal: p1 });
      check('direct: with the default policy direct, the author\'s self-reviewed entry is ACTIVE at admission, recorded as direct', r.status === 201 && r.body.status === 'ACTIVE' && r.body.direct === true, JSON.stringify(r.body));
      const g = await j(`${IN4}/internal/v1/scripts/${p1.allowlistId}`);
      check('direct: its status says direct and lists no decisions', g.body.direct === true && g.body.decisions.length === 0 && g.body.status === 'ACTIVE');
      const rp = directPlan({ deviceClass: 'WORKSTATION', action: { id: 'windows.script.run', version: 1 }, params: { scriptVersionId: p1.versionId, sha256: p1.contentSha256, parameters: { Name: 'x' }, timeoutMinutes: 5 }, script: sr.scriptBlockOf(p1) });
      rp.policy.risk = 'high';
      r = await post4('/internal/v1/plans', { plan: rp });
      check('direct: a run of the direct entry, requested by its author, is signed at admission', r.status === 201 && r.body.status === 'SIGNED', JSON.stringify(r.body));
      // Revoked: never signed again, direct or not.
      await post4(`/internal/v1/scripts/${p1.allowlistId}/revoke`, { reason: 'withdrawn in test' });
      const rp2 = { ...rp, jobId: randomBytes(16).toString('hex') };
      r = await post4('/internal/v1/plans', { plan: rp2 });
      check('direct: a revoked script is refused at admission (script_revoked), direct or not', r.status === 409 && r.body?.error === 'script_revoked', JSON.stringify(r.body));
      r = await post4('/internal/v1/scripts', { proposal: { ...prop(), allowlistId: randomBytes(16).toString('hex') } });
      check('direct: and its content can never be proposed again', r.status === 409 && r.body?.error === 'script_revoked', JSON.stringify(r.body));
      cli4(['policy', 'set', '--business', 'default', '--approval', 'signed']);
    }

    // Pure: the same rules without HTTP.
    {
      const now = new Date();
      const direct = { default: { customerSignoff: false }, businesses: { [BIZ_A]: { customerSignoff: false, approval: 'direct' } } };
      const signed = { default: { customerSignoff: false }, businesses: {} };
      const code = (f) => { try { f(); return null; } catch (e) { return e.code; } };
      check('pure: admitPlan accepts a direct plan only under a direct policy', code(() => core.admitPlan(directPlan(), direct, now)) === null && code(() => core.admitPlan(directPlan(), signed, now)) === 'policy_mismatch');
      check('pure: admitPlan refuses an undirected plan under a direct policy', code(() => core.admitPlan(plan(), direct, now)) === 'policy_mismatch');
      const doc = { createdBy: { userId: people.requester.userId } };
      check('pure: policyQuorum — no approvals count only under direct, never with customer sign-off', P.policyQuorum(doc, [], false, true) === true && P.policyQuorum(doc, [], false, false) === false && P.policyQuorum(doc, [], true, true) === false);
      check('pure: allowlistDirect reads only the default policy', core.allowlistDirect(direct) === false && core.allowlistDirect({ default: { customerSignoff: false, approval: 'direct' }, businesses: {} }) === true);
      const raw = { allowlistId: randomBytes(16).toString('hex'), scriptId: 'scr_x00000001', versionId: 'ver_x00000001', name: 'x', version: 1, description: 'x', businessId: BIZ_A, businessName: 'Acme', language: 'powershell', targetOs: 'windows', risk: 'medium', parameters: [], content: 'Write-Output 1\n', contentSha256: sr.sha256Hex('Write-Output 1\n'), contributors: [{ userId: 'user_a0000001', name: 'A' }], reviewedBy: { userId: 'user_a0000001', name: 'A', at: now.toISOString() }, proposedBy: { userId: 'user_a0000001', name: 'A' } };
      check('pure: admitScriptProposal — a self-reviewed entry only in direct, and then ACTIVE', code(() => core.admitScriptProposal(raw, now)) === 'invalid_script' && core.admitScriptProposal(raw, now, true).status === 'ACTIVE');
    }
    await s4.close();
    rmSync(d4, { recursive: true, force: true });
  }
}

// ── the boundary itself: the signer loads nothing of the portal's ─────────
const loaded = Object.keys(require.cache).filter((k) => /node_modules[\\/](@nestjs|@prisma|\.prisma)/.test(k));
check('the signer loads no Nest or Prisma module', loaded.length === 0, loaded.slice(0, 3).join(', '));

if (failures.length) {
  console.error(`✗ ${failures.length} failed, ${passed} passed`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ ${passed} approval-signer checks passed`);
