#!/usr/bin/env node
/**
 * End-to-end proof of Admin → Security (0.74, check-security-invariants §84),
 * through the real routes on a scratch API whose host is a fixture:
 *
 *   - every route is Platform Admin only: a Business Owner gets 403, no
 *     session gets 401;
 *   - the posture reads the fixture (an Ubuntu 24.04 host as its service user
 *     saw it) and reports what that host really had: PermitRootLogin yes
 *     behind an unreadable include (unknown, not pass), an unexpected public
 *     UDP port, a pending restart, fail2ban's sshd jail watching sshd.service,
 *     a certificate with under 20 days, no Permissions-Policy, a vulnerable
 *     dependency, NODE_ENV=test and this process's off switches;
 *   - with an empty fixture (nothing readable) no host, network or web check
 *     passes: each is unknown, and the score says so through its coverage;
 *   - every change (ban, unban, never-ban, jail settings, install, OS
 *     upgrade, lockout) asks for a fresh confirmation when its key asks,
 *     refuses bad input before anything runs, refuses banning your own
 *     address, reports a failed command as 502 instead of success, and
 *     leaves a HOST_SECURITY_CHANGED / LOGIN_POLICY_CHANGED audit row with the
 *     outcome;
 *   - tightening the lockout never asks; the stored, never-enforced GeoIP
 *     and IP rules cannot be set and can be cleared;
 *   - under NODE_ENV=test with no fixture, host changes are refused
 *     (HOST_CHANGES_OFF_IN_TEST), so a scratch API cannot touch its host.
 *
 *   cd apps/api && npx nest build
 *   DATABASE_URL=postgresql://…/<name containing scratch or test> node scripts/e2e-host-security.mjs
 *
 * Self-starting: its APIs run from dist/ on HOSTSEC_API_PORT (3991) and the
 * two ports after it. Nothing here runs a host command.
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const DB = process.env.DATABASE_URL ?? '';
const dbName = DB.split('/').pop()?.split('?')[0] ?? '';
if (!/scratch|test/.test(dbName)) { console.error(`Refusing to run against database "${dbName}": name must contain "scratch" or "test".`); process.exit(2); }
const BASE_PORT = Number(process.env.HOSTSEC_API_PORT ?? 3991);
for (const p of [BASE_PORT, BASE_PORT + 1, BASE_PORT + 2]) {
  if ([3000, 3001, 3201, 3202, 4000, 4001, 443].includes(p)) { console.error(`Refusing port ${p}`); process.exit(2); }
}
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'host-security-e2e-password-123';
const FIXTURE = path.join(here, 'fixtures', 'host-security.json');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'rem0te-hostsec-'));
const EMPTY = path.join(tmp, 'empty.json');
writeFileSync(EMPTY, JSON.stringify({ files: {}, commands: {} }));

let pass = 0, fail = 0;
const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;

const baseEnv = {
  ...process.env, NODE_ENV: 'test', DATABASE_URL: DB,
  JWT_SECRET: randomBytes(32).toString('hex'), LAUNCHER_TOKEN_SECRET: randomBytes(32).toString('hex'),
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? randomBytes(32).toString('hex'), TRUSTED_PROXIES: 'loopback', HBBS_PRESENCE_HOST: '127.0.0.2',
  VERSION_FILE: path.resolve(here, '..', '..', '..', 'version.json'), FRONTEND_URL: 'https://remote.example.com',
  GEOIP_DB_PATH: path.join(here, 'no-geoip.mmdb'), INTEGRATION_PEERS_FILE: '', UPDATE_REPO_DIR: '', APPROVAL_SIGNER_INTERNAL_URL: '',
  MONITOR_SWEEP: 'off', AUDIT_SEALER: 'off', CLIENT_UPDATE_SWEEP: 'off', SNAPSHOT_SWEEP: 'off', PATCH_POLICY_SWEEP: 'off', METRIC_SWEEP: 'off',
  AUTO_MIGRATION_SWEEP: 'off', TRAY_SWEEP: 'off', RETENTION_SWEEP: 'off', CHAT_RETENTION_SWEEP: 'off', STALE_SWEEP: 'off', AGENT_AUTO_UPDATE: 'off',
  REPORT_SCHEDULE_SWEEP: 'off', SCRIPT_OUTPUT_SWEEP: 'off', WINGET_INDEX_SWEEP: 'off', WARRANTY_SWEEP: 'off',
};
delete baseEnv.PUBLIC_API_URL;
delete baseEnv.SECURITY_HOST_FIXTURE;

const apis = [];
async function startApi(port, extra) {
  const env = { ...baseEnv, PORT: String(port), ...extra };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  const p = spawn(process.execPath, [path.join(dist, 'main.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  p.log = ''; p.stdout.on('data', (d) => { p.log += d; }); p.stderr.on('data', (d) => { p.log += d; });
  apis.push(p);
  for (let i = 0; i < 150; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/api/v1/health`); if (r.status < 500) return p; } catch { /* not yet */ } await sleep(300); }
  throw new Error(`api did not come up:\n${p.log.slice(-3000)}`);
}
async function stopApi(p) { if (!p || p.exitCode !== null || p.signalCode !== null) return; await new Promise((r) => { p.once('exit', r); p.kill('SIGTERM'); }); }

function client(port) {
  const API = `http://127.0.0.1:${port}/api/v1`;
  const req = async (method, p, { s, body, from } = {}) => {
    await sleep(40);
    const h = { 'content-type': 'application/json', 'x-forwarded-for': from ?? rip() };
    if (s) h.cookie = s.cookie + (s.stepUp ? `; step_up=${s.stepUp}` : '');
    const r = await fetch(`${API}${p}`, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = text; }
    return { status: r.status, body: j, data: j?.data, setCookie: r.headers.get('set-cookie') ?? '' };
  };
  const login = async (email, from) => {
    const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': from ?? rip() }, body: JSON.stringify({ email, password: PW }) });
    const m = (r.headers.get('set-cookie') ?? '').match(/access_token=([^;]+)/);
    if (r.status !== 200 || !m) throw new Error(`login ${email}: ${r.status} ${await r.text()}`);
    return { cookie: `access_token=${m[1]}` };
  };
  const stepUp = async (s) => {
    const r = await req('POST', '/auth/step-up', { s, body: { password: PW } });
    const m = r.setCookie.match(/step_up=([^;]+)/);
    if (r.status !== 200 || !m) throw new Error(`step-up: ${r.status} ${JSON.stringify(r.body)}`);
    return { ...s, stepUp: m[1] };
  };
  return { req, login, stepUp };
}
const code = (r) => r.body?.code ?? r.body?.message?.code ?? r.body?.error?.code;
const msg = (r) => `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 400)}`;

const created = { businesses: [], users: [] };
let savedConfig = null;
let savedAsk = [];
const KEYS = ['server.security', 'login.lockout'];

const READS = ['/admin/security/posture', '/admin/security/config', '/admin/security/fail2ban', '/admin/security/fail2ban/ignore',
  '/admin/security/fail2ban/jail/sshd/config', '/admin/security/os-updates', '/admin/security/os-updates/status', '/admin/security/audit', '/admin/security/tls'];
const WRITES = [['POST', '/admin/security/fail2ban/ban', { jail: 'sshd', ip: '192.0.2.50' }], ['POST', '/admin/security/fail2ban/unban', { jail: 'sshd', ip: '192.0.2.50' }],
  ['POST', '/admin/security/fail2ban/ignore', { ip: '192.0.2.0/24' }], ['DELETE', '/admin/security/fail2ban/ignore/192.0.2.1', undefined],
  ['PATCH', '/admin/security/fail2ban/jail/sshd/config', { bantime: 3600 }], ['POST', '/admin/security/fail2ban/install', undefined],
  ['POST', '/admin/security/os-updates/run', undefined], ['PATCH', '/admin/security/config', { maxLoginAttempts: 5 }]];

async function audits(actorId, since) {
  return prisma.activityLog.findMany({ where: { actorId, action: { in: ['HOST_SECURITY_CHANGED', 'LOGIN_POLICY_CHANGED'] }, createdAt: { gte: since } }, orderBy: { seq: 'asc' } });
}

async function all() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });

  section('Fixtures (synthetic): a Platform Admin, a Business Owner; the confirmations for this page set to ask');
  const biz = await prisma.customer.create({ data: { tenantId: tenant.id, name: `HostSec ${sfx}` } });
  created.businesses.push(biz.id);
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag, extra = {}) => { const u = await prisma.user.create({ data: { email: `hs-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'Hs', lastName: tag, status: 'ACTIVE', ...extra } }); created.users.push(u.id); return u; };
  const admin = await mkUser('admin', { isPlatformAdmin: true });
  const owner = await mkUser('owner');
  await prisma.membership.create({ data: { userId: owner.id, tenantId: tenant.id, customerId: biz.id, roleId: roleOwner.id } });
  savedConfig = await prisma.platformSecurityConfig.findFirst();
  if (savedConfig) await prisma.platformSecurityConfig.update({ where: { id: savedConfig.id }, data: { maxLoginAttempts: 5, lockoutMinutes: 15, geoipBlockEnabled: true, blockedCountries: ['ZZ'] } });
  else await prisma.platformSecurityConfig.create({ data: { maxLoginAttempts: 5, lockoutMinutes: 15, geoipBlockEnabled: true, blockedCountries: ['ZZ'] } });
  savedAsk = await prisma.confirmPolicy.findMany({ where: { key: { in: KEYS } } });
  for (const key of KEYS) await prisma.confirmPolicy.upsert({ where: { key }, create: { key, value: 'ask' }, update: { value: 'ask' } });
  check(true, 'fixtures written');

  // ── 1. The fixture host ───────────────────────────────────────────────────
  section(`API 1 (port ${BASE_PORT}): the host is the fixture`);
  const api1 = await startApi(BASE_PORT, { SECURITY_HOST_FIXTURE: FIXTURE });
  const c = client(BASE_PORT);
  const since = new Date();

  section('Platform Admin only');
  for (const p of READS) { const r = await c.req('GET', p); check(r.status === 401, `no session: GET ${p} is 401`, msg(r)); }
  const so = await c.login(owner.email);
  for (const p of READS) { const r = await c.req('GET', p, { s: so }); check(r.status === 403, `Business Owner: GET ${p} is 403`, msg(r)); }
  for (const [m, p, b] of WRITES) { const r = await c.req(m, p, { s: so, body: b }); check(r.status === 403 && code(r) !== 'STEP_UP_REQUIRED', `Business Owner: ${m} ${p} is 403 (before any step-up)`, msg(r)); }
  check((await audits(owner.id, since)).length === 0, 'nothing the Business Owner tried was recorded as a change');

  const sa = await c.login(admin.email, '198.51.100.20');
  section('The posture reads what the host had');
  const po = await c.req('GET', '/admin/security/posture', { s: sa });
  check(po.status === 200 && Array.isArray(po.data?.findings), 'GET posture', msg(po));
  const F = Object.fromEntries((po.data?.findings ?? []).map((f) => [f.id, f]));
  const st = (id) => F[id]?.status;
  check(po.data.findings.every((f) => f.id && f.area && f.title && f.status && f.severity && typeof f.evidence === 'string' && !Number.isNaN(Date.parse(f.checkedAt))), 'every finding has an id, area, status, severity, evidence and a time it was read');
  check(st('host.ssh.root_login') === 'unknown' && /PermitRootLogin yes|permitrootlogin yes/i.test(F['host.ssh.root_login'].evidence) && /50-cloud-init/.test(F['host.ssh.root_login'].evidence),
    'SSH root login: "yes" behind an unreadable include is unknown, never pass, and says why', JSON.stringify(F['host.ssh.root_login']));
  check(st('host.ssh.x11') === undefined || st('host.ssh.x11') === 'unknown', 'SSH X11: uncertain, so not decided', JSON.stringify(F['host.ssh.x11']));
  check(st('host.firewall') === 'pass' && /sudo ufw status/.test(F['host.firewall'].evidence), 'firewall: ufw enabled and active, and it says the rules need root', JSON.stringify(F['host.firewall']));
  check(st('network.listeners') === 'fail' && /udp\/33344/.test(F['network.listeners'].evidence), 'listeners: the unexpected public UDP port is a finding', JSON.stringify(F['network.listeners']));
  check(st('host.updates.security') === 'pass' && st('host.updates.other') === 'fail', 'updates: eleven pending, none security', JSON.stringify([F['host.updates.security'], F['host.updates.other']]));
  check(st('host.reboot') === 'fail' && /linux-image-6\.8\.0-151-generic/.test(F['host.reboot'].evidence), 'a pending restart, with the packages asking', JSON.stringify(F['host.reboot']));
  check(st('host.updates.unattended') === 'pass', 'unattended upgrades on', JSON.stringify(F['host.updates.unattended']));
  check(st('host.fail2ban') === 'pass' && st('host.fail2ban.sshd_unit') === 'fail' && /ssh\.service/.test(F['host.fail2ban.sshd_unit'].fix), "fail2ban runs, and its sshd jail watching sshd.service is a finding", JSON.stringify(F['host.fail2ban.sshd_unit']));
  check(st('web.tls.remote.example.com') === 'pass' && st('web.tls.approve.example.com') === 'fail', 'TLS: one good certificate, one with under 20 days (renewal failing)', JSON.stringify([F['web.tls.remote.example.com'], F['web.tls.approve.example.com']]));
  check(st('web.header.hsts') === 'pass' && st('web.header.permissions') === 'fail' && st('web.http_redirect') === 'pass', 'headers: HSTS good, no Permissions-Policy, plain HTTP redirects', JSON.stringify([F['web.header.permissions'], F['web.http_redirect']]));
  check(st('deps.npm') === 'fail' && /1 high/.test(F['deps.npm'].evidence) && /never `npm audit fix` on the server/.test(F['deps.npm'].fix), 'dependencies: the fixture high advisory, and the fix is a deploy, not npm audit fix', JSON.stringify(F['deps.npm']));
  check(st('process.node_env') === 'fail' && F['process.node_env'].severity === 'critical', 'NODE_ENV=test is a critical finding');
  check(st('process.switch.STALE_SWEEP') === 'fail' && F['process.switch.STALE_SWEEP'].severity === 'critical' && st('process.switch.AUDIT_SEALER') === 'fail', "this process's off switches are findings", JSON.stringify(F['process.switch.STALE_SWEEP']));
  check(st('portal.mfa.admins') === 'fail' && F['portal.mfa.admins'].evidence.includes(admin.email), 'a Platform Admin without MFA is named', JSON.stringify(F['portal.mfa.admins']));
  check(st('portal.unenforced_rules') === 'fail', 'a stored, never-enforced GeoIP rule is a finding');
  check(st('portal.release_root_keys') === 'unknown', 'signing root keys: unknown (the portal cannot read the key directory)');
  check(st('portal.approval_signer') === 'info' && st('portal.signed_releases') === 'info', 'no signer and no signed repository are information, not passes');
  check(['pass', 'fail', 'unknown'].includes(st('portal.audit_chain')), 'the audit chain finding reuses the chain verifier', JSON.stringify(F['portal.audit_chain']));
  const sum = po.data.summary;
  check(typeof sum.score === 'number' && sum.grade === 'poor' && sum.coverage < 100 && sum.counts.unknown > 0, 'summary: a number, poor (a critical fails), and coverage below 100 with unknowns', JSON.stringify(sum));
  const order = po.data.findings.map((f) => f.status);
  check(order.indexOf('pass') > order.lastIndexOf('fail') || !order.includes('pass'), 'failures are listed first');
  check(!JSON.stringify(po.body).includes('rem0te-release') && !JSON.stringify(po.body).includes('rem0te-signed'), 'the API names no release-host path or command (§56)');

  section('fail2ban, OS updates, TLS and dependencies read the fixture');
  const fb = await c.req('GET', '/admin/security/fail2ban', { s: sa });
  const sshd = fb.data?.jails?.find((j) => j.jail === 'sshd');
  check(fb.data?.state === 'running' && sshd?.currentBanned === 2 && sshd?.totalFailed === 118 && sshd.bannedIps.includes('198.51.100.7'), 'fail2ban: running, sshd jail counts', msg(fb));
  const ig = await c.req('GET', '/admin/security/fail2ban/ignore', { s: sa });
  check(ig.status === 200 && ig.data.ips.includes('127.0.0.0/8') && ig.data.ips.includes('::1'), 'never-ban list merged across jails', msg(ig));
  const jc = await c.req('GET', '/admin/security/fail2ban/jail/sshd/config', { s: sa });
  check(jc.status === 200 && jc.data.bantime === 600 && jc.data.maxretry === 5, 'jail settings are numbers', msg(jc));
  const jx = await c.req('GET', '/admin/security/fail2ban/jail/nosuch/config', { s: sa });
  check(jx.status === 503 && code(jx) === 'FAIL2BAN_UNAVAILABLE', 'an unreadable jail is 503, not empty settings', msg(jx));
  const jb = await c.req('GET', '/admin/security/fail2ban/jail/a%20b/config', { s: sa });
  check(jb.status === 400, 'a jail name outside the charset is 400', msg(jb));
  const ou = await c.req('GET', '/admin/security/os-updates', { s: sa });
  check(ou.data?.state === 'ok' && ou.data.total === 11 && ou.data.security === 0 && ou.data.rebootRequired === true && ou.data.listsUpdatedAt, 'OS updates: counts, restart and list age', msg(ou));
  const tl = await c.req('GET', '/admin/security/tls', { s: sa });
  check(tl.data?.caddyActive === true && tl.data.certs.length === 2 && tl.data.certs.every((x) => x.daysLeft !== null && x.issuer), 'TLS: both sites, with days and issuer', msg(tl));
  const dp = await c.req('GET', '/admin/security/audit', { s: sa });
  check(dp.data?.state === 'ok' && dp.data.audit.counts.high === 1 && dp.data.audit.packages[0].name === 'example-lib', 'dependency audit: the production report', msg(dp));
  for (const gone of [['POST', '/admin/security/audit/fix'], ['POST', '/admin/security/tls/renew']]) {
    const r = await c.req(gone[0], gone[1], { s: sa, body: {} });
    check(r.status === 404, `${gone.join(' ')} is gone (404)`, msg(r));
  }

  section('Changes ask for a fresh confirmation, validate first, and are audited with the outcome');
  for (const [m, p, b] of WRITES.filter(([, p]) => !p.endsWith('/config') || p.includes('jail'))) {
    const r = await c.req(m, p, { s: sa, body: b });
    check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED' && r.body?.action === 'server.security', `${m} ${p} asks (server.security)`, msg(r));
  }
  check((await audits(admin.id, since)).length === 0, 'nothing ran or was recorded before the confirmation');
  const sf = await c.stepUp(sa);
  const bad = await c.req('POST', '/admin/security/fail2ban/ban', { s: sf, body: { jail: 'sshd', ip: "1.2.3.4 actionban 'id'" } });
  check(bad.status === 400 && code(bad) === 'INVALID_INPUT', 'a ban with a shell-looking address is 400', msg(bad));
  const extra = await c.req('POST', '/admin/security/fail2ban/ban', { s: sf, body: { jail: 'sshd', ip: '192.0.2.50', action: 'x' } });
  check(extra.status === 400, 'an unknown field is refused', msg(extra));
  const self = await c.req('POST', '/admin/security/fail2ban/ban', { s: sf, body: { jail: 'sshd', ip: '198.51.100.20' }, from: '198.51.100.20' });
  check(self.status === 409 && code(self) === 'BAN_SELF', 'banning the address you are connected from is refused', msg(self));
  const ban = await c.req('POST', '/admin/security/fail2ban/ban', { s: sf, body: { jail: 'sshd', ip: '192.0.2.50' } });
  check(ban.status === 200 && ban.data.persistent === false, 'a ban runs, and says it lasts until fail2ban restarts', msg(ban));
  const banFail = await c.req('POST', '/admin/security/fail2ban/ban', { s: sf, body: { jail: 'sshd', ip: '192.0.2.66' } });
  check(banFail.status === 502 && code(banFail) === 'HOST_COMMAND_FAILED' && /refused/.test(JSON.stringify(banFail.body)), 'a ban the wrapper refuses is 502 with its message, not success', msg(banFail));
  const unban = await c.req('POST', '/admin/security/fail2ban/unban', { s: sf, body: { jail: 'sshd', ip: '192.0.2.50' } });
  check(unban.status === 200, 'unban', msg(unban));
  const addIg = await c.req('POST', '/admin/security/fail2ban/ignore', { s: sf, body: { ip: '192.0.2.0/24' } });
  check(addIg.status === 200 && addIg.data.jails.length === 2, 'never-ban added to every jail', msg(addIg));
  const delIg = await c.req('DELETE', `/admin/security/fail2ban/ignore/${encodeURIComponent('192.0.2.0/24')}`, { s: sf });
  check(delIg.status === 200, 'never-ban removed', msg(delIg));
  const jbad = await c.req('PATCH', '/admin/security/fail2ban/jail/sshd/config', { s: sf, body: { bantime: 5 } });
  check(jbad.status === 400, 'a ban time under a minute is refused', msg(jbad));
  const jset = await c.req('PATCH', '/admin/security/fail2ban/jail/sshd/config', { s: sf, body: { bantime: 3600, maxretry: 4 } });
  check(jset.status === 200 && jset.data.persistent === false, 'jail settings applied (until fail2ban restarts)', msg(jset));
  const inst = await c.req('POST', '/admin/security/fail2ban/install', { s: sf });
  check(inst.status === 200 && inst.data.steps.map((x) => x.step).join() === 'install,enable,start', 'install runs its three granted steps in order', msg(inst));
  const run = await c.req('POST', '/admin/security/os-updates/run', { s: sf });
  check(run.status === 200 && run.data.running === true, 'an OS update starts', msg(run));
  let job = null;
  for (let i = 0; i < 50; i++) { const s2 = await c.req('GET', '/admin/security/os-updates/status', { s: sa }); job = s2.data; if (job && !job.running) break; await sleep(200); }
  check(job && !job.running && job.exitCode === 0 && job.phase === 'apt-get upgrade', 'the update ran apt-get update, then apt-get upgrade', JSON.stringify(job));
  const rows = await audits(admin.id, since);
  const ops = rows.filter((r) => r.action === 'HOST_SECURITY_CHANGED').map((r) => `${r.metadata.op}${r.metadata.phase ? `:${r.metadata.phase}` : ''}:${r.metadata.ok ?? ''}`);
  check(JSON.stringify(ops) === JSON.stringify(['fail2ban.ban:true', 'fail2ban.ban:false', 'fail2ban.unban:true', 'fail2ban.ignore.add:', 'fail2ban.ignore.remove:', 'fail2ban.jail.set:true', 'fail2ban.install:true', 'os.upgrade:started:', 'os.upgrade:finished:true']),
    'one audit row per change, in order, with the outcome (the refused ban recorded as ok:false)', JSON.stringify(ops));
  const failedRow = rows.find((r) => r.metadata.op === 'fail2ban.ban' && r.metadata.ok === false);
  check(failedRow?.metadata.address === '192.0.2.66' && /refused/.test(failedRow.metadata.error), 'the failed ban names its address and error', JSON.stringify(failedRow?.metadata));
  check(rows.every((r) => r.actorIp && r.resource === 'server_security'), 'each row carries the actor and the address they came from');

  section('The lockout: weakening asks, tightening does not; the unenforced rules can only be cleared');
  const weak = await c.req('PATCH', '/admin/security/config', { s: sa, body: { maxLoginAttempts: 10 } });
  check(weak.status === 403 && code(weak) === 'STEP_UP_REQUIRED' && weak.body?.action === 'login.lockout', 'more attempts asks (login.lockout)', msg(weak));
  const off = await c.req('PATCH', '/admin/security/config', { s: sa, body: { maxLoginAttempts: 0 } });
  check(off.status === 403 && code(off) === 'STEP_UP_REQUIRED', 'turning the lockout off asks', msg(off));
  const weakOk = await c.req('PATCH', '/admin/security/config', { s: sf, body: { maxLoginAttempts: 10 } });
  check(weakOk.status === 200 && weakOk.data.maxLoginAttempts === 10, 'with a fresh confirmation it saves', msg(weakOk));
  const tight = await c.req('PATCH', '/admin/security/config', { s: sa, body: { maxLoginAttempts: 5, lockoutMinutes: 30 } });
  check(tight.status === 200 && tight.data.maxLoginAttempts === 5 && tight.data.lockoutMinutes === 30, 'tightening needs no confirmation', msg(tight));
  const geo = await c.req('PATCH', '/admin/security/config', { s: sf, body: { geoipBlockEnabled: true } });
  check(geo.status === 400, 'GeoIP blocking cannot be switched on (nothing enforces it)', msg(geo));
  const clr = await c.req('PATCH', '/admin/security/config', { s: sa, body: { clearUnenforced: true } });
  check(clr.status === 200 && clr.data.unenforced.geoipBlockEnabled === false && clr.data.unenforced.blockedCountries.length === 0, 'the stored GeoIP rule is cleared', msg(clr));
  const lp = (await audits(admin.id, since)).filter((r) => r.action === 'LOGIN_POLICY_CHANGED');
  check(lp.length === 3 && lp[0].metadata.before.maxLoginAttempts === 5 && lp[0].metadata.after.maxLoginAttempts === 10 && lp[2].metadata.clearedUnenforced === true, 'LOGIN_POLICY_CHANGED before and after, three times', JSON.stringify(lp.map((r) => r.metadata)));
  const po2 = await c.req('GET', '/admin/security/posture?refresh=1', { s: sa });
  check(!po2.data.findings.some((f) => f.id === 'portal.unenforced_rules'), 'the unenforced-rules finding is gone after clearing');
  await stopApi(api1);

  // ── 2. Nothing readable ───────────────────────────────────────────────────
  section(`API 2 (port ${BASE_PORT + 1}): a host where nothing can be read`);
  const api2 = await startApi(BASE_PORT + 1, { SECURITY_HOST_FIXTURE: EMPTY, FRONTEND_URL: 'https://remote.example.com' });
  const c2 = client(BASE_PORT + 1);
  const s2 = await c2.login(admin.email);
  const pe = await c2.req('GET', '/admin/security/posture', { s: s2 });
  const hostish = (pe.data?.findings ?? []).filter((f) => ['host', 'network', 'web'].includes(f.area));
  check(pe.status === 200 && hostish.length >= 6, 'posture still answers', msg(pe));
  // web.public_https is decided from this API's own setting (FRONTEND_URL), not from the host.
  const passing = hostish.filter((f) => f.status === 'pass' && f.id !== 'web.public_https');
  check(passing.length === 0, 'no host, network or web check passes when its source is unreadable', JSON.stringify(passing.map((f) => f.id)));
  check(hostish.filter((f) => f.id !== 'web.public_https').every((f) => f.status === 'unknown'), 'each of them is unknown', JSON.stringify(hostish.filter((f) => f.status !== 'unknown').map((f) => `${f.id}:${f.status}`)));
  check(pe.data.summary.coverage < 100 && pe.data.summary.counts.unknown >= hostish.length - 1, 'the summary counts them as unknown and its coverage drops', JSON.stringify(pe.data.summary));
  const f2 = await c2.req('GET', '/admin/security/fail2ban', { s: s2 });
  check(f2.data?.state === 'unavailable' && /wrapper is not installed/.test(f2.data.reason), 'fail2ban: unavailable with the reason, not "stopped"', msg(f2));
  const o2 = await c2.req('GET', '/admin/security/os-updates', { s: s2 });
  check(o2.data?.state === 'unavailable' && o2.data.total === null, 'OS updates: unavailable, total null (never "up to date")', msg(o2));
  const d2 = await c2.req('GET', '/admin/security/audit', { s: s2 });
  check(d2.data?.state === 'unavailable' && /package-lock\.json/.test(d2.data.reason), 'dependency audit: unavailable with the reason', msg(d2));
  const t2 = await c2.req('GET', '/admin/security/tls', { s: s2 });
  check(t2.data?.caddyActive === null && t2.data.certs.length === 0 && t2.data.caddyfileReadable === false, 'TLS: Caddy state unknown, no certificates, Caddyfile unreadable', msg(t2));
  await stopApi(api2);

  // ── 3. A test process without a fixture changes nothing ───────────────────
  section(`API 3 (port ${BASE_PORT + 2}): NODE_ENV=test without a fixture`);
  const api3 = await startApi(BASE_PORT + 2, {});
  const c3 = client(BASE_PORT + 2);
  const s3 = await c3.stepUp(await c3.login(admin.email));
  for (const [m, p, b] of [['POST', '/admin/security/fail2ban/ban', { jail: 'sshd', ip: '192.0.2.50' }], ['POST', '/admin/security/fail2ban/install', undefined], ['POST', '/admin/security/os-updates/run', undefined]]) {
    const r = await c3.req(m, p, { s: s3, body: b });
    check(r.status === 503 && code(r) === 'HOST_CHANGES_OFF_IN_TEST', `${m} ${p} is refused: a test process changes nothing on its host`, msg(r));
  }
  await stopApi(api3);
}

async function cleanup() {
  for (const p of apis) await stopApi(p);
  try {
    if (savedConfig) await prisma.platformSecurityConfig.update({ where: { id: savedConfig.id }, data: {
      maxLoginAttempts: savedConfig.maxLoginAttempts, lockoutMinutes: savedConfig.lockoutMinutes, geoipBlockEnabled: savedConfig.geoipBlockEnabled,
      ipAllowlistEnabled: savedConfig.ipAllowlistEnabled, blockedCountries: savedConfig.blockedCountries, blockedIpRanges: savedConfig.blockedIpRanges, allowedIpRanges: savedConfig.allowedIpRanges } });
    else await prisma.platformSecurityConfig.deleteMany({});
    await prisma.confirmPolicy.deleteMany({ where: { key: { in: KEYS } } });
    for (const r of savedAsk) await prisma.confirmPolicy.create({ data: r }).catch(() => undefined);
    await prisma.membership.deleteMany({ where: { customerId: { in: created.businesses } } });
    await prisma.customer.deleteMany({ where: { id: { in: created.businesses } } }).catch((e) => console.error('businesses:', e.message.slice(0, 200)));
    await prisma.activityLog.updateMany({ where: { actorId: { in: created.users } }, data: { actorId: null } }).catch(() => undefined);
    if (created.users.length) await prisma.user.deleteMany({ where: { id: { in: created.users } } }).catch((e) => console.error('users:', e.message.slice(0, 200)));
  } catch (e) { console.error('cleanup:', e.message); }
  await prisma.$disconnect();
}

all().catch((e) => { fail++; failures.push(`crashed: ${e.stack ?? e}`); console.error(e); })
  .finally(async () => {
    const logs = apis.map((p) => p.log).join('\n');
    await cleanup();
    console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
    if (failures.length) { for (const f of failures) console.log(`  - ${f}`); console.log(`\n── API output (last 4000 characters)\n${logs.slice(-4000)}`); process.exit(1); }
    process.exit(0);
  });
