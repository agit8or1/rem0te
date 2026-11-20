#!/usr/bin/env node
/**
 * Capture wire fixtures (0.73.1): the request bodies each released standard
 * agent sends, produced by that release's own scripts. docs/compatibility.md.
 *
 *   node scripts/compat/capture-wire.mjs                 # every agent × tag in wire/agents.json
 *   node scripts/compat/capture-wire.mjs linux v0.64.0   # one
 *   PWSH=/path/to/pwsh node scripts/compat/capture-wire.mjs windows v0.68.3
 *
 * For each tag it takes `apps/api/src/public` from `git archive <tag>` (never
 * the working tree), transpiles the script builders and generates the scripts
 * that release served. Then it runs them:
 *
 *   linux, macos  the standard agent (`rem0te-agent`) under sh, with its own
 *                 test overrides, OS commands stubbed on PATH and its absolute
 *                 /proc, /sys and /etc reads rerooted into a fixture tree; real
 *                 curl to a loopback capture server on 127.0.0.1. The
 *                 installer's registration block (claim, or an unclaimed
 *                 heartbeat) is cut out of the release's installer and run
 *                 under bash with a curl stub that records `-d`.
 *   windows       heartbeat.ps1, the installer's `Register` function and
 *                 retry-enroll.ps1, cut out of the release's installer and run
 *                 under PowerShell 7 with capture/windows-prelude.ps1 standing
 *                 in for Windows (CIM, the registry, Windows Update, event
 *                 logs) and for Invoke-RestMethod, which records the body.
 *                 Windows paths are rewritten into a scratch directory.
 *
 * The bodies are the agent's own bytes; only the values are synthetic. Known
 * values (RustDesk ID, device secret, password, token, command and run ids,
 * tray key id) are replaced with {{placeholders}} that compat-wire.mjs fills
 * at replay. Nothing is sent anywhere: the server side is a canned stub.
 *
 * Output: scripts/compat/wire/<agent>/<tag>/NN-<name>.json and manifest.json.
 * Commit them. CI replays them (scripts/compat-wire.mjs); it does not capture.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..', '..');
const WIRE = path.join(here, 'wire');
const require = createRequire(path.join(ROOT, 'apps', 'api', 'package.json'));
const ts = require('typescript');
const AGENTS = JSON.parse(fs.readFileSync(path.join(WIRE, 'agents.json'), 'utf8'));
const CAPTURE_PORT = Number(process.env.WIRE_CAPTURE_PORT ?? 3989);
if (CAPTURE_PORT < 3981 || CAPTURE_PORT > 3989) { console.error('WIRE_CAPTURE_PORT must be in 3981–3989'); process.exit(2); }

// ── The synthetic values, and the placeholders they become ─────────────────
const V = {
  rid: '987654321',
  secret: 'wireFixtureDeviceSecret_0123456789abcdefABCDEF',
  password: 'WirePermPassword1',
  token: '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0',
  rotate: 'WireRotatedPassword2',
  trayKeyId: 'wiretraykeyid00000000001',
  host: 'portal.wire.example',
};
const sha = (s) => createHash('sha256').update(s).digest('hex');
const CMD = { INVENTORY_REFRESH: 'wirecmd-inventory-refresh', UPDATE_SCAN: 'wirecmd-update-scan', EVENT_LOG_QUERY: 'wirecmd-event-log-query' };
const DIAG = (k) => `wirediag-${k.replace(/_/g, '-')}`;
const PLACEHOLDERS = [
  [V.rid, '{{rustdeskId}}'], [V.secret, '{{agentSecret}}'], [V.token, '{{token}}'], [V.rotate, '{{rotatePassword}}'],
  [V.password, '{{password}}'], [sha(V.rotate), '{{sha256:rotatePassword}}'], [V.trayKeyId, '{{trayKeyId}}'],
  ...Object.entries(CMD).map(([t, id]) => [id, `{{commandId:${t}}}`]),
];
function placehold(v, diagKeys) {
  if (typeof v === 'string') {
    for (const k of diagKeys) if (v === DIAG(k)) return `{{diagRunId:${k}}}`;
    for (const [real, ph] of PLACEHOLDERS) if (v === real) return ph;
    for (const [real, ph] of PLACEHOLDERS) if (v.includes(real)) throw new Error(`a synthetic secret is embedded in "${v.slice(0, 80)}"`);
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => placehold(x, diagKeys));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, placehold(x, diagKeys)]));
  return v;
}

// ── A release's script builders, from git archive ───────────────────────────
function loadTag(tag, scratch) {
  const dir = path.join(scratch, 'src');
  fs.mkdirSync(dir, { recursive: true });
  const tar = execFileSync('git', ['-C', ROOT, 'archive', tag, 'apps/api/src/public'], { maxBuffer: 64 << 20 });
  execFileSync('tar', ['-x', '-C', dir], { input: tar });
  const pub = path.join(dir, 'apps', 'api', 'src', 'public');
  for (const f of fs.readdirSync(pub)) {
    if (!f.endsWith('.ts') || f.endsWith('.spec.ts')) continue;
    const src = fs.readFileSync(path.join(pub, f), 'utf8');
    const out = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, experimentalDecorators: true } });
    fs.writeFileSync(path.join(pub, f.replace(/\.ts$/, '.js')), out.outputText);
  }
  const req = createRequire(path.join(pub, 'x.js'));
  return { pub, req, controllerText: fs.readFileSync(path.join(pub, 'public.controller.ts'), 'utf8') };
}

// The installer's "Always register" block, as the release's controller holds
// it inside a template literal: cut out, un-escaped exactly as the template
// literal would be, and refused if it interpolates anything.
function registrationBlocks(controllerText) {
  const out = [];
  let at = 0;
  for (;;) {
    const i = controllerText.indexOf('# Always register', at);
    if (i < 0) break;
    const end = controllerText.indexOf('\nfi\n', i);
    const raw = controllerText.slice(i, end + 4);
    if (/(^|[^\\])\$\{/.test(raw)) throw new Error('the registration block interpolates a value; cannot evaluate it alone');
    out.push(new Function(`return \`${raw}\`;`)());
    at = end;
  }
  return out;
}

// ── Loopback capture server for the POSIX agents ───────────────────────────
function captureServer(responses) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      const p = req.url.replace(/^\/api\/v1/, '');
      seen.push({ path: p, method: req.method, body: b });
      const r = responses[p] ?? responses.default;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(typeof r === 'string' ? r : JSON.stringify(r));
    });
  });
  return new Promise((resolve) => srv.listen(CAPTURE_PORT, '127.0.0.1', () => resolve({ seen, close: () => new Promise((r) => srv.close(r)) })));
}
const run = (cmd, args, opts) => new Promise((resolve) => {
  const p = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
  p.on('exit', (code) => resolve({ code, out }));
});
const which = (t) => { try { return execFileSync('sh', ['-c', `command -v ${t}`], { encoding: 'utf8' }).trim(); } catch { return ''; } };
function stubDir(dir, stubs, real) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [c, body] of Object.entries(stubs)) fs.writeFileSync(path.join(dir, c), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  for (const t of real) { const p = which(t); if (p && !stubs[t]) fs.symlinkSync(p, path.join(dir, t)); }
}
const POSIX_TOOLS = ['sh', 'curl', 'sed', 'grep', 'awk', 'tr', 'cut', 'head', 'cat', 'wc', 'stat', 'id', 'mktemp', 'rm', 'sleep', 'date', 'readlink', 'printf', 'touch', 'sort'];

// The heartbeat response the stub hands a POSIX agent: authenticated, with one
// command of each type, serialised id-then-type as the server does.
const posixHeartbeatResponse = () => JSON.stringify({ success: true, data: {
  found: true, authenticated: true, rotate: null, updateRustdesk: null, reinstallAgent: null,
  commands: Object.entries(CMD).map(([type, id]) => ({ id, type, params: type === 'EVENT_LOG_QUERY' ? { logName: 'System', sinceHours: 24, maxEvents: 10 } : null })),
} });

// ── Linux ──────────────────────────────────────────────────────────────────
async function captureLinux(tag, scratch, mod) {
  const version = tag.slice(1);
  const agent = mod.req('./linux-agent.js').buildLinuxAgentScript(version);
  const sb = path.join(scratch, 'linux');
  const fx = path.join(sb, 'root');
  // The fixture tree the absolute reads are rerooted into.
  const files = {
    'proc/uptime': '273600.42 2000000.00\n',
    'proc/stat': 'cpu  1000 0 500 8000 100 0 0 0 0 0\ncpu0 1000 0 500 8000 100 0 0 0 0 0\nbtime 1795000000\n',
    'proc/meminfo': 'MemTotal:       16303104 kB\nMemFree:         2048000 kB\nMemAvailable:    9437184 kB\nBuffers:          100000 kB\nCached:          4000000 kB\n',
    'proc/cpuinfo': 'processor\t: 0\nmodel name\t: Fixture CPU 4-Core\nphysical id\t: 0\ncore id\t\t: 0\ncpu MHz\t\t: 2400.000\n\nprocessor\t: 1\nmodel name\t: Fixture CPU 4-Core\nphysical id\t: 0\ncore id\t\t: 1\ncpu MHz\t\t: 2400.000\n',
    'sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq': '3600000\n',
    'etc/timezone': 'Etc/UTC\n',
    'usr/share/update-notifier/notify-reboot-required': '',
    'os-release': 'NAME="Ubuntu"\nVERSION="24.04.1 LTS (Noble Numbat)"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\nID=ubuntu\n',
    'dmi/sys_vendor': 'Contoso Hardware\n', 'dmi/product_name': 'Fixture 9000\n', 'dmi/product_serial': 'WIRE-SERIAL-0002\n',
    'dmi/chassis_type': '3\n', 'dmi/bios_version': '1.2.3\n', 'dmi/bios_date': '03/14/2024\n',
  };
  for (const [f, s] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(fx, f)), { recursive: true }); fs.writeFileSync(path.join(fx, f), s); }
  let text = agent;
  for (const p of ['/proc/', '/sys/devices/', '/etc/timezone', '/usr/share/update-notifier/', '/run/reboot-required', '/var/run/reboot-required']) text = text.split(p).join(fx + p);
  // /etc/localtime is read with readlink; a link in the tree gives the zone.
  fs.mkdirSync(path.join(fx, 'etc'), { recursive: true });
  fs.symlinkSync('/usr/share/zoneinfo/Etc/UTC', path.join(fx, 'etc', 'localtime'));
  text = text.split('/etc/localtime').join(path.join(fx, 'etc', 'localtime'));
  const bin = path.join(sb, 'bin');
  stubDir(bin, {
    hostname: `printf 'wire-fixture-linux\\n'`,
    uname: `case "$1" in -r) echo 6.8.0-49-generic;; -m) echo x86_64;; -n) echo wire-fixture-linux;; *) echo Linux;; esac`,
    who: `printf 'tech     pts/0        2026-11-20 09:00 (192.0.2.20)\\n'`,
    df: `case "$*" in *T*) printf 'Filesystem Type 1024-blocks Used Available Capacity Mounted on\\n/dev/sda2 ext4 102687672 40000000 57440000 42%% /\\n/dev/sda1 vfat 1098632 6216 1092416 1%% /boot/efi\\ntmpfs tmpfs 1630312 2000 1628312 1%% /run\\n';; *) printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/sda2 102687672 40000000 57440000 42%% /\\n';; esac`,
    'dpkg-query': `printf 'rustdesk\\t1.4.1\\n'`,
    dpkg: 'exit 0',
    apt: `printf 'Listing...\\nopenssl/noble-updates,noble-security 3.0.13-0ubuntu3.5 amd64 [upgradable from: 3.0.13-0ubuntu3.4]\\ncurl/noble-updates 8.5.0-2ubuntu10.6 amd64 [upgradable from: 8.5.0-2ubuntu10.5]\\n'`,
    nproc: 'echo 2',
  }, POSIX_TOOLS);
  return capturePosix({ tag, sb, text, platform: 'linux', env: {
    PATH: bin, REM0TE_OS_RELEASE: path.join(fx, 'os-release'), REM0TE_DMI_DIR: path.join(fx, 'dmi'),
  }, mod, installerIndex: 0, hostnameCmd: 'hostname -s' });
}

// ── macOS ──────────────────────────────────────────────────────────────────
async function captureMacos(tag, scratch, mod) {
  const version = tag.slice(1);
  const agent = mod.req('./macos-agent.js').buildMacosAgentScript(version);
  const sb = path.join(scratch, 'macos');
  const sys = path.join(sb, 'sys'), su = path.join(sb, 'su');
  fs.mkdirSync(sys, { recursive: true }); fs.mkdirSync(su, { recursive: true });
  const sysctls = { 'kern.boottime': '{ sec = 1795000000, usec = 517000 } Sun Nov  1 09:00:00 2026\n', 'hw.memsize': '17179869184\n',
    'machdep.cpu.brand_string': 'Apple M2 Pro\n', 'hw.physicalcpu': '10\n', 'hw.logicalcpu': '12\n', 'hw.model': 'Mac14,10\n', 'hw.cpufrequency_max': '3504000000\n' };
  for (const [k, v] of Object.entries(sysctls)) fs.writeFileSync(path.join(sys, k), v);
  const recent = new Date(Date.now() - 2 * 3600_000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' +0000');
  fs.writeFileSync(path.join(su, 'LastSuccessfulDate'), `${recent}\n`);
  fs.writeFileSync(path.join(su, 'AutomaticCheckEnabled'), '1\n');
  fs.writeFileSync(path.join(su, 'RecommendedUpdates'), '(\n        {\n        "Display Name" = "macOS Sonoma 14.6";\n        "Display Version" = "14.6";\n        Identifier = "MSU_UPDATE_23G80_patch_14.6";\n        "Product Key" = "MSU_UPDATE_23G80_patch_14.6";\n    }\n)\n');
  const app = path.join(sb, 'RustDesk.app', 'Contents');
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, 'Info.plist'), '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n\t<key>CFBundleName</key>\n\t<string>RustDesk</string>\n\t<key>CFBundleShortVersionString</key>\n\t<string>1.4.1</string>\n</dict>\n</plist>\n');
  const bin = path.join(sb, 'bin');
  const TOP = 'Processes: 512 total\n2026/11/20 09:00:00\nCPU usage: 30.0% user, 20.0% sys, 50.0% idle\n\nProcesses: 512 total\n2026/11/20 09:00:01\nCPU usage: 8.25% user, 4.5% sys, 87.25% idle\n';
  fs.writeFileSync(path.join(sb, 'top.txt'), TOP);
  stubDir(bin, {
    sw_vers: `printf 'ProductName:\\t\\tmacOS\\nProductVersion:\\t\\t14.5\\nBuildVersion:\\t\\t23F79\\n'`,
    top: `cat '${path.join(sb, 'top.txt')}'`,
    vm_stat: `printf 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\\nPages free:                               20000.\\nPages active:                            300000.\\nPages inactive:                          150000.\\nPages speculative:                        30000.\\nPages wired down:                        100000.\\nPages purgeable:                          10000.\\n'`,
    df: `case "$*" in '-Pk /') printf 'Filesystem     1024-blocks      Used Available Capacity  Mounted on\\n/dev/disk3s1s1   482797652  10000000 300000000     4%%    /\\n';; *) printf 'Filesystem     1024-blocks      Used Available Capacity  Mounted on\\n/dev/disk3s1s1   482797652  10000000 300000000     4%%    /\\ndevfs                  206       206         0   100%%    /dev\\n/dev/disk3s5     482797652 170000000 300000000    37%%    /System/Volumes/Data\\n';; esac`,
    mount: `printf '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)\\ndevfs on /dev (devfs, local, nobrowse)\\n/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse, protect)\\n'`,
    ioreg: `printf '+-o Mac14,10  <class IOPlatformExpertDevice>\\n    {\\n      "manufacturer" = <"Apple Inc.">\\n      "model" = <"Mac14,10">\\n      "IOPlatformSerialNumber" = "WIRESERIAL03"\\n    }\\n'`,
    system_profiler: `printf 'Hardware:\\n\\n    Hardware Overview:\\n\\n      Model Name: MacBook Pro\\n      Model Identifier: Mac14,10\\n      Chip: Apple M2 Pro\\n      Total Number of Cores: 12 (8 performance and 4 efficiency)\\n      Memory: 16 GB\\n      System Firmware Version: 10151.121.1\\n      Serial Number (system): WIRESERIAL03\\n'`,
    who: `printf 'tech     console  Nov 20 09:00 \\n'`,
    hostname: `printf 'wire-fixture-mac\\n'`,
    uname: `case "$1" in -r) echo 23.5.0;; -m) echo arm64;; -n) echo wire-fixture-mac.local;; *) echo Darwin;; esac`,
    sysctl: `[ "$1" = -n ] || exit 1; f='${sys}/'"$2"; [ -f "$f" ] || exit 1; cat "$f"`,
    defaults: `[ "$1" = read ] || exit 1; f='${su}/'"$3"; [ -f "$f" ] || exit 1; cat "$f"`,
    plutil: 'exit 1',
    dscl: `echo "NFSHomeDirectory: ${sb}/home"`,
    timeout: 'shift; exec "$@"',
  }, POSIX_TOOLS);
  return capturePosix({ tag, sb, text: agent, platform: 'macos', env: {
    PATH: '/nonexistent', REM0TE_TEST_PATH: bin, REM0TE_RUSTDESK_APP: path.join(sb, 'RustDesk.app'),
  }, mod, installerIndex: 1 });
}

async function capturePosix({ tag, sb, text, platform, env, mod, installerIndex }) {
  const agentPath = path.join(sb, 'rem0te-agent');
  fs.writeFileSync(agentPath, text, { mode: 0o755 });
  fs.mkdirSync(path.join(sb, 'tmp'), { recursive: true });
  fs.writeFileSync(path.join(sb, 'agent.conf'), `API_BASE=http://127.0.0.1:${CAPTURE_PORT}/api/v1\n`);
  fs.writeFileSync(path.join(sb, 'secret'), V.secret, { mode: 0o600 });
  fs.writeFileSync(path.join(sb, 'RustDesk.toml'), `id = '${V.rid}'\n`);
  const exchanges = [];

  // The installer's registration: claim with a token, and the unclaimed heartbeat.
  const blocks = registrationBlocks(mod.controllerText);
  const block = blocks[installerIndex];
  if (!block) throw new Error(`no registration block ${installerIndex} in the ${tag} installer`);
  const cbin = path.join(sb, 'cbin');
  const curlLog = path.join(sb, 'curl.jsonl');
  // The curl stub records the URL path and the -d argument, as the installer passed them.
  stubDir(cbin, { curl: `u=''; d=''; while [ $# -gt 0 ]; do case "$1" in -d) d="$2"; shift;; https://*) u="$1";; esac; shift; done\n`
    + `node -e 'const fs=require("fs");fs.appendFileSync(process.argv[1], JSON.stringify({path:new URL(process.argv[2]).pathname.replace(/^\\/api\\/v1/,""),method:"POST",body:process.argv[3]})+"\\n")' '${curlLog}' "$u" "$d"\n`
    + `echo '{"success":true,"data":{}}'` }, ['sh', 'cat', 'printf']);
  fs.symlinkSync(process.execPath, path.join(cbin, 'node'));
  for (const [label, token] of [['claim', V.token], ['register-heartbeat', '']]) {
    fs.rmSync(curlLog, { force: true });
    const pre = `RD_ID='${V.rid}'\nCLAIM_TOKEN='${token}'\nHOST_ADDR='${V.host}'\nHOSTNAME_SHORT='wire-fixture-${platform === 'linux' ? 'linux' : 'mac'}'\nPERM_PW='${V.password}'\nAGENT_SECRET='${V.secret}'\n`;
    const f = path.join(sb, `register-${label}.sh`);
    fs.writeFileSync(f, pre + block);
    const r = await run(which('bash'), [f], { env: { PATH: cbin } });
    if (r.code !== 0) throw new Error(`${tag} ${platform} registration (${label}) exited ${r.code}: ${r.out}`);
    const got = fs.readFileSync(curlLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    if (got.length !== 1) throw new Error(`${tag} ${platform} registration (${label}) made ${got.length} calls`);
    exchanges.push({ name: label === 'claim' ? 'installer-claim' : 'installer-register-heartbeat', identity: label === 'claim' ? 'claimed' : 'pooled', ...got[0],
      source: `the ${tag} installer's registration block, run under bash with a recording curl` });
  }

  // The agent itself.
  const srv = await captureServer({ '/enrollment/heartbeat': posixHeartbeatResponse(), default: { success: true, data: { recorded: true } } });
  let r;
  try {
    r = await run(which('dash') || which('sh'), [agentPath], { cwd: sb, env: {
      HOME: sb, TMPDIR: path.join(sb, 'tmp'), LANG: 'C',
      REM0TE_AGENT_CONF: path.join(sb, 'agent.conf'), REM0TE_AGENT_SECRET_FILE: path.join(sb, 'secret'), REM0TE_RUSTDESK_CONFIG: path.join(sb, 'RustDesk.toml'), ...env,
    } });
  } finally { await srv.close(); }
  if (r.code !== 0 || !/3 command\(s\) answered/.test(r.out)) throw new Error(`${tag} ${platform} agent run failed (${r.code}): ${r.out}`);
  const order = { INVENTORY_REFRESH: 0, UPDATE_SCAN: 1, EVENT_LOG_QUERY: 2 };
  for (const s of srv.seen) {
    const b = JSON.parse(s.body);
    if (s.path === '/enrollment/heartbeat') exchanges.push({ name: 'heartbeat', identity: 'claimed', ...s, stage: { commands: Object.keys(CMD) }, source: `the ${tag} agent (rem0te-agent), run under dash against a loopback stub` });
    else {
      const type = Object.entries(CMD).find(([, id]) => id === b.commandId)?.[0];
      exchanges.push({ name: `command-result-${type.toLowerCase().replace(/_/g, '-')}`, identity: 'claimed', commandType: type, ...s, _o: order[type], source: `the ${tag} agent (rem0te-agent), run under dash against a loopback stub` });
    }
  }
  // The POSIX contract: what the agent reads from a heartbeat response.
  const m = text.match(/grep -oE '(\\\{"id":"[^']+)'/);
  if (!m) throw new Error(`${tag} ${platform}: cannot find the command pattern the agent greps for`);
  const contract = { heartbeat: { rawContains: ['"authenticated":true'], commandPattern: m[1] } };
  return { exchanges, contract, evidence: 'captured' };
}

// ── Windows (standard agent) ───────────────────────────────────────────────
function cut(text, start, endRe, what) {
  const i = text.indexOf(start);
  if (i < 0) return null;
  const rest = text.slice(i + start.length);
  const m = rest.match(endRe);
  if (!m) throw new Error(`cannot find the end of ${what}`);
  return rest.slice(0, m.index);
}
async function captureWindows(tag, scratch, mod) {
  const pwsh = process.env.PWSH || which('pwsh');
  if (!pwsh) throw new Error('pwsh is needed to capture the Windows agent (set PWSH)');
  const version = tag.slice(1);
  const ws = mod.req('./windows-script.js');
  const script = ws.buildLegacyWindowsScript({ version: '1.4.1', host: V.host, key: 'V2lyZUZpeHR1cmVQdWJsaWNLZXlOb3RSZWFsMDAwMDA=', enrollToken: V.token,
    clientSha256: null, updateNonce: null, agentVersion: version, fallbackVersion: '1.4.1', traySha256: null });
  const sb = path.join(scratch, 'windows');
  const pd = path.join(sb, 'ProgramData', 'Rem0te');
  const pf = path.join(sb, 'Program Files');
  fs.mkdirSync(path.join(pd, 'tray'), { recursive: true });
  fs.mkdirSync(path.join(pf, 'RustDesk'), { recursive: true });
  fs.mkdirSync(path.join(pf, 'Rem0te', 'tray'), { recursive: true });
  const rdexe = path.join(pf, 'RustDesk', 'rustdesk.exe');
  fs.writeFileSync(rdexe, `#!/bin/sh\n[ "$1" = --get-id ] && echo '${V.rid}'\nexit 0\n`, { mode: 0o755 });
  // A tray is installed (the standard installer put it there), not yet paired.
  fs.writeFileSync(path.join(pf, 'Rem0te', 'tray', 'rem0te-tray.exe'), 'not a program');
  // Windows paths in the agent's text, rewritten into the scratch tree. The
  // escaped forms are what a PowerShell single-quoted string holds.
  const rewrite = (t) => t
    .split('C:\\ProgramData\\Rem0te').join(pd)
    .split('C:\\Program Files\\RustDesk\\rustdesk.exe').join(rdexe)
    .split('C:\\Program Files\\Rem0te').join(path.join(pf, 'Rem0te'))
    .split('[Environment]::OSVersion.VersionString').join("'Microsoft Windows NT 10.0.22631.0'");
  const prelude = fs.readFileSync(path.join(here, 'capture', 'windows-prelude.ps1'), 'utf8');
  const capFile = path.join(sb, 'capture.jsonl');
  const respFile = path.join(sb, 'responses.json');
  const env = { ...process.env, WIRE_CAPTURE: capFile, WIRE_RESPONSES: respFile, WIRE_RDEXE: rdexe, ProgramFiles: pf, HOME: sb, TMPDIR: path.join(sb, 'tmp') };
  fs.mkdirSync(path.join(sb, 'tmp'), { recursive: true });
  const runPs = async (name, body, responses) => {
    fs.writeFileSync(respFile, JSON.stringify(responses));
    fs.rmSync(capFile, { force: true });
    const f = path.join(sb, `${name}.ps1`);
    fs.writeFileSync(f, `${prelude}\n${body}\n`);
    const r = await run(pwsh, ['-NoProfile', '-NonInteractive', '-File', f], { cwd: sb, env });
    if (r.code !== 0) throw new Error(`${tag} windows ${name} exited ${r.code}: ${r.out.slice(-2000)}`);
    if (/\b(CommandNotFoundException|is not recognized as a name of a cmdlet)\b/.test(r.out)) throw new Error(`${tag} windows ${name} called something the stand-in lacks:\n${r.out.slice(-2000)}`);
    return fs.existsSync(capFile) ? fs.readFileSync(capFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  const ok = { success: true, data: {} };
  const exchanges = [];
  const src = (what) => `the ${tag} standard Windows agent's ${what}, generated by buildLegacyWindowsScript() and run under PowerShell 7 with capture/windows-prelude.ps1`;
  const vars = `$REM0TE_HOST = '${V.host}'\n$PERM_PW = '${V.password}'\n$AGENT_SECRET = '${V.secret}'\n$AGENT_VERSION = '${version}'\n$UPDATE_NONCE = ''\n$STATEDIR = '${pd}'\nfunction Log([string]$m, [string]$l = 'INFO') { }\n`;

  // 1. The installer's Register: claim with the token, and the unclaimed heartbeat.
  const reg = cut(script, '\nfunction Register([string]$id) {', /\n}\n/, 'Register');
  if (!reg) throw new Error(`${tag}: no Register function in the installer`);
  const regFn = `function Register([string]$id) {${rewrite(reg)}\n}\n`;
  for (const [label, token] of [['claim', V.token], ['register-heartbeat', '']]) {
    const got = await runPs(`register-${label}`, `${vars}$CLAIM_TOKEN = '${token}'\n${regFn}\n$null = Register '${V.rid}'`, { default: ok });
    if (got.length !== 1) throw new Error(`${tag} windows registration (${label}) made ${got.length} calls`);
    exchanges.push({ name: label === 'claim' ? 'installer-claim' : 'installer-register-heartbeat', identity: label === 'claim' ? 'claimed' : 'pooled', ...got[0], source: src('installer Register function') });
  }

  // 2. retry-enroll.ps1 (the installer's retry task when registration failed), with a token.
  const retry = cut(script, "$retryBody = @'\n", /\n'@\n/, 'retry-enroll.ps1');
  const payload = cut(script, '$payload = [PSCustomObject]@{', /\} \| ConvertTo-Json -Compress\n/, 'enroll.dat payload');
  if (retry && payload) {
    const write = `${vars}$CLAIM_TOKEN = '${V.token}'\n$p = [PSCustomObject]@{${payload}} | ConvertTo-Json -Compress\nSet-Content -LiteralPath '${path.join(pd, 'enroll.dat')}' -Value $p -Encoding UTF8\n`;
    const got = await runPs('retry-enroll', `${write}\n${rewrite(retry)}`, { default: ok });
    if (got.length !== 1) throw new Error(`${tag} windows retry-enroll made ${got.length} calls`);
    // A second computer: the retry runs only when the first registration failed.
    exchanges.push({ name: 'retry-enroll-claim', identity: 'retry', ...got[0], source: src('retry-enroll.ps1') });
  }

  // 3. heartbeat.ps1, twice. heartbeat.dat is written by the installer's own lines.
  const hbState = cut(script, '\n$hbState = ', /\n\$hbPayload = [^\n]*\n/, 'heartbeat state');
  const hbBody = cut(script, "$hbBody = @'\n", /\n'@\n/, 'heartbeat.ps1');
  if (!hbState || !hbBody) throw new Error(`${tag}: no heartbeat in the installer`);
  const stateWrite = `${vars}$hbState = ${hbState}\n$hbPayload = [PSCustomObject]$hbState | ConvertTo-Json -Compress\nSet-Content -LiteralPath '${path.join(pd, 'heartbeat.dat')}' -Value $hbPayload -Encoding UTF8\n`;
  await runPs('state', stateWrite, { default: ok });
  const hb = rewrite(hbBody);
  fs.writeFileSync(path.join(sb, 'heartbeat.ps1'), hb);
  const firstDiag = ['disk_space', 'reboot_status', 'service_list'];
  const secondDiag = ['process_list', 'network_adapters', 'top_processes'];
  const diagKeys = [...firstDiag, ...secondDiag];
  const knows = (k) => hb.includes(`'${k}'`);
  const beat1 = { success: true, data: {
    found: true, authenticated: true, rotate: { password: V.rotate, sha256: sha(V.rotate) }, updateRustdesk: null, reinstallAgent: null,
    commands: Object.entries(CMD).map(([type, id]) => ({ id, type, params: type === 'EVENT_LOG_QUERY' ? { logName: 'System', sinceHours: 24, maxEvents: 10, levels: [1, 2] } : null })),
    diagnostics: firstDiag.filter(knows).map((key) => ({ id: DIAG(key), key })),
    monitor: { services: ['Spooler', 'WireMissingSvc'], events: [{ key: 'disk-errors', log: 'System', ids: [7, 11], levels: [1, 2, 3] }] },
    tray: { pair: true }, chat: null,
  } };
  const responses = {
    '/enrollment/confirm-rotation': { success: true, data: { confirmed: true } },
    '/tray/pair': { success: true, data: { trayKey: `tk_${V.trayKeyId}.${'A'.repeat(43)}`, keyId: V.trayKeyId } },
    default: ok,
  };
  const first = await runPs('heartbeat-1', hb, { ...responses, '/enrollment/heartbeat': beat1 });
  const beat2 = { success: true, data: { found: true, authenticated: true, commands: [], diagnostics: secondDiag.filter(knows).map((key) => ({ id: DIAG(key), key })), monitor: null, tray: null } };
  const second = await runPs('heartbeat-2', hb, { ...responses, '/enrollment/heartbeat': beat2 });
  const name = (s, b, n) => {
    switch (s.path) {
      case '/enrollment/heartbeat': return `heartbeat-${n}`;
      case '/enrollment/command-result': return `command-result-${Object.entries(CMD).find(([, id]) => id === b.commandId)[0].toLowerCase().replace(/_/g, '-')}`;
      case '/enrollment/diagnostic-result': return `diagnostic-result-${b.key.replace(/_/g, '-')}-${b.state}`;
      case '/enrollment/monitor-report': return 'monitor-report';
      case '/enrollment/confirm-rotation': return 'confirm-rotation';
      case '/tray/pair': return 'tray-pair';
      default: throw new Error(`${tag}: unexpected call to ${s.path}`);
    }
  };
  for (const [n, seen, beat] of [[1, first, beat1], [2, second, beat2]]) {
    for (const s of seen) {
      const b = JSON.parse(s.body);
      const e = { name: name(s, b, n), identity: 'claimed', ...s, source: src('heartbeat.ps1') };
      if (s.path === '/enrollment/heartbeat') {
        const results = seen.filter((x) => x.path === '/enrollment/command-result').map((x) => JSON.parse(x.body).commandId);
        e.stage = {
          commands: Object.entries(CMD).filter(([, id]) => results.includes(id)).map(([t]) => t),
          diagnostics: beat.data.diagnostics.map((d) => d.key),
          rotation: !!beat.data.rotate && seen.some((x) => x.path === '/enrollment/confirm-rotation'),
          monitor: !!beat.data.monitor,
        };
      }
      if (s.path === '/enrollment/command-result') e.commandType = Object.entries(CMD).find(([, id]) => id === b.commandId)[0];
      exchanges.push(e);
    }
  }
  // What this release's heartbeat reads from the server's answers.
  const reads = [...new Set([...hb.matchAll(/\$resp\.data\.([A-Za-z]+)/g)].map((m) => m[1]))].sort();
  const trayKey = hb.match(/\$tk -cmatch '([^']+)'/)?.[1] ?? null;
  const contract = { heartbeat: { reads }, ...(trayKey ? { trayPair: { trayKeyPattern: trayKey } } : {}) };
  return { exchanges, contract, evidence: 'captured', diagKeys };
}

// ── Main ───────────────────────────────────────────────────────────────────
const CAPTURE = { linux: captureLinux, macos: captureMacos, windows: captureWindows };
async function captureOne(agent, tag) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `rem0te-wire-${agent}-${tag}-`));
  try {
    const mod = loadTag(tag, scratch);
    const { exchanges, contract, evidence, diagKeys = [] } = await CAPTURE[agent](tag, scratch, mod);
    const outDir = path.join(WIRE, agent, tag);
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    exchanges.sort((a, b) => (a._o ?? 0) - (b._o ?? 0));
    let n = 0;
    for (const e of exchanges) {
      n++;
      const body = placehold(JSON.parse(e.body), diagKeys);
      const fixture = {
        agent, tag, name: e.name, evidence, source: e.source, identity: e.identity,
        request: { method: e.method, path: e.path, body },
        // The exact text the agent sent, placeholders in: key order and number
        // formatting are part of the wire too.
        raw: rawPlacehold(e.body, diagKeys),
        ...(e.commandType ? { commandType: e.commandType } : {}),
        ...(e.stage ? { stage: e.stage } : {}),
        expect: { status: 200 },
      };
      fs.writeFileSync(path.join(outDir, `${String(n).padStart(2, '0')}-${e.name}.json`), `${JSON.stringify(fixture, null, 2)}\n`);
    }
    fs.writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify({
      agent, tag, agentVersion: tag.slice(1), evidence, contract,
      capturedFrom: `git archive ${tag} apps/api/src/public (${execFileSync('git', ['-C', ROOT, 'rev-list', '-n', '1', tag], { encoding: 'utf8' }).trim()})`,
      fixtures: n,
    }, null, 2)}\n`);
    console.log(`  ${agent} ${tag}: ${n} exchanges (${evidence})`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
function rawPlacehold(text, diagKeys) {
  let t = text;
  for (const k of diagKeys) t = t.split(`"${DIAG(k)}"`).join(`"{{diagRunId:${k}}}"`);
  for (const [real, ph] of PLACEHOLDERS) t = t.split(real).join(ph);
  return t;
}

const [onlyAgent, onlyTag] = process.argv.slice(2);
let failed = 0;
for (const [agent, def] of Object.entries(AGENTS.agents)) {
  if (onlyAgent && agent !== onlyAgent) continue;
  for (const { tag } of def.tags) {
    if (onlyTag && tag !== onlyTag) continue;
    try { await captureOne(agent, tag); } catch (e) { failed++; console.error(`  ${agent} ${tag}: FAILED — ${e.message}`); }
  }
}
if (failed) process.exit(1);
