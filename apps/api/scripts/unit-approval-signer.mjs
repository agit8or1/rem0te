#!/usr/bin/env node
// Tests for the approval signer (src/approval-signer), run against dist:
//
//   node apps/api/scripts/unit-approval-signer.mjs
//
// It starts the signer in-process on loopback with a scratch directory, and
// approves with synthetic passkeys (scripts/lib/synthetic-passkey.mjs) that the
// signer's real WebAuthn verification checks. No database, no portal: the
// point of the signer is that it needs neither to decide.

import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { generateKeyPairSync, verify, createPublicKey, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { syntheticPasskey } from './lib/synthetic-passkey.mjs';

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
]) {
  const r = await submit(p);
  check(`admission refuses ${name}`, r.status === 409 && (!code || r.body?.error === code), JSON.stringify(r.body));
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

// ── the boundary itself: the signer loads nothing of the portal's ─────────
const loaded = Object.keys(require.cache).filter((k) => /node_modules[\\/](@nestjs|@prisma|\.prisma)/.test(k));
check('the signer loads no Nest or Prisma module', loaded.length === 0, loaded.slice(0, 3).join(', '));

if (failures.length) {
  console.error(`✗ ${failures.length} failed, ${passed} passed`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ ${passed} approval-signer checks passed`);
