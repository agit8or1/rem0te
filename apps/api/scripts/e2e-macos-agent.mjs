#!/usr/bin/env node
/**
 * End-to-end proof of the standard macOS agent (0.33), with the real generated
 * script running against a real API and database:
 *
 *   - the macOS installer embeds the agent, a LaunchDaemon (every 180 s), a
 *     root-only 0600 secret, and an --uninstall path that removes all of it;
 *     the agent parses under sh, dash, bash --posix, busybox sh and zsh's sh
 *     emulation, and runs to completion under three of them;
 *   - the agent heartbeats with the secret bound at claim (the Windows and
 *     Linux claim flow, unchanged) and its inventory and pending updates land;
 *   - a wrong, missing, loose or foreign-owned secret is refused, by the
 *     server or by the agent before it sends anything;
 *   - one business's agent cannot write into, or read, another's computer;
 *   - hostile device strings (sw_vers, hostname, who, df, system_profiler,
 *     ioreg, the update list, Info.plist) arrive reduced and clamped, and are
 *     never evaluated;
 *   - it is read-only: a staged rotation, reinstall, client update or event
 *     log query is not acted on, the console refuses to stage them, and no
 *     state-changing command (softwareupdate, launchctl, shutdown, defaults
 *     write, ...) ever runs;
 *   - pending updates come from macOS's own last check, never from running
 *     softwareupdate: "unknown" when there was none or it is stale, and no
 *     re-asking every heartbeat after that;
 *   - system_profiler is bounded: a hung one costs SP_TIMEOUT seconds, not the
 *     run.
 *
 *   cd apps/api && npx nest build
 *   DATABASE_URL=postgresql://…/<name containing scratch or test> node scripts/e2e-macos-agent.mjs
 *   (ZSH_BIN=/path/to/zsh also runs it under zsh's sh emulation; found on PATH otherwise)
 *
 * This host is not a Mac. The agent runs as this user, from a temp directory,
 * under REM0TE_TEST_PATH: stubs of the macOS commands (sw_vers, sysctl,
 * vm_stat, top, who, df, mount, ioreg, system_profiler, defaults, plutil,
 * dscl, hostname, uname) that print recorded macOS output, then links to the
 * real POSIX tools it shares with Linux (sed, awk, tr, curl, stat, ...).
 * Every command that changes state is a marker that logs being run. Nothing is
 * installed and nothing outside the temp directory is written.
 * INTEGRATION ONLY — not a Mac, not launchd, not root, not RustDesk.
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { spawn, execFileSync, spawnSync } from 'node:child_process';
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
const PORT = Number(process.env.MACOS_API_PORT ?? 3321);
if ([3000, 3001, 4000, 4001, 443].includes(PORT)) { console.error(`Refusing port ${PORT}`); process.exit(2); }
const API = `http://127.0.0.1:${PORT}/api/v1`;
const ENC_KEY = process.env.ENCRYPTION_KEY ?? randomBytes(32).toString('hex');
const VERSION = JSON.parse(fs.readFileSync(path.resolve(here, '..', '..', '..', 'version.json'), 'utf8')).version;
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const PW = 'macos-agent-e2e-password-123';
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'rem0te-macos-e2e-'));

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
/** How `defaults read` prints a date: "2024-05-13 09:12:34 +0000". */
const plistDate = (msAgo) => new Date(Date.now() - msAgo).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' +0000');

// ── The sandbox ─────────────────────────────────────────────────────────────
// Real POSIX tools the agent shares with Linux, linked into min/. Everything
// macOS-specific is a stub in bin/, which comes first.
const TOOLS = ['sh', 'curl', 'sed', 'grep', 'awk', 'tr', 'cut', 'head', 'cat', 'wc', 'stat', 'id', 'mktemp', 'rm', 'sleep', 'date', 'readlink'];
const which = (t) => { try { return execFileSync('sh', ['-c', `command -v ${t}`], { encoding: 'utf8' }).trim(); } catch { return ''; } };
// Commands that change a Mac's state. If the agent ever runs one, it is caught
// writing to markers.log.
const MARK_CMDS = ['softwareupdate', 'launchctl', 'shutdown', 'reboot', 'halt', 'rustdesk', 'open', 'osascript', 'pmset',
  'systemsetup', 'installer', 'networksetup', 'scutil', 'killall', 'pkill', 'sudo', 'bash', 'zsh', 'python3', 'wget', 'nvram',
  'diskutil', 'spctl', 'tmutil', 'profiles', 'mdmclient', 'csrutil', 'kextload', 'brew'];

const SW_VERS = 'ProductName:\t\tmacOS\nProductVersion:\t\t14.5\nBuildVersion:\t\t23F79\n';
const TOP = 'Processes: 512 total, 3 running, 509 sleeping, 2390 threads\n2026/11/11 09:00:00\nLoad Avg: 2.10, 1.90, 1.80\nCPU usage: 30.0% user, 20.0% sys, 50.0% idle\n\n'
  + 'Processes: 512 total, 3 running, 509 sleeping, 2390 threads\n2026/11/11 09:00:01\nLoad Avg: 2.10, 1.90, 1.80\nCPU usage: 8.25% user, 4.5% sys, 87.25% idle\n';
const VM_STAT = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:                               20000.\nPages active:                            300000.\n'
  + 'Pages inactive:                          150000.\nPages speculative:                        30000.\nPages throttled:                              0.\nPages wired down:                        100000.\nPages purgeable:                          10000.\n';
const DF = 'Filesystem     1024-blocks      Used Available Capacity  Mounted on\n/dev/disk3s1s1   482797652  10000000 300000000     4%    /\n'
  + 'devfs                  206       206         0   100%    /dev\n/dev/disk3s6     482797652   2097152 300000000     1%    /System/Volumes/VM\n'
  + '/dev/disk3s5     482797652 170000000 300000000    37%    /System/Volumes/Data\nmap auto_home            0         0         0   100%    /System/Volumes/Data/home\n'
  + '/dev/disk5s1     976762584 500000000 476762584    52%    /Volumes/Archive Disk\n';
const MOUNT = '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)\ndevfs on /dev (devfs, local, nobrowse)\n'
  + '/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse, protect)\nmap auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)\n'
  + '/dev/disk5s1 on /Volumes/Archive Disk (hfs, local, nodev, nosuid, journaled, noowners)\n';
const IOREG = '+-o Mac14,10  <class IOPlatformExpertDevice, id 0x100000245, registered, matched, active, busy 0 (148 ms), retain 34>\n    {\n'
  + '      "IOPlatformUUID" = "UUID-THAT-IS-NOT-SENT"\n      "manufacturer" = <"Apple Inc.">\n      "model" = <"Mac14,10">\n      "IOPlatformSerialNumber" = "SERIAL1234"\n    }\n';
const SP = 'Hardware:\n\n    Hardware Overview:\n\n      Model Name: MacBook Pro\n      Model Identifier: Mac14,10\n      Model Number: Z17G000NBB/A\n      Chip: Apple M2 Pro\n'
  + '      Total Number of Cores: 12 (8 performance and 4 efficiency)\n      Memory: 16 GB\n      System Firmware Version: 10151.121.1\n      OS Loader Version: 10151.121.1\n'
  + '      Serial Number (system): SERIAL1234\n      Hardware UUID: UUID-THAT-IS-NOT-SENT\n      Activation Lock Status: Enabled\n';
const RECOMMENDED = '(\n        {\n        "Display Name" = "macOS Sonoma 14.6";\n        "Display Version" = "14.6";\n        Identifier = "MSU_UPDATE_23G80_patch_14.6";\n'
  + '        "Product Key" = "MSU_UPDATE_23G80_patch_14.6";\n    },\n        {\n        "Display Name" = Safari;\n        "Display Version" = "17.6";\n'
  + '        Identifier = "Safari17.6SonomaAuto";\n        "Product Key" = "062-41047";\n    }\n)\n';
const INFO_PLIST = (v) => `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n\t<key>CFBundleName</key>\n\t<string>RustDesk</string>\n\t<key>CFBundleShortVersionString</key>\n\t<string>${v}</string>\n</dict>\n</plist>\n`;

function sandbox(name, { secret, rid: rustdeskId }) {
  const dir = path.join(ROOT, name);
  for (const d of ['', 'bin', 'min', 'tmp', 'fx', 'su', 'sys', 'RustDesk.app/Contents', 'home-alice/Library/Preferences/com.carriez.RustDesk']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  const markers = path.join(dir, 'markers.log');
  const fx = (f) => path.join(dir, 'fx', f);
  const write = (f, s, mode = 0o600) => { fs.writeFileSync(path.join(dir, f), s); fs.chmodSync(path.join(dir, f), mode); };
  write('agent.conf', `API_BASE=${API}\n`, 0o644);
  write('secret', secret);
  write('RustDesk.toml', `id = '${rustdeskId}'\nenc_id = ''\n`);
  write('RustDesk.app/Contents/Info.plist', INFO_PLIST('1.4.2'), 0o644);
  const fixtures = { sw_vers: SW_VERS, top: TOP, vm_stat: VM_STAT, df: DF, mount: MOUNT, ioreg: IOREG, system_profiler: SP,
    who: 'alice    console  Nov 11 09:00 \nbob      ttys001  Nov 11 09:05 (10.0.0.5)\n', hostname: `${name}-mbp\n` };
  for (const [k, v] of Object.entries(fixtures)) fs.writeFileSync(fx(k), v);
  // sysctl: one file per name, so a test can change or remove one.
  const sysctls = { 'kern.boottime': `{ sec = ${Math.floor(Date.now() / 1000) - 3 * 86400 - 123}, usec = 517000 } Sun Nov  8 09:00:00 2026\n`,
    'hw.memsize': '17179869184\n', 'machdep.cpu.brand_string': 'Apple M2 Pro\n', 'hw.physicalcpu': '10\n', 'hw.logicalcpu': '12\n', 'hw.model': 'Mac14,10\n' };
  for (const [k, v] of Object.entries(sysctls)) fs.writeFileSync(path.join(dir, 'sys', k), v);
  // defaults: one file per key of com.apple.SoftwareUpdate.
  fs.writeFileSync(path.join(dir, 'su', 'LastSuccessfulDate'), `${plistDate(2 * 3600_000)}\n`);
  fs.writeFileSync(path.join(dir, 'su', 'RecommendedUpdates'), RECOMMENDED);
  fs.writeFileSync(path.join(dir, 'su', 'AutomaticCheckEnabled'), '1\n');
  fs.writeFileSync(path.join(dir, 'home-alice/Library/Preferences/com.carriez.RustDesk/RustDesk.toml'), `id = '${rustdeskId}'\n`);

  const stubs = {
    sw_vers: `cat '${fx('sw_vers')}'`,
    top: `case "$*" in '-l 2 -n 0 -s 1') cat '${fx('top')}';; *) echo "top $*" >> '${markers}';; esac`,
    vm_stat: `cat '${fx('vm_stat')}'`,
    df: `case "$*" in '-Pk /') head -n 2 '${fx('df')}';; '-Pk') cat '${fx('df')}';; *) echo "df $*" >> '${markers}'; exit 1;; esac`,
    mount: `[ $# -eq 0 ] || { echo "mount $*" >> '${markers}'; exit 1; }; cat '${fx('mount')}'`,
    ioreg: `case "$*" in '-rd1 -c IOPlatformExpertDevice') cat '${fx('ioreg')}';; *) echo "ioreg $*" >> '${markers}';; esac`,
    system_profiler: `echo "$*" >> '${dir}/sp.calls'; [ -f '${fx('sp.sleep')}' ] && sleep "$(cat '${fx('sp.sleep')}')"; cat '${fx('system_profiler')}'`,
    who: `[ $# -eq 0 ] || exit 1; cat '${fx('who')}'`,
    hostname: `case "$*" in -s) cat '${fx('hostname')}';; *) echo "hostname $*" >> '${markers}';; esac`,
    uname: `case "$1" in -r) echo 23.5.0;; -m) echo arm64;; -n) echo mbp.local;; *) echo Darwin;; esac`,
    sysctl: `[ "$1" = -n ] && [ $# -eq 2 ] || { echo "sysctl $*" >> '${markers}'; exit 1; }; f='${dir}/sys/'"$2"; [ -f "$f" ] || { echo "sysctl: unknown oid '$2'" >&2; exit 1; }; cat "$f"`,
    // Only "read <domain> <key>" exists; write, delete, import... are markers.
    defaults: `[ "$1" = read ] && [ "$2" = /Library/Preferences/com.apple.SoftwareUpdate ] && [ $# -eq 3 ] || { echo "defaults $*" >> '${markers}'; exit 0; }; f='${dir}/su/'"$3"; [ -f "$f" ] || { echo "The domain/default pair of ($2, $3) does not exist" >&2; exit 1; }; cat "$f"`,
    plutil: `echo "$*" >> '${dir}/plutil.calls'; case "$1 $2 $3 $4" in '-convert xml1 -o -') cat '${fx('plist.xml')}';; *) echo "plutil $*" >> '${markers}'; exit 1;; esac`,
    dscl: `case "$1 $2" in '. -read') echo "NFSHomeDirectory: ${dir}/home-alice";; *) echo "dscl $*" >> '${markers}';; esac`,
  };
  for (const [c, body] of Object.entries(stubs)) fs.writeFileSync(path.join(dir, 'bin', c), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  for (const c of MARK_CMDS) fs.writeFileSync(path.join(dir, 'bin', c), `#!/bin/sh\necho "${c} $*" >> '${markers}'\nexit 0\n`, { mode: 0o755 });
  for (const t of TOOLS) { const p = which(t); if (p) fs.symlinkSync(p, path.join(dir, 'min', t)); }
  return { dir, markers, file: (f) => path.join(dir, f), fx };
}
const SHELLS = {
  dash: (sb) => [path.join(sb.dir, 'min', 'sh'), []],
  'bash --posix': () => [which('bash'), ['--posix']],
  'zsh (sh emulation)': () => [process.env.ZSH_BIN || which('zsh'), ['--emulate', 'sh']],
};
function runAgent(agentPath, sb, { env = {}, shell = 'dash', rdOverride = true } = {}) {
  const [bin, pre] = SHELLS[shell](sb);
  return new Promise((resolve) => {
    const p = spawn(bin, [...pre, agentPath], {
      cwd: sb.dir,
      env: {
        PATH: '/nonexistent', REM0TE_TEST_PATH: `${sb.dir}/bin:${sb.dir}/min`, HOME: sb.dir, TMPDIR: path.join(sb.dir, 'tmp'), LANG: 'C',
        REM0TE_AGENT_CONF: sb.file('agent.conf'), REM0TE_AGENT_SECRET_FILE: sb.file('secret'),
        ...(rdOverride ? { REM0TE_RUSTDESK_CONFIG: sb.file('RustDesk.toml') } : {}), REM0TE_RUSTDESK_APP: sb.file('RustDesk.app'), ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
    const t0 = Date.now();
    p.on('exit', (c) => resolve({ code: c, out, ms: Date.now() - t0 }));
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
  const acme = await prisma.customer.create({ data: { tenantId: tenant.id, name: `MAC Acme ${sfx}` } });
  const birch = await prisma.customer.create({ data: { tenantId: tenant.id, name: `MAC Birch ${sfx}` } });
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag) => prisma.user.create({ data: { email: `mac-${tag}-${sfx}@test.invalid`, passwordHash: hash, firstName: 'MAC', lastName: tag, status: 'ACTIVE' } });
  const owen = await mkUser('owen-acme'), bea = await mkUser('bea-birch');
  await prisma.membership.create({ data: { userId: owen.id, tenantId: tenant.id, customerId: acme.id, roleId: roleOwner.id } });
  await prisma.membership.create({ data: { userId: bea.id, tenantId: tenant.id, customerId: birch.id, roleId: roleOwner.id } });
  check(true, `temp directory ${ROOT}`);

  const busy = await fetch(`${API}/health`).then(() => true, () => false);
  if (busy) throw new Error(`port ${PORT} is already in use; set MACOS_API_PORT to a free port`);
  startApi();
  await waitUp();
  const S = { owen: await login(owen.email), bea: await login(bea.email) };

  // ── Installer ────────────────────────────────────────────────────────────
  section('The installer embeds the agent, a 180-second LaunchDaemon, a root-only secret and an uninstall path');
  const mint = async (s, businessId) => {
    const r = await req('POST', '/enrollment/tokens', { s, body: { businessId } });
    if (r.status !== 201 && r.status !== 200) throw new Error(`token: ${msg(r)}`);
    return r.data.token;
  };
  const tokA = await mint(S.owen, acme.id);
  let r = await req('GET', `/public/install/mac/${tokA}`, { raw: true });
  const installer = r.text ?? '';
  check(r.status === 200 && installer.startsWith('#!/usr/bin/env bash'), 'GET /public/install/mac/<token> serves a bash installer', msg(r));
  const instPath = path.join(ROOT, 'install.sh'); fs.writeFileSync(instPath, installer);
  let syntax = ''; try { execFileSync('bash', ['-n', instPath], { stdio: 'pipe' }); } catch (e) { syntax = String(e.stderr); }
  check(!syntax, 'the installer parses (bash -n)', syntax);
  const m = installer.match(/<<'REM0TE_AGENT_EOF'\n([\s\S]*?\n)REM0TE_AGENT_EOF\n/);
  check(!!m, 'the agent is embedded in a quoted heredoc (nothing in it is expanded at install)');
  const agentText = m?.[1] ?? '';
  const agentPath = path.join(ROOT, 'rem0te-agent'); fs.writeFileSync(agentPath, agentText, { mode: 0o755 });
  const zsh = process.env.ZSH_BIN || which('zsh');
  for (const [sh, args] of [['sh', ['-n']], ['dash', ['-n']], ['bash', ['-n']], ['bash', ['--posix', '-n']], ['busybox', ['sh', '-n']], [zsh, ['--emulate', 'sh', '-n']]]) {
    const label = `${sh === zsh ? 'zsh' : sh} ${args.join(' ')}`;
    if (!sh || !(sh.includes('/') ? fs.existsSync(sh) : which(sh))) { check(true, `${label}: not installed here — skipped`); continue; }
    let err = ''; try { execFileSync(sh, [...args, agentPath], { stdio: 'pipe' }); } catch (e) { err = String(e.stderr || e.message); }
    check(!err, `the generated agent parses: ${label}`, err);
  }
  check(agentText.includes(`AGENT_VERSION='${VERSION}'`) && /AGENT_PLATFORM=macos/.test(agentText), `the agent reports platform macos and version ${VERSION}`);
  const plist = installer.match(/<<'REM0TE_PLIST_EOF'\n(<\?xml[\s\S]*?\n)REM0TE_PLIST_EOF\n/)?.[1] ?? '';
  const plistPath = path.join(ROOT, 'agent.plist'); fs.writeFileSync(plistPath, plist);
  const xmlOk = spawnSync('python3', ['-I', '-c', 'import sys, xml.dom.minidom as m; m.parse(sys.argv[1])', plistPath], { encoding: 'utf8' });
  check(plist && xmlOk.status === 0, 'the LaunchDaemon plist is well-formed XML', xmlOk.stderr);
  check(/<key>Label<\/key>\s*<string>com\.rem0te\.agent<\/string>/.test(plist) && /<key>StartInterval<\/key>\s*<integer>180<\/integer>/.test(plist)
    && /<key>RunAtLoad<\/key>\s*<true\/>/.test(plist) && /<string>\/bin\/sh<\/string>\s*<string>\/Library\/Rem0te\/rem0te-agent<\/string>/.test(plist),
  'com.rem0te.agent runs /bin/sh /Library/Rem0te/rem0te-agent every 180 s and at load');
  check(/<key>PATH<\/key>\s*<string>\/usr\/bin:\/bin:\/usr\/sbin:\/sbin<\/string>/.test(plist) && !/\/usr\/local/.test(plist + agentText.replace(/^#.*$/gm, '')),
    'the daemon and the agent use the system PATH only, and nothing under /usr/local (admin-writable with Homebrew)');
  check(/launchctl bootstrap system \/Library\/LaunchDaemons\/com\.rem0te\.agent\.plist/.test(installer) && /chown root:wheel \/Library\/LaunchDaemons\/com\.rem0te\.agent\.plist/.test(installer),
    'the installer loads the daemon from a root-owned plist');
  check(/\( umask 077; printf '%s' "\$\{AGENT_SECRET\}" > "\$\{AGENT_STATE\}" \)/.test(installer) && /chown root:wheel "\$\{AGENT_STATE\}"/.test(installer)
    && /chmod 600 "\$\{AGENT_STATE\}"/.test(installer) && /AGENT_STATE="\/Library\/Rem0te\/agent\.secret"/.test(installer),
  'as root, the device secret is /Library/Rem0te/agent.secret, written under umask 077, chown root:wheel, chmod 600');
  check(/stat -f '%u %Lp' "\$\{f\}" 2>\/dev\/null\)" = "0 600"/.test(installer) && /rm -f "\$\{f\}"/.test(installer),
    'a pre-0.33 secret in a home directory is kept only if root wrote it (owner 0, mode 600), and every copy is deleted');
  const agentBlock = installer.slice(installer.indexOf('# ── The Rem0te agent'), installer.indexOf('echo "============================================="'));
  check(/if \[ "\$\{IS_ROOT\}" = 1 \] && \[ -n "\$\{HOST_ADDR\}" \]; then/.test(agentBlock) && /re-run this installer with sudo/.test(agentBlock),
    'without sudo, the agent is not installed and the installer says how to add it');
  const un = installer.slice(installer.indexOf('--uninstall" ]; then'), installer.indexOf('exit 0\nfi'));
  check(/launchctl bootout system\/com\.rem0te\.agent/.test(un) && /rm -f \/Library\/LaunchDaemons\/com\.rem0te\.agent\.plist/.test(un)
    && /rm -f \/Library\/Rem0te\/rem0te-agent \/Library\/Rem0te\/agent\.conf \/Library\/Rem0te\/agent\.secret/.test(un) && !/RustDesk\.app/.test(un.replace(/echo "[^"]*"/g, '')),
  '--uninstall boots out the daemon and removes the plist, the script, the config and the secret, and leaves RustDesk', un.slice(0, 400));
  check(/\$\{1:-\}" = "--uninstall"/.test(installer) && installer.indexOf('--uninstall" ]; then') < installer.indexOf('PERM_PW='), '--uninstall is handled before anything is installed or generated');
  // Found writing this: `tr < /dev/urandom | head -c N` exits 141 under
  // pipefail, which ended both installers at their first line of work.
  const linuxInstaller = (await req('GET', `/public/install/linux/${await mint(S.owen, acme.id)}`, { raw: true })).text ?? '';
  for (const [n, text] of [['macOS', installer], ['Linux', linuxInstaller]]) {
    const lines = text.split('\n').filter((l) => /^\s*(PERM_PW|AGENT_SECRET)=\$\(LC_ALL=C tr -dc '[^']+' < \/dev\/urandom/.test(l));
    const probe = `set -euo pipefail\n${lines.join('\n')}\nprintf '%s %s' "\${#PERM_PW}" "\${#AGENT_SECRET}"\n`;
    const out = spawnSync('bash', ['-c', probe], { encoding: 'utf8' });
    check(lines.length >= 2 && out.status === 0 && out.stdout === '12 43', `${n} installer: its random password and secret lines survive set -euo pipefail (12 and 43 characters)`, `${lines.length} lines, exit ${out.status}, "${out.stdout}"`);
  }

  // ── Claim and first heartbeat ──────────────────────────────────────────────
  section('Claim (the same claim flow) and a first run against recorded macOS output');
  const A = { rid: rid(), secret: randomBytes(32).toString('base64url') };
  r = await req('POST', '/enrollment/claim', { body: { token: tokA, rustdeskId: A.rid, hostname: 'acme-mbp', platform: 'macos', password: 'Perm2Pass9', agentSecret: A.secret } });
  check(r.status === 200, 'the installer\'s claim body is accepted', msg(r));
  A.id = r.data?.endpoint?.id;
  const nodeA = await prisma.rustdeskNode.findUnique({ where: { rustdeskId: A.rid } });
  check(nodeA?.agentSecretHash === sha(A.secret) && nodeA.endpointId === A.id, 'the claim bound the device secret to the new computer');
  const sbA = sandbox('acme', A);

  let run = await runAgent(agentPath, sbA, { rdOverride: false });
  check(run.code === 0 && /heartbeat ok; 2 command\(s\) answered/.test(run.out), 'the agent finds the RustDesk ID in the console user\'s preferences, heartbeats, and answers both automatic collections', run.out);
  let e = await ep(A.id), i = await inv(A.id);
  check(e.platform === 'macos' && e.agentVersion === VERSION && e.updateChannel === 'legacy', 'platform macos, agent version reported, channel recorded as legacy (never signed)', JSON.stringify({ p: e.platform, v: e.agentVersion, c: e.updateChannel }));
  check(e.hostname === 'acme-mbp' && e.osVersion === 'macOS 14.5', `hostname and OS from hostname -s and sw_vers: ${e.hostname} / ${e.osVersion}`);
  check(i?.osCaption === 'macOS 14.5' && i.osBuild === '23F79, Darwin 23.5.0' && i.osArch === 'arm64', 'inventory: OS, build and kernel, architecture', JSON.stringify({ c: i?.osCaption, b: i?.osBuild, a: i?.osArch }));
  check(i.cpuModel === 'Apple M2 Pro' && i.cpuCores === 10 && i.cpuThreads === 12 && i.cpuMhz == null, 'inventory: CPU from sysctl (no clock speed on Apple silicon)', JSON.stringify([i.cpuModel, i.cpuCores, i.cpuThreads, i.cpuMhz]));
  check(i.memoryTotalMb === 16384 && i.memoryFreeMb === 3125, `memory: 16384 MB from hw.memsize, 3125 MB available from vm_stat (free + inactive + speculative): ${i.memoryFreeMb}`);
  check(i.cpuLoadPercent === 13, `CPU load from top's second sample (87.25% idle → 13%), not its first: ${i.cpuLoadPercent}`);
  check(Math.abs(i.uptimeSeconds - (3 * 86400 + 123)) < 30 && Math.abs(i.lastBootAt.getTime() - (Date.now() - (3 * 86400 + 123) * 1000)) < 30_000,
    `uptime ${i.uptimeSeconds}s and last boot ${i.lastBootAt?.toISOString()} from kern.boottime, converted without date(1)`);
  const disks = Array.isArray(i.disks) ? i.disks : [];
  check(disks.length === 2 && disks[0].drive === '/' && disks[0].fsType === 'apfs' && disks[0].label === '/dev/disk3s1s1' && disks[0].totalBytes === 482797652 * 1024
    && disks[1].drive === '/Volumes/Archive' && disks[1].fsType === 'hfs', `disks: the startup volume and an external one, with types from mount; /System/Volumes/*, devfs and autofs left out: ${JSON.stringify(disks.map((d) => [d.drive, d.fsType]))}`);
  check(i.systemDiskTotalMb === Math.round(482797652 / 1024) && i.systemDiskFreeMb === Math.round(300000000 / 1024), 'system disk from df /');
  check(i.loggedOnUser === 'alice', `the console user only (not the ssh session): "${i.loggedOnUser}"`);
  check(i.manufacturer === 'Apple Inc.' && i.model === 'MacBook Pro (Mac14,10)' && i.serialNumber === 'SERIAL1234' && i.chassisType === 'Laptop' && i.biosVersion === '10151.121.1',
    `hardware from ioreg and system_profiler: ${JSON.stringify([i.manufacturer, i.model, i.serialNumber, i.chassisType, i.biosVersion])}`);
  check(!JSON.stringify(i).includes('UUID-THAT-IS-NOT-SENT'), 'the hardware UUID is not sent');
  const hostTz = (() => { try { return fs.readlinkSync('/etc/localtime').split('/zoneinfo/')[1] ?? null; } catch { return null; } })();
  check(i.timezone === hostTz, `time zone from /etc/localtime: ${i.timezone}`);
  check(e.rustdeskNode.version === '1.4.2', 'RustDesk version from RustDesk.app\'s Info.plist', e.rustdeskNode.version);
  let c = await cmds(A.id);
  check(c.length === 2 && c.every((x) => x.status === 'SUCCEEDED'), 'INVENTORY_REFRESH and UPDATE_SCAN both SUCCEEDED', JSON.stringify(c.map((x) => [x.type, x.status, x.error])));
  check(i.pendingUpdateCount === 2 && i.pendingUpdates[0].title === 'macOS Sonoma 14.6' && i.pendingUpdates[1].title === 'Safari 17.6' && i.rebootRequired == null && i.updatesCheckedAt,
    `pending updates from macOS's last check (defaults read): ${JSON.stringify(i.pendingUpdates?.map((u) => u.title))}; restart pending stays unknown`);
  check(fs.readFileSync(sbA.file('sp.calls'), 'utf8').trim() === 'SPHardwareDataType', 'system_profiler is asked for SPHardwareDataType only, and only on the inventory pass');
  check(!markers(sbA) && tmpEmpty(sbA), 'no state-changing command ran (softwareupdate, launchctl, shutdown, defaults write, …), and the temp directory was cleaned', markers(sbA));
  check(!run.out.includes(A.secret) && !/agentSecret/.test(run.out), 'the secret never appears in the agent\'s output');

  section('The same agent under bash --posix (macOS /bin/sh) and zsh\'s sh emulation');
  for (const shell of ['bash --posix', 'zsh (sh emulation)']) {
    const [bin] = SHELLS[shell](sbA);
    if (!bin || !fs.existsSync(bin)) { check(true, `${shell}: not installed here — skipped (set ZSH_BIN)`); continue; }
    await req('POST', `/endpoints/${A.id}/inventory/refresh`, { s: S.owen });
    fs.writeFileSync(sbA.fx('hostname'), `acme-${shell.split(' ')[0]}\n`);
    run = await runAgent(agentPath, sbA, { shell });
    i = await inv(A.id); e = await ep(A.id);
    check(run.code === 0 && /2 command\(s\) answered/.test(run.out) && e.hostname === `acme-${shell.split(' ')[0]}` && i.memoryFreeMb === 3125 && i.cpuLoadPercent === 13 && i.disks.length === 2,
      `${shell}: heartbeat and inventory land with the same values`, run.out);
  }
  fs.writeFileSync(sbA.fx('hostname'), 'acme-mbp\n');
  check(!markers(sbA), 'no marker ran under either', markers(sbA));

  // ── Hostile strings ────────────────────────────────────────────────────────
  section('Hostile device strings are reduced before they leave, and never evaluated');
  const pwn = sbA.file('PWNED');
  fs.writeFileSync(sbA.fx('sw_vers'), `ProductName:\tEvil" OS\x07 \x1b[31m$(touch ${pwn}) \`touch ${pwn}\`\nProductVersion:\t14.5 ${'A'.repeat(200)}\nBuildVersion:\t23F"79\\\n`);
  fs.writeFileSync(sbA.fx('hostname'), 'evil&calc"x\\y\n');
  fs.writeFileSync(sbA.fx('who'), 'ev"il;rm  console  Nov 11 09:00\n');
  fs.writeFileSync(sbA.fx('df'), DF.replace('/Volumes/Archive Disk', '/Volumes/da"ta\\ with spaces'));
  fs.writeFileSync(sbA.fx('mount'), MOUNT.replace('/Volumes/Archive Disk (hfs', '/Volumes/da"ta\\ with spaces (h"f$s'));
  fs.writeFileSync(sbA.fx('system_profiler'), SP.replace('Model Name: MacBook Pro', `Model Name: Mac$(touch ${pwn})Book "Pro"\x1b[0m\\`));
  fs.writeFileSync(sbA.fx('ioreg'), IOREG.replace('"SERIAL1234"', '"SER\\\\IAL`touch x`"'));
  fs.writeFileSync(sbA.file('su/RecommendedUpdates'), RECOMMENDED.replace('"Display Name" = Safari;', `"Display Name" = "Evil\\"Update$(touch ${pwn})\\\\";`));
  fs.writeFileSync(sbA.file('RustDesk.app/Contents/Info.plist'), INFO_PLIST('1.4.3"; rm -rf /; echo "'));
  r = await req('POST', `/endpoints/${A.id}/inventory/refresh`, { s: S.owen });
  check(r.status === 200 || r.status === 201, 'the owner asks for a refresh', msg(r));
  run = await runAgent(agentPath, sbA);
  check(run.code === 0 && /2 command\(s\) answered/.test(run.out), 'the run is accepted (every field within the heartbeat limits)', run.out);
  e = await ep(A.id); i = await inv(A.id);
  check(!fs.existsSync(pwn) && !fs.existsSync(path.join(sbA.dir, 'x')), 'no $( ) or backtick in sw_vers, system_profiler, ioreg or an update name was evaluated');
  check(e.hostname === 'evilcalcxy', `hostname reduced to the inert charset: "${e.hostname}"`);
  check(!CONTROL.test(e.osVersion) && !/["\\]/.test(e.osVersion) && e.osVersion.length <= 64 && e.osVersion.startsWith('Evil OS'), `OS name: no control characters, quotes or backslashes, ≤64: "${e.osVersion}"`);
  check(i.loggedOnUser === 'evilrm', `console user reduced: "${i.loggedOnUser}"`);
  check(i.disks[1]?.drive === '/Volumes/data wi' && !/["\\$]/.test(i.disks[1].fsType ?? '') && i.disks[1].fsType === 'hfs', `disk names stripped and clamped: ${JSON.stringify(i.disks[1])}`);
  check(!/["\\]/.test(i.model) && !CONTROL.test(i.model) && !/["\\]/.test(i.serialNumber ?? '') && !/["\\]/.test(i.osBuild), `model, serial and build inert: ${JSON.stringify([i.model, i.serialNumber, i.osBuild])}`);
  const evil = i.pendingUpdates.find((u) => u.title.startsWith('Evil'));
  check(evil && !/["\\]/.test(evil.title) && !CONTROL.test(evil.title), `a hostile update name arrives as inert text: "${evil?.title}"`);
  check(e.rustdeskNode.version === '1.4.3', `RustDesk version: only the leading x.y.z of Info.plist: ${e.rustdeskNode.version}`);
  check(!markers(sbA), 'nothing on the marker list ran', markers(sbA));
  // Restore the fixtures.
  for (const [k, v] of Object.entries({ sw_vers: SW_VERS, hostname: 'acme-mbp\n', who: 'alice    console  Nov 11 09:00 \n', df: DF, mount: MOUNT, system_profiler: SP, ioreg: IOREG })) fs.writeFileSync(sbA.fx(k), v);
  fs.writeFileSync(sbA.file('su/RecommendedUpdates'), RECOMMENDED);

  section('A binary Info.plist is converted to stdout, never in place');
  const bin = Buffer.concat([Buffer.from('bplist00'), randomBytes(40)]);
  fs.writeFileSync(sbA.file('RustDesk.app/Contents/Info.plist'), bin);
  fs.writeFileSync(sbA.fx('plist.xml'), INFO_PLIST('1.4.4'));
  run = await runAgent(agentPath, sbA);
  check(run.code === 0, 'the run with a binary Info.plist succeeds', run.out);
  e = await ep(A.id);
  const plCalls = fs.existsSync(sbA.file('plutil.calls')) ? fs.readFileSync(sbA.file('plutil.calls'), 'utf8').trim().split('\n') : [];
  check(e.rustdeskNode.version === '1.4.4' && plCalls.length === 1 && plCalls[0] === `-convert xml1 -o - ${sbA.file('RustDesk.app/Contents/Info.plist')}`, `plutil -convert xml1 -o - (to stdout): ${JSON.stringify(plCalls)}`);
  check(fs.readFileSync(sbA.file('RustDesk.app/Contents/Info.plist')).equals(bin), 'the bundle\'s Info.plist is unchanged');
  fs.writeFileSync(sbA.file('RustDesk.app/Contents/Info.plist'), INFO_PLIST('1.4.2'));

  // ── Read-only ──────────────────────────────────────────────────────────────
  section('Read-only: nothing the server stages is acted on, and the console refuses to stage it');
  r = await req('POST', `/endpoints/${A.id}/rotate-credential`, { s: S.owen });
  check(r.status === 400 && code(r) === 'MACOS_AGENT_READ_ONLY' && /not available on macOS/.test(JSON.stringify(r.body)), 'rotating the password from the console is refused for macOS', msg(r));
  r = await req('POST', `/endpoints/${A.id}/reinstall-agent`, { s: S.owen });
  check(r.status === 400 && code(r) === 'MACOS_AGENT_READ_ONLY', 'reinstalling from the console is refused for macOS', msg(r));
  r = await req('POST', `/endpoints/${A.id}/event-log`, { s: S.owen, body: { logName: 'System' } });
  check(r.status === 400 && code(r) === 'MACOS_AGENT_READ_ONLY', 'an event-log query is refused for macOS', msg(r));
  r = await req('POST', `/endpoints/${A.id}/diagnostics/runs`, { s: S.owen, body: { key: 'disk_space' } });
  check(r.status === 400 && code(r) === 'DIAGNOSTIC_OS_UNSUPPORTED', 'a catalog diagnostic is refused for macOS (Windows-only)', msg(r));
  await prisma.rustdeskNode.update({ where: { rustdeskId: A.rid }, data: { pendingPassword: encryptPassword('Rotated123'), pendingPasswordAt: new Date(), reinstallRequestedAt: new Date(), updateRequestedAt: new Date(), updateTargetVersion: '9.9.9' } });
  const evq = await prisma.endpointCommand.create({ data: { endpointId: A.id, tenantId: tenant.id, customerId: acme.id, type: 'EVENT_LOG_QUERY', params: { logName: 'System', levels: [], maxEvents: 5, sinceHours: 1, providerName: null }, requestedById: owen.id, expiresAt: new Date(Date.now() + 30 * 60_000) } });
  const rotateResp = await req('POST', '/enrollment/heartbeat', { body: { rustdeskId: A.rid, agentSecret: A.secret, platform: 'macos' } });
  check(!!rotateResp.data?.rotate?.password, 'the heartbeat response does carry the staged rotation (the agent must ignore it)', JSON.stringify(rotateResp.data).slice(0, 300));
  run = await runAgent(agentPath, sbA);
  const nodeAfter = await prisma.rustdeskNode.findUnique({ where: { rustdeskId: A.rid } });
  check(run.code === 0 && !markers(sbA), 'the agent ran nothing (softwareupdate, launchctl, shutdown, rustdesk, open, defaults write, … are all markers)', markers(sbA) || run.out);
  check(!!nodeAfter.pendingPassword && nodeAfter.updateTargetVersion === '9.9.9' && !!nodeAfter.updateRequestedAt, 'the rotation was never confirmed and the client update is still pending (nothing was applied)');
  const evAfter = await prisma.endpointCommand.findUnique({ where: { id: evq.id } });
  check(evAfter.status === 'FAILED' && /Windows-only: the macOS agent/.test(evAfter.error ?? ''), 'the event-log query is answered as failed, Windows-only — not left to expire', JSON.stringify([evAfter.status, evAfter.error]));
  await prisma.rustdeskNode.update({ where: { rustdeskId: A.rid }, data: { pendingPassword: null, pendingPasswordAt: null, reinstallRequestedAt: null, updateRequestedAt: null, updateTargetVersion: null } });

  // ── Wrong or missing secret ───────────────────────────────────────────────
  section('A wrong, missing, loose or foreign-owned secret is refused');
  const sec = sbA.file('secret');
  const rejBefore = await prisma.activityLog.count({ where: { action: 'ENDPOINT_HEARTBEAT_REJECTED', resourceId: A.id } });
  fs.writeFileSync(sec, randomBytes(32).toString('base64url'));
  fs.writeFileSync(sbA.fx('hostname'), 'attacker-host\n');
  run = await runAgent(agentPath, sbA);
  e = await ep(A.id);
  check(run.code === 0 && /HTTP 401/.test(run.out), 'a wrong secret: the server answers 401 and the agent says why', run.out);
  check(e.hostname !== 'attacker-host', 'nothing it said was written (hostname unchanged)');
  check(await prisma.activityLog.count({ where: { action: 'ENDPOINT_HEARTBEAT_REJECTED', resourceId: A.id } }) === rejBefore + 1, 'the refusal is audited (ENDPOINT_HEARTBEAT_REJECTED)');
  fs.rmSync(sec);
  run = await runAgent(agentPath, sbA);
  check(run.code === 1 && /no device secret/.test(run.out), 'a missing secret: the agent refuses locally', run.out);
  fs.writeFileSync(sec, A.secret);
  for (const mode of [0o644, 0o640, 0o660, 0o604]) {
    fs.chmodSync(sec, mode);
    run = await runAgent(agentPath, sbA);
    check(run.code === 1 && new RegExp(`mode ${mode.toString(8)}`).test(run.out), `a ${mode.toString(8)} secret: the agent refuses to use it`, run.out);
  }
  fs.chmodSync(sec, 0o600);
  // Owned by someone other than the account the agent runs as: without root
  // the file cannot be given away, so the agent is told it runs as uid 0.
  fs.writeFileSync(sbA.file('bin/id'), '#!/bin/sh\n[ "$1" = -u ] && echo 0\n', { mode: 0o755 });
  run = await runAgent(agentPath, sbA);
  check(run.code === 1 && new RegExp(`owned by uid ${os.userInfo().uid}, not by the account this agent runs as \\(0\\)`).test(run.out), 'a secret not owned by the agent\'s account (root): refused', run.out);
  fs.rmSync(sbA.file('bin/id'));
  check(await prisma.activityLog.count({ where: { action: 'ENDPOINT_HEARTBEAT_REJECTED', resourceId: A.id } }) === rejBefore + 1, 'none of the local refusals sent a request');
  r = await req('POST', '/enrollment/heartbeat', { body: { rustdeskId: A.rid, hostname: 'no-secret', platform: 'macos' } });
  check(r.status === 401 && (await ep(A.id)).hostname !== 'no-secret', 'a heartbeat with no secret for a bound computer: 401, nothing written', msg(r));
  r = await req('POST', '/enrollment/command-result', { body: { rustdeskId: A.rid, agentSecret: randomBytes(24).toString('base64url'), commandId: 'x', ok: true, inventory: { osCaption: 'forged' } } });
  check(r.status === 401, 'a command result with a wrong secret: 401', msg(r));
  fs.writeFileSync(sbA.file('agent.conf'), 'API_BASE=http://example.com/api/v1\n');
  run = await runAgent(agentPath, sbA);
  check(run.code === 1 && /not an https URL/.test(run.out), 'plain http to anything but this machine is refused', run.out);
  fs.writeFileSync(sbA.file('agent.conf'), `API_BASE=${API}\n`);
  fs.writeFileSync(sbA.fx('hostname'), 'acme-mbp\n');
  run = await runAgent(agentPath, sbA);
  e = await ep(A.id);
  check(run.code === 0 && /heartbeat ok/.test(run.out) && e.hostname === 'acme-mbp' && !e.rustdeskNode.candidateSecretHash, 'with the bound secret back, it reports again and the candidate is cleared', run.out);

  // ── Business isolation ─────────────────────────────────────────────────────
  section('Business isolation');
  const tokB = await mint(S.bea, birch.id);
  const B = { rid: rid(), secret: randomBytes(32).toString('base64url') };
  r = await req('POST', '/enrollment/claim', { body: { token: tokB, rustdeskId: A.rid, hostname: 'steal', platform: 'macos', agentSecret: B.secret } });
  check(r.status === 400 && (await ep(A.id)).customerId === acme.id, 'Birch\'s token cannot claim Acme\'s RustDesk ID', msg(r));
  r = await req('POST', '/enrollment/claim', { body: { token: tokB, rustdeskId: B.rid, hostname: 'birch-imac', platform: 'macos', agentSecret: B.secret } });
  B.id = r.data?.endpoint?.id;
  check(r.status === 200 && B.id, 'Birch claims its own Mac', msg(r));
  const sbB = sandbox('birch', B);
  run = await runAgent(agentPath, sbB);
  check(run.code === 0 && (await inv(B.id))?.collectedAt && (await ep(B.id)).hostname === 'birch-mbp', 'Birch\'s agent reports its own inventory', run.out);
  r = await req('GET', `/endpoints/${A.id}/inventory`, { s: S.bea });
  check(r.status === 403 || r.status === 404, 'Birch\'s owner cannot read Acme\'s inventory', msg(r));
  r = await req('GET', `/endpoints/${B.id}/inventory`, { s: S.owen });
  check(r.status === 403 || r.status === 404, 'Acme\'s owner cannot read Birch\'s inventory', msg(r));
  r = await req('GET', `/endpoints/${A.id}/inventory`, { s: S.owen });
  check(r.status === 200 && r.data?.inventory?.endpointId === A.id, 'Acme\'s owner reads Acme\'s', msg(r));
  r = await req('POST', `/endpoints/${A.id}/rotate-credential`, { s: S.bea });
  check(r.status === 403 || r.status === 404, 'Birch\'s owner gets not-found, not the macOS refusal, for Acme\'s Mac', msg(r));
  const listB = await req('GET', '/endpoints/list', { s: S.bea });
  const listA = await req('GET', '/endpoints/list', { s: S.owen });
  const idsB = (listB.data?.rows ?? []).map((x) => x.id), idsA = (listA.data?.rows ?? []).map((x) => x.id);
  check(idsB.includes(B.id) && !idsB.includes(A.id) && idsA.includes(A.id) && !idsA.includes(B.id), 'each device list shows only its own business\'s Mac', JSON.stringify({ idsA, idsB }));
  const rowA = (listA.data?.rows ?? []).find((x) => x.id === A.id);
  check(rowA?.platform === 'macos' && rowA.agent?.type === 'standard' && rowA.agent.version === VERSION && rowA.patches?.source === 'standard_agent_scan', 'the device list shows it as the standard agent on macos, with a standard scan', JSON.stringify([rowA?.agent, rowA?.patches?.source]));
  fs.writeFileSync(sbB.file('RustDesk.toml'), `id = '${A.rid}'\n`);
  fs.writeFileSync(sbB.fx('hostname'), 'hijack\n');
  run = await runAgent(agentPath, sbB);
  check(/HTTP 401/.test(run.out) && (await ep(A.id)).hostname === 'acme-mbp', 'Birch\'s secret under Acme\'s RustDesk ID: 401, Acme unchanged', run.out);
  fs.writeFileSync(sbB.file('RustDesk.toml'), `id = '${B.rid}'\n`);
  await req('POST', `/endpoints/${A.id}/inventory/refresh`, { s: S.owen });
  const acmeCmd = await prisma.endpointCommand.findFirst({ where: { endpointId: A.id, status: 'PENDING' }, orderBy: { createdAt: 'desc' } });
  r = await req('POST', '/enrollment/command-result', { body: { rustdeskId: B.rid, agentSecret: B.secret, commandId: acmeCmd.id, ok: true, inventory: { osCaption: 'forged by birch' } } });
  check(r.status === 200 && r.data?.accepted === false && r.data?.reason === 'unknown_command', 'Birch cannot close or fill a command staged for Acme', msg(r));
  check((await prisma.endpointCommand.findUnique({ where: { id: acmeCmd.id } })).status === 'PENDING' && (await inv(A.id)).osCaption !== 'forged by birch', 'Acme\'s command and inventory are untouched');

  // ── Pending updates ────────────────────────────────────────────────────────
  section('Pending updates: from macOS\'s own last check; unknown when there is none or it is stale');
  const tokC = await mint(S.owen, acme.id);
  const C = { rid: rid(), secret: randomBytes(32).toString('base64url') };
  r = await req('POST', '/enrollment/claim', { body: { token: tokC, rustdeskId: C.rid, hostname: 'acme-mini', platform: 'macos', agentSecret: C.secret } });
  C.id = r.data?.endpoint?.id;
  const sbC = sandbox('acme-c', C);
  fs.rmSync(sbC.file('su/LastSuccessfulDate'));
  fs.writeFileSync(sbC.file('su/AutomaticCheckEnabled'), '0\n');
  // A hung system_profiler, too: the inventory must still land.
  fs.writeFileSync(sbC.fx('sp.sleep'), '40');
  run = await runAgent(agentPath, sbC);
  let cc = await cmds(C.id); i = await inv(C.id);
  const upd = cc.find((x) => x.type === 'UPDATE_SCAN');
  check(upd?.status === 'FAILED' && /unknown: macOS has not recorded a successful software update check\. Automatic checking is turned off/.test(upd.error ?? '') && /does not run Software Update itself/.test(upd.error),
    'no recorded check: the scan is reported failed, "unknown", with automatic checking named as the reason', JSON.stringify([upd?.status, upd?.error]));
  check(i?.pendingUpdateCount == null && i?.updatesCheckedAt == null && i?.collectedAt, 'nothing claims "0 pending": the count stays unknown, and the rest of the inventory landed');
  check(run.ms < 15_000 + 8_000 && run.ms >= 15_000 && i.serialNumber === 'SERIAL1234' && i.model === 'Mac14,10' && i.biosVersion == null,
    `a hung system_profiler is cut off at SP_TIMEOUT (run took ${(run.ms / 1000).toFixed(1)} s); serial and model still come from ioreg`, JSON.stringify([i.serialNumber, i.model]));
  fs.rmSync(sbC.fx('sp.sleep'));
  run = await runAgent(agentPath, sbC);
  cc = await cmds(C.id);
  check(cc.filter((x) => x.type === 'UPDATE_SCAN').length === 1 && /0 command\(s\)/.test(run.out), 'the next heartbeat does not ask again (no failed row every three minutes)', JSON.stringify(cc.map((x) => [x.type, x.status])));
  r = await req('GET', `/endpoints/${C.id}/patches`, { s: S.owen });
  check(r.status === 200 && r.data?.summary?.evidence?.source === 'none', 'the Patches tab says no scan received, not "up to date"', msg(r));

  fs.writeFileSync(sbC.file('su/LastSuccessfulDate'), `${plistDate(80 * 3600_000)}\n`);
  await req('POST', `/endpoints/${C.id}/inventory/refresh`, { s: S.owen });
  await runAgent(agentPath, sbC);
  cc = await cmds(C.id);
  check(/unknown: macOS last checked for updates 80 hours ago \(more than 36\)\. Automatic checking is turned off/.test(cc.at(-1)?.error ?? ''), 'a check older than 36 hours is stale: failed with its age, not presented as current', cc.at(-1)?.error);

  fs.writeFileSync(sbC.file('su/LastSuccessfulDate'), `${plistDate(30 * 60_000)}\n`);
  fs.writeFileSync(sbC.file('su/AutomaticCheckEnabled'), '1\n');
  fs.rmSync(sbC.file('su/RecommendedUpdates'));
  await req('POST', `/endpoints/${C.id}/inventory/refresh`, { s: S.owen });
  await runAgent(agentPath, sbC);
  cc = await cmds(C.id);
  check(cc.at(-1)?.status === 'FAILED' && /recorded a check but no list/.test(cc.at(-1)?.error ?? ''), 'a recent check with no list and no count: unknown, not "none"', cc.at(-1)?.error);
  fs.writeFileSync(sbC.file('su/LastRecommendedUpdatesAvailable'), '0\n');
  await req('POST', `/endpoints/${C.id}/inventory/refresh`, { s: S.owen });
  await runAgent(agentPath, sbC);
  i = await inv(C.id); cc = await cmds(C.id);
  check(cc.at(-1)?.status === 'SUCCEEDED' && i.pendingUpdateCount === 0 && i.updatesCheckedAt, 'a recent check that recorded zero available: 0 pending');
  r = await req('GET', `/endpoints/${C.id}/patches`, { s: S.owen });
  check(r.status === 200 && r.data?.summary?.evidence?.source === 'standard_agent_scan', 'the Patches tab shows it as a standard agent scan (read-only)', JSON.stringify(r.data?.summary?.evidence));
  fs.writeFileSync(sbC.file('su/LastSuccessfulDate'), 'garbage date\n');
  await req('POST', `/endpoints/${C.id}/inventory/refresh`, { s: S.owen });
  await runAgent(agentPath, sbC);
  cc = await cmds(C.id);
  check(/could not read the time of macOS's last update check/.test(cc.at(-1)?.error ?? '') && (await inv(C.id)).pendingUpdateCount === 0, 'an unreadable check time is unknown too; the last good result stays', cc.at(-1)?.error);
  check(!markers(sbC) && !markers(sbB) && !markers(sbA), 'no marker ran on any of the three Macs: softwareupdate was never invoked, in any form', [markers(sbA), markers(sbB), markers(sbC)].join(' | '));
}

let crashed = null;
try { await all(); } catch (e) { crashed = e; console.error(e); }
await stopApi();
await prisma.$disconnect();
try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* best-effort */ }
if (crashed) { console.error(`\nCRASHED after ${pass} passed, ${fail} failed`); if (api?.log) console.error(api.log.slice(-2000)); process.exit(1); }
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
