#!/usr/bin/env node
// Tests for the read-only diagnostics palette (0.76), run against dist:
//
//   cd apps/api && npx nest build && node scripts/unit-diagnostics-palette.mjs
//
// Pure parts: the thirteen catalog entries, the typed-parameter schema (and
// that the portal, the agent and the database hold the same host-name rule),
// every sanitizer against hostile input, every interpretation threshold, the
// rule that nothing unread is Healthy, and the OS end-of-servicing table.
// Then the build-time guard on the agent's palette block, each refusal proven
// by mutating the script. With pwsh (on PATH, or PWSH=/path/to/pwsh) it
// parses the block with PowerShell's own parser and runs every palette key
// against stub cmdlets in two worlds — a desktop and a Server without
// BitLocker, Secure Boot or a TPM — checking every post and that no secret a
// stub carries (a recovery password, a product key, a task's command line, a
// SID) reaches a result.
//
// SIMULATED: stubs stand in for Windows. The Windows lab
// (tools/lab/windows/diagnostics-lab.mjs) runs the same block for real.

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const c = require(join(here, '..', 'dist', 'diagnostics-catalog', 'catalog.js'));
const ip = require(join(here, '..', 'dist', 'diagnostics-catalog', 'interpret.js'));
const w = require(join(here, '..', 'dist', 'public', 'windows-script.js'));

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => { if (ok) passed++; else failures.push(`${name}${detail ? ` — ${detail}` : ''}`); };

const PALETTE = ['defender_status', 'firewall_status', 'bitlocker_status', 'secure_boot_tpm', 'local_admins', 'dns_lookup', 'tcp_port', 'route_table', 'time_sync', 'windows_activation', 'unexpected_shutdowns', 'scheduled_tasks', 'signed_in_sessions'];
const AT = '2026-11-20T12:00:00.000Z';
const NOW = Date.parse(AT);
const daysAgo = (n) => new Date(NOW - n * 86_400_000).toISOString();
const states = (i) => (i?.findings ?? []).map((f) => `${f.id}:${f.state}`).join(' ');
const stateOf = (i, id) => i?.findings?.find((f) => f.id === id)?.state;

// ── The catalog ─────────────────────────────────────────────────────────────
{
  check('the thirteen palette keys follow the twelve, in order', JSON.stringify(c.DIAGNOSTIC_KEYS.slice(12)) === JSON.stringify(PALETTE));
  for (const k of PALETTE) {
    const e = c.catalogEntry(k);
    check(`${k}: read-only, no impact, no approvals, Windows, a group, agent 0.76.0, lab evidence only`,
      e && e.risk === 'read_only' && e.expectedImpact === 'none' && e.approvals === 'none (read-only)' && JSON.stringify(e.supportedOs) === '["windows"]'
        && ['security', 'networking', 'maintenance'].includes(e.group) && e.minAgent === '0.76.0' && e.evidence === 'lab_windows_server' && !e.tab, JSON.stringify(e));
  }
  check('every entry has a group, and snapshot keys keep their tab', c.CATALOG.every((e) => ['general', 'security', 'networking', 'maintenance'].includes(e.group)) && c.CATALOG.filter((e) => e.tab).length === 3);
  check('Run all security checks is exactly the five security keys', JSON.stringify(c.SECURITY_KEYS) === JSON.stringify(['defender_status', 'firewall_status', 'bitlocker_status', 'secure_boot_tpm', 'local_admins']) && c.SECURITY_KEYS.every((k) => c.catalogEntry(k).group === 'security'));
  check('only dns_lookup and tcp_port declare parameters', JSON.stringify(c.CATALOG.filter((e) => e.params).map((e) => e.key)) === '["dns_lookup","tcp_port"]');
  check('the two keys that take a target need computers:connect', ['dns_lookup', 'tcp_port'].every((k) => c.catalogEntry(k).capability === 'computers:connect'));
  check('BitLocker and activation say what is never read', /never read/i.test(c.catalogEntry('bitlocker_status').description) && /never read/i.test(c.catalogEntry('windows_activation').description) && /never read/i.test(c.catalogEntry('scheduled_tasks').description));
  check('agentTooOld: 0.75.0 is too old, 0.76.0 and later are not, unknown is not refused',
    c.agentTooOld(c.catalogEntry('defender_status'), '0.75.0') && !c.agentTooOld(c.catalogEntry('defender_status'), '0.76.0') && !c.agentTooOld(c.catalogEntry('defender_status'), '0.80.1')
      && !c.agentTooOld(c.catalogEntry('defender_status'), 'unknown') && !c.agentTooOld(c.catalogEntry('defender_status'), null) && !c.agentTooOld(c.catalogEntry('disk_space'), '0.31.0'));
}

// ── Typed parameters ────────────────────────────────────────────────────────
{
  const P = (k, v) => c.parseDiagnosticParams(k, v);
  check('a key without a schema takes nothing: undefined and null pass', P('disk_space', undefined).ok && P('disk_space', null).ok && P('disk_space', undefined).params === null);
  for (const v of [{}, { name: 'x' }, [], 'x', 0, false]) check(`a key without a schema refuses ${JSON.stringify(v)}`, !P('disk_space', v).ok && !P('defender_status', v).ok);
  check('an unknown key is refused', !P('run_script', undefined).ok);
  check('dns_lookup: a host name is accepted and returned canonical', JSON.stringify(P('dns_lookup', { name: 'portal.example.com' })) === '{"ok":true,"params":{"name":"portal.example.com"}}');
  check('dns_lookup: an IPv4 literal and a single label are accepted', P('dns_lookup', { name: '10.0.0.1' }).ok && P('dns_lookup', { name: 'fileserver' }).ok && P('dns_lookup', { name: 'a'.repeat(63) }).ok);
  const badNames = ['', ' ', 'a b', 'evil.com;whoami', 'https://x.com', 'x.com/path', 'user@x.com', '-x.com', 'x-.com', 'x..com', '.x.com', 'x.com.', 'x_y.com', '*.x.com', 'x.com\n', '\nx.com', 'x.com\r\n',
    'a'.repeat(64), `${'a'.repeat(60)}.`.repeat(5).slice(0, 254), '$(calc)', '`calc`', "x'.com", 'x".com', 'ex%41mple.com', 'xn--', '::1', '[::1]', 'x.com:443', 'ｘ.com', 'é.com', null, 5, ['x.com'], { toString: () => 'x.com' }];
  for (const n of badNames) check(`dns_lookup refuses the name ${JSON.stringify(n)?.slice(0, 40)}`, !P('dns_lookup', { name: n }).ok);
  check('dns_lookup refuses a 254-character name and accepts a 253-character one', !P('dns_lookup', { name: `${'a'.repeat(63)}.`.repeat(4).slice(0, 254) }).ok && P('dns_lookup', { name: `${'a'.repeat(63)}.${'a'.repeat(63)}.${'a'.repeat(63)}.${'a'.repeat(61)}` }).ok);
  check('dns_lookup refuses an extra field, a missing name, an array and a non-plain object', !P('dns_lookup', { name: 'x.com', type: 'MX' }).ok && !P('dns_lookup', {}).ok && !P('dns_lookup', ['x.com']).ok && !P('dns_lookup', Object.create({ name: 'x.com' })).ok && !P('dns_lookup', undefined).ok);
  check('tcp_port: host, port and timeout are accepted and returned canonical', JSON.stringify(P('tcp_port', { host: 'db.corp.example', port: 5432, timeoutSeconds: 3 })) === '{"ok":true,"params":{"host":"db.corp.example","port":5432,"timeoutSeconds":3}}');
  check('tcp_port: the timeout defaults to 5 seconds', P('tcp_port', { host: 'x.com', port: 443 }).params?.timeoutSeconds === 5);
  for (const port of [0, -1, 65536, 1.5, '443', NaN, Infinity, null, true, 1e10]) check(`tcp_port refuses the port ${String(port)}`, !P('tcp_port', { host: 'x.com', port, timeoutSeconds: 5 }).ok);
  check('tcp_port accepts ports 1 and 65535', P('tcp_port', { host: 'x.com', port: 1 }).ok && P('tcp_port', { host: 'x.com', port: 65535 }).ok);
  for (const t of [0, 4, 6, 11, 30, '5', 2.5, null]) check(`tcp_port refuses the timeout ${String(t)}`, !P('tcp_port', { host: 'x.com', port: 443, timeoutSeconds: t }).ok);
  check('tcp_port accepts each listed timeout', [1, 2, 3, 5, 10].every((t) => P('tcp_port', { host: 'x.com', port: 443, timeoutSeconds: t }).ok));
  check('tcp_port refuses a bad host, an extra field and a name field', !P('tcp_port', { host: 'x.com;rm', port: 443 }).ok && !P('tcp_port', { host: 'x.com', port: 443, data: 'GET /' }).ok && !P('tcp_port', { name: 'x.com', port: 443 }).ok);
  // One rule, three places.
  const mig = readFileSync(join(here, '..', 'prisma', 'migrations', '0092_diagnostics_palette', 'migration.sql'), 'utf8');
  const sqlPatterns = [...mig.matchAll(/~ '(\^\[A-Za-z0-9\][^']*)'/g)].map((m) => m[1]);
  check('the host-name rule is the same text in the portal, the agent and the database (both CHECK clauses)',
    c.HOSTNAME_RE_SOURCE === w.PALETTE_HOSTNAME_RE && sqlPatterns.length === 2 && sqlPatterns.every((p) => p === c.HOSTNAME_RE_SOURCE), JSON.stringify({ ts: c.HOSTNAME_RE_SOURCE, ps: w.PALETTE_HOSTNAME_RE, sql: sqlPatterns }));
  check('the database CHECK names the exact fields and the timeout list', /\("params" - 'name'\) = '\{\}'::jsonb/.test(mig) && /\("params" - 'host' - 'port' - 'timeoutSeconds'\) = '\{\}'::jsonb/.test(mig) && /IN \('1', '2', '3', '5', '10'\)/.test(mig) && /ELSE "params" IS NULL/.test(mig));
  check('the timeout list agrees with the agent', JSON.stringify(c.TCP_TIMEOUTS) === '[1,2,3,5,10]');
}

// ── Sanitising ──────────────────────────────────────────────────────────────
{
  const S = c.sanitizeResult;
  const bl = S('bitlocker_status', { supported: true, volumes: [
    { mountPoint: 'C:', volumeType: 'OperatingSystem', protectionStatus: 'On', volumeStatus: 'FullyEncrypted', encryptionMethod: 'XtsAes128', encryptionPercentage: 100, protectorTypes: ['Tpm', 'RecoveryPassword', '123456-123456-123456-123456-123456-123456-123456-123456', 'Tpm'], recoveryPassword: '123456-123456-123456-123456-123456-123456-123456-123456', keyProtectorId: '{abc}' },
    { mountPoint: 'C:\\Users\\alice', volumeType: 'Data' },
    { mountPoint: '\\\\?\\Volume{01234567-89ab-cdef-0123-456789abcdef}\\', volumeType: 'Data', volumeStatus: 'FullyDecrypted', encryptionPercentage: 140 },
  ] });
  const blJson = JSON.stringify(bl);
  check('bitlocker: no recovery password or protector id survives, kinds are a closed list', !/123456-123456|keyProtectorId|recoveryPassword|\{abc\}/.test(blJson) && JSON.stringify(bl.volumes[0].protectorTypes) === '["RecoveryPassword","Tpm"]', blJson);
  check('bitlocker: a mount point must be a drive or a volume GUID path', bl.volumes.length === 2 && bl.volumes[1].mountPoint.startsWith('\\\\?\\Volume{'));
  check('bitlocker: a percentage over 100 is dropped', bl.volumes[1].encryptionPercentage === null);
  check('bitlocker: unsupported keeps only its reason', JSON.stringify(S('bitlocker_status', { supported: false, reason: 'rm -rf', volumes: [{ mountPoint: 'C:' }] })) === '{"supported":false,"reason":"not_installed","error":null}');
  const act = S('windows_activation', { products: [{ name: 'Windows(R), Professional edition', channel: 'Retail', licenseStatus: 1, graceMinutes: 0, partialProductKey: 'ABCDE', productKey: 'XXXXX-XXXXX-XXXXX-XXXXX-ABCDE' }] });
  check('activation: no product key or partial key survives', !/ABCDE|XXXXX|productKey/i.test(JSON.stringify(act)) && act.products[0].licenseStatus === 1);
  const tasks = S('scheduled_tasks', { taskCount: 3, microsoftTasks: 1, tasks: [
    { path: '\\', name: 'Backup', state: 'Ready', author: 'CORP\\admin', runAs: 'SYSTEM', lastRunAt: '1999-11-30T00:00:00Z', lastResult: 267011, nextRunAt: '2026-11-21T02:00:00Z', actions: [{ execute: 'C:\\evil.exe', arguments: '-p hunter2' }], command: 'C:\\evil.exe -p hunter2' },
    { path: '\\Vendor\\', name: 'Updater', state: 'Exploding', author: 'C:\\Users\\bob\\x', runAs: 'bad;acct', lastResult: 1 },
  ] });
  const tj = JSON.stringify(tasks);
  check('tasks: no action, command or argument survives', !/evil|hunter2|actions|command/i.test(tj), tj);
  check('tasks: Task Scheduler\'s 1999 "never" is no date; states are closed; accounts checked; profile paths redacted', tasks.tasks[0].lastRunAt === null && tasks.tasks[1].state === 'Unknown' && tasks.tasks[1].runAs === null && tasks.tasks[1].author === '%USERPROFILE%\\x', tj);
  const adm = S('local_admins', { method: 'localaccounts', members: [{ name: 'PC\\Administrator', kind: 'User', source: 'Local', builtinAdministrator: true, sid: 'S-1-5-21-1-2-3-500' }, { name: 'bad;name', kind: 'Robot', source: 'Mars' }] });
  check('admins: no SID survives; names, kinds and sources are checked', !/S-1-5/.test(JSON.stringify(adm)) && adm.members[1].name === null && adm.members[1].kind === 'Unknown' && adm.members[1].source === null && adm.members[0].builtinAdministrator === true);
  const tcp = S('tcp_port', { host: 'x.com', port: 443, timeoutSeconds: 5, outcome: 'pwned', remoteAddress: '10.0.0.1; rm', banner: 'SSH-2.0' });
  check('tcp: the outcome is a closed list, the address an address, nothing read from the socket kept', tcp.outcome === 'error' && tcp.remoteAddress === null && !('banner' in tcp));
  const dns = S('dns_lookup', { resolvers: ['10.0.0.1', 'evil'], lookup: { name: 'x.com;rm', ok: true, addresses: ['1.2.3.4', '<script>'] } });
  check('dns: the name must pass the host-name rule; addresses must be addresses', dns.lookup.name === null && JSON.stringify(dns.lookup.addresses) === '["1.2.3.4"]' && JSON.stringify(dns.resolvers) === '["10.0.0.1"]');
  const def = S('defender_status', { supported: true, realTimeProtectionEnabled: 'yes', runningMode: 'Hacked Mode', signatureAgeDays: 70000, exclusions: ['C:\\secret'], registeredAntivirus: [{ name: 'Contoso AV', productState: 397568 }] });
  check('defender: booleans are booleans, modes closed, ages bounded, nothing else kept', def.realTimeProtectionEnabled === null && def.runningMode === null && def.signatureAgeDays === null && !('exclusions' in def) && def.registeredAntivirus[0].productState === 397568);
  const fw = S('firewall_status', { profiles: [{ name: 'Public', enabled: true, defaultInbound: 'Block' }, { name: 'Evil', enabled: true }], activeCategories: ['Public', 'Wormhole'], rules: [{ port: 3389 }] });
  check('firewall: profiles and categories from closed lists, no rules', fw.profiles.length === 1 && JSON.stringify(fw.activeCategories) === '["Public"]' && !('rules' in fw));
  const sh = S('unexpected_shutdowns', { events: [{ at: daysAgo(1), kind: 'bugcheck', eventId: 1001, bugcheckCode: '0x0000009F', message: 'secret' }, { at: daysAgo(2), kind: 'bugcheck', eventId: 41 }, { at: daysAgo(3), kind: 'kernel_power', eventId: 41, bugcheckCode: 'nope' }] });
  check('shutdowns: a kind must match its event id; no message text; codes checked', sh.events.length === 2 && !/secret/.test(JSON.stringify(sh)) && sh.events[1].bugcheckCode === null && sh.read === true);
  const ts = S('time_sync', { type: 'NTP', ntpServer: 'time.windows.com,0x9', status: { ran: true, exitCode: 0, leapIndicator: 9, stratum: 3, lastSyncAt: daysAgo(1), source: 'time.windows.com,0x9' } });
  check('time: the leap indicator is 0–3, servers checked', ts.status.leapIndicator === null && ts.ntpServer === 'time.windows.com,0x9' && ts.status.stratum === 3);
  const rt = S('route_table', { routes: [{ destination: '0.0.0.0/0', nextHop: '10.0.0.1', interfaceAlias: 'Ethernet', routeMetric: 0, addressFamily: 'IPv4' }, { destination: 'x/0' }] });
  check('routes: destinations must be prefixes', rt.routes.length === 1 && rt.read === true);
  const ss = S('signed_in_sessions', { userNamesRead: true, sessions: [{ sessionId: 1, user: 'CORP\\alice', since: daysAgo(0) }, { sessionId: 2, user: 'C:\\Users\\x' }] });
  check('sessions: accounts must look like accounts', ss.sessions[0].user === 'CORP\\alice' && ss.sessions[1].user === null);
  for (const k of PALETTE) {
    const s = S(k, {});
    check(`${k}: an empty result sanitises to an object that fits the cap`, !!s && typeof s === 'object' && c.capResult(s).truncated === false);
  }
  const huge = S('scheduled_tasks', { tasks: Array.from({ length: 900 }, (_, i) => ({ name: `T${i}`.padEnd(256, 'x'), path: '\\'.padEnd(256, 'p'), author: 'a'.repeat(128), state: 'Ready' })) });
  const cap = c.capResult(huge, c.resultCapFor('scheduled_tasks'));
  check('tasks: at most 300 rows, and the 32 KB cap cuts the rest', huge.tasks.length === 300 && cap.bytes <= 32_768 && cap.truncated);
}

// ── Interpretation ──────────────────────────────────────────────────────────
{
  const I = (k, raw) => ip.interpret(k, c.sanitizeResult(k, raw), AT);
  // Nothing unread is Healthy: every key, given nothing, has no green finding and is not green overall.
  for (const k of PALETTE) {
    const i = I(k, {});
    check(`${k}: an empty result is never Healthy`, !!i && i.overall !== 'healthy' && i.findings.every((f) => f.state !== 'healthy' || /^Off\b/.test(f.detail) === false) && i.findings.every((f) => f.evidenceAt === AT), `${i?.overall} ${states(i)}`);
  }
  check('worst(): Unknown and Unsupported outrank Healthy; Critical outranks all', ip.worst(['healthy', 'unknown']) === 'unknown' && ip.worst(['healthy', 'unsupported']) === 'unsupported' && ip.worst(['unknown', 'critical', 'warning']) === 'critical' && ip.worst([]) === 'unknown');
  check('interpret: a key outside the palette, a non-object and an oversized marker', ip.interpret('disk_space', {}, AT) === null && ip.interpret('defender_status', null, AT) === null && ip.interpret('defender_status', { tooLarge: true }, AT).overall === 'unknown');

  // Defender
  const d = (o) => I('defender_status', { supported: true, realTimeProtectionEnabled: true, isTamperProtected: true, runningMode: 'Normal', signatureLastUpdated: daysAgo(1), quickScanEndAt: daysAgo(2), ...o });
  check('defender: all on, fresh signatures, recent scan → Healthy', d({}).overall === 'healthy', states(d({})));
  check('defender: signatures 3 days old are still Healthy, 4 Warning, 8 Critical', stateOf(d({ signatureLastUpdated: daysAgo(3) }), 'signatures') === 'healthy' && stateOf(d({ signatureLastUpdated: daysAgo(4) }), 'signatures') === 'warning' && stateOf(d({ signatureLastUpdated: daysAgo(8) }), 'signatures') === 'critical');
  check('defender: the age is from the date at the evidence time, not the agent\'s figure', stateOf(d({ signatureLastUpdated: daysAgo(10), signatureAgeDays: 0 }), 'signatures') === 'critical');
  check('defender: no date and no age → Unknown', stateOf(d({ signatureLastUpdated: null }), 'signatures') === 'unknown');
  check('defender: real-time off → Critical; tamper off → Warning; tamper unreported → Unknown', stateOf(d({ realTimeProtectionEnabled: false }), 'antivirus') === 'critical' && stateOf(d({ isTamperProtected: false }), 'tamper') === 'warning' && stateOf(d({ isTamperProtected: null }), 'tamper') === 'unknown');
  check('defender: passive with an enabled third-party antivirus → Healthy; passive alone → Critical',
    stateOf(d({ realTimeProtectionEnabled: false, runningMode: 'Passive Mode', securityCenterRead: true, registeredAntivirus: [{ name: 'Contoso AV', productState: 0x61000 }] }), 'antivirus') === 'healthy'
      && stateOf(d({ realTimeProtectionEnabled: false, runningMode: 'Passive Mode', registeredAntivirus: [{ name: 'Contoso AV', productState: 0x60100 }] }), 'antivirus') === 'critical');
  check('defender: last scan 15 days ago → Warning; none reported → Unknown', stateOf(d({ quickScanEndAt: daysAgo(15) }), 'scan') === 'warning' && stateOf(d({ quickScanEndAt: null }), 'scan') === 'unknown' && stateOf(d({ quickScanEndAt: daysAgo(20), fullScanEndAt: daysAgo(1) }), 'scan') === 'healthy');
  check('defender: not installed and no other antivirus → Unsupported, never Healthy', I('defender_status', { supported: false, reason: 'not_installed' }).overall === 'unsupported');
  check('avProductState decodes Security Center\'s bits', ip.avProductState(0x61100).enabled === true && ip.avProductState(0x60100).enabled === false && ip.avProductState(0x61100).upToDate === true && ip.avProductState(0x61110).upToDate === false && ip.avProductState(null).enabled === null);
  check('defender: no evidence time → ages are Unknown, not "NaN days"', (() => { const i = ip.interpret('defender_status', c.sanitizeResult('defender_status', { supported: true, realTimeProtectionEnabled: true, isTamperProtected: true, signatureLastUpdated: daysAgo(1), signatureAgeDays: 1, quickScanEndAt: daysAgo(1) }), null); return stateOf(i, 'signatures') === 'unknown' && stateOf(i, 'scan') === 'unknown' && !/NaN/.test(JSON.stringify(i)); })());

  // Firewall
  const fw = (p, cats = ['Private']) => I('firewall_status', { profiles: p, activeCategories: cats, serviceState: 'Running' });
  const all = (o = {}) => ['Domain', 'Private', 'Public'].map((n) => ({ name: n, enabled: true, defaultInbound: 'Block', defaultOutbound: 'Allow', ...(o[n] ?? {}) }));
  check('firewall: all three on, inbound blocked → Healthy', fw(all()).overall === 'healthy', states(fw(all())));
  check('firewall: Public off → Critical even when not in use; Domain off unused → Warning; Private off in use → Critical',
    stateOf(fw(all({ Public: { enabled: false } })), 'public') === 'critical' && stateOf(fw(all({ Domain: { enabled: false } })), 'domain') === 'warning' && stateOf(fw(all({ Private: { enabled: false } })), 'private') === 'critical');
  check('firewall: Domain in use is matched by DomainAuthenticated', stateOf(fw(all({ Domain: { enabled: false } }), ['DomainAuthenticated']), 'domain') === 'critical');
  check('firewall: inbound allowed by default → Warning; a missing profile → Unknown; service stopped → Critical',
    stateOf(fw(all({ Private: { defaultInbound: 'Allow' } })), 'private') === 'warning' && stateOf(fw(all().slice(0, 2)), 'public') === 'unknown' && stateOf(I('firewall_status', { profiles: all(), serviceState: 'Stopped' }), 'service') === 'critical');

  // BitLocker
  const v = (o) => ({ mountPoint: 'C:', volumeType: 'OperatingSystem', protectionStatus: 'On', volumeStatus: 'FullyEncrypted', encryptionMethod: 'XtsAes128', encryptionPercentage: 100, ...o });
  const b = (vols) => I('bitlocker_status', { supported: true, volumes: vols });
  check('bitlocker: protected and encrypted → Healthy', b([v({})]).overall === 'healthy');
  check('bitlocker: suspended, decrypted and encrypting → Warning each', b([v({ protectionStatus: 'Off' })]).overall === 'warning' && b([v({ protectionStatus: 'Off', volumeStatus: 'FullyDecrypted' })]).overall === 'warning' && b([v({ volumeStatus: 'EncryptionInProgress', encryptionPercentage: 40 })]).findings[0].detail.includes('40%'));
  check('bitlocker: no Windows volume reported → Unknown; no volumes → Unknown; unsupported → Unsupported', stateOf(b([v({ volumeType: 'Data', mountPoint: 'D:' })]), 'os-volume') === 'unknown' && b([]).overall === 'unknown' && I('bitlocker_status', { supported: false }).overall === 'unsupported');
  check('bitlocker: a volume with no status → Unknown, not Healthy', b([v({ volumeStatus: null, protectionStatus: null })]).overall === 'unknown');

  // Secure Boot / TPM
  const sb = (o, t) => I('secure_boot_tpm', { secureBoot: 'on', tpm: { read: true, present: true, ready: true, enabled: true, activated: true, specVersion: '2.0, 0, 1.59', ...t }, ...o });
  check('secure boot on, TPM 2.0 ready → Healthy', sb({}).overall === 'healthy' && /version 2\.0/.test(sb({}).findings[1].detail));
  check('secure boot off → Warning; legacy BIOS → Unsupported; unreadable → Unknown', stateOf(sb({ secureBoot: 'off' }), 'secure-boot') === 'warning' && stateOf(sb({ secureBoot: 'unsupported' }), 'secure-boot') === 'unsupported' && stateOf(sb({ secureBoot: 'unknown' }), 'secure-boot') === 'unknown');
  check('TPM absent or not ready → Warning; unread → Unknown', stateOf(sb({}, { present: false }), 'tpm') === 'warning' && stateOf(sb({}, { ready: false }), 'tpm') === 'warning' && stateOf(sb({}, { read: false }), 'tpm') === 'unknown' && stateOf(sb({}, { present: null }), 'tpm') === 'unknown');

  // Local administrators
  const m = (n) => [{ name: 'PC\\Administrator', kind: 'User', source: 'Local', builtinAdministrator: true }, { name: 'CORP\\Domain Admins', kind: 'Group', source: 'ActiveDirectory' }, ...Array.from({ length: n }, (_, i) => ({ name: `CORP\\u${i}`, kind: 'User', source: 'ActiveDirectory' }))];
  check('admins: three user accounts besides the built-in one → Healthy; four → Warning', I('local_admins', { method: 'localaccounts', members: m(3) }).overall === 'healthy' && I('local_admins', { method: 'localaccounts', members: m(4) }).overall === 'warning');
  check('admins: an unnamed member → Warning; unread → Unknown', stateOf(I('local_admins', { method: 'cim', members: [...m(0), { name: 'x;y', kind: 'User' }] }), 'unresolved') === 'warning' && I('local_admins', { method: 'none' }).overall === 'unknown');

  // Networking
  check('dns: resolved → Healthy; slow → Warning; failed or timed out → Critical',
    I('dns_lookup', { lookup: { name: 'x.com', ok: true, addresses: ['1.2.3.4'], latencyMs: 20 } }).overall === 'healthy' && I('dns_lookup', { lookup: { name: 'x.com', ok: true, addresses: ['1.2.3.4'], latencyMs: 1500 } }).overall === 'warning'
      && I('dns_lookup', { lookup: { name: 'x.com', ok: false, error: 'No such host is known' } }).overall === 'critical' && I('dns_lookup', { lookup: { name: 'x.com', timedOut: true } }).overall === 'critical');
  check('tcp: open → Healthy; refused, timeout, not resolved → Critical with the reason', I('tcp_port', { host: 'x.com', port: 443, outcome: 'open', latencyMs: 5 }).overall === 'healthy'
    && ['refused', 'timeout', 'not_resolved', 'unreachable', 'error'].every((o) => I('tcp_port', { host: 'x.com', port: 443, outcome: o }).overall === 'critical') && /nothing is listening/.test(I('tcp_port', { host: 'x.com', port: 1, outcome: 'refused' }).findings[0].detail));
  check('routes: a default route → Healthy with its gateway; none → Critical; unread → Unknown',
    /via 10\.0\.0\.1/.test(I('route_table', { routes: [{ destination: '0.0.0.0/0', nextHop: '10.0.0.1' }] }).findings[0].detail) && I('route_table', { routes: [{ destination: '10.0.0.0/24', nextHop: '0.0.0.0' }] }).overall === 'critical' && I('route_table', {}).overall === 'unknown');

  // Maintenance
  const t = (q, o = {}) => I('time_sync', { type: 'NTP', ntpServer: 'time.windows.com,0x9', serviceState: 'Running', serviceStart: 'Automatic', status: { ran: true, exitCode: 0, leapIndicator: 0, stratum: 3, lastSyncAt: daysAgo(1), source: 'time.windows.com,0x9', ...q }, ...o });
  check('time: synced yesterday → Healthy; 9 days → Warning; 31 days → Critical', t({}).overall === 'healthy' && stateOf(t({ lastSyncAt: daysAgo(9) }), 'sync') === 'warning' && stateOf(t({ lastSyncAt: daysAgo(31) }), 'sync') === 'critical');
  check('time: free-running clock or leap indicator 3 → Warning; NoSync → Warning; no date → Unknown', stateOf(t({ source: 'Local CMOS Clock' }), 'sync') === 'warning' && stateOf(t({ leapIndicator: 3 }), 'sync') === 'warning' && stateOf(t({}, { type: 'NoSync' }), 'config') === 'warning' && stateOf(t({ lastSyncAt: null }), 'sync') === 'unknown');
  check('time: service stopped (w32tm fails) → Warning, explained; w32tm missing → Unknown', stateOf(t({ exitCode: -2147023838 }, { serviceState: 'Stopped', serviceStart: 'Manual' }), 'sync') === 'warning' && stateOf(t({ ran: false }), 'sync') === 'unknown' && stateOf(t({ exitCode: 1 }), 'sync') === 'unknown');
  const a = (s, g = 0) => I('windows_activation', { products: [{ name: 'Windows(R), Professional edition', channel: 'Retail', licenseStatus: s, graceMinutes: g }] });
  check('activation: licensed → Healthy; grace → Warning with days left; unlicensed or notification → Critical; none → Unknown', a(1).overall === 'healthy' && a(2, 43200).overall === 'warning' && /30 days of grace/.test(a(2, 43200).findings[0].detail) && a(0).overall === 'critical' && a(5).overall === 'critical' && I('windows_activation', { products: [] }).overall === 'unknown');
  const sd = (ev) => I('unexpected_shutdowns', { events: ev });
  check('shutdowns: none → Healthy (when read); one dirty restart → Warning; three → Critical; any blue screen → Critical',
    sd([]).overall === 'healthy' && sd([{ at: daysAgo(1), kind: 'kernel_power', eventId: 41 }, { at: daysAgo(1), kind: 'unexpected_shutdown', eventId: 6008 }]).overall === 'warning'
      && sd([1, 2, 3].map((n) => ({ at: daysAgo(n), kind: 'kernel_power', eventId: 41 }))).overall === 'critical' && sd([{ at: daysAgo(2), kind: 'bugcheck', eventId: 1001, bugcheckCode: '0x0000009F' }]).findings[0].detail.includes('0x0000009F'));
  check('tasks: never-run, running and disabled are not failures; 0x1 is', ip.taskResultState(0x41303, 'Ready') === 'healthy' && ip.taskResultState(0x41301, 'Running') === 'healthy' && ip.taskResultState(1, 'Disabled') === 'healthy' && ip.taskResultState(1, 'Ready') === 'warning' && ip.taskResultState(null, 'Ready') === 'unknown');
  check('tasks: one failed last run → Warning; none → Healthy', I('scheduled_tasks', { tasks: [{ name: 'A', state: 'Ready', lastResult: 1 }, { name: 'B', state: 'Ready', lastResult: 0 }] }).overall === 'warning' && I('scheduled_tasks', { tasks: [{ name: 'B', state: 'Ready', lastResult: 0 }] }).overall === 'healthy' && I('scheduled_tasks', { tasks: [] }).overall === 'healthy');
  check('sessions: names read → Healthy; not read → Unknown', I('signed_in_sessions', { userNamesRead: true, sessions: [{ sessionId: 1, user: 'CORP\\a' }] }).overall === 'healthy' && I('signed_in_sessions', { userNamesRead: false, sessions: [{ sessionId: 1 }] }).overall === 'unknown');
  check('reboot_status: pending → Warning; up 31 days → Warning; an old stored result (no read flag) still interprets', I('reboot_status', { sources: ['windows_update'], uptimeSeconds: 3600 }).overall === 'warning' && stateOf(I('reboot_status', { sources: [], uptimeSeconds: 31 * 86400 }), 'uptime') === 'warning' && ip.interpret('reboot_status', { pending: false, sources: [], lastBootAt: daysAgo(1), uptimeSeconds: 86400 }, AT).overall === 'healthy');
  check('every finding of every key carries the evidence time', PALETTE.every((k) => I(k, {}).findings.every((f) => f.evidenceAt === AT)));
}

// ── OS support ──────────────────────────────────────────────────────────────
{
  const O = (cap, build, now = NOW) => ip.osSupport(cap, build, AT, now);
  check('Windows 10 22H2 Pro: ended 2025-10-14 → Critical, mentions ESU', O('Microsoft Windows 10 Pro', '19045').state === 'critical' && /Extended Security Updates/.test(O('Microsoft Windows 10 Pro', '19045').detail));
  check('Windows 11 23H2 Pro (ended 2025-11-11) and Enterprise (ended 2026-11-10) → Critical', O('Microsoft Windows 11 Pro', '22631').state === 'critical' && O('Microsoft Windows 11 Enterprise', '22631').state === 'critical');
  check('Windows 11 24H2: Pro ended 2026-10-13 → Critical; Enterprise until 2027-10-12 → Healthy', O('Microsoft Windows 11 Pro', '26100').state === 'critical' && O('Microsoft Windows 11 Enterprise', '26100').state === 'healthy' && O('Microsoft Windows 11 Enterprise', '26100').endsOn === '2027-10-12');
  check('Windows 11 24H2 Pro on 2026-08-01 → Warning (73 days left)', O('Microsoft Windows 11 Pro', '26100', Date.parse('2026-08-01T00:00:00Z')).state === 'warning');
  check('Windows 11 25H2 Home → Healthy until 2027-10-12', O('Microsoft Windows 11 Home', '26200').state === 'healthy' && O('Microsoft Windows 11 Home', '26200').endsOn === '2027-10-12');
  check('Server 2022, 2025 and 2019 → Healthy; Server 2016 (ends 2027-01-12) → Warning; 2012 R2 → Critical', ['20348', '26100', '17763'].every((b) => O('Microsoft Windows Server 2022 Datacenter', b).state === 'healthy') && O('Microsoft Windows Server 2016 Standard', '14393').state === 'warning' && O('Microsoft Windows Server 2012 R2 Standard', '9600').state === 'critical');
  check('LTSC is its own channel: Windows 10 Enterprise LTSC 2021 (ends 2027-01-12) → Warning, LTSC 2019 → Healthy; the same build as Enterprise → Critical', O('Microsoft Windows 10 Enterprise LTSC', '19044').state === 'warning' && O('Microsoft Windows 10 Enterprise LTSC', '19044').channel === 'ltsc' && O('Microsoft Windows 10 Enterprise LTSC 2019', '17763').state === 'healthy' && O('Microsoft Windows 10 Enterprise', '19044').state === 'critical');
  check('an unknown build, no build and no caption → Unknown', O('Microsoft Windows 11 Pro', '27999').state === 'unknown' && O('Microsoft Windows 11 Pro', null).state === 'unknown' && O(null, '26100').state === 'unknown' && O('Microsoft Windows 11 Pro', '26100; rm').state === 'unknown');
  check('a channel the build has no date for → Unknown (Server 2022 build as "Pro")', O('Microsoft Windows 11 Pro', '20348').state === 'unknown');
  check('the table goes Unknown when it is more than a year old', O('Microsoft Windows 11 Enterprise', '26100', Date.parse('2027-12-01T00:00:00Z')).state === 'unknown' && /reviewed on 2026-11-20/.test(O('Microsoft Windows 11 Enterprise', '26100', Date.parse('2027-12-01T00:00:00Z')).detail));
  check('the table\'s dates are all valid ISO dates', Object.values(ip.OS_SUPPORT).every((r) => ['consumer', 'enterprise', 'ltsc', 'server'].every((k) => !r[k] || /^\d{4}-\d{2}-\d{2}$/.test(r[k]) && !Number.isNaN(Date.parse(r[k])))));
}

// ── The build-time guard on the palette block ───────────────────────────────
const signed = w.buildSignedWindowsScript('0.76.0');
const legacy = w.buildLegacyWindowsScript({ version: '1.4.1', host: 'portal.example.com', key: 'A'.repeat(43) + '=', agentVersion: '0.76.0', fallbackVersion: '1.4.1' });
const hbOf = (s) => /\$hbBody = @'\r?\n([\s\S]*?)\r?\n'@/.exec(s)[1];
const palOf = (hb) => hb.slice(hb.indexOf(`\n${w.PALETTE_BLOCK_START}`) + 1, hb.indexOf(`\n${w.SNAPSHOT_BLOCK_START}`) + 1);
const diagOf = (hb) => hb.slice(hb.indexOf('# ---- Diagnostics catalog (0.31)'), hb.indexOf('# ---- Monitoring (0.29)'));
{
  const pal = palOf(hbOf(signed));
  check('both installer variants carry the same palette block', pal.length > 15000 && pal === palOf(hbOf(legacy)));
  check('the guard passes the shipped script', w.assertPaletteBlockSafe(signed) === signed);
  const refuses = (label, from, to) => {
    const i = signed.indexOf(from, signed.indexOf(`\n${w.PALETTE_BLOCK_START}`));
    if (i < 0 || i > signed.indexOf(`\n${w.SNAPSHOT_BLOCK_START}`)) { failures.push(`guard mutation "${label}": anchor not found in the palette block`); return; }
    const mutated = signed.slice(0, i) + to + signed.slice(i + from.length);
    let threw = null;
    try { w.assertPaletteBlockSafe(mutated); } catch (e) { threw = String(e.message); }
    check(`the palette guard refuses ${label}`, !!threw, 'it accepted the mutated script');
  };
  const A = '$out = @{ supported = $true }';
  refuses('Invoke-Expression', A, `${A}; Invoke-Expression $x`);
  refuses('Set-MpPreference (turning protection off)', A, `${A}; Set-MpPreference -DisableRealtimeMonitoring $true`);
  refuses('Disable-BitLocker', A, `${A}; Disable-BitLocker -MountPoint C:`);
  refuses('Remove-LocalGroupMember', A, `${A}; Remove-LocalGroupMember -SID S-1-5-32-544 -Member x`);
  refuses('Start-ScheduledTask', A, `${A}; Start-ScheduledTask -TaskName x`);
  refuses('Stop-Service', A, `${A}; Stop-Service W32Time`);
  refuses('Restart-Computer', A, `${A}; Restart-Computer`);
  refuses('Register-ScheduledTask', A, `${A}; Register-ScheduledTask x`);
  refuses('Enable-NetFirewallRule', A, `${A}; Enable-NetFirewallRule x`);
  refuses('an unknown cmdlet (Clear-Tpm)', A, `${A}; Clear-Tpm`);
  refuses('a cmdlet the list does not name (Resolve-DnsName)', A, `${A}; Resolve-DnsName x`);
  refuses('a second call operator', A, `${A}; & 'sc.exe' stop x`);
  refuses('w32tm from a relative path', "$w32tm = Join-Path ([Environment]::SystemDirectory) 'w32tm.exe'", "$w32tm = 'w32tm.exe'");
  refuses('w32tm with other arguments (/resync)', "& $w32tm '/query' '/status'", "& $w32tm '/resync'");
  refuses('reading a recovery password', "$t = Get-Rem0tePalMatch $kp.KeyProtectorType", "$rp = $kp.RecoveryPassword; $t = Get-Rem0tePalMatch $kp.KeyProtectorType");
  refuses('reading a protector id', "$t = Get-Rem0tePalMatch $kp.KeyProtectorType", "$rp = $kp.KeyProtectorId; $t = Get-Rem0tePalMatch $kp.KeyProtectorType");
  refuses('reading the partial product key', 'licenseStatus = (Get-Rem0tePalInt $l.LicenseStatus)', 'licenseStatus = (Get-Rem0tePalInt $l.LicenseStatus); k = $l.PartialProductKey');
  refuses('reading a task\'s actions', '$info = $null', '$info = $null; $act = $t.Actions');
  refuses('a second New-Object', A, `${A}; $wc = New-Object Net.WebClient`);
  refuses('a script block', A, `${A}; $f = { param($x) $x }`);
  refuses('a static call off the list', A, `${A}; [System.IO.File]::WriteAllText('x', 'y')`);
  refuses('a method off the list', A, `${A}; $s.Kill()`);
  refuses('an environment read', A, `${A}; $q = $env:PATH`);
  refuses('Add-Type', A, `${A}; Add-Type -TypeDefinition 'x'`);
  refuses('a download', A, `${A}; $x = Get-Content 'x'; $y.DownloadString('u')`);
  refuses('a host check that is not the portal rule', "return ($v -cmatch '^[A-Za-z0-9]", "return ($v -cmatch '^.*$' -or '^[A-Za-z0-9]");
  refuses('a missing block', w.PALETTE_BLOCK_START, '# gone');
  const blk = diagOf(hbOf(signed));
  check('each palette function is called once, from the catalog switch', PALETTE.every((k) => new RegExp(`'${k}' \\{ \\$out = Get-Rem0tePal[A-Za-z]+( \\$dr\\.params)? \\}`).test(blk)));
  check('only dns_lookup and tcp_port are handed $dr.params', (blk.match(/\$dr\.params/g) ?? []).length === 2 && /'dns_lookup' \{ \$out = Get-Rem0tePalDns \$dr\.params \}/.test(blk) && /'tcp_port' \{ \$out = Get-Rem0tePalTcp \$dr\.params \}/.test(blk));
  check('the agent checks the exact fields before using them', /Test-Rem0tePalKeys \$p @\('name'\)/.test(pal) && /Test-Rem0tePalKeys \$p @\('host', 'port', 'timeoutSeconds'\)/.test(pal) && /@\(1, 2, 3, 5, 10\) -contains/.test(pal) && /\$port -lt 1 -or \$port -gt 65535/.test(pal));
  check('the host check refuses a line break separately (.NET $ matches before a final newline)', /if \(\$v -match '\[\\r\\n\]'\) \{ return \$false \}/.test(pal));
}

// ── PowerShell: parse, then run the palette against stubs (optional) ───────
const pwsh = process.env.PWSH || (spawnSync('pwsh', ['-v']).status === 0 ? 'pwsh' : null);
if (!pwsh || (process.env.PWSH && !existsSync(process.env.PWSH))) console.log('  (pwsh not found: the PowerShell is not parsed or executed)');
else {
  const dir = mkdtempSync(join(tmpdir(), 'rem0te-pspal-'));
  const blk = diagOf(hbOf(signed));
  writeFileSync(join(dir, 'signed.ps1'), signed);
  writeFileSync(join(dir, 'legacy.ps1'), legacy);
  writeFileSync(join(dir, 'hb.ps1'), hbOf(signed));
  writeFileSync(join(dir, 'parse.ps1'), `
$bad = 0
foreach ($f in $args) { $t = $null; $e = $null; [System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$t, [ref]$e) | Out-Null; if ($e.Count) { $bad++; Write-Output ("$f : " + $e[0].Message + ' @ line ' + $e[0].Extent.StartLineNumber) } }
exit $bad`);
  const pr = spawnSync(pwsh, ['-NoProfile', '-File', join(dir, 'parse.ps1'), join(dir, 'signed.ps1'), join(dir, 'legacy.ps1'), join(dir, 'hb.ps1')], { encoding: 'utf8' });
  check('pwsh: the signed and legacy installers and the heartbeat parse with no errors', pr.status === 0, pr.stdout + pr.stderr);

  // A local listener for the "open" TCP case; port 1 on loopback is the refused one.
  const srv = createServer((s) => s.destroy());
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const openPort = srv.address().port;
  const SECRET_RP = '111111-222222-333333-444444-555555-666666-777777-888888';
  const posts = join(dir, 'posts.txt');
  const stubs = (world) => `
$ErrorActionPreference = 'Continue'
$id = '123456789'; $state = [pscustomobject]@{ agentSecret = 'secretsecretsecret'; host = 'portal.test' }
$resp = Get-Content -Raw '${join(dir, 'resp.json')}' | ConvertFrom-Json
function Invoke-RestMethod { param($Uri, $Method, $Body, $ContentType, [switch]$UseBasicParsing, $TimeoutSec, $ErrorAction) Add-Content -LiteralPath '${posts}' -Value ($Uri + ' ' + $Body) }
function Add-Calls($w) { Add-Content -LiteralPath '${join(dir, 'calls.txt')}' -Value $w }
${world === 'desktop' ? `
function Get-MpComputerStatus { param($ErrorAction) [pscustomobject]@{ AMServiceEnabled = $true; AntivirusEnabled = $true; RealTimeProtectionEnabled = $true; BehaviorMonitorEnabled = $true; IsTamperProtected = $true; AMRunningMode = 'Normal'; AntivirusSignatureVersion = '1.421.0.0'; AntivirusSignatureLastUpdated = (Get-Date).AddDays(-1); AntivirusSignatureAge = 1; QuickScanEndTime = (Get-Date).AddDays(-2); FullScanEndTime = $null; ExclusionPath = @('C:\\secret-exclusion') } }
function Get-BitLockerVolume { param($ErrorAction) @(
  [pscustomobject]@{ MountPoint = 'C:'; VolumeType = 'OperatingSystem'; ProtectionStatus = 'On'; VolumeStatus = 'FullyEncrypted'; LockStatus = 'Unlocked'; EncryptionMethod = 'XtsAes128'; EncryptionPercentage = 100; KeyProtector = @([pscustomobject]@{ KeyProtectorType = 'Tpm'; KeyProtectorId = '{AAAA-SECRET-ID}' }, [pscustomobject]@{ KeyProtectorType = 'RecoveryPassword'; KeyProtectorId = '{BBBB-SECRET-ID}'; RecoveryPassword = '${SECRET_RP}' }) },
  [pscustomobject]@{ MountPoint = 'D:'; VolumeType = 'Data'; ProtectionStatus = 'Off'; VolumeStatus = 'FullyDecrypted'; LockStatus = 'Unlocked'; EncryptionMethod = 'None'; EncryptionPercentage = 0; KeyProtector = @() }) }
function Confirm-SecureBootUEFI { param($ErrorAction) $true }
function Get-Tpm { param($ErrorAction) [pscustomobject]@{ TpmPresent = $true; TpmReady = $true; TpmEnabled = $true; TpmActivated = $true; ManufacturerIdTxt = 'INTC'; OwnerAuth = 'SECRET-OWNER-AUTH' } }
function Get-LocalGroupMember { param($SID, $ErrorAction) @(
  [pscustomobject]@{ Name = 'DESK1\\Administrator'; ObjectClass = 'User'; PrincipalSource = 'Local'; SID = 'S-1-5-21-111-222-333-500' },
  [pscustomobject]@{ Name = 'CORP\\Domain Admins'; ObjectClass = 'Group'; PrincipalSource = 'ActiveDirectory'; SID = 'S-1-5-21-444-555-666-512' },
  [pscustomobject]@{ Name = 'MicrosoftAccount\\alice@example.com'; ObjectClass = 'User'; PrincipalSource = 'MicrosoftAccount'; SID = 'S-1-5-21-777-888-999-1001' }) }
function w32tm.exe { Add-Calls ('w32tm ' + ($args -join ' ')); $global:LASTEXITCODE = 0; @('Leap Indicator: 0(no warning)', 'Stratum: 4 (secondary reference - syncd by (S)NTP)', 'Precision: -23 (119.209ns per tick)', 'Root Delay: 0.0312500s', 'Root Dispersion: 7.8000000s', 'ReferenceId: 0x14650A22 (source IP:  20.101.10.34)', ('Last Successful Sync Time: ' + (Get-Date).AddHours(-5).ToString()), 'Source: time.windows.com,0x9', 'Poll Interval: 10 (1024s)') }
` : `
function Get-MpComputerStatus { param($ErrorAction) [pscustomobject]@{ AMServiceEnabled = $true; AntivirusEnabled = $true; RealTimeProtectionEnabled = $true; IsTamperProtected = $null; AMRunningMode = 'Normal'; AntivirusSignatureLastUpdated = (Get-Date).AddDays(-9); AntivirusSignatureAge = 9; QuickScanEndTime = $null; FullScanEndTime = $null } }
function Confirm-SecureBootUEFI { param($ErrorAction) throw [System.PlatformNotSupportedException]::new('Cmdlet not supported on this platform: 0xC0000002') }
function Get-Tpm { param($ErrorAction) throw 'TPM is not supported on this computer' }
function Get-LocalGroupMember { param($SID, $ErrorAction) throw 'Failed to compare two elements in the array.' }
function Get-CimAssociatedInstance { param($InputObject, $Association, $ErrorAction) @(
  [pscustomobject]@{ Domain = 'SRV1'; Name = 'Administrator'; SID = 'S-1-5-21-1-2-3-500'; CimClass = [pscustomobject]@{ CimClassName = 'Win32_UserAccount' } },
  [pscustomobject]@{ Domain = 'CORP'; Name = 'Domain Admins'; SID = 'S-1-5-21-1-2-3-512'; CimClass = [pscustomobject]@{ CimClassName = 'Win32_Group' } }) }
function w32tm.exe { Add-Calls ('w32tm ' + ($args -join ' ')); $global:LASTEXITCODE = -2147023838; @('The following error occurred: The service has not been started. (0x80070426)') }
`}
function Get-CimInstance { param($ClassName, $Namespace, $Filter, $ErrorAction)
  Add-Calls ('cim ' + $Namespace + ' ' + $ClassName + ' ' + $Filter)
  switch ($ClassName) {
    'AntiVirusProduct' { ${world === 'desktop' ? "return @([pscustomobject]@{ displayName = 'Windows Defender'; productState = 397568 })" : "throw 'Invalid namespace'"} }
    'Win32_Tpm' { ${world === 'desktop' ? "return [pscustomobject]@{ SpecVersion = '2.0, 0, 1.59' }" : "throw 'Invalid namespace'"} }
    'Win32_Group' { return [pscustomobject]@{ Name = 'Administrators' } }
    'Win32_NetworkAdapterConfiguration' { return @([pscustomobject]@{ DNSServerSearchOrder = @('10.0.0.1', 'bad server') }) }
    'SoftwareLicensingProduct' { return @([pscustomobject]@{ Name = 'Windows(R), Professional edition'; ProductKeyChannel = 'Retail'; LicenseStatus = 1; GracePeriodRemaining = 0; PartialProductKey = 'SECRETKEY5'; Description = 'Windows(R) Operating System, RETAIL channel' }) }
  } }
function Get-NetFirewallProfile { param($PolicyStore, $ErrorAction) Add-Calls ('fw ' + $PolicyStore); @(
  [pscustomobject]@{ Name = 'Domain'; Enabled = 'True'; DefaultInboundAction = 'Block'; DefaultOutboundAction = 'Allow' },
  [pscustomobject]@{ Name = 'Private'; Enabled = 'True'; DefaultInboundAction = 'Block'; DefaultOutboundAction = 'Allow' },
  [pscustomobject]@{ Name = 'Public'; Enabled = '${world === 'desktop' ? 'True' : 'False'}'; DefaultInboundAction = 'Block'; DefaultOutboundAction = 'Allow' }) }
function Get-NetConnectionProfile { param($ErrorAction) @([pscustomobject]@{ NetworkCategory = 'Private'; InterfaceAlias = 'Ethernet' }) }
function Get-Service { param($Name, $ErrorAction) if ($Name -eq 'mpssvc') { return [pscustomobject]@{ Name = 'mpssvc'; Status = 'Running'; StartType = 'Automatic' } } if ($Name -eq 'W32Time') { return [pscustomobject]@{ Name = 'W32Time'; Status = '${world === 'desktop' ? 'Running' : 'Stopped'}'; StartType = 'Manual' } } }
function Get-NetRoute { param($ErrorAction) @(
  [pscustomobject]@{ DestinationPrefix = '0.0.0.0/0'; NextHop = '10.0.0.1'; InterfaceAlias = 'Ethernet'; RouteMetric = 0; AddressFamily = 'IPv4' },
  [pscustomobject]@{ DestinationPrefix = '10.0.0.0/24'; NextHop = '0.0.0.0'; InterfaceAlias = 'Ethernet'; RouteMetric = 256; AddressFamily = 'IPv4' },
  [pscustomobject]@{ DestinationPrefix = '224.0.0.0/4'; NextHop = '0.0.0.0'; InterfaceAlias = 'Ethernet'; RouteMetric = 256; AddressFamily = 'IPv4' },
  [pscustomobject]@{ DestinationPrefix = 'ff00::/8'; NextHop = '::'; InterfaceAlias = 'Ethernet'; RouteMetric = 256; AddressFamily = 'IPv6' }) }
function Get-ItemProperty { param($LiteralPath, $ErrorAction) [pscustomobject]@{ Type = 'NTP'; NtpServer = 'time.windows.com,0x9' } }
function Test-Path { param($LiteralPath, $Path, $PathType) return $true }
# pwsh off Windows has no System32 ([Environment]::SystemDirectory is empty): hand back the bare name, which the w32tm.exe stub answers.
function Join-Path { param($Path, $ChildPath) if ($ChildPath -eq 'w32tm.exe') { return 'w32tm.exe' } Microsoft.PowerShell.Management\Join-Path -Path $Path -ChildPath $ChildPath }
function Get-WinEvent { param($FilterHashtable, $MaxEvents, $ErrorAction)
  Add-Content -LiteralPath '${join(dir, 'filters.txt')}' -Value ($FilterHashtable | ConvertTo-Json -Compress -Depth 4)
  ${world === 'desktop' ? `return @(
    [pscustomobject]@{ Id = 41; ProviderName = 'Microsoft-Windows-Kernel-Power'; TimeCreated = (Get-Date).AddDays(-3); Properties = @([pscustomobject]@{ Value = 159 }); Message = 'SECRET-MESSAGE-TEXT' },
    [pscustomobject]@{ Id = 6008; ProviderName = 'EventLog'; TimeCreated = (Get-Date).AddDays(-3); Properties = @([pscustomobject]@{ Value = 'x' }); Message = 'SECRET-MESSAGE-TEXT' },
    [pscustomobject]@{ Id = 1001; ProviderName = 'Microsoft-Windows-WER-SystemErrorReporting'; TimeCreated = (Get-Date).AddDays(-3); Properties = @([pscustomobject]@{ Value = '0x0000009f (0x0000000000000003, 0xffff)' }); Message = 'SECRET-MESSAGE-TEXT' },
    [pscustomobject]@{ Id = 1001; ProviderName = 'Some-Other-Provider'; TimeCreated = (Get-Date).AddDays(-4); Properties = @(); Message = 'x' })` : `throw ([System.Management.Automation.ErrorRecord]::new([Exception]::new('none'), 'NoMatchingEventsFound,Microsoft.PowerShell.Commands.GetWinEventCommand', [System.Management.Automation.ErrorCategory]::ObjectNotFound, $null))`} }
function Get-ScheduledTask { param($ErrorAction) @(
  [pscustomobject]@{ TaskPath = '\\'; TaskName = 'Nightly backup'; State = 'Ready'; Author = 'CORP\\it'; Principal = [pscustomobject]@{ UserId = 'SYSTEM' }; Actions = @([pscustomobject]@{ Execute = 'C:\\tools\\backup.exe'; Arguments = '--password SECRET-TASK-ARG' }) },
  [pscustomobject]@{ TaskPath = '\\Vendor\\'; TaskName = 'Updater'; State = 'Disabled'; Author = 'Vendor'; Principal = [pscustomobject]@{ UserId = 'CORP\\svc' }; Actions = @() },
  [pscustomobject]@{ TaskPath = '\\Microsoft\\Windows\\Defrag\\'; TaskName = 'ScheduledDefrag'; State = 'Ready'; Author = 'Microsoft'; Principal = $null; Actions = @() }) }
function Get-ScheduledTaskInfo { param($InputObject, $ErrorAction) if ($InputObject.TaskName -eq 'Nightly backup') { [pscustomobject]@{ LastRunTime = (Get-Date).AddHours(-10); LastTaskResult = 1; NextRunTime = (Get-Date).AddHours(14) } } else { [pscustomobject]@{ LastRunTime = [datetime]'1999-11-30'; LastTaskResult = 267011; NextRunTime = $null } } }
function Get-Process { param($Name, [switch]$IncludeUserName, $ErrorAction) @(
  [pscustomobject]@{ ProcessName = 'explorer'; SessionId = 1; UserName = 'CORP\\alice'; StartTime = (Get-Date).AddHours(-2) },
  [pscustomobject]@{ ProcessName = 'explorer'; SessionId = 1; UserName = 'CORP\\alice'; StartTime = (Get-Date).AddHours(-1) },
  [pscustomobject]@{ ProcessName = 'explorer'; SessionId = 3; UserName = 'CORP\\bob'; StartTime = (Get-Date).AddMinutes(-30) }) }
${blk}
`;
  const runs = (extra) => [
    ...PALETTE.map((k, i) => ({ id: `pal${i}aaaaaaaaaaaaaaaaaaaa`, key: k, ...(k === 'dns_lookup' ? { params: { name: 'localhost' } } : k === 'tcp_port' ? { params: { host: '127.0.0.1', port: openPort, timeoutSeconds: 2 } } : {}) })),
    ...extra,
  ];
  const hostile = [
    { id: 'badA0aaaaaaaaaaaaaaaaaaaa', key: 'dns_lookup', params: { name: 'x.com; Remove-Item C:\\ -Recurse' } },
    { id: 'badA1aaaaaaaaaaaaaaaaaaaa', key: 'dns_lookup', params: { name: 'x.com', type: 'MX' } },
    { id: 'badA2aaaaaaaaaaaaaaaaaaaa', key: 'tcp_port', params: { host: '127.0.0.1', port: 70000, timeoutSeconds: 2 } },
    { id: 'badA3aaaaaaaaaaaaaaaaaaaa', key: 'tcp_port', params: { host: '127.0.0.1', port: 1, timeoutSeconds: 7 } },
    { id: 'badA4aaaaaaaaaaaaaaaaaaaa', key: 'tcp_port', params: { host: '127.0.0.1', port: '443', timeoutSeconds: 2 } },
    { id: 'badA5aaaaaaaaaaaaaaaaaaaa', key: 'dns_lookup' },
    { id: 'okRefused1aaaaaaaaaaaaaaa', key: 'tcp_port', params: { host: '127.0.0.1', port: 1, timeoutSeconds: 2 } },
    { id: 'badA6aaaaaaaaaaaaaaaaaaaa', key: 'dns_lookup', params: { name: 'x.com\n' } },
  ];
  const runWorld = (world) => {
    writeFileSync(join(dir, 'run.ps1'), stubs(world));
    const results = {};
    const list = runs(world === 'desktop' ? hostile : []);
    for (let i = 0; i < list.length; i += 3) {
      writeFileSync(join(dir, 'resp.json'), JSON.stringify({ data: { diagnostics: list.slice(i, i + 3) } }));
      rmSync(posts, { force: true });
      const rr = spawnSync(pwsh, ['-NoProfile', '-File', join(dir, 'run.ps1')], { encoding: 'utf8', timeout: 120_000 });
      if (rr.status !== 0) failures.push(`pwsh ${world} batch ${i}: ${rr.stderr}`);
      const ls = existsSync(posts) ? readFileSync(posts, 'utf8').trim().split('\n').filter(Boolean) : [];
      for (const l of ls) { const sp = l.indexOf(' '); const b = JSON.parse(l.slice(sp + 1)); (results[b.runId] ??= []).push({ uri: l.slice(0, sp), ...b }); }
    }
    return results;
  };
  // Run the worlds one after the other (each spawns pwsh per batch); srv answers meanwhile.
  const desk = await new Promise((r) => setImmediate(() => r(runWorld('desktop'))));
  const serv = runWorld('server');
  srv.close();
  const res = (R, k) => (R[`pal${PALETTE.indexOf(k)}aaaaaaaaaaaaaaaaaaaa`] ?? []).find((b) => b.state === 'completed')?.result ?? null;
  for (const [name, R] of [['desktop', desk], ['server', serv]]) {
    for (const k of PALETTE) {
      const seq = R[`pal${PALETTE.indexOf(k)}aaaaaaaaaaaaaaaaaaaa`] ?? [];
      check(`pwsh ${name}: ${k} reports running, then completed, to /enrollment/diagnostic-result with the device secret`,
        seq.length === 2 && seq[0].state === 'running' && seq[1].state === 'completed' && seq.every((b) => b.uri === 'https://portal.test/api/v1/enrollment/diagnostic-result' && b.agentSecret === 'secretsecretsecret'), JSON.stringify(seq).slice(0, 400));
      const s = c.sanitizeResult(k, res(R, k));
      const i = ip.interpret(k, s, AT);
      check(`pwsh ${name} → server: ${k} sanitises, fits the cap and is interpreted`, !!s && c.capResult(s).truncated === false && !!i && i.findings.length > 0, JSON.stringify(s).slice(0, 200));
    }
  }
  const allText = JSON.stringify(desk) + JSON.stringify(serv);
  check('pwsh: no recovery password, protector id, product key, task argument, message text, TPM owner auth or SID in any post',
    !new RegExp(`${SECRET_RP.slice(0, 13)}|SECRET-ID|SECRETKEY5|SECRET-TASK-ARG|backup\\.exe|SECRET-MESSAGE-TEXT|SECRET-OWNER-AUTH|secret-exclusion|S-1-5-21`).test(allText), allText.match(/.{30}(SECRET|S-1-5-21|backup\.exe).{20}/)?.[0]);
  const I = (R, k) => ip.interpret(k, c.sanitizeResult(k, res(R, k)), AT);
  check('pwsh desktop: Defender healthy; BitLocker C: protected, D: not encrypted', I(desk, 'defender_status').overall === 'healthy' && stateOf(I(desk, 'bitlocker_status'), 'volume-c') === 'healthy' && stateOf(I(desk, 'bitlocker_status'), 'volume-d') === 'warning', states(I(desk, 'bitlocker_status')));
  check('pwsh desktop: protector kinds are Tpm and RecoveryPassword only', JSON.stringify(c.sanitizeResult('bitlocker_status', res(desk, 'bitlocker_status')).volumes[0].protectorTypes) === '["RecoveryPassword","Tpm"]');
  check('pwsh desktop: Secure Boot on, TPM 2.0 ready', I(desk, 'secure_boot_tpm').overall === 'healthy');
  check('pwsh desktop: three administrators, the built-in one flagged, names kept', (() => { const m = c.sanitizeResult('local_admins', res(desk, 'local_admins')).members; return m.length === 3 && m[0].builtinAdministrator && !m[1].builtinAdministrator && m[2].name === 'MicrosoftAccount\\alice@example.com' && m[2].source === 'MicrosoftAccount'; })());
  check('pwsh: the firewall is read from the active store', /fw ActiveStore/.test(readFileSync(join(dir, 'calls.txt'), 'utf8')));
  check('pwsh desktop: firewall healthy; server: Public off is Critical', I(desk, 'firewall_status').overall === 'healthy' && stateOf(I(serv, 'firewall_status'), 'public') === 'critical');
  check('pwsh: w32tm is run as /query /status and nothing else', readFileSync(join(dir, 'calls.txt'), 'utf8').split('\n').filter((l) => l.startsWith('w32tm')).every((l) => l.trim() === 'w32tm /query /status'));
  const tsd = c.sanitizeResult('time_sync', res(desk, 'time_sync'));
  check('pwsh desktop: w32tm parsed: stratum 4, source, a sync five hours ago, poll 1024 s', tsd.status.stratum === 4 && tsd.status.source === 'time.windows.com,0x9' && tsd.status.pollSeconds === 1024 && !!tsd.status.lastSyncAt && I(desk, 'time_sync').overall === 'healthy', JSON.stringify(tsd));
  check('pwsh server: w32tm fails with the service stopped → a Warning that says why', stateOf(I(serv, 'time_sync'), 'sync') === 'warning' && /stopped/.test(I(serv, 'time_sync').findings.find((f) => f.id === 'sync').detail));
  const sdk = c.sanitizeResult('unexpected_shutdowns', res(desk, 'unexpected_shutdowns'));
  check('pwsh desktop: 41, 6008 and a bugcheck with its code; another provider\'s 1001 ignored', sdk.events.length === 3 && sdk.events.find((e) => e.kind === 'bugcheck').bugcheckCode === '0x0000009F' && sdk.events.find((e) => e.kind === 'kernel_power').bugcheckCode === '0x0000009F' && I(desk, 'unexpected_shutdowns').overall === 'critical', JSON.stringify(sdk));
  const filters = readFileSync(join(dir, 'filters.txt'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  check('pwsh: only the System log, ids 41, 6008 and 1001', filters.every((f) => f.LogName === 'System' && JSON.stringify(f.Id) === '[41,6008,1001]'));
  check('pwsh server: no matching events → read, none, Healthy', (() => { const s = c.sanitizeResult('unexpected_shutdowns', res(serv, 'unexpected_shutdowns')); return s.read === true && s.events.length === 0 && I(serv, 'unexpected_shutdowns').overall === 'healthy'; })());
  const tk = c.sanitizeResult('scheduled_tasks', res(desk, 'scheduled_tasks'));
  check('pwsh desktop: two non-Microsoft tasks, one Microsoft counted; the failed backup is a Warning', tk.tasks.length === 2 && tk.microsoftTasks === 1 && tk.taskCount === 3 && I(desk, 'scheduled_tasks').overall === 'warning' && tk.tasks[1].lastRunAt === null, JSON.stringify(tk));
  const se = c.sanitizeResult('signed_in_sessions', res(desk, 'signed_in_sessions'));
  check('pwsh desktop: one row per session (two), with the user', se.sessions.length === 2 && se.sessions[0].user === 'CORP\\alice' && se.userNamesRead === true);
  const rt = c.sanitizeResult('route_table', res(desk, 'route_table'));
  check('pwsh: routes keep the default and local route, drop multicast', rt.routes.length === 2 && rt.routeCount === 4 && I(desk, 'route_table').overall === 'healthy');
  check('pwsh: activation licensed, the partial key nowhere', I(desk, 'windows_activation').overall === 'healthy' && /PartialProductKey IS NOT NULL/.test(readFileSync(join(dir, 'calls.txt'), 'utf8')));
  const dn = c.sanitizeResult('dns_lookup', res(desk, 'dns_lookup'));
  check('pwsh: dns_lookup resolves localhost through the system resolver, with resolvers filtered', dn.lookup.name === 'localhost' && dn.lookup.ok === true && dn.lookup.addresses.length > 0 && JSON.stringify(dn.resolvers) === '["10.0.0.1"]', JSON.stringify(dn));
  const tc = c.sanitizeResult('tcp_port', res(desk, 'tcp_port'));
  check('pwsh: tcp_port to a listening loopback port is open', tc.outcome === 'open' && tc.port === openPort && tc.remoteAddress === '127.0.0.1', JSON.stringify(tc));
  const refused = (desk.okRefused1aaaaaaaaaaaaaaa ?? []).find((b) => b.state === 'completed')?.result;
  check('pwsh: tcp_port to loopback port 1 is refused (socket error 10061 / ECONNREFUSED)', refused?.outcome === 'refused' || (refused?.outcome === 'error' && /refused/i.test(refused?.error ?? '')), JSON.stringify(refused));
  for (const id of ['badA0', 'badA1', 'badA2', 'badA3', 'badA4', 'badA5', 'badA6']) {
    const seq = desk[`${id}aaaaaaaaaaaaaaaaaaaa`] ?? [];
    check(`pwsh: the agent refuses bad parameters itself (${id}) — failed, nothing resolved or dialled`, seq.length === 2 && seq[1].state === 'failed' && !seq[1].result && /parameter|valid|port|timeout/i.test(seq[1].error ?? ''), JSON.stringify(seq).slice(0, 300));
  }
  const sv = c.sanitizeResult('defender_status', res(serv, 'defender_status'));
  check('pwsh server: Defender read, Security Center not (Server has none), signatures 9 days → Critical, tamper Unknown', sv.supported === true && sv.securityCenterRead === false && stateOf(I(serv, 'defender_status'), 'signatures') === 'critical' && stateOf(I(serv, 'defender_status'), 'tamper') === 'unknown');
  check('pwsh server: no BitLocker cmdlet → Unsupported', I(serv, 'bitlocker_status').overall === 'unsupported' && c.sanitizeResult('bitlocker_status', res(serv, 'bitlocker_status')).reason === 'not_installed');
  check('pwsh server: legacy BIOS → Secure Boot Unsupported; Get-Tpm failing → TPM Unknown', stateOf(I(serv, 'secure_boot_tpm'), 'secure-boot') === 'unsupported' && stateOf(I(serv, 'secure_boot_tpm'), 'tpm') === 'unknown');
  check('pwsh server: Get-LocalGroupMember failing falls back to the CIM association', (() => { const a = c.sanitizeResult('local_admins', res(serv, 'local_admins')); return a.method === 'cim' && a.members.length === 2 && a.members[0].name === 'SRV1\\Administrator' && a.members[0].builtinAdministrator && a.members[1].kind === 'Group'; })());
  rmSync(dir, { recursive: true, force: true });
}

console.log(`unit-diagnostics-palette: ${passed} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1); }
