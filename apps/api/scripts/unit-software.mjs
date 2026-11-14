#!/usr/bin/env node
/**
 * Unit proof of the pure software-deployment rules (v0.34), from the
 * compiled API (no database, no network):
 *
 *   - the closed parameters and their charsets (actions/catalog.ts);
 *   - version comparison and detection, which repeat the agent's
 *     (tools/windows-installer/internal/action/software.go);
 *   - compliance from evidence, with the 14-day staleness rule;
 *   - the winget-pkgs manifest reader, installer choice and path layout;
 *   - the ring gate and which ring may be requested next;
 *   - that WINGET_MANIFEST_BASE is honoured only for a loopback http URL;
 *   - 0.41: reading the winget index out of its MSIX, which rows are kept,
 *     search ranking and the refresh rule; choosing the installer and the
 *     detection rule for a one-click install; the closed parameters of
 *     windows.software.remove and what the console offers to remove.
 *   - 0.42: search ranking tiers; the removal kinds and protected programs;
 *     and, when PWSH (or pwsh on PATH) is there, the inventory collector's
 *     Get-Rem0teRemovalKind run over the same fixture the agent's Go test
 *     reads (tools/windows-installer/internal/action/testdata/removal-kinds.json).
 *
 *   cd apps/api && npx nest build && node scripts/unit-software.mjs
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const cat = require(path.join(dist, 'actions/catalog.js'));
const D = require(path.join(dist, 'software/definition.js'));
const M = require(path.join(dist, 'software/manifest.js'));

let passed = 0; const failures = [];
const check = (name, ok, detail = '') => { if (ok) passed++; else failures.push(`${name}${detail ? ` — ${detail}` : ''}`); };

// ── Closed params ──────────────────────────────────────────────────────────
const SW = { packageId: '7zip.7zip', version: '24.08', installerSha256: 'e'.repeat(64), scope: 'machine', detection: { kind: 'display_name', name: '7-Zip', match: 'prefix', compare: 'gte', version: '24.08' } };
const ok = (p) => cat.SoftwareParams.safeParse(p).success;
check('the reference params parse', ok(SW));
for (const id of ['7zip.7zip', 'Notepad++.Notepad++', 'Microsoft.VisualStudioCode', 'Mozilla.Firefox.ESR', 'Git.Git', 'a.b', 'Python.Python.3_12']) check(`package id ${id} is accepted`, ok({ ...SW, packageId: id }));
for (const id of ['7zip', '.7zip', '7zip.', '-h.x', '--force.x', '7zip.7zip;calc', '7zip.7zip calc', '7zip.7zip"', "7zip.7zip'", '7zip.7zip&calc', '7zip.7zip|calc', '7zip.7zip`calc`', '$(calc).x', '7zip\\7zip', '7zip/7zip', '7zip..7zip', '%TEMP%.x', 'ü.x', `a.${'b'.repeat(64)}.${'c'.repeat(64)}`, 'a.b.c.d.e.f.g.h.i', `${'a'.repeat(65)}.b`]) {
  check(`package id ${JSON.stringify(id).slice(0, 40)} is refused`, !ok({ ...SW, packageId: id }));
}
for (const v of ['24.08', '1.2.3.4', '8.7.2', '2024-11-01', '1.0.0+build.5', 'v2', '130.0.2849.80']) check(`version ${v} is accepted`, ok({ ...SW, version: v }));
for (const v of ['', '-1', '--force', '1.0 --override', '1;calc', '1/2', 'latest ', `1${'0'.repeat(64)}`]) check(`version ${JSON.stringify(v)} is refused`, !ok({ ...SW, version: v }));
check('an upper-case hash is refused (one spelling only)', !ok({ ...SW, installerSha256: 'E'.repeat(64) }));
check('a short hash is refused', !ok({ ...SW, installerSha256: 'e'.repeat(63) }));
check('user scope is refused', !ok({ ...SW, scope: 'user' }));
check('an extra key is refused', !ok({ ...SW, override: '/S' }));
check('a missing detection is refused', !ok({ packageId: SW.packageId, version: SW.version, installerSha256: SW.installerSha256, scope: 'machine' }));
const det = (d) => ok({ ...SW, detection: d });
check('uninstall_key rule parses', det({ kind: 'uninstall_key', key: '{23170F69-40C1-2702-2408-000001000000}', compare: 'eq', version: '24.08' }));
check('uninstall_key with a backslash is refused', !det({ kind: 'uninstall_key', key: 'Uninstall\\..\\Run', compare: 'eq', version: '1' }));
check('file_version rule parses', det({ kind: 'file_version', base: 'ProgramFilesX86', file: 'Mozilla Firefox\\firefox.exe', compare: 'gte', version: '128.0' }));
for (const f of ['..\\Windows\\cmd.exe', '.\\x.exe', 'C:\\x.exe', '\\x.exe', 'a/b.exe', 'x.bat', 'x.ps1', 'dir\\', ' x.exe', 'x.exe ', 'x.exe.', `${'a\\'.repeat(8)}x.exe`, 'a\\\\b.exe', 'a\\b\u0000.exe']) {
  check(`file ${JSON.stringify(f).slice(0, 30)} is refused`, !det({ kind: 'file_version', base: 'ProgramFiles', file: f, compare: 'gte', version: '1' }) && !cat.fileUnderBaseOk(f));
}
check('a base outside the two is refused', !det({ kind: 'file_version', base: 'SystemRoot', file: 'x.exe', compare: 'gte', version: '1' }));
check('a display name with markup is refused', !det({ ...SW.detection, name: '<b>7-Zip</b>' }));
check('a fourth kind of rule is refused', !det({ kind: 'script', script: 'Get-Item' }));
check('a rule with an extra key is refused', !det({ ...SW.detection, cmd: 'whoami' }));
const ids = cat.CATALOG.map((a) => `${a.id}@${a.version}`);
check('the catalog ends with the three software actions', ids.slice(-3).join(',') === 'windows.software.install@1,windows.software.uninstall@1,windows.software.remove@1' && ids.length === 10 && ids[6] === 'windows.script.run@1', ids.join(','));
for (const a of [cat.SOFTWARE_INSTALL, cat.SOFTWARE_UNINSTALL]) {
  check(`${a.id}: high on a workstation, a server and 25 computers`, ['WORKSTATION', 'SERVER'].every((c) => a.risk([{ deviceClass: c }]) === 'high') && a.risk(Array(25).fill({ deviceClass: 'WORKSTATION' })) === 'high');
  check(`${a.id}: never direct, never offered to ClientSt0r, at most 25`, a.direct === false && a.integration === false && a.maxTargets === 25 && /catalog/.test(a.indirectVia ?? ''));
}

// ── Versions ───────────────────────────────────────────────────────────────
for (const [a, b, want] of [
  ['24.08', '24.08', 0], ['24.09', '24.08', 1], ['24.8', '24.08', 0], ['1.10', '1.9', 1], ['1.2', '1.2.0', 0], ['1.2.0.1', '1.2', 1],
  ['10', '9', 1], ['1.0-beta', '1.0-alpha', 1], ['1.0-RC1', '1.0-rc1', 0], ['2.0', '10.0', -1], ['123456789012345678901234567890', '123456789012345678901234567889', 1],
  ['1..2', '1.0.2', 0], ['', '0', 0], ['8.7.2', '8.7', 1], ['130.0.2849.80', '130.0.2849.9', 1],
]) check(`compare ${a} vs ${b} = ${want}`, D.compareVersions(a, b) === want && D.compareVersions(b, a) === -want, String(D.compareVersions(a, b)));
check('gte: 24.09 meets 24.08, 24.07 does not', D.meets('24.09', { compare: 'gte', version: '24.08' }) && !D.meets('24.07', { compare: 'gte', version: '24.08' }));
check('eq: 2.0.0.0 meets 2.0, 2.0.0.1 does not', D.meets('2.0.0.0', { compare: 'eq', version: '2.0' }) && !D.meets('2.0.0.1', { compare: 'eq', version: '2.0' }));

// ── Detection from the inventory ───────────────────────────────────────────
const progs = [{ name: '7-Zip 23.01 (x64)', version: '23.01' }, { name: '7-Zip 24.08 (x64)', version: '24.08' }, { name: 'Microsoft Edge', version: '130.0' }];
check('prefix: the highest matching version decides (installed)', D.detectFromInventory(SW.detection, progs) === 'installed');
check('prefix: only an old one → outdated', D.detectFromInventory(SW.detection, progs.slice(0, 1)) === 'outdated');
check('not found → absent', D.detectFromInventory(SW.detection, [{ name: 'Microsoft Edge', version: '1' }]) === 'absent');
check('exact match is case-insensitive and not a prefix', D.detectFromInventory({ ...SW.detection, match: 'exact', name: '7-zip 24.08 (X64)' }, progs) === 'installed' && D.detectFromInventory({ ...SW.detection, match: 'exact', name: '7-Zip' }, progs) === 'absent');
check('no version recorded → outdated (version "")', D.detectFromInventory(SW.detection, [{ name: '7-Zip', version: null }]) === 'outdated');
check('no inventory → null, never "absent"', D.detectFromInventory(SW.detection, null) === null);
check('a registry-key or file rule is never answered from the inventory', D.detectFromInventory({ kind: 'uninstall_key', key: '7-Zip', compare: 'gte', version: '1' }, progs) === null && D.detectFromInventory({ kind: 'file_version', base: 'ProgramFiles', file: '7-Zip\\7z.exe', compare: 'gte', version: '1' }, progs) === null);
check('a result: detectedAfter first, then detectedNow, then detectedBefore', D.detectFromResult({ observed: { detectedBefore: 'absent', detectedAfter: 'installed', versionAfter: '24.08' } })?.state === 'installed'
  && D.detectFromResult({ observed: { detectedBefore: 'installed', detectedNow: 'absent' } })?.state === 'absent' && D.detectFromResult({ observed: { detectedBefore: 'outdated' } })?.state === 'outdated');
check('a result with no detection, or a made-up state → null', D.detectFromResult({ observed: { managers: 'intune' } }) === null && D.detectFromResult({ observed: { detectedAfter: 'probably' } }) === null && D.detectFromResult(null) === null);

// ── Compliance from evidence ───────────────────────────────────────────────
const now = new Date('2026-11-11T12:00:00Z');
const at = (d) => new Date(now.getTime() - d * 86_400_000);
const job = (params, resultAt, observed) => ({ resultAt, result: { observed }, job: { params } });
const entry = { packageId: SW.packageId, detection: SW.detection };
let ev = D.evidenceFor(entry, at(1), progs.slice(0, 1), [job(SW, at(0.5), { detectedAfter: 'installed', versionAfter: '24.08' })]);
check('the agent\'s newer detection beats an older inventory', D.complianceOf(ev, now).state === 'compliant' && D.complianceOf(ev, now).evidence.source === 'agent');
ev = D.evidenceFor(entry, at(0.1), progs.slice(0, 1), [job(SW, at(0.5), { detectedAfter: 'installed' })]);
check('a newer inventory beats an older agent result (outdated)', D.complianceOf(ev, now).state === 'outdated');
ev = D.evidenceFor(entry, at(20), progs, []);
const c20 = D.complianceOf(ev, now);
check('evidence over 14 days old → unknown, marked stale', c20.state === 'unknown' && c20.stale === true);
check('no evidence → unknown, not stale', D.complianceOf(D.evidenceFor(entry, null, null, []), now).state === 'unknown' && !D.complianceOf([], now).stale);
ev = D.evidenceFor(entry, null, null, [job({ ...SW, packageId: 'Other.Pkg' }, at(0.1), { detectedAfter: 'installed' })]);
check('another package\'s result is not evidence', D.complianceOf(ev, now).state === 'unknown');
ev = D.evidenceFor(entry, null, null, [job({ ...SW, detection: { ...SW.detection, version: '1.0' } }, at(0.1), { detectedAfter: 'installed' })]);
check('the same package under a different rule is not evidence', D.complianceOf(ev, now).state === 'unknown');
ev = D.evidenceFor(entry, null, null, [job({ ...SW, detection: { version: '24.08', compare: 'gte', match: 'prefix', name: '7-Zip', kind: 'display_name' } }, at(0.1), { detectedAfter: 'absent' })]);
check('the same rule with keys in another order is the same rule (missing)', D.complianceOf(ev, now).state === 'missing');
check('tally', JSON.stringify(D.tallyCompliance(['compliant', 'missing', 'missing', 'unknown'])) === JSON.stringify({ total: 4, compliant: 1, outdated: 0, missing: 2, unknown: 1 }));

// ── The winget-pkgs manifest ───────────────────────────────────────────────
check('manifest path follows the winget-pkgs layout', D.manifestPath('7zip.7zip', '24.08') === '7/7zip/7zip/24.08/7zip.7zip.installer.yaml' && D.manifestPath('Mozilla.Firefox.ESR', '128.4.0') === 'm/Mozilla/Firefox/ESR/128.4.0/Mozilla.Firefox.ESR.installer.yaml');
let threw = false; try { D.manifestPath('../../etc.passwd', '1'); } catch { threw = true; }
check('manifest path refuses an id outside the charset', threw);
const H = (c) => c.repeat(64);
const yaml = `# comment\nPackageIdentifier: 7zip.7zip\nPackageVersion: "24.08"\nInstallerType: exe\nScope: machine\nInstallers:\n- Architecture: x86\n  InstallerUrl: https://example.com/x86.exe\n  InstallerSha256: ${H('A')}\n- Architecture: x64\n  InstallerUrl: https://example.com/x64.exe\n  InstallerSha256: ${H('B')} # trailing comment\n  InstallerSwitches:\n    Silent: /S\n- Architecture: x64\n  Scope: user\n  InstallerSha256: ${H('C')}\nManifestType: installer\nManifestVersion: 1.6.0\n`;
const m = D.parseInstallerManifest(yaml);
check('the manifest reader: identity, three installers, root defaults applied, hashes lower-cased, nested keys ignored',
  m.packageIdentifier === '7zip.7zip' && m.packageVersion === '24.08' && m.manifestType === 'installer' && m.installers.length === 3
  && m.installers[1].installerSha256 === H('b') && m.installers[1].scope === 'machine' && m.installers[1].installerType === 'exe' && m.installers[2].scope === 'user', JSON.stringify(m));
const sel = D.selectInstaller(m, 'x64');
check('x64 machine scope: the x64 machine installer (the user-scope one is not a candidate)', sel.ok && sel.installer.installerSha256 === H('b'));
check('arm64: NO_MACHINE_INSTALLER', D.selectInstaller(m, 'arm64').code === 'NO_MACHINE_INSTALLER');
check('a named hash not among the candidates: HASH_NOT_IN_MANIFEST (the user-scope one is not offered)', D.selectInstaller(m, 'x64', H('c')).code === 'HASH_NOT_IN_MANIFEST');
const two = D.parseInstallerManifest(`PackageIdentifier: A.B\nPackageVersion: 1\nInstallers:\n- Architecture: x64\n  InstallerSha256: ${H('1')}\n- Architecture: x64\n  InstallerSha256: ${H('2')}\n`);
check('two different x64 installers: AMBIGUOUS_INSTALLER, unless one is named', D.selectInstaller(two, 'x64').code === 'AMBIGUOUS_INSTALLER' && D.selectInstaller(two, 'x64', H('2')).ok);
check('a malformed hash is not read as a hash', D.parseInstallerManifest(`Installers:\n- Architecture: x64\n  InstallerSha256: ${H('z')}\n`).installers[0].installerSha256 === null);
check('garbage yields no installers', D.parseInstallerManifest('<html>404</html>').installers.length === 0);

// ── WINGET_MANIFEST_BASE ───────────────────────────────────────────────────
for (const [v, want] of [
  ['http://127.0.0.1:3464/manifests', 'http://127.0.0.1:3464/manifests'], ['https://evil.example.com/manifests', D.WINGET_PKGS_RAW], ['http://localhost:3464/m', D.WINGET_PKGS_RAW],
  ['http://127.0.0.1.evil.com:80/m', D.WINGET_PKGS_RAW], ['http://10.0.0.5:3464/m', D.WINGET_PKGS_RAW], ['file:///etc', D.WINGET_PKGS_RAW], ['http://user@127.0.0.1:1/m', D.WINGET_PKGS_RAW],
]) {
  process.env.WINGET_MANIFEST_BASE = v;
  check(`WINGET_MANIFEST_BASE=${v} → ${want === D.WINGET_PKGS_RAW ? 'ignored' : 'used'}`, M.manifestBase() === want, M.manifestBase());
}
delete process.env.WINGET_MANIFEST_BASE;
check('the default is raw.githubusercontent.com/microsoft/winget-pkgs over https', M.manifestBase() === 'https://raw.githubusercontent.com/microsoft/winget-pkgs/master/manifests');

// ── The ring gate ──────────────────────────────────────────────────────────
const t = (status, observed = {}, outcome = 'succeeded', extra = {}) => ({ endpointId: `e${Math.random()}`, status, reconciled: false, resultAt: new Date(now.getTime() - 3600_000), result: { outcome, observed }, ...extra });
const gate = (ring, jobStatus, targets, o = {}) => D.evaluateSoftwareGate({ ring, jobStatus, targets, operation: 'install', failureThreshold: 0, soakHours: 0, ...o }, now);
check('not requested', gate(0, null, []).reason === 'not_requested');
check('awaiting approval → in progress', gate(0, 'AWAITING_APPROVAL', []).reason === 'in_progress');
check('rejected → ring_not_run', gate(0, 'REJECTED', []).reason === 'ring_not_run');
check('an unreconciled uncertain computer holds the gate', gate(1, 'UNKNOWN', [t('UNKNOWN', {}, 'uncertain')]).reason === 'unreconciled');
check('a reconciled one does not hold it as unreconciled', gate(1, 'UNKNOWN', [t('UNKNOWN', {}, 'uncertain', { reconciled: true })], { failureThreshold: 1 }).reason !== 'unreconciled');
check('canary effective → passed', gate(0, 'SUCCEEDED', [t('SUCCEEDED', { effective: 'true' })]).ok);
check('canary that already had it → canary_proved_nothing', gate(0, 'SUCCEEDED', [t('SUCCEEDED', {}, 'no_change')]).reason === 'canary_proved_nothing');
check('canary "succeeded" without effective → too_many_failures at threshold 0', gate(0, 'SUCCEEDED', [t('SUCCEEDED', { effective: 'false' })]).reason === 'too_many_failures');
check('canary restart_required, at threshold 1 → canary_not_effective', gate(0, 'SUCCEEDED', [t('SUCCEEDED', { effective: 'false' }, 'restart_required')], { failureThreshold: 1 }).reason === 'canary_not_effective');
check('canary restart_required confirmed by a later inventory → passed', gate(0, 'SUCCEEDED', [t('SUCCEEDED', { effective: 'false' }, 'restart_required', { laterInventory: 'installed' })]).ok);
check('ring 1: one failure over threshold 0 → too_many_failures', gate(1, 'FAILED', [t('SUCCEEDED', { effective: 'true' }), t('FAILED', {}, 'failed')]).reason === 'too_many_failures');
check('ring 1: one failure within threshold 1 → passed', gate(1, 'FAILED', [t('SUCCEEDED', { effective: 'true' }), t('FAILED', {}, 'failed')], { failureThreshold: 1 }).ok);
check('ring 1: no_change counts as fine', gate(1, 'SUCCEEDED', [t('SUCCEEDED', {}, 'no_change')]).ok);
check('soaking until the last result plus the soak', gate(0, 'SUCCEEDED', [t('SUCCEEDED', { effective: 'true' })], { soakHours: 2 }).reason === 'soaking');
const uninstallGate = D.evaluateSoftwareGate({ ring: 0, jobStatus: 'SUCCEEDED', targets: [t('SUCCEEDED', {}, 'restart_required', { laterInventory: 'absent' })], operation: 'uninstall', failureThreshold: 0, soakHours: 0 }, now);
check('uninstall restart_required, later inventory absent → passed', uninstallGate.ok);
const ok2 = { ok: true, reason: 'passed', detail: '' };
check('next: start with the canary', D.nextRing('ACTIVE', null, new Map(), [{ ok: false, reason: 'not_requested' }, { ok: false, reason: 'not_requested' }], 2).ring === 0);
check('next: after the canary passes, ring 1', (() => { const n = D.nextRing('ACTIVE', null, new Map([[0, { status: 'SUCCEEDED' }]]), [ok2, { ok: false, reason: 'not_requested', detail: '' }], 2); return n.ring === 1 && n.canRequest; })());
check('next: a failed ring is retried, never promoted past', (() => { const n = D.nextRing('ACTIVE', null, new Map([[0, { status: 'FAILED' }]]), [{ ok: false, reason: 'too_many_failures', detail: 'x' }, { ok: false, reason: 'not_requested' }], 2); return n.ring === 0 && n.canRequest; })());
check('next: a soaking canary does not let ring 1 through', (() => { const n = D.nextRing('ACTIVE', null, new Map([[0, { status: 'SUCCEEDED' }]]), [{ ok: false, reason: 'soaking', detail: 'soak' }, { ok: false, reason: 'not_requested' }], 2); return n.ring === 1 && !n.canRequest; })());
check('next: paused → nothing', D.nextRing('PAUSED', 'canary failed', new Map(), [], 2).ring === null);

// ── 0.41: the winget index, one-click install, removing a program ──────────
{
  const W = require(path.join(dist, 'software/winget-index.js'));
  const E = require(path.join(dist, 'monitoring/engine.js'));
  const zlib = require('node:zlib');
  // A zip written the way an MSIX is: optional data descriptors (local sizes 0), central directory last.
  const makeZip = (entries, opts = {}) => {
    const locals = [], cds = [];
    let off = 0;
    for (const e of entries) {
      const data = Buffer.from(e.data);
      const comp = e.method === 8 ? zlib.deflateRawSync(data) : data;
      const crc = e.badCrc ? (W.crc32(data) ^ 1) >>> 0 : W.crc32(data);
      const name = Buffer.from(e.name);
      const dd = e.descriptor ? 8 : 0;
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(dd, 6); lh.writeUInt16LE(e.method, 8);
      lh.writeUInt32LE(dd ? 0 : crc, 14); lh.writeUInt32LE(dd ? 0 : comp.length, 18); lh.writeUInt32LE(dd ? 0 : data.length, 22); lh.writeUInt16LE(name.length, 26);
      const desc = dd ? Buffer.alloc(16) : Buffer.alloc(0);
      if (dd) { desc.writeUInt32LE(0x08074b50, 0); desc.writeUInt32LE(crc, 4); desc.writeUInt32LE(comp.length, 8); desc.writeUInt32LE(data.length, 12); }
      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(dd | (e.encrypted ? 1 : 0), 8); cd.writeUInt16LE(e.method, 10);
      cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(e.claimSize ?? data.length, 24); cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(off, 42);
      // 0.41.1: ZIP64 the way MSIX packagers write it — every size and offset in the extra field.
      let x64 = Buffer.alloc(0);
      if (opts.zip64) {
        x64 = Buffer.alloc(28); x64.writeUInt16LE(1, 0); x64.writeUInt16LE(24, 2);
        x64.writeBigUInt64LE(BigInt(e.claimSize ?? data.length), 4); x64.writeBigUInt64LE(BigInt(comp.length), 12); x64.writeBigUInt64LE(BigInt(opts.badLocal ? 1e12 : off), 20);
        if (opts.shortExtra) x64.writeUInt16LE(8, 2);
        cd.writeUInt32LE(0xffffffff, 20); cd.writeUInt32LE(0xffffffff, 24); cd.writeUInt32LE(0xffffffff, 42); cd.writeUInt16LE(x64.length, 30);
      }
      locals.push(lh, name, comp, desc); cds.push(cd, name, x64);
      off += 30 + name.length + comp.length + desc.length;
    }
    const cdBuf = Buffer.concat(cds);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(off, 16);
    if (!opts.zip64) return Buffer.concat([...locals, cdBuf, eocd]);
    const z = Buffer.alloc(56), zAt = off + cdBuf.length;
    z.writeUInt32LE(0x06064b50, 0); z.writeBigUInt64LE(44n, 4); z.writeUInt16LE(45, 12); z.writeUInt16LE(45, 14);
    z.writeBigUInt64LE(BigInt(entries.length), 24); z.writeBigUInt64LE(BigInt(entries.length), 32); z.writeBigUInt64LE(BigInt(cdBuf.length), 40); z.writeBigUInt64LE(BigInt(opts.badCdOff ? 1e12 : off), 48);
    const loc = Buffer.alloc(20); loc.writeUInt32LE(0x07064b50, 0); loc.writeBigUInt64LE(BigInt(opts.noLocator ? 0 : zAt), 8); loc.writeUInt32LE(1, 16);
    if (opts.noLocator) loc.writeUInt32LE(0, 0);
    eocd.writeUInt16LE(0xffff, 8); eocd.writeUInt16LE(0xffff, 10); eocd.writeUInt32LE(0xffffffff, 12); eocd.writeUInt32LE(0xffffffff, 16);
    return Buffer.concat([...locals, cdBuf, z, loc, eocd]);
  };
  const DB = Buffer.from('SQLite format 3\u0000' + 'x'.repeat(5000));
  const zipOk = makeZip([{ name: 'AppxManifest.xml', data: '<x/>', method: 8 }, { name: 'Public/index.db', data: DB, method: 8, descriptor: true }]);
  check('index: the database is read out of an MSIX-shaped zip (deflate, data descriptor)', W.readZipEntry(zipOk, 'Public/index.db', 1 << 20).equals(DB));
  check('index: a stored entry is read too', W.readZipEntry(makeZip([{ name: 'Public/index.db', data: 'abc', method: 0 }]), 'Public/index.db', 100).toString() === 'abc');
  const throws = (f, re) => { try { f(); return false; } catch (e) { return e instanceof W.ZipError && re.test(e.message); } };
  check('index: a CRC mismatch is refused', throws(() => W.readZipEntry(makeZip([{ name: 'Public/index.db', data: DB, method: 8, badCrc: true }]), 'Public/index.db', 1 << 20), /CRC/));
  check('index: an entry over the cap is refused before inflating', throws(() => W.readZipEntry(zipOk, 'Public/index.db', 100), /larger than/));
  check('index: an entry that inflates past what it claims is refused', throws(() => W.readZipEntry(makeZip([{ name: 'Public/index.db', data: DB, method: 8, claimSize: 10 }]), 'Public/index.db', 20), /inflate|expected|larger/));
  check('index: a missing entry is refused', throws(() => W.readZipEntry(zipOk, 'Public/other.db', 1 << 20), /not in the archive/));
  {
    // 0.41.1: the real source2.msix is ZIP64 (MSIX packagers always write it); 0.41.0 refused it in production.
    const z64 = (o) => makeZip([{ name: 'AppxManifest.xml', data: '<x/>', method: 8 }, { name: 'Public/index.db', data: DB, method: 8, descriptor: true }], { zip64: true, ...o });
    check('index: a ZIP64 archive (MSIX-shaped) is read', W.readZipEntry(z64({}), 'Public/index.db', 1 << 20).equals(DB));
    check('index: ZIP64 — a missing locator is refused', throws(() => W.readZipEntry(z64({ noLocator: true }), 'Public/index.db', 1 << 20), /locator/));
    check('index: ZIP64 — a central directory offset past the end is refused', throws(() => W.readZipEntry(z64({ badCdOff: true }), 'Public/index.db', 1 << 20), /out of bounds|out of range/));
    check('index: ZIP64 — a local header offset past the end is refused', throws(() => W.readZipEntry(z64({ badLocal: true }), 'Public/index.db', 1 << 20), /bad local header|out of bounds/));
    check('index: ZIP64 — a short extra field is refused', throws(() => W.readZipEntry(z64({ shortExtra: true }), 'Public/index.db', 1 << 20), /short ZIP64|bad central/));
    check('index: ZIP64 — the cap still holds', throws(() => W.readZipEntry(z64({}), 'Public/index.db', 100), /larger than/));
  }
  check('index: an encrypted entry is refused', throws(() => W.readZipEntry(makeZip([{ name: 'Public/index.db', data: 'abc', method: 0, encrypted: true }]), 'Public/index.db', 100), /encrypted/));
  check('index: another compression method is refused', throws(() => W.readZipEntry(makeZip([{ name: 'Public/index.db', data: 'abc', method: 12 }]), 'Public/index.db', 100), /method 12/));
  check('index: something that is not a zip is refused', throws(() => W.readZipEntry(Buffer.from('<html>not found</html>'.repeat(4)), 'Public/index.db', 100), /not a zip/));
  check('index: crc32 is the standard one', W.crc32(Buffer.from('123456789')) === 0xcbf43926);

  const rows = W.normalizeIndexRows([
    { id: '7zip.7zip', name: '7-Zip', moniker: '7zip', version: '24.09', publisher: 'igorpavlov' },
    { id: 'Notepad++.Notepad++', name: 'Notepad++', moniker: 'notepad++', version: '8.7.4', publisher: 'notepadplusplusteam' },
    { id: 'Google.Chrome', name: 'Google Chrome', moniker: 'chrome', version: '131.0.6778.86', publisher: 'google' },
    { id: '-x.y', name: 'bad', version: '1' }, { id: 'a b.c', name: 'bad', version: '1' }, { id: 'nodot', name: 'bad', version: '1' },
    { id: '7ZIP.7ZIP', name: 'duplicate', version: '1' }, { id: 'Some.Thing', name: 'No version' },
    { id: 'Odd.Version', name: 'Odd <b>name</b>\u0007', version: 'latest build', publisher: null },
  ]);
  check('index: rows outside the plan charset, duplicates and versionless rows are skipped and counted', rows.rows.length === 4 && rows.skipped === 5, JSON.stringify(rows));
  const odd = rows.rows.find((r) => r.packageId === 'Odd.Version');
  check('index: text is made inert and bounded; a version the agent refuses is kept but not installable', odd && !['<', '>', '\u0007'].some((c) => odd.name.includes(c)) && !W.installable(odd) && W.installable(rows.rows[0]));
  let big = false; try { W.normalizeIndexRows(Array.from({ length: W.INDEX_MAX_ROWS + 1 }, (_, i) => ({ id: `a.b${i}`, name: 'x', version: '1' }))); } catch { big = true; }
  check('index: more rows than the cap is refused', big);
  check('index: schema 2 only', (() => { try { W.checkIndexSchema([{ name: 'majorVersion', value: '1' }]); return false; } catch { return true; } })() && W.checkIndexSchema([{ name: 'majorVersion', value: '2' }, { name: 'lastwritetime', value: '1731456000' }]).writtenAt?.toISOString() === '2024-11-13T00:00:00.000Z');
  const rank = W.rankSearch('7zip', rows.rows).map((r) => r.packageId);
  check('index: an exact id or moniker ranks first', rank[0] === '7zip.7zip', rank.join());
  check('index: every term must match', W.rankSearch('google chrome', rows.rows).map((r) => r.packageId).join() === 'Google.Chrome' && W.rankSearch('google firefox', rows.rows).length === 0);
  // 0.42: tiers — exact, starts with the word, whole word, prefix, id/moniker, substring; shorter name, then id.
  {
    const R = W.normalizeIndexRows([
      { id: 'Flo.Notepad2', name: 'Notepad2', moniker: 'notepad2', version: '4.24', publisher: 'flo' },
      { id: 'JackieLiu.NotepadsApp', name: 'Notepads App', moniker: 'notepads', version: '1.5', publisher: 'jackieliu' },
      { id: 'Rizonesoft.Notepad3', name: 'Notepad3', moniker: 'notepad3', version: '6.24', publisher: 'rizonesoft' },
      { id: 'dail8859.NotepadNext', name: 'Notepad Next', version: '0.9', publisher: 'dail8859' },
      { id: 'Notepad++.Notepad++', name: 'Notepad++', moniker: 'notepad++', version: '8.9.9.1', publisher: 'notepadplusplusteam' },
      { id: 'Microsoft.WindowsNotepad', name: 'Windows Notepad', version: '11.2', publisher: 'microsoft' },
      { id: 'Contoso.SuperNotepadPro', name: 'SuperNotepadPro', version: '1', publisher: 'contoso' },
      { id: 'Google.Chrome', name: 'Google Chrome', moniker: 'chrome', version: '142.0', publisher: 'google' },
      { id: 'Google.ChromeRemoteDesktopHost', name: 'Chrome Remote Desktop Host', version: '1', publisher: 'google' },
      { id: 'Google.Chrome.Canary', name: 'Google Chrome Canary', version: '144.0', publisher: 'google' },
      { id: 'Hibbiki.Chromium', name: 'Chromium', moniker: 'chromium', version: '142.0', publisher: 'hibbiki' },
      { id: 'VideoLAN.VLC', name: 'VLC media player', moniker: 'vlc', version: '3.0.24', publisher: 'videolan' },
      { id: 'Contoso.VLCRemote', name: 'VLC Remote', version: '1', publisher: 'contoso' },
    ]).rows;
    const ids = (q) => W.rankSearch(q, R).map((r) => r.packageId);
    const np = ids('notepad');
    check('rank: "notepad" puts Notepad++ first — a name starting with the whole word, shortest', np[0] === 'Notepad++.Notepad++' && np[1] === 'dail8859.NotepadNext', np.join());
    check('rank: then the whole word inside a name, then a bare prefix, shorter first, then id', np.indexOf('Microsoft.WindowsNotepad') === 2 && np.indexOf('Flo.Notepad2') === 3 && np.indexOf('Rizonesoft.Notepad3') === 4 && np.indexOf('JackieLiu.NotepadsApp') === 5 && np.at(-1) === 'Contoso.SuperNotepadPro', np.join());
    const ch = ids('chrome');
    check('rank: "chrome" gives Google.Chrome first (exact moniker) ahead of a name starting with the word', ch[0] === 'Google.Chrome' && ch[1] === 'Google.ChromeRemoteDesktopHost' && ch[2] === 'Google.Chrome.Canary' && !ch.includes('Hibbiki.Chromium'), ch.join());
    check('rank: an exact name wins over everything', ids('notepad++')[0] === 'Notepad++.Notepad++' && ids('vlc media player')[0] === 'VideoLAN.VLC' && ids('vlc')[0] === 'VideoLAN.VLC');
    check('rank: an exact id wins', ids('google.chrome.canary')[0] === 'Google.Chrome.Canary');
    check('rank: a query with regex characters is literal', ids('notepad+').length >= 1 && ids('n.tepad').length === 0);
  }
  check('index: the search charset refuses shell and SQL characters', W.SEARCH_RE.test('notepad++') && W.SEARCH_RE.test('7-zip') && !["a'b", 'a;b', 'a%b', 'a"b', 'x', '<b>'].some((s) => W.SEARCH_RE.test(s)));
  check('index: WINGET_INDEX_URL is honoured only for loopback http', W.indexUrl({ WINGET_INDEX_URL: 'http://127.0.0.1:3473/source2.msix' }) === 'http://127.0.0.1:3473/source2.msix'
    && ['https://evil.example/source2.msix', 'http://127.0.0.1.evil.example:80/x', 'http://localhost:3473/x', 'file:///etc/passwd', 'http://127.0.0.1:3473/../x?y'].every((u) => W.indexUrl({ WINGET_INDEX_URL: u }) === W.WINGET_INDEX_URL)
    && W.WINGET_INDEX_URL === 'https://cdn.winget.microsoft.com/cache/source2.msix');
  check('index: WINGET_INDEX_SWEEP=off and nothing else stops the sweep', !W.indexSweepEnabled({ WINGET_INDEX_SWEEP: 'off' }) && W.indexSweepEnabled({ WINGET_INDEX_SWEEP: 'OFF' }) && W.indexSweepEnabled({}));
  const T0 = new Date('2026-11-13T12:00:00Z'), hrs = (h) => new Date(T0.getTime() - h * 3600_000);
  check('index: due when never read, daily after a success, an hour after a failure',
    W.refreshDue(null, T0) && !W.refreshDue({ refreshedAt: hrs(23), attemptedAt: hrs(23) }, T0) && W.refreshDue({ refreshedAt: hrs(25), attemptedAt: hrs(25) }, T0)
      && !W.refreshDue({ refreshedAt: null, attemptedAt: hrs(0.5) }, T0) && W.refreshDue({ refreshedAt: null, attemptedAt: hrs(1.5) }, T0) && !W.refreshDue({ refreshedAt: hrs(30), attemptedAt: hrs(0.2) }, T0));

  // Installer choice and detection, on manifests shaped like the real ones.
  const SEVENZIP = `PackageIdentifier: 7zip.7zip\nPackageVersion: "24.09"\nInstallerLocale: en-US\nMinimumOSVersion: 10.0.0.0\nScope: machine\nInstallers:\n- Architecture: x86\n  InstallerType: exe\n  InstallerUrl: https://www.7-zip.org/a/7z2409.exe\n  InstallerSha256: ${H('1')}\n  ProductCode: 7-Zip\n- Architecture: x64\n  InstallerType: exe\n  InstallerUrl: https://www.7-zip.org/a/7z2409-x64.exe\n  InstallerSha256: ${H('2')}\n  ProductCode: 7-Zip\n- Architecture: arm64\n  InstallerType: exe\n  InstallerUrl: https://www.7-zip.org/a/7z2409-arm64.exe\n  InstallerSha256: ${H('3')}\n  ProductCode: 7-Zip\n- Architecture: x64\n  InstallerType: wix\n  InstallerUrl: https://www.7-zip.org/a/7z2409-x64.msi\n  InstallerSha256: ${H('4')}\n  ProductCode: '{23170F69-40C1-2702-2409-000001000000}'\n  AppsAndFeaturesEntries:\n  - DisplayName: 7-Zip 24.09 (x64 edition)\n    ProductCode: '{23170F69-40C1-2702-2409-000001000000}'\n    UpgradeCode: '{23170F69-40C1-2702-0000-000004000000}'\nManifestType: installer\nManifestVersion: 1.9.0\n`;
  const sz = D.parseInstallerManifest(SEVENZIP);
  const sx = D.autoSelectInstaller(sz, 'x64');
  check('one-click: 7-Zip x64 picks the first x64 machine installer in manifest order, and says another one exists', sx.ok && sx.installer.installerSha256 === H('2') && sx.alternatives === 1, JSON.stringify(sx).slice(0, 200));
  check('one-click: an arm64 computer gets the arm64 installer; an x86 one the x86', D.autoSelectInstaller(sz, 'arm64').installer.installerSha256 === H('3') && D.autoSelectInstaller(sz, 'x86').installer.installerSha256 === H('1'));
  const d7 = D.deriveDetection(sx.installer, '24.09');
  check('one-click: 7-Zip\'s ARP key name becomes an uninstall_key rule at the package version', d7?.kind === 'uninstall_key' && d7.key === '7-Zip' && d7.version === '24.09' && d7.compare === 'gte');
  const d7m = D.deriveDetection(sz.installers[3], '24.09');
  check('one-click: the MSI\'s AppsAndFeaturesEntries product code is the rule; with no DisplayVersion it is presence', d7m?.kind === 'uninstall_key' && d7m.key === '{23170F69-40C1-2702-2409-000001000000}' && d7m.version === '0');
  check('one-click: an AppsAndFeaturesEntries list is read per installer', sz.installers[3].appsAndFeatures.length === 1 && sz.installers[1].appsAndFeatures.length === 0);
  const CHROME = `PackageIdentifier: Google.Chrome\nPackageVersion: 131.0.6778.86\nInstallerType: wix\nScope: machine\nUpgradeBehavior: install\nAppsAndFeaturesEntries:\n- DisplayName: Google Chrome\n  Publisher: Google LLC\n  DisplayVersion: 131.0.6778.86\n  ProductCode: '{D4A9D1E5-5D04-3B53-BAB2-0E7B54B9C8E1}'\nInstallers:\n- Architecture: x86\n  InstallerUrl: https://dl.google.com/x86.msi\n  InstallerSha256: ${H('5')}\n- Architecture: x64\n  InstallerUrl: https://dl.google.com/x64.msi\n  InstallerSha256: ${H('6')}\nManifestType: installer\nManifestVersion: 1.9.0\n`;
  const ch = D.parseInstallerManifest(CHROME);
  const cs = D.autoSelectInstaller(ch, 'x64');
  const dc = cs.ok ? D.deriveDetection(cs.installer, '131.0.6778.86') : null;
  check('one-click: root AppsAndFeaturesEntries apply to every installer; Chrome x64 → its GUID at DisplayVersion', cs.ok && cs.installer.installerSha256 === H('6') && dc?.key === '{D4A9D1E5-5D04-3B53-BAB2-0E7B54B9C8E1}' && dc.version === '131.0.6778.86', JSON.stringify(dc));
  const NPP = `PackageIdentifier: Notepad++.Notepad++\nPackageVersion: 8.7.4\nInstallerType: nullsoft\nInstallers:\n- Architecture: x86\n  Scope: user\n  InstallerUrl: https://x/npp.x86.exe\n  InstallerSha256: ${H('7')}\n- Architecture: x64\n  InstallerUrl: https://x/npp.x64.exe\n  InstallerSha256: ${H('8')}\n  ProductCode: Notepad++\n- Architecture: x64\n  Scope: machine\n  InstallerUrl: https://x/npp.x64.exe\n  InstallerSha256: ${H('9')}\n  ProductCode: Notepad++\n  AppsAndFeaturesEntries:\n  - DisplayName: Notepad++ (64-bit x64)\n    DisplayVersion: 8.7.4\nManifestType: installer\n`;
  const np = D.autoSelectInstaller(D.parseInstallerManifest(NPP), 'x64');
  check('one-click: an explicit machine scope beats an unstated one', np.ok && np.installer.installerSha256 === H('9'));
  const dn = D.deriveDetection(np.installer, '8.7.4');
  check('one-click: an AppsAndFeaturesEntries entry with no product code falls back to the installer\'s own', dn?.kind === 'uninstall_key' && dn.key === 'Notepad++' && dn.version === '8.7.4', JSON.stringify(dn));
  const ONLYUSER = `PackageIdentifier: A.B\nPackageVersion: 1\nInstallers:\n- Architecture: x64\n  Scope: user\n  InstallerSha256: ${H('a')}\n- Architecture: x64\n  InstallerType: portable\n  InstallerSha256: ${H('b')}\n- Architecture: arm64\n  InstallerSha256: ${H('c')}\n`;
  const nu = D.autoSelectInstaller(D.parseInstallerManifest(ONLYUSER), 'x64');
  check('one-click: per-user, portable and wrong-architecture installers are never chosen → NO_MACHINE_INSTALLER', !nu.ok && nu.code === 'NO_MACHINE_INSTALLER');
  const LOC = `PackageIdentifier: A.B\nPackageVersion: 1\nInstallers:\n- Architecture: x64\n  InstallerLocale: de-DE\n  InstallerSha256: ${H('d')}\n- Architecture: x64\n  InstallerLocale: en-US\n  InstallerSha256: ${H('e')}\n`;
  check('one-click: en-US is preferred over another locale', D.autoSelectInstaller(D.parseInstallerManifest(LOC), 'x64').installer.installerSha256 === H('e'));
  const NEUT = `PackageIdentifier: A.B\nPackageVersion: 1\nInstallers:\n- Architecture: neutral\n  InstallerSha256: ${H('f')}\n`;
  check('one-click: a neutral installer serves x64', D.autoSelectInstaller(D.parseInstallerManifest(NEUT), 'x64').installer?.installerSha256 === H('f'));
  check('one-click: no product code and no display name → no rule (refused, not guessed)', D.deriveDetection(D.parseInstallerManifest(NEUT).installers[0], '1') === null);
  const nameOnly = D.parseInstallerManifest(`PackageIdentifier: A.B\nPackageVersion: 2.0\nInstallers:\n- Architecture: x64\n  InstallerSha256: ${H('0')}\n  AppsAndFeaturesEntries:\n  - DisplayName: Some App\n`).installers[0];
  const dno = D.deriveDetection(nameOnly, '2.0');
  check('one-click: a display name alone → an exact display_name rule', dno?.kind === 'display_name' && dno.match === 'exact' && dno.name === 'Some App' && dno.version === '2.0');
  const evilKey = D.parseInstallerManifest(`PackageIdentifier: A.B\nPackageVersion: 2.0\nInstallers:\n- Architecture: x64\n  InstallerSha256: ${H('0')}\n  ProductCode: ..\\\\Run\n`).installers[0];
  check('one-click: a product code outside the key charset is not used', D.deriveDetection(evilKey, '2.0') === null);
  check('one-click: the architecture comes from the OS', D.archOf('64-bit') === 'x64' && D.archOf('ARM 64-bit Processor') === 'arm64' && D.archOf('32-bit') === 'x86' && D.archOf(null) === 'x64');
  check('one-click: an entry name from the index is inert and bounded', D.entryName('A\u0000<b>' + 'x'.repeat(300), 'A.B').length <= 120 && !['<', '>', '\u0000'].some((c) => D.entryName('A\u0000<b>', 'A.B').includes(c)) && D.entryName('', 'A.B') === 'A.B');
  check('one-click: the request is closed', D.QuickInstallDto.safeParse({ packageId: '7zip.7zip' }).success && !D.QuickInstallDto.safeParse({ packageId: '7zip.7zip', installerSha256: H('1') }).success && !D.QuickInstallDto.safeParse({ packageId: '-h.x' }).success);
  check('one-click: adding from the search never takes a pasted hash', !D.FromWingetDto.safeParse({ scope: 'global', packageId: '7zip.7zip', hash: { source: 'admin_pasted', installerSha256: H('1') } }).success);

  // Removing a program.
  const RP = (p) => cat.RemoveParams.safeParse(p).success;
  check('remove: the reference params parse', RP({ key: '{23170F69-40C1-2702-2409-000001000000}', view: '64', displayName: '7-Zip 24.09 (x64 edition)' }) && RP({ key: 'Mozilla Firefox 132.0 (x64 en-US)', view: '64', displayName: 'Mozilla Firefox (x64 en-US)' }) && RP({ key: 'Notepad++', view: '32', displayName: 'Notepad++ (32-bit x86)' }));
  for (const k of ['..\\Run', 'a\\b', 'a/b', '-x', ' x', 'a"b', 'a;b', 'a|b', '%TEMP%', 'a`b', 'a$b', '', 'x'.repeat(129)]) check(`remove: key ${JSON.stringify(k).slice(0, 20)} is refused`, !RP({ key: k, view: '64', displayName: 'X' }));
  for (const n of ['', ' X', 'X ', 'a"b', 'a<b', 'a\\b', 'a\u0000b', 'a\nb', 'x'.repeat(201)]) check(`remove: display name ${JSON.stringify(n).slice(0, 20)} is refused`, !RP({ key: 'X', view: '64', displayName: n }));
  check('remove: the view is 64 or 32 only, and nothing else is accepted', !RP({ key: 'X', view: '128', displayName: 'X' }) && !RP({ key: 'X', view: '64', displayName: 'X', command: 'cmd /c calc' }) && !RP({ key: 'X', view: '64' }));
  check('remove: the action is high impact, one computer, not direct and not offered to ClientSt0r', cat.SOFTWARE_REMOVE.risk([]) === 'high' && cat.SOFTWARE_REMOVE.maxTargets === 1 && cat.SOFTWARE_REMOVE.direct === false && cat.SOFTWARE_REMOVE.integration === false);
  const inv = E.sanitizeSoftware([
    { name: '7-Zip 24.09 (x64)', version: '24.09', publisher: 'Igor Pavlov', key: '7-Zip', view: '64', quiet: true, msi: false },
    { name: 'Chrome', version: '131', key: '{D4A9D1E5-5D04-3B53-BAB2-0E7B54B9C8E1}', view: '32', quiet: false, msi: true },
    { name: 'Evil', version: '1', key: '..\\Run', view: '64', quiet: true },
    { name: 'NoView', version: '1', key: 'NoView', view: 'x', quiet: true },
    { name: 'Interactive', version: '1', key: 'Interactive', view: '64', quiet: false, msi: false, kind: 'none' },
    { name: 'Old agent', version: '1' },
  ]);
  const by = Object.fromEntries(inv.map((p) => [p.name, p]));
  check('inventory: a key outside the charset, or without a view, is dropped (the program is kept)', by.Evil && by.Evil.key === undefined && by.NoView.key === undefined && by['7-Zip 24.09 (x64)'].key === '7-Zip' && by.Chrome.view === '32');
  const progs = D.installedOf(inv);
  const P = Object.fromEntries(progs.map((p) => [p.name, p]));
  check('remove: an MSI product key → msiexec; a silent uninstall → quiet', D.removalHint(P.Chrome).method === 'msi' && D.removalHint(P['7-Zip 24.09 (x64)']).method === 'quiet');
  // 0.42: the kinds the collector recognises, RustDesk and Rem0te protected, and the list banner.
  const prog = (name, extra) => D.installedOf([{ name, key: 'K', view: '64', ...extra }])[0];
  for (const k of ['msi', 'quiet', 'inno', 'nsis', 'chromium']) check(`remove: kind ${k} is offered, as ${k}`, D.removalHint(prog('App', { kind: k })).possible && D.removalHint(prog('App', { kind: k })).method === k);
  for (const [k, code, re] of [['office', 'office', /Click-to-Run/], ['driver', 'driver', /driver package/i], ['none', 'interactive', /interactive/]]) {
    const h = D.removalHint(prog('App', { kind: k }));
    check(`remove: kind ${k} is not offered, with its reason`, !h.possible && h.code === code && re.test(h.reason), JSON.stringify(h));
  }
  check('remove: an unknown kind from a device is dropped, not trusted', D.installedOf([{ name: 'A', key: 'K', view: '64', kind: 'shell' }])[0].kind === null);
  for (const n of ['RustDesk', 'rustdesk 1.4.3', 'Rem0te Agent', 'rem0te-tray', 'Reboot Remote']) {
    const h = D.removalHint(prog(n, { kind: 'quiet', quiet: true }));
    check(`remove: ${n} is protected even with a silent uninstall`, !h.possible && h.code === 'protected' && /RustDesk and Rem0te/.test(h.reason), JSON.stringify(h));
  }
  check('remove: the key alone also protects', D.removalHint(D.installedOf([{ name: 'Remote helper', key: 'RustDesk', view: '64', kind: 'quiet' }])[0]).code === 'protected');
  check('remove: lookalikes are not protected', ['RustDesker', 'Remote Desktop Manager', 'Rem0teX'].every((n) => D.removalHint(prog(n, { kind: 'quiet' })).possible));
  check('remove: the portal and agent protected-program patterns are one expression', cat.PROTECTED_PROGRAM_RE.source === '^(?:rustdesk|rem0te|reboot ?remote)(?:[^a-z0-9]|$)' && cat.PROTECTED_PROGRAM_RE.flags === 'i');
  {
    const E = require(path.join(dist, 'monitoring/engine.js'));
    const sw = E.sanitizeSoftware([{ name: 'A', key: 'A_is1', view: '32', kind: 'inno' }, { name: 'B', key: 'B', view: '64', kind: 'run-this' }, { name: 'C', kind: 'nsis' }]);
    const by = Object.fromEntries(sw.map((x) => [x.name, x]));
    check('inventory: a known removal kind is kept with its key; anything else, or a kind without a key, is dropped', by.A.kind === 'inno' && by.B.kind === undefined && by.C.kind === undefined, JSON.stringify(sw));
  }
  {
    const Wi = require(path.join(dist, 'software/winget-index.js'));
    const T = new Date('2026-11-14T12:00:00Z'), h = (x) => new Date(T.getTime() - x * 3600_000);
    check('index: the next read — now when never read, an hour after a failed attempt, a day after a success, never with the sweep off',
      Wi.nextIndexRead(null, T, true).getTime() === T.getTime() && Wi.nextIndexRead({ refreshedAt: null, attemptedAt: h(0.25) }, T, true).getTime() === T.getTime() + 45 * 60_000
        && Wi.nextIndexRead({ refreshedAt: h(2), attemptedAt: h(2) }, T, true).getTime() === T.getTime() + 22 * 3600_000 && Wi.nextIndexRead(null, T, false) === null);
  }
  check('remove: a 0.41 inventory (booleans, no kind) says to refresh for the newer forms', D.removalHint(prog('App', { quiet: false, msi: false })).code === 'old_collector');
  const st = (list) => D.inventoryRemovalState(D.installedOf(list));
  check('remove: the banner — no keys → refresh; keys without kinds → refresh (old collector); kinds → nothing',
    st([{ name: 'A' }, { name: 'B' }]).needsRefresh === 'no_keys' && st([{ name: 'A', key: 'A', view: '64', quiet: false }]).needsRefresh === 'old_collector'
      && st([{ name: 'A', key: 'A', view: '64', kind: 'none' }]).needsRefresh === null && st([]).needsRefresh === null, JSON.stringify(st([{ name: 'A' }])));
  check('remove: interactive only, or no key reported, → not offered, with the reason', !D.removalHint(P.Interactive).possible && /interactive/.test(D.removalHint(P.Interactive).reason) && !D.removalHint(P['Old agent']).possible && /0\.41/.test(D.removalHint(P['Old agent']).reason) && !D.removalHint(P.Evil).possible);
  const entries = [{ id: 'e1', detection: { kind: 'uninstall_key', key: '7-zip', compare: 'gte', version: '24' } }, { id: 'e2', detection: { kind: 'display_name', name: 'Chr', match: 'prefix', compare: 'gte', version: '1' } }, { id: 'e3', detection: { kind: 'file_version', base: 'ProgramFiles', file: 'x.exe', compare: 'gte', version: '1' } }];
  check('remove: a program a catalog entry describes is uninstalled through that entry', D.entryFor(P['7-Zip 24.09 (x64)'], entries)?.id === 'e1' && D.entryFor(P.Chrome, entries)?.id === 'e2' && D.entryFor(P.Interactive, entries) === null);
  check('remove: the request is closed and names the inventory\'s key', D.RemoveProgramDto.safeParse({ key: '7-Zip', view: '64', displayName: '7-Zip 24.09 (x64)' }).success && !D.RemoveProgramDto.safeParse({ key: '7-Zip', view: '64', displayName: 'x', quietUninstallString: 'calc.exe' }).success);
}

// ── 0.42: the inventory collector's removal kinds, under PowerShell ─────────
{
  const fx = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'tools/windows-installer/internal/action/testdata/removal-kinds.json'), 'utf8')).cases;
  const W = require(path.join(dist, 'public/windows-script.js'));
  const script = W.buildSignedWindowsScript('0.42.0');
  const a = script.indexOf('function Split-Rem0teUninstall'), b = script.indexOf('function Get-Rem0teInventory');
  check('collector: the removal-kind functions are in the signed install script, before the inventory', a > 0 && b > a && /kind = \(Get-Rem0teRemovalKind \(\[string\]\$ue\.PSChildName\) \$ue\)/.test(script));
  const fns = script.slice(a, b);
  check('collector: the removal-kind functions only read', !/Start-Process|Invoke-Expression|\biex\b|Remove-Item|Set-ItemProperty|New-ItemProperty|\.Invoke\(|&\s*\$|cmd\.exe \/c|msiexec\s+\/x/i.test(fns.replace(/^\s*#.*$/gm, '').replace(/'[^'\n]*'/g, "''")));
  const pwsh = process.env.PWSH || 'pwsh';
  let have = true; try { execFileSync(pwsh, ['-NoProfile', '-Command', '1'], { stdio: 'ignore' }); } catch { have = false; }
  if (!have) console.log('  (pwsh not found: the collector fixture run is skipped; set PWSH)');
  else {
    const dir = mkdtempSync(path.join(tmpdir(), 'rmkind-'));
    try {
      writeFileSync(path.join(dir, 'fx.json'), JSON.stringify(fx));
      // Test-Rem0teNsis reads the file; here the fixture says which files carry the header.
      writeFileSync(path.join(dir, 'run.ps1'), `${fns}
$nsisFiles = @{}
$cases = Get-Content -Raw -LiteralPath '${path.join(dir, 'fx.json')}' | ConvertFrom-Json
foreach ($c in $cases) { if ($c.nsis) { $sp = Split-Rem0teUninstall ([string]$c.uninstallString); if ($sp) { $nsisFiles[$sp.exe] = $true } } }
function Test-Rem0teNsis([string]$path) { return [bool]$nsisFiles[$path] }
$out = foreach ($c in $cases) {
  $ue = [pscustomobject]@{ DisplayName = [string]$c.displayName; UninstallString = $c.uninstallString; QuietUninstallString = $c.quietUninstallString; WindowsInstaller = $(if ($c.windowsInstaller) { 1 } else { $null }) }
  [pscustomobject]@{ name = $c.name; kind = (Get-Rem0teRemovalKind ([string]$c.key) $ue) }
}
$out | ConvertTo-Json -Compress
`);
      const got = JSON.parse(execFileSync(pwsh, ['-NoProfile', '-NonInteractive', '-File', path.join(dir, 'run.ps1')], { encoding: 'utf8' }));
      const byName = Object.fromEntries(got.map((g) => [g.name, g.kind]));
      for (const c of fx) check(`collector: ${c.name} → ${c.kind} (as the agent decides)`, byName[c.name] === c.kind, `got ${byName[c.name]}`);
      // The real NSIS reader, on files: an NSIS header, an ordinary file, a missing one.
      const nsisFile = path.join(dir, 'uninst.exe'), plainFile = path.join(dir, 'plain.exe');
      writeFileSync(nsisFile, Buffer.concat([Buffer.from('MZ'), Buffer.alloc(40000), Buffer.from([0xef, 0xbe, 0xad, 0xde]), Buffer.from('NullsoftInst'), Buffer.alloc(100)]));
      writeFileSync(plainFile, Buffer.concat([Buffer.from('MZ'), Buffer.alloc(40000), Buffer.from('Nullsoft but no header')]));
      writeFileSync(path.join(dir, 'head.ps1'), `${fns}\n@((Test-Rem0teNsis '${nsisFile}'), (Test-Rem0teNsis '${plainFile}'), (Test-Rem0teNsis '${path.join(dir, 'missing.exe')}')) | ConvertTo-Json -Compress\n`);
      const heads = JSON.parse(execFileSync(pwsh, ['-NoProfile', '-NonInteractive', '-File', path.join(dir, 'head.ps1')], { encoding: 'utf8' }));
      check('collector: the NSIS header is read from the file itself', heads.join() === 'true,false,false', heads.join());
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
}

if (failures.length) {
  console.error(`✗ ${failures.length} failed, ${passed} passed`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ ${passed} software-deployment checks passed`);
