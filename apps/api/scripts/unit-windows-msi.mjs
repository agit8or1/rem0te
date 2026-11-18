#!/usr/bin/env node
// Unit tests for the Windows Installer package (0.65, §77), run against dist
// with no database:
//
//   - every refusal comes before a spawn: a token outside the installers' hex
//     charset (a quote, a space, an SQL quote, too short, too long), a portal
//     that is not a host[:port], an agent path that is not a plain absolute
//     path, missing builder binaries (MSI_BUILDER_UNAVAILABLE) — each spawns
//     nothing, counted through the runner hook;
//   - the spawn: only /usr/bin/wixl and /usr/bin/msibuild, an argument array,
//     the token only as the value of one msibuild query; a failed builder is
//     MSI_BUILD_FAILED whose message names no token; the private temporary
//     directory is gone afterwards, success or failure; at most two builds
//     at once (MSI_BUSY);
//   - with msitools installed, real packages, read back with msiinfo and
//     msiextract: the generic one has no TOKEN; a stamped one has exactly
//     its token (a claim token, or a 96-hex deployment key); the custom
//     action is the agent from the Binary table, deferred, as SYSTEM, with
//     return checked, on first install only, inside the install script; the
//     agent bytes are the target's exactly; the package installs no file and
//     writes one registry marker; TOKEN is hidden and secure; every build has
//     its own product and package codes; the launch condition refuses a
//     missing token on install and not on uninstall.
//
// Without msitools the real-package section is skipped with a message, except
// under CI (or REQUIRE_MSI_TOOLS=1), where a missing wixl is a failure: the
// check and e2e jobs install `wixl msitools` for this.
//
// Build first: pnpm --filter @reboot-remote/api build
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const W = require(join(here, '..', 'dist', 'public', 'windows-msi.js'));

let pass = 0, fail = 0;
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${n}${d ? `\n      ${d}` : ''}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

const work = mkdtempSync(join(tmpdir(), 'unit-msi-'));
const agentPath = join(work, 'rem0te-agent.exe');
const agentBytes = Buffer.concat([Buffer.from('MZ unit-test stand-in for the signed agent '), randomBytes(200_000), Buffer.from('REM0TE_INST_URL:'), Buffer.alloc(240)]);
writeFileSync(agentPath, agentBytes);
const TOKEN = randomBytes(32).toString('hex');           // a claim token: 64 hex
const KEY = randomBytes(48).toString('hex');             // a deployment key: 96 hex
const base = { agentPath, portalHost: 'portal.example.com', version: '0.65.0' };
const msiDirs = () => readdirSync(tmpdir()).filter((n) => n.startsWith('rem0te-msi-'));

async function code(p) { try { await p; return null; } catch (e) { return e instanceof W.MsiError ? e.code : `other: ${e?.message}`; } }
function counting(impl) {
  const calls = [];
  const run = async (bin, args, cwd) => { calls.push({ bin, args, cwd }); if (impl) return impl(bin, args, cwd); };
  return { calls, run };
}
const okAccess = async () => {};
const noAccess = async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };

section('Refused before anything is spawned');
for (const [label, token] of [
  ['a quote', `${TOKEN.slice(0, 20)}"`], ['a space', `${TOKEN.slice(0, 20)} --portal evil.example`], ['an SQL quote', `${TOKEN.slice(0, 20)}'); DROP`],
  ['15 hex (too short)', TOKEN.slice(0, 15)], ['129 hex (too long)', `${KEY}${KEY}`.slice(0, 129)], ['a newline', `${TOKEN}\n`], ['empty', ''],
]) {
  const r = counting();
  const c = await code(W.buildWindowsMsi({ ...base, token }, { run: r.run, access: okAccess }));
  check(c === 'MSI_TOKEN_INVALID' && r.calls.length === 0, `a token with ${label}: MSI_TOKEN_INVALID, nothing spawned`, `${c} / ${r.calls.length}`);
}
for (const [label, portalHost] of [['a scheme', 'https://portal.example.com'], ['a path', 'portal.example.com/x'], ['a quote', 'portal"x'], ['two ports', 'a:1:2'], ['port 0', 'a:0'], ['a space', 'a b']]) {
  const r = counting();
  const c = await code(W.buildWindowsMsi({ ...base, portalHost, token: TOKEN }, { run: r.run, access: okAccess }));
  check(c === 'MSI_BAD_INPUT' && r.calls.length === 0, `a portal with ${label}: MSI_BAD_INPUT, nothing spawned`, `${c} / ${r.calls.length}`);
}
for (const [label, p] of [['relative', 'rem0te-agent.exe'], ['traversal', `${work}/../x.exe`], ['a quote', `${work}/a".exe`], ['a space', `${work}/a b.exe`], ['missing', `${work}/missing.exe`]]) {
  const r = counting();
  const c = await code(W.buildWindowsMsi({ ...base, agentPath: p }, { run: r.run, access: okAccess }));
  check(c === 'MSI_BAD_INPUT' && r.calls.length === 0, `an agent path that is ${label}: MSI_BAD_INPUT, nothing spawned`, `${c} / ${r.calls.length}`);
}
{
  const r = counting();
  const c = await code(W.buildWindowsMsi({ ...base, token: TOKEN }, { run: r.run, access: noAccess }));
  check(c === 'MSI_BUILDER_UNAVAILABLE' && r.calls.length === 0, 'wixl / msibuild missing: MSI_BUILDER_UNAVAILABLE, nothing spawned', `${c} / ${r.calls.length}`);
  const empty = join(work, 'empty.exe'); writeFileSync(empty, '');
  const r2 = counting();
  const c2 = await code(W.buildWindowsMsi({ ...base, agentPath: empty }, { run: r2.run, access: okAccess }));
  check(c2 === 'MSI_AGENT_TOO_LARGE' && r2.calls.length === 0, 'an empty agent binary is refused, nothing spawned', `${c2}`);
}
check(W.checkMsiInput({ ...base, version: 'unknown' }).version === '0.0.0' && W.checkMsiInput({ ...base, version: '1.2.3-rc1' }).version === '0.0.0'
  && W.checkMsiInput(base).version === '0.65.0' && W.checkMsiInput({ ...base, version: '256.0.0' }).version === '256.0.0',
  'a version outside Windows Installer\'s three numeric fields becomes 0.0.0');

section('The spawn: fixed binaries, an argument array, the token only inside one query');
{
  const before = msiDirs().length;
  const r = counting(async (bin, args) => {
    if (bin === W.WIXL_BIN) writeFileSync(args[args.indexOf('-o') + 1], Buffer.concat([agentBytes, Buffer.alloc(1024)]));
  });
  const out = await W.buildWindowsMsi({ ...base, token: KEY }, { run: r.run, access: okAccess }).catch((e) => e);
  check(Buffer.isBuffer(out), 'a stub build returns the package bytes', String(out));
  check(r.calls.length === 2 && r.calls[0].bin === '/usr/bin/wixl' && r.calls[1].bin === '/usr/bin/msibuild' && r.calls.every((c) => Array.isArray(c.args)),
    'exactly two spawns: /usr/bin/wixl, then /usr/bin/msibuild, each with an argument array', JSON.stringify(r.calls.map((c) => c.bin)));
  const wx = r.calls[0].args;
  check(wx.join(' ') === `-a x64 -D Version=0.65.0 -D Portal=portal.example.com -D AgentExe=${agentPath} -o ${join(r.calls[0].cwd, 'rem0te.msi')} ${join(r.calls[0].cwd, 'rem0te.wxs')}`,
    'wixl gets the version, portal and agent path as -D variables (nothing interpolated into the XML)', wx.join(' '));
  const withToken = r.calls.flatMap((c) => c.args).filter((a) => a.includes(KEY));
  check(withToken.length === 1 && withToken[0] === `INSERT INTO \`Property\` (\`Property\`, \`Value\`) VALUES ('TOKEN', '${KEY}')`,
    'the deployment key appears in exactly one argument: the msibuild query that stamps the Property table', JSON.stringify(withToken));
  check(!W.MSI_WXS.includes('${') && /Value="\$\(var\.Portal\)"/.test(W.MSI_WXS) && !W.MSI_WXS.includes('TOKEN" Value'), 'the package source is constant: no TOKEN default, the portal a preprocessor variable');
  check(msiDirs().length === before && !existsSync(r.calls[0].cwd), 'the private temporary directory is gone after a build');
  const r2 = counting();
  const c = await code(W.buildWindowsMsi({ ...base, token: TOKEN }, { run: async () => { r2.calls.push(1); throw new Error(`wixl failed: msibuild x -q ... '${TOKEN}'`); }, access: okAccess }));
  let msg = ''; try { await W.buildWindowsMsi({ ...base, token: TOKEN }, { run: async () => { throw new Error(`boom '${TOKEN}'`); }, access: okAccess }); } catch (e) { msg = `${e.message} ${e.stack}`; }
  check(c === 'MSI_BUILD_FAILED' && !msg.includes(TOKEN), 'a failed builder is MSI_BUILD_FAILED, and the error carries no token (the command line is never surfaced)', msg.slice(0, 200));
  check(msiDirs().length === before, 'the temporary directory is removed after a failure too');
  const r3 = counting(async (bin, args) => { if (bin === W.WIXL_BIN) writeFileSync(args[args.indexOf('-o') + 1], Buffer.alloc(10)); });
  check(await code(W.buildWindowsMsi(base, { run: r3.run, access: okAccess })) === 'MSI_BUILD_FAILED', 'a package smaller than the agent it must carry is refused');
}
{
  let release; const gate = new Promise((r) => { release = r; });
  const slow = async (bin, args) => { await gate; if (bin === W.WIXL_BIN) writeFileSync(args[args.indexOf('-o') + 1], agentBytes); };
  const a = W.buildWindowsMsi(base, { run: slow, access: okAccess });
  const b = W.buildWindowsMsi(base, { run: slow, access: okAccess });
  await new Promise((r) => setTimeout(r, 50));
  const r = counting();
  const c = await code(W.buildWindowsMsi(base, { run: r.run, access: okAccess }));
  release(); await Promise.allSettled([a, b]);
  check(c === 'MSI_BUSY' && r.calls.length === 0, 'a third build while two run: MSI_BUSY, nothing spawned', c);
}

section('Real packages, read back with msiinfo and msiextract');
const haveTools = existsSync(W.WIXL_BIN) && existsSync(W.MSIBUILD_BIN) && existsSync('/usr/bin/msiinfo') && existsSync('/usr/bin/msiextract');
const required = process.env.CI === 'true' || process.env.REQUIRE_MSI_TOOLS === '1';
if (!haveTools) {
  if (required) check(false, 'msitools is installed (required under CI: apt-get install -y wixl msitools)');
  else console.log('  \x1b[33m–\x1b[0m skipped: wixl / msibuild / msiinfo / msiextract are not installed (apt-get install -y wixl msitools). Under CI this is a failure.');
} else {
  const info = (file, ...a) => execFileSync('/usr/bin/msiinfo', [...a, file], { encoding: 'utf8' });
  const table = (file, t) => execFileSync('/usr/bin/msiinfo', ['export', file, t], { encoding: 'utf8' }).split(/\r?\n/).slice(3).filter(Boolean).map((l) => l.split('\t'));
  const prop = (file) => Object.fromEntries(table(file, 'Property').map(([k, v]) => [k, v]));
  const save = (name, buf) => { const p = join(work, name); writeFileSync(p, buf); return p; };

  const before = msiDirs().length;
  const generic = save('generic.msi', await W.buildWindowsMsi(base));
  const stamped = save('stamped.msi', await W.buildWindowsMsi({ ...base, token: TOKEN }));
  const keyed = save('keyed.msi', await W.buildWindowsMsi({ ...base, portalHost: 'portal.example.com:8443', token: KEY }));
  check(msiDirs().length === before, 'three real builds leave no temporary directory behind');
  const tables = info(generic, 'tables').split(/\r?\n/);
  check(['Property', 'CustomAction', 'InstallExecuteSequence', 'Binary', 'LaunchCondition', 'Registry', 'Upgrade'].every((t) => tables.includes(t)), 'msiinfo reads the package: the expected tables are there', tables.join(','));
  const pg = prop(generic), ps = prop(stamped), pk = prop(keyed);
  check(!('TOKEN' in pg), 'the generic package has no TOKEN: it must be given on the msiexec command line');
  check(ps.TOKEN === TOKEN && pk.TOKEN === KEY, 'a stamped package carries exactly its token: a claim token, or a 96-hex deployment key', `${ps.TOKEN?.length} / ${pk.TOKEN?.length}`);
  check(pg.Rem0tePortal === 'portal.example.com' && pk.Rem0tePortal === 'portal.example.com:8443', 'the portal is the private Rem0tePortal property (host, or host:port)');
  check(pg.MsiHiddenProperties === 'TOKEN' && pg.SecureCustomProperties.split(';').includes('TOKEN'), 'TOKEN is hidden from the installer log and is a secure property');
  check(pg.ALLUSERS === '1' && pg.ProductVersion === '0.65.0' && pg.UpgradeCode === W.MSI_UPGRADE_CODE && pg.ARPNOMODIFY === '1' && pg.ARPNOREPAIR === '1',
    'per-machine (ALLUSERS=1), version 0.65.0, the fixed upgrade code, no Modify or Repair in Programs and Features');
  check(pg.ProductCode !== ps.ProductCode && ps.ProductCode !== pk.ProductCode, 'every build has its own product code');
  const rev = (f) => /Revision number \(UUID\): (\{[0-9A-F-]+\})/.exec(info(f, 'suminfo'))?.[1];
  check(rev(generic) && rev(generic) !== rev(stamped) && /Template: x64;1033/.test(info(generic, 'suminfo')), 'every build has its own package code; the template is x64');
  const ca = table(stamped, 'CustomAction');
  check(ca.length === 1 && ca[0][0] === 'Rem0teInstall' && ca[0][1] === '3074' && ca[0][2] === 'Rem0teAgent' && ca[0][3] === 'install --token [TOKEN] --portal [Rem0tePortal]',
    'one custom action: the agent from the Binary table (type 3074: deferred, as SYSTEM, return checked), install --token [TOKEN] --portal [Rem0tePortal]', JSON.stringify(ca));
  const seq = Object.fromEntries(table(stamped, 'InstallExecuteSequence').map(([a, c, s]) => [a, { c, s: Number(s) }]));
  check(seq.Rem0teInstall?.c === 'NOT Installed AND NOT REMOVE' && seq.Rem0teInstall.s > seq.InstallInitialize.s && seq.Rem0teInstall.s < seq.InstallFinalize.s,
    'it runs on a first install only (never on repair or uninstall), inside the install script', JSON.stringify(seq.Rem0teInstall));
  const lc = table(generic, 'LaunchCondition').map(([c]) => c);
  check(lc.includes('Installed OR (TOKEN AND NOT (TOKEN >< " ") AND NOT (TOKEN >< Rem0teTab) AND NOT (TOKEN >< Rem0teQuote))') && pg.Rem0teQuote === '"'
    && execFileSync('/usr/bin/msiinfo', ['export', '-s', generic, 'Property'], { encoding: 'utf8' }).includes("VALUES ('Rem0teTab', '\t')"),
    'the launch condition needs a TOKEN with no space, tab or quote on install, and nothing on uninstall', JSON.stringify(lc));
  const bin = execFileSync('/usr/bin/msiinfo', ['extract', stamped, 'Binary.Rem0teAgent']);
  check(Buffer.compare(bin, agentBytes) === 0, 'the agent in the Binary table is byte for byte the signed target (no slot patched, no token in it)');
  check(!bin.includes(Buffer.from(TOKEN)), 'the token is not inside the agent bytes');
  check(table(generic, 'File').length === 0 && table(generic, 'Component').length === 1 && table(generic, 'Registry').length === 1
    && table(generic, 'Registry')[0][2] === 'SOFTWARE\\Rem0te\\Installer', 'it installs no file: one component, one registry marker (HKLM\\SOFTWARE\\Rem0te\\Installer)');
  const ex = mkdtempSync(join(work, 'extract-'));
  execFileSync('/usr/bin/msiextract', ['-C', ex, stamped]);
  check(readdirSync(ex).length === 0, 'msiextract finds no files to lay down, so uninstalling cannot remove anything of the agent\'s');
  const streams = info(stamped, 'streams').split(/\r?\n/).filter(Boolean);
  check(streams.includes('Binary.Rem0teAgent') && !streams.some((s) => /\.cab$/.test(s)), 'its streams: the agent binary, no cabinet', streams.join(','));
  const up = table(generic, 'Upgrade');
  check(up.some((r) => r[0] === W.MSI_UPGRADE_CODE && r[6] === 'WIX_SAME_VERSION_UPGRADE_DETECTED'), 'a newer or same-version package replaces an older one\'s registration (MajorUpgrade)');
  check(!readFileSync(generic).includes(Buffer.from(TOKEN)) && readFileSync(stamped).includes(Buffer.from(TOKEN)), 'the token is in the stamped download and nowhere in the generic one');
}

rmSync(work, { recursive: true, force: true });
console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
process.exit(fail ? 1 : 0);
