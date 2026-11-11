#!/usr/bin/env node
/**
 * End-to-end proof of the script library (review only; nothing runs):
 *   - who may see, write and review, per business and globally, including
 *     technicians (whole-business grants only) and independent reviewers;
 *   - another business's script is indistinguishable from a missing one,
 *     whatever business header or body field is sent;
 *   - versions are immutable, hashed, and an edit is a new draft;
 *   - Draft → In review → Approved / Rejected, final; withdraw back to draft;
 *   - SAME_PERSON: an author never approves their own content — not through
 *     an owner role, a Platform Admin role, a technician context, or by
 *     having someone else make a trivial edit (contributors);
 *   - approval binds the hash the reviewer saw, and needs fresh authentication;
 *   - the database refuses what the service would: content or hash changes,
 *     illegal status moves, an approver who is the author, a script moved
 *     between businesses;
 *   - there is no run route, and no action job is ever created;
 *   - everything is audited, refusals included.
 *
 *   cd apps/api && npx nest build
 *   DATABASE_URL=postgresql://…/<name containing scratch or test> node scripts/e2e-script-library.mjs
 *
 * Its own API from dist on port 3231 (SCRIPTS_API_PORT to change it).
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const DB = process.env.DATABASE_URL ?? '';
const dbName = DB.split('/').pop()?.split('?')[0] ?? '';
if (!/scratch|test/.test(dbName)) { console.error(`Refusing to run against database "${dbName}": name must contain "scratch" or "test".`); process.exit(2); }
const PORT = Number(process.env.SCRIPTS_API_PORT ?? 3231);
if ([3000, 3001, 4000, 4001, 443].includes(PORT)) { console.error(`Refusing port ${PORT}`); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'script-library-e2e-password-123';

let pass = 0, fail = 0;
const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;
const sha = (b) => createHash('sha256').update(Buffer.from(b, 'utf8')).digest('hex');

const apiEnv = {
  ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATABASE_URL: DB,
  JWT_SECRET: randomBytes(32).toString('hex'), LAUNCHER_TOKEN_SECRET: randomBytes(32).toString('hex'),
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? randomBytes(32).toString('hex'), TRUSTED_PROXIES: 'loopback', HBBS_PRESENCE_HOST: '127.0.0.2',
  VERSION_FILE: path.resolve(here, '..', '..', '..', 'version.json'), MONITOR_SWEEP: 'off', AUDIT_SEALER: 'off',
};
let api;
function startApi() {
  api = spawn(process.execPath, [path.join(dist, 'main.js')], { env: apiEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  api.log = ''; api.stdout.on('data', (d) => { api.log += d; }); api.stderr.on('data', (d) => { api.log += d; });
}
async function stopApi() { if (!api || api.exitCode !== null) return; await new Promise((r) => { api.once('exit', r); api.kill('SIGTERM'); }); }
async function waitUp() {
  for (let i = 0; i < 120; i++) { try { const r = await fetch(`${API}/health`); if (r.status < 500) return; } catch { /* not yet */ } await sleep(300); }
  throw new Error(`api did not come up:\n${api.log.slice(-3000)}`);
}

async function req(method, p, { s, body, business } = {}) {
  const h = { 'content-type': 'application/json', 'x-forwarded-for': s?.ip ?? ip() };
  if (s) h.cookie = s.cookie + (s.stepUp ? `; step_up=${s.stepUp}` : '');
  if (business) h['x-rem0te-business'] = business;
  const r = await fetch(`${API}${p}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j, data: j?.data, setCookie: r.headers.get('set-cookie') ?? '' };
}
async function login(email) {
  const s = { ip: ip() };
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': s.ip }, body: JSON.stringify({ email, password: PW }) });
  const mm = (r.headers.get('set-cookie') ?? '').match(/access_token=([^;]+)/);
  if (r.status !== 200 || !mm) throw new Error(`login ${email}: ${r.status} ${await r.text()}`);
  s.cookie = `access_token=${mm[1]}`;
  return s;
}
async function stepUp(s) {
  const r = await req('POST', '/auth/step-up', { s, body: { password: PW } });
  const m = r.setCookie.match(/step_up=([^;]+)/);
  if (r.status !== 200 || !m) throw new Error(`step-up: ${r.status} ${JSON.stringify(r.body)}`);
  return { ...s, stepUp: m[1] };
}
const code = (r) => r.body?.code ?? r.body?.message?.code ?? r.body?.error?.code;
const msg = (r) => `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 400)}`;

const created = { businesses: [], users: [], scripts: [] };

const SPOOLER = 'param([string]$Service = "Spooler")\r\n$s = Get-Service -Name $Service\r\nif ($s.Status -ne "Running") { Start-Service -Name $Service }\r\nInvoke-Expression "Get-Service $Service"\r\n';
const body = (extra = {}) => ({ scope: 'business', name: `Restart spooler ${sfx}`, description: 'Starts the print spooler if it is stopped.', risk: 'medium',
  parameters: [{ name: 'Service', type: 'string', required: false, charset: 'identifier', maxLength: 64, description: 'Service name' }], content: SPOOLER, ...extra });

async function all() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });
  const roleUser = await prisma.role.findFirst({ where: { type: 'BUSINESS_USER' } });

  section('Fixtures (synthetic): Acme and Birch; owners, users, technicians, admins, an independent reviewer');
  const acme = await prisma.customer.create({ data: { tenantId: tenant.id, name: `SL Acme ${sfx}` } });
  const birch = await prisma.customer.create({ data: { tenantId: tenant.id, name: `SL Birch ${sfx}` } });
  created.businesses.push(acme.id, birch.id);
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag, extra = {}) => { const u = await prisma.user.create({ data: { email: `sl-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'SL', lastName: tag, status: 'ACTIVE', ...extra } }); created.users.push(u.id); return u; };
  const member = (u, biz, role, capabilities = []) => prisma.membership.create({ data: { userId: u.id, tenantId: tenant.id, customerId: biz.id, roleId: role.id, capabilities } });
  const admin1 = await mkUser('admin1', { isPlatformAdmin: true }), admin2 = await mkUser('admin2', { isPlatformAdmin: true });
  const rita = await mkUser('rita-reviewer', { platformPermissions: ['approvals:review'] });
  const owen = await mkUser('owen-owner-acme'), olga = await mkUser('olga-owner2-acme'), bea = await mkUser('bea-owner-birch');
  const abe = await mkUser('abe-author-acme'), rae = await mkUser('rae-reviewer-acme'), vic = await mkUser('vic-viewer-acme');
  const tess = await mkUser('tess-tech'), tom = await mkUser('tom-tech-named');
  await member(owen, acme, roleOwner); await member(olga, acme, roleOwner); await member(bea, birch, roleOwner);
  await member(abe, acme, roleUser, ['computers:view', 'scripts:author']);
  await member(rae, acme, roleUser, ['computers:view', 'scripts:review']);
  await member(vic, acme, roleUser, ['computers:view', 'computers:connect']);
  const ep = await prisma.endpoint.create({ data: { tenantId: tenant.id, customerId: acme.id, name: 'FRONTDESK', hostname: 'FRONTDESK', platform: 'Windows', status: 'ACTIVE', isManaged: true, accessMode: 'ASSIGNED_USERS', deviceClass: 'WORKSTATION' } });
  // tess: a whole-business grant with both library capabilities. tom: the same capabilities, on one named computer only.
  await prisma.technicianAssignment.create({ data: { tenantId: tenant.id, customerId: acme.id, userId: tess.id, capabilities: ['computers:view', 'scripts:author', 'scripts:review'] } });
  await prisma.technicianAssignment.create({ data: { tenantId: tenant.id, customerId: acme.id, userId: tom.id, capabilities: ['computers:view', 'scripts:author', 'scripts:review'], endpointIds: [ep.id] } });
  const actionJobsBefore = await prisma.actionJob.count();

  startApi();
  await waitUp();
  const S = {};
  for (const [k, u] of Object.entries({ admin1, admin2, rita, owen, olga, bea, abe, rae, vic, tess, tom })) S[k] = await login(u.email);

  section('Who may open the library');
  let r = await req('GET', '/scripts');
  check(r.status === 401, 'anonymous: 401', msg(r));
  r = await req('GET', '/scripts', { s: S.vic });
  check(r.status === 403, 'a user with only view and connect: 403', msg(r));
  r = await req('GET', '/scripts', { s: S.tom });
  check(r.status === 403, 'a technician whose grant names computers gets no library rights, even with the capabilities', msg(r));
  for (const k of ['abe', 'rae', 'owen', 'tess', 'rita', 'admin1']) {
    r = await req('GET', '/scripts', { s: S[k] });
    check(r.status === 200 && Array.isArray(r.data?.scripts) && r.data.execution?.available === false, `${k}: 200, and the response says scripts cannot run`, msg(r));
  }

  section('Writing: scope, refusals before anything is stored');
  const before = await prisma.scriptVersion.count();
  r = await req('POST', '/scripts', { s: S.rae, body: body() });
  check(r.status === 403, 'a reviewer without the Write scripts permission cannot add one', msg(r));
  r = await req('POST', '/scripts', { s: S.abe, body: body({ businessId: birch.id }) });
  check(r.status === 403, 'Acme\'s author cannot add a script to Birch by naming it in the body', msg(r));
  r = await req('POST', '/scripts', { s: S.abe, business: birch.id, body: body() });
  const birchRows = await prisma.script.count({ where: { customerId: birch.id } });
  check(birchRows === 0, 'nor by sending Birch as the active business (it lands in Acme, if anywhere)', `birch scripts: ${birchRows}`);
  if (r.status === 201) await prisma.script.delete({ where: { id: r.data.id } });
  for (const [what, b] of [
    ['an authorId', body({ authorId: rae.id })], ['a status', body({ status: 'APPROVED' })], ['a content hash', body({ contentSha256: 'a'.repeat(64) })],
    ['a NUL in the content', body({ content: 'Get-Service\u0000' })], ['empty content', body({ content: '' })], ['content over 64 KiB', body({ content: 'a'.repeat(65_537) })],
    ['another language', body({ language: 'bash' })], ['another OS', body({ targetOs: 'linux' })], ['a parameter without a charset', body({ parameters: [{ name: 'X', type: 'string', required: true, maxLength: 5 }] })],
    ['a parameter with a regex', body({ parameters: [{ name: 'X', type: 'string', required: true, charset: 'identifier', maxLength: 5, pattern: '.*' }] })],
  ]) {
    r = await req('POST', '/scripts', { s: S.abe, body: b });
    check(r.status === 400, `refused: ${what}`, msg(r));
  }
  r = await req('POST', '/scripts', { s: S.owen, body: body({ scope: 'global' }) });
  check(r.status === 403, 'a Business Owner cannot write a global script', msg(r));
  check((await prisma.scriptVersion.count()) === before, 'none of those stored anything');

  r = await req('POST', '/scripts', { s: S.abe, body: body() });
  const sA = r.data?.id;
  if (sA) created.scripts.push(sA);
  check(r.status === 201 && r.data.version === 1 && r.data.status === 'DRAFT' && r.data.contentSha256 === sha(SPOOLER), 'Acme\'s author adds a script: version 1, DRAFT, hashed over the exact bytes', msg(r));
  const row = await prisma.script.findUnique({ where: { id: sA }, include: { versions: true } });
  check(row.customerId === acme.id && row.scope === 'BUSINESS' && row.versions[0].authorId === abe.id && JSON.stringify(row.versions[0].contributorIds) === JSON.stringify([abe.id]),
    'stored in Acme, authored by abe, abe its only contributor');
  r = await req('POST', '/scripts', { s: S.owen, body: body() });
  check(r.status === 409 && code(r) === 'NAME_TAKEN', 'a second script with the same name in Acme: NAME_TAKEN', msg(r));
  r = await req('POST', '/scripts', { s: S.bea, body: body() });
  check(r.status === 201, 'the same name in Birch is another business\'s script', msg(r));
  const sB = r.data?.id; if (sB) created.scripts.push(sB);

  section('Business isolation');
  for (const [who, extra] of [['bea', {}], ['bea', { business: acme.id }]]) {
    r = await req('GET', `/scripts/${sA}`, { s: S[who], ...extra });
    check(r.status === 404, `Birch's owner cannot read Acme's script${extra.business ? ' even naming Acme as the active business' : ''} (404, as for a missing one)`, msg(r));
  }
  r = await req('GET', `/scripts/${sA}/versions/1`, { s: S.bea });
  check(r.status === 404, 'nor its version', msg(r));
  r = await req('GET', `/scripts/${sA}/diff?from=1&to=1`, { s: S.bea });
  check(r.status === 404, 'nor a diff of it', msg(r));
  r = await req('POST', `/scripts/${sA}/versions`, { s: S.bea, body: { basedOnVersion: 1, description: 'mine now', risk: 'low', content: 'Get-Date' } });
  check(r.status === 404, 'nor edit it', msg(r));
  r = await req('POST', `/scripts/${sA}/versions/1/review`, { s: await stepUp(S.bea), body: { decision: 'approve', expectedSha256: sha(SPOOLER), note: 'looks fine' } });
  check(r.status === 404, 'nor approve it, with fresh authentication', msg(r));
  r = await req('GET', '/scripts', { s: S.bea });
  check(r.status === 200 && !r.data.scripts.some((x) => x.id === sA) && r.data.scripts.some((x) => x.id === sB), 'Birch\'s list has Birch\'s script and not Acme\'s', msg(r));
  r = await req('GET', '/scripts', { s: S.bea, business: acme.id });
  check(r.status === 200 && !r.data.scripts.some((x) => x.id === sA), 'still not with Acme as the active business');
  r = await req('GET', `/scripts?businessId=${acme.id}`, { s: S.bea });
  check(r.status === 403, 'a businessId query naming Acme is a 403', msg(r));
  r = await req('GET', `/scripts/${sA}`, { s: S.vic });
  check(r.status === 404, 'an Acme user without library rights cannot read it', msg(r));
  r = await req('GET', `/scripts/${sA}`, { s: S.tom });
  check(r.status === 404, 'nor can the named-computer technician', msg(r));
  r = await req('GET', `/scripts/${sA}`, { s: S.tess });
  check(r.status === 200 && r.data.you.canAuthor && r.data.you.canReview, 'the whole-business technician can, and may author and review', msg(r));
  r = await req('GET', `/scripts/${sA}`, { s: S.rita });
  check(r.status === 404, 'an independent reviewer has no business scripts (only global ones)', msg(r));
  r = await req('GET', '/scripts/not-an-id!', { s: S.owen });
  check(r.status === 404, 'a malformed id is a 404', msg(r));

  section('The version, with its static checks');
  r = await req('GET', `/scripts/${sA}/versions/1`, { s: S.rae });
  const v1 = r.data;
  check(r.status === 200 && v1.content === SPOOLER && v1.contentSha256 === sha(SPOOLER) && /^[0-9a-f]{64}$/.test(v1.definitionSha256) && v1.contentBytes === Buffer.byteLength(SPOOLER), 'content, both hashes and the byte count', msg(r));
  check(v1.staticChecks?.findings?.some((f) => f.rule === 'invoke_expression' && f.line === 4 && f.severity === 'danger') && /not thereby safe/.test(v1.staticChecks.disclaimer), 'Invoke-Expression is flagged on line 4, with the disclaimer that no findings is not safe', JSON.stringify(v1.staticChecks));
  check(v1.execution?.available === false && v1.you.canSubmit === false && v1.you.canReview === false, 'not runnable; the reviewer cannot submit, and nothing is in review yet');
  const keysOf = (o) => (o && typeof o === 'object' ? Object.entries(o).flatMap(([k, x]) => [k, ...keysOf(x)]) : []);
  check(!keysOf(r.body).some((k) => /^(run|runs|execute|exec|dispatch|endpoints?|endpointIds|targets|schedule)$/i.test(k)) && Object.keys(v1.you).every((k) => /^(canSubmit|canWithdraw|canReview|cannotReviewBecause|canEdit)$/.test(k)), 'the response offers nothing to run: no run, target or endpoint field, and only review permissions', keysOf(r.body).join(','));

  section('Submit and withdraw: the author only');
  r = await req('POST', `/scripts/${sA}/versions/1/review`, { s: await stepUp(S.rae), body: { decision: 'approve', expectedSha256: sha(SPOOLER), note: 'early' } });
  check(r.status === 409 && code(r) === 'NOT_IN_REVIEW', 'a draft cannot be approved', msg(r));
  r = await req('POST', `/scripts/${sA}/versions/1/submit`, { s: S.owen });
  check(r.status === 403 && code(r) === 'NOT_AUTHOR', 'the owner cannot submit someone else\'s version', msg(r));
  r = await req('POST', `/scripts/${sA}/versions/1/submit`, { s: S.abe });
  check(r.status === 200 && r.data.status === 'IN_REVIEW', 'the author submits it: IN_REVIEW', msg(r));
  r = await req('POST', `/scripts/${sA}/versions/1/submit`, { s: S.abe });
  check(r.status === 409, 'submitting twice: 409', msg(r));
  r = await req('POST', `/scripts/${sA}/versions/1/withdraw`, { s: S.rae });
  check(r.status === 403, 'a reviewer cannot withdraw it', msg(r));
  r = await req('POST', `/scripts/${sA}/versions/1/withdraw`, { s: S.abe });
  check(r.status === 200 && r.data.status === 'DRAFT', 'the author withdraws it: back to DRAFT', msg(r));
  r = await req('POST', `/scripts/${sA}/versions/1/submit`, { s: S.abe });
  check(r.status === 200, 'and submits it again', msg(r));

  section('Review: the right capability, the hash seen, fresh authentication');
  r = await req('POST', `/scripts/${sA}/versions/1/review`, { s: S.abe, body: { decision: 'approve', expectedSha256: sha(SPOOLER), note: 'mine' } });
  check(r.status === 403 && code(r) === 'NOT_A_REVIEWER', 'the author, who lacks Review scripts: NOT_A_REVIEWER', msg(r));
  r = await req('POST', `/scripts/${sA}/versions/1/review`, { s: await stepUp(S.vic), body: { decision: 'approve', expectedSha256: sha(SPOOLER), note: 'sure' } });
  check(r.status === 404, 'a user without library rights: 404', msg(r));
  r = await req('POST', `/scripts/${sA}/versions/1/review`, { s: await stepUp(S.tom), body: { decision: 'approve', expectedSha256: sha(SPOOLER), note: 'sure' } });
  check(r.status === 404, 'the named-computer technician: 404', msg(r));
  r = await req('POST', `/scripts/${sA}/versions/1/review`, { s: S.rae, body: { decision: 'approve', expectedSha256: sha(SPOOLER), note: 'read it, fine' } });
  check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED', 'the reviewer without fresh authentication: STEP_UP_REQUIRED', msg(r));
  const raeF = await stepUp(S.rae);
  r = await req('POST', `/scripts/${sA}/versions/1/review`, { s: raeF, body: { decision: 'approve', expectedSha256: sha('something else'), note: 'read it, fine' } });
  check(r.status === 409 && code(r) === 'HASH_MISMATCH', 'approving a hash other than the version\'s: HASH_MISMATCH', msg(r));
  r = await req('POST', `/scripts/${sA}/versions/1/review`, { s: raeF, body: { decision: 'approve', expectedSha256: sha(SPOOLER), note: 'x' } });
  check(r.status === 400, 'a note is required', msg(r));
  r = await req('POST', `/scripts/${sA}/versions/1/review`, { s: raeF, body: { decision: 'approve', expectedSha256: sha(SPOOLER), note: 'read it, fine', decidedById: owen.id } });
  check(r.status === 400, 'a decider named in the body is refused', msg(r));
  r = await req('POST', `/scripts/${sA}/versions/1/review`, { s: raeF, body: { decision: 'approve', expectedSha256: sha(SPOOLER), note: 'read it, fine' } });
  check(r.status === 200 && r.data.status === 'APPROVED' && r.data.approvedSha256 === sha(SPOOLER), 'the reviewer approves it, fresh, over the hash she saw', msg(r));
  let dbv = await prisma.scriptVersion.findUnique({ where: { scriptId_version: { scriptId: sA, version: 1 } } });
  check(dbv.status === 'APPROVED' && dbv.decidedById === rae.id && dbv.approvedSha256 === dbv.contentSha256 && dbv.decisionNote === 'read it, fine', 'stored: approver, the approved hash equal to the content hash, the note');
  r = await req('POST', `/scripts/${sA}/versions/1/review`, { s: await stepUp(S.owen), body: { decision: 'reject', expectedSha256: sha(SPOOLER), note: 'changed my mind' } });
  check(r.status === 409, 'an approved version is final: rejecting it later is refused', msg(r));
  r = await req('POST', `/scripts/${sA}/versions/1/withdraw`, { s: S.abe });
  check(r.status === 409, 'and it cannot be withdrawn', msg(r));

  section('An edit after approval is a new, unapproved version');
  const edited = SPOOLER.replace('Invoke-Expression "Get-Service $Service"', 'Get-Service $Service');
  r = await req('POST', `/scripts/${sA}/versions`, { s: S.abe, body: { basedOnVersion: 1, description: v1.description, risk: 'medium', parameters: v1.parameters, content: SPOOLER } });
  check(r.status === 409 && code(r) === 'NO_CHANGE', 'an identical "edit" is refused (NO_CHANGE)', msg(r));
  r = await req('POST', `/scripts/${sA}/versions`, { s: S.abe, body: { basedOnVersion: 9, description: 'x y z', risk: 'low', content: edited } });
  check(r.status === 404, 'editing from a version that does not exist: 404', msg(r));
  r = await req('POST', `/scripts/${sA}/versions`, { s: S.rae, body: { basedOnVersion: 1, description: 'no iex', risk: 'low', content: edited } });
  check(r.status === 403, 'a reviewer without Write scripts cannot edit', msg(r));
  r = await req('POST', `/scripts/${sA}/versions`, { s: S.abe, body: { basedOnVersion: 1, description: 'Without Invoke-Expression.', risk: 'low', parameters: v1.parameters, content: edited } });
  check(r.status === 201 && r.data.version === 2 && r.data.status === 'DRAFT' && r.data.contentSha256 === sha(edited), 'the author edits it: version 2, DRAFT, its own hash', msg(r));
  dbv = await prisma.scriptVersion.findUnique({ where: { scriptId_version: { scriptId: sA, version: 1 } } });
  const v2row = await prisma.scriptVersion.findUnique({ where: { scriptId_version: { scriptId: sA, version: 2 } } });
  check(dbv.status === 'APPROVED' && dbv.content === SPOOLER && v2row.basedOnId === dbv.id && JSON.stringify(v2row.contributorIds) === JSON.stringify([abe.id]), 'version 1 is untouched and still approved; version 2 records its base, and (the base being approved) only abe contributed');
  r = await req('GET', `/scripts/${sA}/diff?from=1&to=2`, { s: S.rae });
  check(r.status === 200 && r.data.removed === 1 && r.data.added === 1 && r.data.lines.some((l) => l.op === '-' && /Invoke-Expression/.test(l.text)) && r.data.changed.includes('risk') && r.data.changed.includes('description'), 'the diff shows the removed Invoke-Expression line and the changed risk and description', msg(r));
  r = await req('GET', `/scripts/${sA}/diff?from=1&to=7`, { s: S.rae });
  check(r.status === 404, 'a diff against a missing version: 404', msg(r));
  r = await req('GET', `/scripts/${sA}`, { s: S.owen });
  check(r.status === 200 && r.data.versions.length === 2 && r.data.versions[0].version === 2 && r.data.versions[0].basedOn === 1 && r.data.versions[1].status === 'APPROVED', 'the script lists both versions, newest first, with the base', msg(r));

  section('SAME_PERSON: an author never approves their own content');
  // A Business Owner holds every capability, Review scripts included.
  r = await req('POST', '/scripts', { s: S.owen, body: body({ name: `Owner script ${sfx}`, content: 'Get-Date\n' }) });
  const sO = r.data?.id; if (sO) created.scripts.push(sO);
  await req('POST', `/scripts/${sO}/versions/1/submit`, { s: S.owen });
  const owenF = await stepUp(S.owen);
  r = await req('POST', `/scripts/${sO}/versions/1/review`, { s: owenF, body: { decision: 'approve', expectedSha256: sha('Get-Date\n'), note: 'self' } });
  check(r.status === 403 && code(r) === 'SAME_PERSON', 'a Business Owner who wrote it: SAME_PERSON, with fresh authentication', msg(r));
  r = await req('POST', `/scripts/${sO}/versions/1/review`, { s: owenF, body: { decision: 'reject', expectedSha256: sha('Get-Date\n'), note: 'self' } });
  check(r.status === 403 && code(r) === 'SAME_PERSON', 'nor reject it (withdraw is the author\'s way back)', msg(r));
  r = await req('GET', `/scripts/${sO}/versions/1`, { s: S.owen });
  check(r.data?.you?.canReview === false && /someone else/i.test(r.data?.you?.cannotReviewBecause ?? ''), 'the page tells the author someone else must review it', msg(r));

  // A Platform Admin who wrote an Acme script, acting as admin or in Acme's context.
  r = await req('POST', '/scripts', { s: S.admin1, body: body({ name: `Admin in Acme ${sfx}`, businessId: acme.id, content: 'Get-Process\n' }) });
  const sAd = r.data?.id; if (sAd) created.scripts.push(sAd);
  check(r.status === 201, 'a Platform Admin writes a script for Acme (naming it)', msg(r));
  await req('POST', `/scripts/${sAd}/versions/1/submit`, { s: S.admin1 });
  const admin1F = await stepUp(S.admin1);
  for (const extra of [{}, { business: acme.id }]) {
    r = await req('POST', `/scripts/${sAd}/versions/1/review`, { s: admin1F, ...extra, body: { decision: 'approve', expectedSha256: sha('Get-Process\n'), note: 'admin self' } });
    check(r.status === 403 && code(r) === 'SAME_PERSON', `the same Platform Admin cannot approve it${extra.business ? ' with Acme as the active business' : ''}`, msg(r));
  }

  // A technician's own version, in their technician context.
  r = await req('POST', '/scripts', { s: S.tess, body: body({ name: `Tech script ${sfx}`, content: 'Get-Volume\n' }) });
  const sT = r.data?.id; if (sT) created.scripts.push(sT);
  check(r.status === 201 && (await prisma.script.findUnique({ where: { id: sT } }))?.customerId === acme.id, 'the whole-business technician writes a script, in Acme', msg(r));
  r = await req('POST', '/scripts', { s: S.tom, body: body({ name: `Named tech ${sfx}` }) });
  check(r.status === 403, 'the named-computer technician cannot', msg(r));

  // The laundering trick: tess writes v1, owen makes a trivial edit (v2),
  // tess approves v2 — her own code, approved by her.
  r = await req('POST', `/scripts/${sT}/versions`, { s: S.owen, body: { basedOnVersion: 1, description: 'Starts the print spooler if it is stopped. (typo fixed)', risk: 'medium', parameters: body().parameters, content: 'Get-Volume \n' } });
  check(r.status === 201 && r.data.version === 2, 'the owner makes a one-character edit of the technician\'s draft: version 2', msg(r));
  const t2 = await prisma.scriptVersion.findUnique({ where: { scriptId_version: { scriptId: sT, version: 2 } } });
  check(t2.authorId === owen.id && t2.contributorIds.includes(tess.id) && t2.contributorIds.includes(owen.id), 'version 2\'s contributors are the owner AND the technician (the base was never approved)');
  await req('POST', `/scripts/${sT}/versions/2/submit`, { s: S.owen });
  const tessF = await stepUp(S.tess);
  r = await req('POST', `/scripts/${sT}/versions/2/review`, { s: tessF, body: { decision: 'approve', expectedSha256: t2.contentSha256, note: 'looks good' } });
  check(r.status === 403 && code(r) === 'SAME_PERSON', 'the technician cannot approve the edit of her own code: SAME_PERSON', msg(r));
  r = await req('POST', `/scripts/${sT}/versions/2/review`, { s: await stepUp(S.owen), body: { decision: 'approve', expectedSha256: t2.contentSha256, note: 'looks good' } });
  check(r.status === 403 && code(r) === 'SAME_PERSON', 'nor can the owner who made the edit', msg(r));
  r = await req('POST', `/scripts/${sT}/versions/2/review`, { s: await stepUp(S.olga), body: { decision: 'approve', expectedSha256: t2.contentSha256, note: 'read both versions' } });
  check(r.status === 200 && r.data.status === 'APPROVED', 'a second owner, who wrote none of it, can', msg(r));
  // And the reverse is fine: tess reviewing abe's v2 (she contributed nothing).
  await req('POST', `/scripts/${sA}/versions/2/submit`, { s: S.abe });
  r = await req('POST', `/scripts/${sA}/versions/2/review`, { s: tessF, body: { decision: 'reject', expectedSha256: sha(edited), note: 'needs a log line' } });
  check(r.status === 200 && r.data.status === 'REJECTED', 'the technician rejects abe\'s version 2 (rejecting needs no fresh authentication, but she has it)', msg(r));
  r = await req('POST', `/scripts/${sA}/versions/2/submit`, { s: S.abe });
  check(r.status === 409, 'a rejected version is final: it cannot be resubmitted', msg(r));
  r = await req('POST', `/scripts/${sA}/versions`, { s: S.abe, body: { basedOnVersion: 2, description: 'With a log line.', risk: 'low', content: `${edited}Write-Output "done"\r\n` } });
  const a3 = await prisma.scriptVersion.findUnique({ where: { scriptId_version: { scriptId: sA, version: 3 } } });
  check(r.status === 201 && a3.status === 'DRAFT' && JSON.stringify(a3.contributorIds) === JSON.stringify([abe.id]), 'editing the rejected version makes version 3, a draft; abe is still the only contributor', msg(r));
  await req('POST', `/scripts/${sA}/versions/3/submit`, { s: S.abe });
  r = await req('POST', `/scripts/${sA}/versions/3/review`, { s: S.rae, body: { decision: 'reject', expectedSha256: a3.contentSha256, note: 'not now' } });
  check(r.status === 200 && r.data.status === 'REJECTED', 'rejecting needs no fresh authentication', msg(r));

  section('Global scripts: Platform Admins write them, independent reviewers approve them');
  const GLOBAL = 'Get-WinEvent -LogName System -MaxEvents 5\n';
  r = await req('POST', '/scripts', { s: S.admin1, body: body({ scope: 'global', name: `Global events ${sfx}`, content: GLOBAL, risk: 'low' }) });
  const sG = r.data?.id; if (sG) created.scripts.push(sG);
  check(r.status === 201 && (await prisma.script.findUnique({ where: { id: sG } }))?.customerId === null, 'a Platform Admin writes a global script', msg(r));
  r = await req('POST', '/scripts', { s: S.admin1, body: body({ scope: 'global', businessId: acme.id, name: `Global x ${sfx}` }) });
  check(r.status === 400, 'a global script naming a business is refused', msg(r));
  r = await req('GET', `/scripts/${sG}`, { s: S.owen });
  check(r.status === 404, 'a business cannot see a global script before a version is approved', msg(r));
  r = await req('GET', '/scripts', { s: S.owen });
  check(!r.data.scripts.some((x) => x.id === sG), 'nor list it');
  r = await req('GET', `/scripts/${sG}`, { s: S.rita });
  check(r.status === 200 && r.data.view === 'full' && r.data.you.canReview && !r.data.you.canAuthor, 'the independent reviewer sees it in full, may review, may not author', msg(r));
  await req('POST', `/scripts/${sG}/versions/1/submit`, { s: S.admin1 });
  r = await req('POST', `/scripts/${sG}/versions/1/review`, { s: await stepUp(S.owen), body: { decision: 'approve', expectedSha256: sha(GLOBAL), note: 'owner' } });
  check(r.status === 404, 'a Business Owner cannot approve a global script', msg(r));
  r = await req('POST', `/scripts/${sG}/versions/1/review`, { s: admin1F, body: { decision: 'approve', expectedSha256: sha(GLOBAL), note: 'self' } });
  check(r.status === 403 && code(r) === 'SAME_PERSON', 'its author, a Platform Admin, cannot approve it', msg(r));
  r = await req('POST', `/scripts/${sG}/versions/1/review`, { s: await stepUp(S.rita), body: { decision: 'approve', expectedSha256: sha(GLOBAL), note: 'read it' } });
  check(r.status === 200 && r.data.status === 'APPROVED', 'the independent reviewer approves it', msg(r));
  r = await req('POST', `/scripts/${sG}/versions`, { s: S.admin1, body: { basedOnVersion: 1, description: 'More events.', risk: 'low', content: 'Get-WinEvent -LogName System -MaxEvents 50\n' } });
  check(r.status === 201 && r.data.version === 2, 'the admin edits it: version 2, a draft', msg(r));
  r = await req('POST', `/scripts/${sG}/versions`, { s: S.owen, body: { basedOnVersion: 1, description: 'Mine.', risk: 'low', content: 'Get-Date\n' } });
  check(r.status === 403, 'a Business Owner cannot edit a global script', msg(r));
  r = await req('GET', `/scripts/${sG}`, { s: S.owen });
  check(r.status === 200 && r.data.view === 'approved_only' && r.data.versions.length === 1 && r.data.versions[0].version === 1 && !r.data.you.canAuthor && !r.data.you.canReview, 'Acme\'s owner now sees the approved version only, read-only', msg(r));
  r = await req('GET', `/scripts/${sG}/versions/2`, { s: S.owen });
  check(r.status === 404, 'and not the draft', msg(r));
  r = await req('GET', `/scripts/${sG}/versions/1`, { s: S.abe });
  check(r.status === 200 && r.data.contributors === undefined, 'an Acme author can read the approved global version, without the contributor list', msg(r));
  r = await req('GET', `/scripts/${sG}/versions/1`, { s: S.vic });
  check(r.status === 404, 'but not someone without library rights');

  section('No way to run anything');
  for (const [m, p] of [['POST', `/scripts/${sA}/versions/1/run`], ['POST', `/scripts/${sA}/run`], ['POST', `/scripts/${sA}/versions/1/execute`], ['POST', `/scripts/${sA}/versions/1/dispatch`], ['POST', `/endpoints/${ep.id}/scripts`], ['POST', `/scripts/${sA}/versions/1/approve`]]) {
    r = await req(m, p, { s: admin1F, body: { endpointIds: [ep.id] } });
    check(r.status === 404, `${m} ${p.replace(sA, ':id').replace(ep.id, ':endpoint')} does not exist`, msg(r));
  }
  r = await req('POST', '/endpoints/' + ep.id + '/actions', { s: admin1F, body: { actionId: 'script.run', version: 1, params: { scriptId: sA, version: 1 }, reason: 'run the approved script' } });
  check(r.status === 400 && code(r) === 'ACTION_NOT_IN_CATALOG', 'asking the actions API for a script run: ACTION_NOT_IN_CATALOG', msg(r));
  check((await prisma.actionJob.count()) === actionJobsBefore, 'no action job was created by anything in this suite');

  section('The database refuses what the service would');
  const refused = async (what, fn, re) => { let e = null; try { await fn(); } catch (x) { e = x; } check(!!e && re.test(String(e.message)), what, e ? String(e.message).slice(-200) : 'it was accepted'); };
  const ap = await prisma.scriptVersion.findUnique({ where: { scriptId_version: { scriptId: sA, version: 1 } } });
  await refused('changing an approved version\'s content', () => prisma.scriptVersion.update({ where: { id: ap.id }, data: { content: 'Remove-Item C:\\ -Recurse' } }), /immutable/);
  await refused('changing its content and hash together', () => prisma.scriptVersion.update({ where: { id: ap.id }, data: { content: 'Get-Date', contentSha256: sha('Get-Date'), contentBytes: 8 } }), /immutable/);
  await refused('changing its parameters', () => prisma.scriptVersion.update({ where: { id: ap.id }, data: { parameters: [] } }), /immutable/);
  await refused('changing its risk', () => prisma.scriptVersion.update({ where: { id: ap.id }, data: { risk: 'high' } }), /immutable/);
  await refused('changing its author', () => prisma.scriptVersion.update({ where: { id: ap.id }, data: { authorId: owen.id } }), /immutable/);
  await refused('moving it back to draft', () => prisma.scriptVersion.update({ where: { id: ap.id }, data: { status: 'DRAFT', decidedById: null, decidedAt: null, approvedSha256: null } }), /cannot go from APPROVED to DRAFT/);
  await refused('changing who approved it', () => prisma.scriptVersion.update({ where: { id: ap.id }, data: { decidedById: abe.id } }), /review fields change only with its status/);
  const rej = await prisma.scriptVersion.findUnique({ where: { scriptId_version: { scriptId: sA, version: 2 } } });
  await refused('flipping a rejected version to approved', () => prisma.scriptVersion.update({ where: { id: rej.id }, data: { status: 'APPROVED', approvedSha256: rej.contentSha256 } }), /cannot go from REJECTED to APPROVED/);
  await refused('inserting a version as already approved', () => prisma.scriptVersion.create({ data: { scriptId: sA, version: 50, description: 'planted', language: 'powershell', targetOs: 'windows', risk: 'low', content: 'Get-Date', contentBytes: 8, contentSha256: sha('Get-Date'), definitionSha256: 'b'.repeat(64), authorId: abe.id, contributorIds: [abe.id], status: 'APPROVED', decidedById: rae.id, decidedAt: new Date(), approvedSha256: sha('Get-Date') } }), /written as a draft/);
  await refused('inserting a version whose hash is not its content\'s', () => prisma.scriptVersion.create({ data: { scriptId: sA, version: 51, description: 'planted', language: 'powershell', targetOs: 'windows', risk: 'low', content: 'Remove-Item x', contentBytes: 13, contentSha256: sha('Get-Date'), definitionSha256: 'b'.repeat(64), authorId: abe.id, contributorIds: [abe.id] } }), /does not match its SHA-256/);
  await refused('inserting a version whose author is not a contributor', () => prisma.scriptVersion.create({ data: { scriptId: sA, version: 52, description: 'planted', language: 'powershell', targetOs: 'windows', risk: 'low', content: 'Get-Date', contentBytes: 8, contentSha256: sha('Get-Date'), definitionSha256: 'b'.repeat(64), authorId: abe.id, contributorIds: [] } }), /ScriptVersion_author_contributes/);
  // An in-review version, approved straight in the database by its author.
  await req('POST', `/scripts/${sO}/versions`, { s: S.owen, body: { basedOnVersion: 1, description: 'Starts the print spooler if it is stopped (v2).', risk: 'low', content: 'Get-Date -Format o\n' } });
  await req('POST', `/scripts/${sO}/versions/2/submit`, { s: S.owen });
  const o2 = await prisma.scriptVersion.findUnique({ where: { scriptId_version: { scriptId: sO, version: 2 } } });
  await refused('approving a version by its own author, directly in the database', () => prisma.scriptVersion.update({ where: { id: o2.id }, data: { status: 'APPROVED', decidedById: owen.id, decidedAt: new Date(), approvedSha256: o2.contentSha256 } }), /ScriptVersion_approver_independent/);
  // The owner edits the technician's still-unapproved v1 again (v3): its
  // contributors are the owner and the technician; the technician approves it in the database.
  r = await req('POST', `/scripts/${sT}/versions`, { s: S.owen, body: { basedOnVersion: 1, description: 'Another edit of the technician\'s draft.', risk: 'low', content: 'Get-Volume -DriveLetter C\n' } });
  await req('POST', `/scripts/${sT}/versions/3/submit`, { s: S.owen });
  const t3 = await prisma.scriptVersion.findUnique({ where: { scriptId_version: { scriptId: sT, version: 3 } } });
  check(r.status === 201 && t3.status === 'IN_REVIEW' && t3.contributorIds.includes(tess.id), 'v3, edited by the owner from the technician\'s draft, is in review with both as contributors', msg(r));
  await refused('approving it, in the database, by the technician who contributed to it', () => prisma.scriptVersion.update({ where: { id: t3.id }, data: { status: 'APPROVED', decidedById: tess.id, decidedAt: new Date(), approvedSha256: t3.contentSha256 } }), /ScriptVersion_approver_independent/);
  await refused('changing a decision note without a decision', () => prisma.scriptVersion.update({ where: { id: t2.id }, data: { decisionNote: 'x' } }), /review fields change only with its status/);
  await refused('approving it over a different hash', () => prisma.scriptVersion.update({ where: { id: o2.id }, data: { status: 'APPROVED', decidedById: olga.id, decidedAt: new Date(), approvedSha256: sha('other') } }), /approved over a different hash/);
  await refused('approving it with no approver recorded', () => prisma.scriptVersion.update({ where: { id: o2.id }, data: { status: 'APPROVED', approvedSha256: o2.contentSha256 } }), /ScriptVersion_decided/);
  await refused('moving a script to another business', () => prisma.script.update({ where: { id: sA }, data: { customerId: birch.id } }), /cannot be changed/);
  await refused('renaming a script', () => prisma.script.update({ where: { id: sA }, data: { name: 'Something else' } }), /cannot be changed/);
  await refused('a business script with no business', () => prisma.script.create({ data: { scope: 'BUSINESS', name: `Orphan ${sfx}`, createdById: abe.id } }), /Script_scope_business/);
  await refused('a second global script with the same name', () => prisma.script.create({ data: { scope: 'GLOBAL', name: `Global events ${sfx}`, createdById: admin2.id } }), /Unique constraint|Script_global_name_key/);
  const o2now = await prisma.scriptVersion.findUnique({ where: { id: o2.id } });
  check(o2now.status === 'IN_REVIEW' && o2now.decidedById === null, 'after all that, the version is still in review with no decision');

  section('Audit');
  const audit = await prisma.activityLog.findMany({ where: { resourceId: { in: [sA, ...(await prisma.scriptVersion.findMany({ where: { scriptId: { in: created.scripts } }, select: { id: true } })).map((v) => v.id)] } }, orderBy: { createdAt: 'asc' } });
  const by = (a) => audit.filter((x) => x.action === a);
  check(by('SCRIPT_CREATED').length === 1 && by('SCRIPT_CREATED')[0].customerId === acme.id && by('SCRIPT_CREATED')[0].metadata.contentSha256 === sha(SPOOLER) && by('SCRIPT_CREATED')[0].metadata.findings.includes('invoke_expression'),
    'creation is audited against Acme, with the hash and the static-check findings', JSON.stringify(by('SCRIPT_CREATED')[0]?.metadata));
  const appr = by('SCRIPT_VERSION_APPROVED');
  check(appr.length === 3 && appr.every((a) => a.metadata.approvedSha256 === a.metadata.contentSha256 && a.metadata.authorId && a.actorId !== a.metadata.authorId && a.metadata.freshAuth), 'every approval: approver, author, the approved hash equal to the content hash, and the fresh authentication', JSON.stringify(appr.map((a) => a.metadata)));
  check(by('SCRIPT_VERSION_REJECTED').length === 2 && by('SCRIPT_VERSION_SUBMITTED').length >= 7 && by('SCRIPT_VERSION_WITHDRAWN').length === 1 && by('SCRIPT_VERSION_CREATED').length === 6, 'rejections, submissions, the withdrawal and every new version are audited',
    JSON.stringify(Object.fromEntries(['SCRIPT_VERSION_REJECTED', 'SCRIPT_VERSION_SUBMITTED', 'SCRIPT_VERSION_WITHDRAWN', 'SCRIPT_VERSION_CREATED'].map((k) => [k, by(k).length]))));
  const refusedA = by('SCRIPT_REVIEW_REFUSED');
  check(refusedA.filter((a) => a.metadata.reason === 'same_person').length === 7 && refusedA.filter((a) => a.metadata.reason === 'hash_mismatch').length === 1, 'every refused review is audited, with the reason (7 SAME_PERSON, 1 hash mismatch)',
    JSON.stringify(refusedA.map((a) => a.metadata.reason)));
  check(!audit.some((a) => JSON.stringify(a.metadata).includes('Start-Service')), 'no script content in the audit trail, only hashes');
}

async function cleanup() {
  await stopApi();
  try {
    // Global scripts have no business to cascade from.
    if (created.scripts.length) await prisma.script.deleteMany({ where: { id: { in: created.scripts } } });
    await prisma.technicianAssignment.deleteMany({ where: { customerId: { in: created.businesses } } });
    await prisma.endpoint.deleteMany({ where: { customerId: { in: created.businesses } } });
    await prisma.membership.deleteMany({ where: { customerId: { in: created.businesses } } });
    await prisma.customer.deleteMany({ where: { id: { in: created.businesses } } });
    if (created.users.length) await prisma.user.deleteMany({ where: { id: { in: created.users } } });
  } catch (e) { console.error('cleanup:', e.message); }
  await prisma.$disconnect();
}

all().catch((e) => { fail++; failures.push(`crashed: ${e.stack ?? e}`); console.error(e); if (api) console.error(api.log.slice(-3000)); })
  .finally(async () => {
    await cleanup();
    console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
    if (failures.length) { for (const f of failures) console.log(`  - ${f}`); if (api?.log) console.log(`\n── API output (last 6000 characters)\n${api.log.slice(-6000)}`); process.exit(1); }
    process.exit(0);
  });
