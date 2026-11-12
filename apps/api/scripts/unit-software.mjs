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
 *   - that WINGET_MANIFEST_BASE is honoured only for a loopback http URL.
 *
 *   cd apps/api && npx nest build && node scripts/unit-software.mjs
 */
import path from 'node:path';
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
check('the catalog ends with the two software actions', ids.slice(-2).join(',') === 'windows.software.install@1,windows.software.uninstall@1' && ids.length === 8, ids.join(','));
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

if (failures.length) {
  console.error(`✗ ${failures.length} failed, ${passed} passed`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ ${passed} software-deployment checks passed`);
