#!/usr/bin/env node
/**
 * End-to-end proof of the standard Linux agent (0.32), with the real generated
 * script running against a real API and database:
 *
 *   - the Linux installer embeds the agent, a systemd timer (3 minutes), a
 *     0600 device secret and an --uninstall path that removes all of it;
 *   - the agent heartbeats with the secret bound at claim (the Windows claim
 *     flow, unchanged) and its inventory and pending updates land;
 *   - a wrong, missing or world-readable secret is refused, by the server or
 *     by the agent before it sends anything;
 *   - one business's agent cannot write into, or read, another's computer;
 *   - hostile device strings (os-release, hostname, who, df, DMI, package
 *     names) arrive reduced and clamped, and are never evaluated;
 *   - it is read-only: a staged rotation, reinstall, client update or event
 *     log query is not acted on, and the console refuses to stage them;
 *   - "unknown" when there is no apt, dnf or zypper, and no re-asking every
 *     heartbeat after that; dnf and zypper output parsed from stubs.
 *
 *   cd apps/api && npx nest build
 *   DATABASE_URL=postgresql://…/<name containing scratch or test> node scripts/e2e-linux-agent.mjs
 *
 * Sandboxed: the agent runs as this user, from a temp directory, with its
 * config, secret, RustDesk config, os-release and DMI files there (the
 * REM0TE_* overrides) and TMPDIR pointing there. Nothing is installed and
 * nothing outside the temp directory is written. It does read this host's
 * /proc, df, who and `apt list --upgradable`, which is the point of the
 * first run: real Linux, not stubs. INTEGRATION + real Linux userland — not
 * an installed endpoint (no systemd unit, no root, no RustDesk).
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { spawn, execFileSync } from 'node:child_process';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const DB = process.env.DATABASE_URL ?? '';
const dbName = DB.split('/').pop()?.split('?')[0] ?? '';
if (!/scratch|test/.test(dbName)) { console.error(`Refusing to run against database "${dbName}": name must contain "scratch" or "test".`); process.exit(2); }
const PORT = Number(process.env.LINUX_API_PORT ?? 3241);
if ([3000, 3001, 4000, 4001, 443].includes(PORT)) { console.error(`Refusing port ${PORT}`); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const ENC_KEY = process.env.ENCRYPTION_KEY ?? randomBytes(32).toString('hex');
const VERSION = JSON.parse(fs.readFileSync(path.resolve(here, '..', '..', '..', 'version.json'), 'utf8')).version;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'linux-agent-e2e-password-123';
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'rem0te-linux-e2e-'));

let pass = 0, fail = 0;
const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const rid = () => String(100000000 + ((Math.random() * 899999999) | 0));
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/;

const apiEnv = {
  ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATABASE_URL: DB,
  JWT_SECRET: randomBytes(32).toString('hex'), LAUNCHER_TOKEN_SECRET: randomBytes(32).toString('hex'),
  ENCRYPTION_KEY: ENC_KEY, TRUSTED_PROXIES: 'loopback', HBBS_PRESENCE_HOST: '127.0.0.2',
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
async function req(method, p, { s, body, raw } = {}) {
  const h = { 'content-type': 'application/json', 'x-forwarded-for': s?.ip ?? ip() };
  if (s) h.cookie = s.cookie;
  const r = await fetch(`${API}${p}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j, data: j?.data, text: raw ? text : undefined };
}
async function login(email) {
  const s = { ip: ip() };
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': s.ip }, body: JSON.stringify({ email, password: PW }) });
  const mm = (r.headers.get('set-cookie') ?? '').match(/access_token=([^;]+)/);
  if (r.status !== 200 || !mm) throw new Error(`login ${email}: ${r.status} ${await r.text()}`);
  s.cookie = `access_token=${mm[1]}`;
  return s;
}
const code = (r) => r.body?.code ?? r.body?.message?.code ?? r.body?.error?.code;
const msg = (r) => `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 400)}`;
const encryptPassword = (text) => {
  const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', Buffer.from(ENC_KEY, 'hex'), iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return `${iv.toString('hex')}:${c.getAuthTag().toString('hex')}:${enc.toString('hex')}`;
};

// ── The sandbox ─────────────────────────────────────────────────────────────
// Tools the agent uses. A "minimal" PATH holds links to these only, so the
// absence of a package manager is real rather than simulated by a flag.
const TOOLS = ['sh', 'curl', 'sed', 'grep', 'awk', 'tr', 'cut', 'head', 'cat', 'wc', 'stat', 'mktemp', 'rm', 'sleep', 'date', 'uname', 'df', 'readlink', 'nproc', 'hostname'];
const which = (t) => { try { return execFileSync('sh', ['-c', `command -v ${t}`], { encoding: 'utf8' }).trim(); } catch { return ''; } };
const MARK_CMDS = ['rustdesk', 'systemctl', 'apt-get', 'reboot', 'shutdown', 'dpkg', 'yum', 'rpm-ostree', 'bash', 'python3', 'wget'];

function sandbox(name, { secret, rid: rustdeskId }) {
  const dir = path.join(ROOT, name);
  for (const d of ['', 'bin', 'min', 'tmp', 'dmi']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  const markers = path.join(dir, 'markers.log');
  const write = (f, s, mode = 0o600) => { fs.writeFileSync(path.join(dir, f), s); fs.chmodSync(path.join(dir, f), mode); };
  write('agent.conf', `API_BASE=${API}\n`, 0o644);
  write('secret', secret);
  write('RustDesk.toml', `id = '${rustdeskId}'\nenc_id = ''\n`);
  // Marker stubs, first on PATH in every mode: if the agent ever runs one of
  // these, the run is caught writing to markers.log.
  for (const c of MARK_CMDS) {
    fs.writeFileSync(path.join(dir, 'bin', c), `#!/bin/sh\necho "${c} $*" >> '${markers}'\nexit 0\n`);
    fs.chmodSync(path.join(dir, 'bin', c), 0o755);
  }
  for (const t of TOOLS) { const p = which(t); if (p) fs.symlinkSync(p, path.join(dir, 'min', t)); }
  return { dir, markers, file: (f) => path.join(dir, f) };
}
function stub(sb, name, script, where = 'bin') {
  const p = path.join(sb.dir, where, name);
  // Unlink first: min/ holds symlinks to the real tools, and writing through
  // one would be writing to /usr/bin.
  fs.rmSync(p, { force: true });
  fs.writeFileSync(p, `#!/bin/sh\n${script}\n`, { mode: 0o755, flag: 'wx' });
}
function runAgent(agentPath, sb, { mode = 'real', env = {} } = {}) {
  const PATH = mode === 'real' ? `${sb.dir}/bin:${process.env.PATH}` : `${sb.dir}/bin:${sb.dir}/min`;
  return new Promise((resolve) => {
    const p = spawn(path.join(sb.dir, 'min', 'sh'), [agentPath], {
      cwd: sb.dir,
      env: {
        PATH, HOME: sb.dir, TMPDIR: path.join(sb.dir, 'tmp'), LANG: 'C',
        REM0TE_AGENT_CONF: sb.file('agent.conf'), REM0TE_AGENT_SECRET_FILE: sb.file('secret'),
        REM0TE_RUSTDESK_CONFIG: sb.file('RustDesk.toml'), ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
    p.on('exit', (c) => resolve({ code: c, out }));
  });
}
const markers = (sb) => (fs.existsSync(sb.markers) ? fs.readFileSync(sb.markers, 'utf8') : '');
const tmpEmpty = (sb) => fs.readdirSync(path.join(sb.dir, 'tmp')).length === 0;

const inv = (id) => prisma.endpointInventory.findUnique({ where: { endpointId: id } });
const ep = (id) => prisma.endpoint.findUnique({ where: { id }, include: { rustdeskNode: true } });
const cmds = (id) => prisma.endpointCommand.findMany({ where: { endpointId: id }, orderBy: { createdAt: 'asc' } });

async function all() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  // The installer embeds the relay host; a scratch database seeded without one gets a placeholder nothing dials.
  const ts = await prisma.tenantSettings.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!ts) throw new Error('seed the scratch database first: no tenant settings');
  if (!ts.rustdeskRelayHost || !ts.rustdeskPublicKey) {
    await prisma.tenantSettings.update({
      where: { id: ts.id },
      data: { rustdeskRelayHost: ts.rustdeskRelayHost || 'relay.scratch.example.com', rustdeskPublicKey: ts.rustdeskPublicKey || randomBytes(32).toString('base64') },
    });
  }
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });

  section('Fixtures (synthetic): businesses Acme and Birch, one owner each');
  const acme = await prisma.customer.create({ data: { tenantId: tenant.id, name: `LX Acme ${sfx}` } });
  const birch = await prisma.customer.create({ data: { tenantId: tenant.id, name: `LX Birch ${sfx}` } });
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag) => prisma.user.create({ data: { email: `lx-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'LX', lastName: tag, status: 'ACTIVE' } });
  const owen = await mkUser('owen-acme'), bea = await mkUser('bea-birch');
  await prisma.membership.create({ data: { userId: owen.id, tenantId: tenant.id, customerId: acme.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: bea.id, tenantId: tenant.id, customerId: birch.id, roleId: roleOwner.id } });
  check(true, `temp directory ${ROOT}`);

  // Someone else's API on this port would answer for ours, against another database.
  const busy = await fetch(`${API}/health`).then(() => true, () => false);
  if (busy) throw new Error(`port ${PORT} is already in use; set LINUX_API_PORT to a free port`);
  startApi();
  await waitUp();
  const S = { owen: await login(owen.email), bea: await login(bea.email) };

  // ── Installer ────────────────────────────────────────────────────────────
  section('The installer embeds the agent, a 3-minute timer, a 0600 secret and an uninstall path');
  const mint = async (s, businessId) => {
    const r = await req('POST', '/enrollment/tokens', { s, body: { businessId } });
    if (r.status !== 201 && r.status !== 200) throw new Error(`token: ${msg(r)}`);
    return r.data.token;
  };
  const tokA = await mint(S.owen, acme.id);
  let r = await req('GET', `/public/install/linux/${tokA}`, { raw: true });
  const installer = r.text ?? '';
  check(r.status === 200 && installer.startsWith('#!/usr/bin/env bash'), 'GET /public/install/linux/<token> serves a bash installer', msg(r));
  const instPath = path.join(ROOT, 'install.sh'); fs.writeFileSync(instPath, installer);
  let syntax = ''; try { execFileSync('bash', ['-n', instPath], { stdio: 'pipe' }); } catch (e) { syntax = String(e.stderr); }
  check(!syntax, 'the installer parses (bash -n)', syntax);
  const m = installer.match(/<<'REM0TE_AGENT_EOF'\n([\s\S]*?\n)REM0TE_AGENT_EOF\n/);
  check(!!m, 'the agent is embedded in a quoted heredoc (nothing in it is expanded at install)');
  const agentText = m?.[1] ?? '';
  const agentPath = path.join(ROOT, 'rem0te-agent'); fs.writeFileSync(agentPath, agentText, { mode: 0o755 });
  for (const [sh, args] of [['sh', ['-n']], ['dash', ['-n']], ['bash', ['-n']], ['bash', ['--posix', '-n']], ['busybox', ['sh', '-n']]]) {
    if (!which(sh)) { check(true, `${sh} not installed here — skipped`); continue; }
    let err = ''; try { execFileSync(sh, [...args, agentPath], { stdio: 'pipe' }); } catch (e) { err = String(e.stderr || e.message); }
    check(!err, `the generated agent parses: ${sh} ${args.join(' ')}`, err);
  }
  check(agentText.includes(`AGENT_VERSION='${VERSION}'`), `the agent reports platform version ${VERSION}`);
  check(/OnUnitActiveSec=3min/.test(installer) && /systemctl enable --now rem0te-agent\.timer/.test(installer), 'rem0te-agent.timer runs every 3 minutes and is enabled');
  check(/ExecStart=\/bin\/sh \/usr\/local\/lib\/rem0te\/rem0te-agent/.test(installer) && /ProtectSystem=full/.test(installer) && /NoNewPrivileges=yes/.test(installer), 'the service runs the agent under ProtectSystem=full and NoNewPrivileges');
  check(/umask 077; printf '%s' "\$\{AGENT_SECRET\}" > "\$\{AGENT_STATE\}"/.test(installer) && /chmod 600 "\$\{AGENT_STATE\}"/.test(installer) && /chown root:root "\$\{AGENT_STATE\}"/.test(installer), 'the device secret is written under umask 077, then chown root and chmod 600');
  check(installer.indexOf('[ "$EUID" -eq 0 ]') < installer.indexOf('AGENT_STATE='), 'the installer checks for root before writing the secret');
  const un = installer.slice(installer.indexOf('--uninstall" ]; then'), installer.indexOf('exit 0\nfi'));
  check(/disable --now rem0te-agent\.timer/.test(un) && /rm -f \/etc\/systemd\/system\/rem0te-agent\.timer \/etc\/systemd\/system\/rem0te-agent\.service/.test(un)
    && /rm -f \/usr\/local\/lib\/rem0te\/rem0te-agent \/etc\/rem0te-agent\.conf \/etc\/rem0te-agent\.secret/.test(un), '--uninstall disables the timer and removes the units, the script, the config and the secret', un.slice(0, 300));
  check(/\$\{1:-\}" = "--uninstall"/.test(installer) && installer.indexOf('--uninstall" ]; then') < installer.indexOf('PERM_PW='), '--uninstall is handled before anything is installed or generated');

  // ── Claim and first heartbeat (real tools) ─────────────────────────────────
  section('Claim (the Windows claim flow) and a first run against this host\'s real /proc, df, who and apt');
  const A = { rid: rid(), secret: randomBytes(32).toString('base64url') };
  r = await req('POST', '/enrollment/claim', { body: { token: tokA, rustdeskId: A.rid, hostname: 'acme-web', platform: 'linux', password: 'Perm2Pass9', agentSecret: A.secret } });
  check(r.status === 200, 'the installer\'s claim body is accepted', msg(r));
  A.id = r.data?.endpoint?.id;
  const nodeA = await prisma.rustdeskNode.findUnique({ where: { rustdeskId: A.rid } });
  check(nodeA?.agentSecretHash === sha(A.secret) && nodeA.endpointId === A.id, 'the claim bound the device secret to the new computer');
  const sbA = sandbox('acme', A);

  let run = await runAgent(agentPath, sbA, { mode: 'real' });
  check(run.code === 0 && /heartbeat ok; 2 command\(s\) answered/.test(run.out), 'the agent heartbeats and answers the two automatic collections in the same run', run.out);
  let e = await ep(A.id), i = await inv(A.id);
  const osr = fs.readFileSync('/etc/os-release', 'utf8').match(/^PRETTY_NAME=(.*)$/m)?.[1]?.replace(/^"|"$/g, '') ?? '';
  const host = os.hostname().split('.')[0].replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64);
  check(e.platform === 'linux' && e.agentVersion === VERSION && e.updateChannel === 'legacy', 'platform linux, agent version reported, channel recorded as legacy (never signed)', JSON.stringify({ p: e.platform, v: e.agentVersion, c: e.updateChannel }));
  check(e.hostname === host && e.osVersion === osr.replace(/["\\]/g, '').slice(0, 64), `hostname and OS from this host (${host}, ${osr})`, `${e.hostname} / ${e.osVersion}`);
  check(i?.osCaption === e.osVersion && i?.osBuild === os.release() && i?.osArch === execFileSync('uname', ['-m'], { encoding: 'utf8' }).trim(), 'inventory: OS release, kernel (as build) and architecture', JSON.stringify({ c: i?.osCaption, b: i?.osBuild, a: i?.osArch }));
  check(i?.cpuThreads === os.cpus().length && !!i?.cpuModel && os.cpus()[0].model.replace(/\s+/g, ' ').includes(i.cpuModel.replace(/\s+/g, ' ').slice(0, 20)), `inventory: CPU model and ${os.cpus().length} threads`, JSON.stringify({ m: i?.cpuModel, t: i?.cpuThreads }));
  const memMb = Math.round(os.totalmem() / 1048576);
  check(Math.abs((i?.memoryTotalMb ?? 0) - memMb) <= Math.max(16, memMb * 0.01) && i.memoryFreeMb > 0 && i.memoryFreeMb <= i.memoryTotalMb, `memory: ${i?.memoryFreeMb} MB available of ${i?.memoryTotalMb} MB (node: ${memMb})`);
  check(typeof i?.cpuLoadPercent === 'number' && i.cpuLoadPercent >= 0 && i.cpuLoadPercent <= 100, `CPU load ${i?.cpuLoadPercent}% from /proc/stat`);
  check(Math.abs((i?.uptimeSeconds ?? -1e9) - os.uptime()) < 600 && i.lastBootAt && Math.abs(i.lastBootAt.getTime() - (Date.now() - os.uptime() * 1000)) < 600_000, `uptime ${i?.uptimeSeconds}s and last boot ${i?.lastBootAt?.toISOString()}`);
  const disks = Array.isArray(i?.disks) ? i.disks : [];
  check(disks.some((d) => d.drive === '/' && d.totalBytes > 0 && d.freeBytes >= 0) && i.systemDiskTotalMb > 0 && i.systemDiskFreeMb >= 0, `disks from df (${disks.map((d) => d.drive).join(', ')}), system disk ${i?.systemDiskFreeMb} MB free`);
  check(disks.every((d) => !/^(tmpfs|devtmpfs|squashfs|overlay)$/.test(d.fsType ?? '')), 'pseudo filesystems are left out');
  const whoUsers = [...new Set(execFileSync('who', { encoding: 'utf8' }).split('\n').map((l) => l.split(/\s+/)[0]).filter(Boolean))].join(', ');
  check((i?.loggedOnUser ?? '') === whoUsers.slice(0, 128), `logged-on users from who: "${whoUsers}"`, `stored "${i?.loggedOnUser}"`);
  const aptN = (() => { try { return execFileSync('apt', ['list', '--upgradable'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter((l) => l.includes('[upgradable from:')).length; } catch { return null; } })();
  let c = await cmds(A.id);
  check(c.length === 2 && c.every((x) => x.status === 'SUCCEEDED'), 'INVENTORY_REFRESH and UPDATE_SCAN both SUCCEEDED', JSON.stringify(c.map((x) => [x.type, x.status, x.error])));
  check(aptN !== null && i?.pendingUpdateCount === Math.min(aptN, 100) && i.updatesCheckedAt, `pending updates from apt list --upgradable: ${i?.pendingUpdateCount} (apt says ${aptN})`);
  check(!markers(sbA) && tmpEmpty(sbA), 'nothing on the marker list ran, and the agent cleaned its temp directory', markers(sbA));
  const sec = sbA.file('secret');
  check(!run.out.includes(A.secret) && !/agentSecret/.test(run.out), 'the secret never appears in the agent\'s output');
  check(fs.statSync(sec).mode % 0o1000 === 0o600, 'the secret file is still 0600');

  // ── Hostile strings, stubbed tools ─────────────────────────────────────────
  section('Hostile device strings are reduced before they leave, and never evaluated');
  const pwn = sbA.file('PWNED');
  fs.writeFileSync(sbA.file('os-release'), `NAME=x\nPRETTY_NAME="Evil\\" OS\x07 \x1b[31m$(touch ${pwn}) \`touch ${pwn}\` ${'A'.repeat(200)}"\n`);
  stub(sbA, 'hostname', `printf 'evil&calc"x\\\\y\\n.example.com'`);
  stub(sbA, 'who', `printf 'bob;rm\\tpts/0\\nalice    pts/1\\n"x\\\\    tty1\\nalice  pts/2\\n'`);
  stub(sbA, 'df', `case "$*" in *T*) printf 'Filesystem Type 1024-blocks Used Available Capacity Mounted on\\n/dev/sda1 ext4 1000 400 600 40%% /\\n/dev/sdb1 xfs 2000000 1 1999999 1%% /mnt/da"ta\\\\ with spaces and more\\ntmpfs tmpfs 10 0 10 0%% /run\\n';; *) printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/sda1 1000 400 600 40%% /\\n';; esac`, 'min');
  stub(sbA, 'dpkg-query', `printf 'rustdesk\\t1.4.2\\n'`, 'min');
  stub(sbA, 'dpkg', 'exit 0', 'min');
  stub(sbA, 'apt', `printf 'Listing...\\nopenssl/noble-updates,noble-security 3.0.13-0ubuntu3.5 amd64 [upgradable from: 3.0.13-0ubuntu3.4]\\ncurl/noble-updates 8.5.0-2ubuntu10.6 amd64 [upgradable from: 8.5.0-2ubuntu10.5]\\nev"il\\\\pkg$(touch ${pwn})/noble 1.0 all [upgradable from: 0.9]\\n'`, 'min');
  fs.writeFileSync(sbA.file('dmi/sys_vendor'), 'Acme "Quoted" \\ Vendor\x07\n');
  fs.writeFileSync(sbA.file('dmi/product_name'), 'Model\tX\n');
  fs.writeFileSync(sbA.file('dmi/chassis_type'), '9\n');
  fs.writeFileSync(sbA.file('dmi/bios_date'), '03/14/2024\n');
  // `dpkg` is a marker command in bin/, but here a stub in min/: bin/ comes
  // first, so drop the marker for this run.
  fs.rmSync(sbA.file('bin/dpkg'));
  r = await req('POST', `/endpoints/${A.id}/inventory/refresh`, { s: S.owen });
  check(r.status === 200 || r.status === 201, 'the owner asks for a refresh', msg(r));
  run = await runAgent(agentPath, sbA, { mode: 'minimal', env: { REM0TE_OS_RELEASE: sbA.file('os-release'), REM0TE_DMI_DIR: sbA.file('dmi') } });
  check(run.code === 0 && /2 command\(s\) answered/.test(run.out), 'the run is accepted (every field within the heartbeat limits)', run.out);
  e = await ep(A.id); i = await inv(A.id);
  check(!fs.existsSync(pwn), 'no $( ) or backtick in os-release or a package name was evaluated');
  check(e.hostname === 'evilcalcxy', `hostname reduced to the inert charset: "${e.hostname}"`);
  check(!CONTROL.test(e.osVersion) && !/["\\]/.test(e.osVersion) && e.osVersion.length <= 64 && e.osVersion.startsWith('Evil OS'), `OS name: no control characters, quotes or backslashes, ≤64: "${e.osVersion}"`);
  check(i.loggedOnUser === 'bobrm, alice, x', `users from who, reduced and de-duplicated: "${i.loggedOnUser}"`);
  const d2 = i.disks;
  check(d2.length === 2 && d2[1].drive === '/mnt/data with s' && d2[1].fsType === 'xfs' && d2[1].totalBytes === 2048000000 && !d2.some((d) => d.fsType === 'tmpfs'), `disks: mount points stripped and clamped, tmpfs dropped: ${JSON.stringify(d2.map((d) => d.drive))}`);
  check(i.manufacturer === 'Acme Quoted  Vendor' && i.model === 'ModelX' && i.chassisType === 'Laptop' && i.biosDate?.toISOString().startsWith('2024-03-14'), `DMI fields reduced: ${JSON.stringify([i.manufacturer, i.model, i.chassisType, i.biosDate])}`);
  const pend = i.pendingUpdates;
  check(i.pendingUpdateCount === 3 && pend[0].title === 'openssl 3.0.13-0ubuntu3.5 (installed 3.0.13-0ubuntu3.4)' && pend[0].severity === 'Security' && !pend[1].severity, 'apt list parsed: title with both versions, Security from a -security pocket', JSON.stringify(pend));
  check(!/["\\]/.test(pend[2].title) && !CONTROL.test(pend[2].title), `a hostile package name arrives as inert text: "${pend[2]?.title}"`);
  check(e.rustdeskNode.version === '1.4.2', 'RustDesk version from the package database (dpkg-query)', e.rustdeskNode.version);
  check(!markers(sbA), 'nothing on the marker list ran', markers(sbA));

  section('The server reduces device strings too, for a caller holding the secret but not using the agent');
  r = await req('POST', '/enrollment/heartbeat', { body: { rustdeskId: A.rid, agentSecret: A.secret, hostname: 'srv\u0007side\nname', osVersion: 'Linux\u001b[2J\r\nOS', platform: 'linux', agentVersion: VERSION } });
  e = await ep(A.id);
  check(r.status === 200 && e.hostname === 'srv side name' && e.osVersion === 'Linux [2J OS' && e.rustdeskNode.hostname === 'srv side name', `stored as "${e.hostname}" / "${e.osVersion}"`, msg(r));

  // ── Read-only ──────────────────────────────────────────────────────────────
  section('Read-only: nothing the server stages is acted on, and the console refuses to stage it');
  r = await req('POST', `/endpoints/${A.id}/rotate-credential`, { s: S.owen });
  check(r.status === 400 && code(r) === 'LINUX_AGENT_READ_ONLY', 'rotating the password from the console is refused for Linux', msg(r));
  r = await req('POST', `/endpoints/${A.id}/reinstall-agent`, { s: S.owen });
  check(r.status === 400 && code(r) === 'LINUX_AGENT_READ_ONLY', 'reinstalling from the console is refused for Linux', msg(r));
  r = await req('POST', `/endpoints/${A.id}/event-log`, { s: S.owen, body: { logName: 'System' } });
  check(r.status === 400 && code(r) === 'LINUX_AGENT_READ_ONLY', 'an event-log query is refused for Linux', msg(r));
  r = await req('POST', `/endpoints/${A.id}/diagnostics/runs`, { s: S.owen, body: { key: 'disk_space' } });
  check(r.status === 400 && code(r) === 'DIAGNOSTIC_OS_UNSUPPORTED', 'a catalog diagnostic is refused for Linux (unchanged, Windows-only)', msg(r));
  // Staged anyway, straight in the database, as an older server or a bug would.
  await prisma.rustdeskNode.update({ where: { rustdeskId: A.rid }, data: { pendingPassword: encryptPassword('Rotated123'), pendingPasswordAt: new Date(), reinstallRequestedAt: new Date(), updateRequestedAt: new Date(), updateTargetVersion: '9.9.9' } });
  const evq = await prisma.endpointCommand.create({ data: { endpointId: A.id, tenantId: tenant.id, customerId: acme.id, type: 'EVENT_LOG_QUERY', params: { logName: 'System', levels: [], maxEvents: 5, sinceHours: 1, providerName: null }, requestedById: owen.id, expiresAt: new Date(Date.now() + 30 * 60_000) } });
  fs.writeFileSync(sbA.file('bin/dpkg'), `#!/bin/sh\necho "dpkg $*" >> '${sbA.markers}'\nexit 0\n`, { mode: 0o755, flag: 'wx' });
  stub(sbA, 'hostname', 'echo acme-web');
  const rotateResp = await req('POST', '/enrollment/heartbeat', { body: { rustdeskId: A.rid, agentSecret: A.secret, platform: 'linux' } });
  check(!!rotateResp.data?.rotate?.password, 'the heartbeat response does carry the staged rotation (the agent must ignore it)', JSON.stringify(rotateResp.data).slice(0, 300));
  run = await runAgent(agentPath, sbA, { mode: 'minimal' });
  const nodeAfter = await prisma.rustdeskNode.findUnique({ where: { rustdeskId: A.rid } });
  check(run.code === 0 && !markers(sbA), 'the agent ran nothing (rustdesk, systemctl, apt-get, dpkg, bash, python3, wget, reboot are all markers)', markers(sbA) || run.out);
  // (The reinstall flag clears by itself here: the server drops a dispatched
  // reinstall once the reported agent matches its version, as for Windows.)
  check(!!nodeAfter.pendingPassword && nodeAfter.updateTargetVersion === '9.9.9' && !!nodeAfter.updateRequestedAt, 'the rotation was never confirmed and the client update is still pending (nothing was applied)', JSON.stringify({ p: !!nodeAfter.pendingPassword, u: nodeAfter.updateTargetVersion }));
  const evAfter = await prisma.endpointCommand.findUnique({ where: { id: evq.id } });
  check(evAfter.status === 'FAILED' && /Windows-only/.test(evAfter.error ?? ''), 'the event-log query is answered as failed, Windows-only — not left to expire', JSON.stringify([evAfter.status, evAfter.error]));
  await prisma.rustdeskNode.update({ where: { rustdeskId: A.rid }, data: { pendingPassword: null, pendingPasswordAt: null, reinstallRequestedAt: null, updateRequestedAt: null, updateTargetVersion: null } });

  // ── Wrong or missing secret ───────────────────────────────────────────────
  section('A wrong, missing or exposed secret is refused');
  const rejBefore = await prisma.activityLog.count({ where: { action: 'ENDPOINT_HEARTBEAT_REJECTED', resourceId: A.id } });
  fs.writeFileSync(sec, randomBytes(32).toString('base64url'));
  stub(sbA, 'hostname', 'echo attacker-host');
  run = await runAgent(agentPath, sbA, { mode: 'minimal' });
  e = await ep(A.id);
  check(run.code === 0 && /HTTP 401/.test(run.out), 'a wrong secret: the server answers 401 and the agent says why', run.out);
  check(e.hostname !== 'attacker-host', 'nothing it said was written (hostname unchanged)');
  check(await prisma.activityLog.count({ where: { action: 'ENDPOINT_HEARTBEAT_REJECTED', resourceId: A.id } }) === rejBefore + 1, 'the refusal is audited (ENDPOINT_HEARTBEAT_REJECTED)');
  fs.rmSync(sec);
  run = await runAgent(agentPath, sbA, { mode: 'minimal' });
  check(run.code === 1 && /no device secret/.test(run.out), 'a missing secret: the agent refuses locally', run.out);
  fs.writeFileSync(sec, A.secret); fs.chmodSync(sec, 0o644);
  run = await runAgent(agentPath, sbA, { mode: 'minimal' });
  check(run.code === 1 && /mode 644/.test(run.out), 'a world-readable secret: the agent refuses to use it', run.out);
  fs.chmodSync(sec, 0o600);
  check(await prisma.activityLog.count({ where: { action: 'ENDPOINT_HEARTBEAT_REJECTED', resourceId: A.id } }) === rejBefore + 1, 'neither local refusal sent a request');
  r = await req('POST', '/enrollment/heartbeat', { body: { rustdeskId: A.rid, hostname: 'no-secret', platform: 'linux' } });
  check(r.status === 401 && (await ep(A.id)).hostname !== 'no-secret', 'a heartbeat with no secret for a bound computer: 401, nothing written', msg(r));
  r = await req('POST', '/enrollment/command-result', { body: { rustdeskId: A.rid, agentSecret: randomBytes(24).toString('base64url'), commandId: 'x', ok: true, inventory: { osCaption: 'forged' } } });
  check(r.status === 401, 'a command result with a wrong secret: 401', msg(r));
  fs.writeFileSync(sbA.file('agent.conf'), 'API_BASE=http://example.com/api/v1\n');
  run = await runAgent(agentPath, sbA, { mode: 'minimal' });
  check(run.code === 1 && /not an https URL/.test(run.out), 'plain http to anything but this machine is refused', run.out);
  fs.writeFileSync(sbA.file('agent.conf'), `API_BASE=${API}\n`);
  // Recover: the right secret again clears the candidate recorded above.
  stub(sbA, 'hostname', 'echo acme-web');
  run = await runAgent(agentPath, sbA, { mode: 'minimal' });
  e = await ep(A.id);
  check(run.code === 0 && /heartbeat ok/.test(run.out) && e.hostname === 'acme-web' && !e.rustdeskNode.candidateSecretHash, 'with the bound secret back, it reports again and the candidate is cleared', run.out);

  // ── Business isolation ─────────────────────────────────────────────────────
  section('Business isolation');
  const tokB = await mint(S.bea, birch.id);
  const B = { rid: rid(), secret: randomBytes(32).toString('base64url') };
  r = await req('POST', '/enrollment/claim', { body: { token: tokB, rustdeskId: A.rid, hostname: 'steal', platform: 'linux', agentSecret: B.secret } });
  check(r.status === 400 && (await ep(A.id)).customerId === acme.id, 'Birch\'s token cannot claim Acme\'s RustDesk ID', msg(r));
  r = await req('POST', '/enrollment/claim', { body: { token: tokB, rustdeskId: B.rid, hostname: 'birch-db', platform: 'linux', agentSecret: B.secret } });
  B.id = r.data?.endpoint?.id;
  check(r.status === 200 && B.id, 'Birch claims its own computer', msg(r));
  const sbB = sandbox('birch', B);
  stub(sbB, 'hostname', 'echo birch-db');
  run = await runAgent(agentPath, sbB, { mode: 'real' });
  check(run.code === 0 && (await inv(B.id))?.collectedAt, 'Birch\'s agent reports its own inventory', run.out);
  r = await req('GET', `/endpoints/${A.id}/inventory`, { s: S.bea });
  check(r.status === 403 || r.status === 404, 'Birch\'s owner cannot read Acme\'s inventory', msg(r));
  r = await req('GET', `/endpoints/${B.id}/inventory`, { s: S.owen });
  check(r.status === 403 || r.status === 404, 'Acme\'s owner cannot read Birch\'s inventory', msg(r));
  r = await req('GET', `/endpoints/${A.id}/inventory`, { s: S.owen });
  check(r.status === 200 && r.data?.inventory?.osCaption, 'Acme\'s owner reads Acme\'s', msg(r));
  const listB = await req('GET', '/endpoints/list', { s: S.bea });
  const listA = await req('GET', '/endpoints/list', { s: S.owen });
  const idsB = (listB.data?.rows ?? []).map((x) => x.id), idsA = (listA.data?.rows ?? []).map((x) => x.id);
  check(idsB.includes(B.id) && !idsB.includes(A.id) && idsA.includes(A.id) && !idsA.includes(B.id), 'each device list shows only its own business\'s Linux computer', JSON.stringify({ idsA, idsB }));
  const rowA = (listA.data?.rows ?? []).find((x) => x.id === A.id);
  check(rowA?.platform === 'linux' && rowA.agent?.type === 'standard' && rowA.agent.version === VERSION && rowA.patches?.source === 'standard_agent_scan', 'the device list shows it as the standard agent on linux, with a standard scan', JSON.stringify(rowA?.agent));
  // Birch's agent pointed at Acme's RustDesk ID, with Birch's secret.
  fs.writeFileSync(sbB.file('RustDesk.toml'), `id = '${A.rid}'\n`);
  stub(sbB, 'hostname', 'echo hijack');
  run = await runAgent(agentPath, sbB, { mode: 'real' });
  check(/HTTP 401/.test(run.out) && (await ep(A.id)).hostname === 'acme-web', 'Birch\'s secret under Acme\'s RustDesk ID: 401, Acme unchanged', run.out);
  fs.writeFileSync(sbB.file('RustDesk.toml'), `id = '${B.rid}'\n`);
  await req('POST', `/endpoints/${A.id}/inventory/refresh`, { s: S.owen });
  const acmeCmd = await prisma.endpointCommand.findFirst({ where: { endpointId: A.id, status: 'PENDING' }, orderBy: { createdAt: 'desc' } });
  r = await req('POST', '/enrollment/command-result', { body: { rustdeskId: B.rid, agentSecret: B.secret, commandId: acmeCmd.id, ok: true, inventory: { osCaption: 'forged by birch' } } });
  check(r.status === 200 && r.data?.accepted === false && r.data?.reason === 'unknown_command', 'Birch cannot close or fill a command staged for Acme', msg(r));
  check((await prisma.endpointCommand.findUnique({ where: { id: acmeCmd.id } })).status === 'PENDING' && (await inv(A.id)).osCaption !== 'forged by birch', 'Acme\'s command and inventory are untouched');

  // ── Package managers ───────────────────────────────────────────────────────
  section('Pending updates: unknown without apt, dnf or zypper; dnf and zypper parsed');
  const tokC = await mint(S.owen, acme.id);
  const C = { rid: rid(), secret: randomBytes(32).toString('base64url') };
  r = await req('POST', '/enrollment/claim', { body: { token: tokC, rustdeskId: C.rid, hostname: 'acme-alpine', platform: 'linux', agentSecret: C.secret } });
  C.id = r.data?.endpoint?.id;
  const sbC = sandbox('acme-c', C);
  stub(sbC, 'hostname', 'echo acme-alpine');
  await runAgent(agentPath, sbC, { mode: 'minimal' });
  let cc = await cmds(C.id); i = await inv(C.id);
  const upd = cc.find((x) => x.type === 'UPDATE_SCAN');
  check(upd?.status === 'FAILED' && /unknown: none of apt, dnf or zypper/.test(upd.error ?? ''), 'no package manager: the scan is reported failed, with "unknown" as the reason', JSON.stringify([upd?.status, upd?.error]));
  check(i?.pendingUpdateCount == null && i?.updatesCheckedAt == null && i?.collectedAt, 'nothing claims "0 pending": the count stays unknown, and the rest of the inventory landed');
  run = await runAgent(agentPath, sbC, { mode: 'minimal' });
  cc = await cmds(C.id);
  check(cc.filter((x) => x.type === 'UPDATE_SCAN').length === 1 && /0 command\(s\)/.test(run.out), 'the next heartbeat does not ask again (no failed row every three minutes)', JSON.stringify(cc.map((x) => [x.type, x.status])));
  r = await req('GET', `/endpoints/${C.id}/patches`, { s: S.owen });
  check(r.status === 200 && r.data?.summary?.evidence?.source === 'none', 'the Patches tab says no scan received, not "up to date"', msg(r));
  stub(sbC, 'dnf', `case "$*" in *check-update*) printf '\\nkernel.x86_64   6.10.3-200.fc40   updates\\nvery-long-package-name-that-wraps.noarch\\n    2.1-1.fc40   updates\\nObsoleting Packages\\nold.x86_64 1-1 updates\\n'; exit 100;; esac; exit 1`, 'min');
  await req('POST', `/endpoints/${C.id}/inventory/refresh`, { s: S.owen });
  await runAgent(agentPath, sbC, { mode: 'minimal' });
  i = await inv(C.id);
  check(i.pendingUpdateCount === 2 && i.pendingUpdates[0].title === 'kernel 6.10.3-200.fc40' && i.pendingUpdates[1].title === 'very-long-package-name-that-wraps 2.1-1.fc40', 'dnf -C check-update: two updates, a wrapped line joined, obsoletes ignored', JSON.stringify(i.pendingUpdates));
  fs.rmSync(sbC.file('min/dnf'));
  stub(sbC, 'dnf', 'exit 1', 'min');
  await req('POST', `/endpoints/${C.id}/inventory/refresh`, { s: S.owen });
  await runAgent(agentPath, sbC, { mode: 'minimal' });
  cc = await cmds(C.id);
  check(/dnf check-update \(from cache\) failed with status 1/.test(cc.at(-1)?.error ?? '') && (await inv(C.id)).pendingUpdateCount === 2, 'a dnf error is a failed scan, not "no updates"; the last good list stays', cc.at(-1)?.error);
  fs.rmSync(sbC.file('min/dnf'));
  stub(sbC, 'zypper', `case "$*" in *list-updates*) printf 'Loading repository data...\\nS | Repository | Name | Current Version | Available Version | Arch\\n--+------------+------+-----------------+-------------------+-------\\nv | repo-oss   | vim  | 9.0-1.1         | 9.1-1.1           | x86_64\\nv | repo-upd   | zlib | 1.2-3           | 1.3-1             | x86_64\\n';; *needs-rebooting*) exit 102;; esac`, 'min');
  await req('POST', `/endpoints/${C.id}/inventory/refresh`, { s: S.owen });
  await runAgent(agentPath, sbC, { mode: 'minimal' });
  i = await inv(C.id);
  check(i.pendingUpdateCount === 2 && i.pendingUpdates[0].title === 'vim 9.1-1.1 (installed 9.0-1.1)' && i.rebootRequired === true, 'zypper --no-refresh list-updates parsed, and zypper needs-rebooting (102) reads as restart pending', JSON.stringify([i.pendingUpdates, i.rebootRequired]));
  check(!markers(sbC) && !markers(sbB), 'no marker ran on the other two computers either');
}

let crashed = null;
try { await all(); } catch (e) { crashed = e; console.error(e); }
await stopApi();
await prisma.$disconnect();
try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* best-effort */ }
if (crashed) { console.error(`\nCRASHED after ${pass} passed, ${fail} failed`); if (api?.log) console.error(api.log.slice(-2000)); process.exit(1); }
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
