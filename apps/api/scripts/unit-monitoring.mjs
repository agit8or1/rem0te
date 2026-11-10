#!/usr/bin/env node
// Tests for the monitoring engine (src/monitoring/engine.ts), run against dist:
//
//   node apps/api/scripts/unit-monitoring.mjs
//
// Pure functions only: rule parameters, inheritance, what the agent is asked,
// sanitising what it reports, every evaluator, site outage decisions,
// maintenance windows, escalation timing and inventory change history.
// With PWSH set (a pwsh binary), it also runs the heartbeat's monitor block
// from the generated installer against stub Get-Service / Get-WinEvent /
// Invoke-RestMethod and checks the report it would send.

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const m = require(join(here, '..', 'dist', 'monitoring', 'engine.js'));

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => { if (ok) passed++; else failures.push(`${name}${detail ? ` — ${detail}` : ''}`); };
const T0 = new Date(Date.UTC(2026, 10, 10, 12, 0, 0));
const at = (min) => new Date(T0.getTime() + min * 60_000);
const rule = (key, kind, params = {}, extra = {}) => ({ id: `r-${key}-${extra.scopeKey ?? 'global'}`, scopeKey: 'global', key, kind, enabled: true, severity: 'WARNING', name: key, params, ...extra });

// ── Parameters ──────────────────────────────────────────────────────────────
{
  const p = m.parseParams('OFFLINE', {});
  check('OFFLINE defaults to 15 minutes', p.ok && p.params.minutes === 15, JSON.stringify(p));
  check('OFFLINE refuses 1 minute', !m.parseParams('OFFLINE', { minutes: 1 }).ok);
  check('unknown params are refused (strict)', !m.parseParams('DISK_FREE', { minFreePercent: 10, rm: '-rf' }).ok);
  check('a service name with a wildcard is refused', !m.parseParams('SERVICE_STOPPED', { service: 'Spool*' }).ok);
  check('a service name with a space or ; is refused', !m.parseParams('SERVICE_STOPPED', { service: 'a;b' }).ok && !m.parseParams('SERVICE_STOPPED', { service: 'a b' }).ok);
  check('a plain service name is accepted', m.parseParams('SERVICE_STOPPED', { service: 'Spooler' }).ok);
  check('an event monitor on an unlisted log is refused', !m.parseParams('EVENT_MATCH', { log: 'Microsoft-Windows-Sysmon/Operational', ids: [1] }).ok);
  check('an event monitor matching every event is refused', !m.parseParams('EVENT_MATCH', { log: 'System' }).ok);
  check('an event monitor with ids is accepted', m.parseParams('EVENT_MATCH', { log: 'System', ids: [7] }).ok);
  check('an event threshold above the agent\'s 100-event cap is refused', !m.parseParams('EVENT_MATCH', { log: 'System', ids: [7], threshold: 500 }).ok);
  check('every recommended monitor has valid params', m.RECOMMENDED.every((r) => m.parseParams(r.kind, r.params).ok));
}

// ── Inheritance ─────────────────────────────────────────────────────────────
{
  const ep = { id: 'ep1', customerId: 'biz1', siteId: 'site1' };
  const scopes = m.scopesFor(ep);
  check('scopes run global → business → site → computer', JSON.stringify(scopes) === JSON.stringify(['global', 'b:biz1', 's:site1', 'e:ep1']));
  check('a computer without a site skips the site scope', JSON.stringify(m.scopesFor({ id: 'e', customerId: 'b', siteId: null })) === JSON.stringify(['global', 'b:b', 'e:e']));
  const rules = [
    rule('disk-free', 'DISK_FREE', { minFreePercent: 10 }),
    rule('disk-free', 'DISK_FREE', { minFreePercent: 20 }, { scopeKey: 'b:biz1' }),
    rule('disk-free', 'DISK_FREE', { minFreePercent: 5 }, { scopeKey: 's:site1' }),
    rule('offline', 'OFFLINE', {}),
    rule('offline', 'OFFLINE', {}, { scopeKey: 'e:ep1', enabled: false }),
    rule('spooler', 'SERVICE_STOPPED', { service: 'Spooler' }, { scopeKey: 'b:biz2' }),
    rule('cpu', 'CPU_HIGH', {}, { scopeKey: 'b:biz1' }),
  ];
  const eff = m.effectiveRules(rules, scopes);
  const by = Object.fromEntries(eff.map((r) => [r.key, r]));
  check('the most specific rule wins (site over business over global)', by['disk-free']?.params.minFreePercent === 5 && by['disk-free'].inheritedFrom === 's:site1', JSON.stringify(by['disk-free']));
  check('and it records what it overrides', JSON.stringify(by['disk-free']?.overrides) === JSON.stringify(['b:biz1', 'global']));
  check('a disabled rule at the computer switches off the inherited monitor', !by.offline);
  check('another business\'s rule never applies', !by.spooler);
  check('a business rule with no global counterpart applies', !!by.cpu);
  const other = m.effectiveRules(rules, m.scopesFor({ id: 'ep2', customerId: 'biz1', siteId: null }));
  check('a sibling computer still gets the global offline monitor', other.some((r) => r.key === 'offline'));
  check('and the business threshold, not the site one', other.find((r) => r.key === 'disk-free')?.params.minFreePercent === 20);
}

// ── What the agent is asked ─────────────────────────────────────────────────
{
  const rules = [
    rule('spooler', 'SERVICE_STOPPED', { service: 'Spooler' }),
    rule('spooler2', 'SERVICE_STOPPED', { service: 'Spooler' }),
    rule('disk-errors', 'EVENT_MATCH', { log: 'System', ids: [7, 11] }),
    rule('bad', 'SERVICE_STOPPED', { service: 'x;y' }),
    rule('disk', 'DISK_FREE', {}),
  ];
  const cfg = m.agentMonitorConfig(rules, { 'disk-errors': '2026-11-10T11:00:00.000Z' });
  check('services are de-duplicated', JSON.stringify(cfg.services) === JSON.stringify(['Spooler']), JSON.stringify(cfg));
  check('a rule with invalid params is never sent to the agent', !cfg.services.includes('x;y'));
  check('event queries carry the agent\'s own last clock as since', cfg.events[0]?.since === '2026-11-10T11:00:00.000Z' && cfg.events[0].log === 'System');
  check('no service or event monitors → nothing to ask', m.agentMonitorConfig([rule('disk', 'DISK_FREE', {})], {}) === null);
  const many = Array.from({ length: 50 }, (_, i) => rule(`s${i}`, 'SERVICE_STOPPED', { service: `Svc${i}` }));
  check('at most 32 services are asked about', m.agentMonitorConfig(many, {}).services.length === 32);
}

// ── Sanitising the report ───────────────────────────────────────────────────
{
  const asked = { services: ['Spooler', 'W32Time'], eventKeys: ['disk-errors'] };
  const r = m.sanitizeReport({
    services: [{ name: 'spooler', status: 'Stopped', startType: 'Automatic' }, { name: 'Evil', status: 'Running' }, { name: 'W32Time', status: 'Running<script>', startType: 'Manual' }, { name: 'Spooler', status: 'Running' }],
    events: [{ key: 'disk-errors', checkedAt: '2026-11-10T17:36:30.8936938Z', count: 3, newestAt: '2026-11-10T17:36:31Z', sample: { eventId: 7, level: 2, provider: 'disk', message: 'm\u0000'.repeat(400) } }, { key: 'invented', checkedAt: '2026-11-10T17:36:30Z', count: 9 }],
  }, asked);
  check('a service the server did not ask about is dropped', r.services.length === 2 && !r.services.some((s) => s.name === 'Evil'), JSON.stringify(r.services));
  check('names come back in the server\'s spelling', r.services[0].name === 'Spooler');
  check('a duplicate report for the same service keeps the first', r.services.filter((s) => s.name === 'Spooler').length === 1 && r.services[0].status === 'Stopped');
  check('an unknown status is stored as Missing, never as text from the device', r.services.find((s) => s.name === 'W32Time').status === 'Missing');
  check('an event key nobody configured is dropped', r.events.length === 1 && r.events[0].key === 'disk-errors');
  check('PowerShell\'s 7-digit fractions are normalised to ms', r.events[0].checkedAt === '2026-11-10T17:36:30.893Z');
  check('the sample message is clamped and stripped of control characters', r.events[0].sample.message.length <= 300 && !r.events[0].sample.message.includes('\u0000'));
  const g = m.sanitizeReport('garbage', asked);
  check('garbage is an empty report', g.services.length === 0 && g.events.length === 0);
}

// ── Evaluators ──────────────────────────────────────────────────────────────
const live = (o = {}) => ({ name: 'PC1', isOnline: true, lastSeenAt: at(0), cpuLoadPercent: 10, memoryTotalMb: 8192, memoryFreeMb: 4096, systemDiskTotalMb: 100_000, systemDiskFreeMb: 50_000, liveSampledAt: at(0), rebootRequired: false, updatesCheckedAt: at(0), ...o });
{
  const off = rule('offline', 'OFFLINE', { minutes: 15 });
  let v = m.evaluateLive(off, live({ isOnline: false, lastSeenAt: at(0) }), m.EMPTY_STATE, at(10), false);
  check('offline for 10 min under a 15-min monitor: no alert', v.verdict === 'ok' && !v.clear);
  v = m.evaluateLive(off, live({ isOnline: false, lastSeenAt: at(0) }), m.EMPTY_STATE, at(16), false);
  check('offline for 16 min: breach', v.verdict === 'breach' && /offline/.test(v.title), JSON.stringify(v));
  v = m.evaluateLive(off, live({ isOnline: true, lastSeenAt: at(30) }), v.state, at(30), false);
  check('back online clears at once', v.verdict === 'ok' && v.clear);

  const cpu = rule('cpu', 'CPU_HIGH', { percent: 90, samples: 3 });
  let st = m.EMPTY_STATE;
  const seq = [95, 96, 97];
  const verdicts = seq.map((p, i) => { const r = m.evaluateLive(cpu, live({ cpuLoadPercent: p, liveSampledAt: at(i * 3) }), st, at(i * 3), true); st = r.state; return r.verdict; });
  check('CPU needs N consecutive samples', JSON.stringify(verdicts) === JSON.stringify(['pending', 'pending', 'breach']), JSON.stringify(verdicts));
  let r = m.evaluateLive(cpu, live({ cpuLoadPercent: 20, liveSampledAt: at(9) }), st, at(9), true); st = r.state;
  check('one good sample does not clear (hysteresis)', r.verdict === 'ok' && !r.clear);
  r = m.evaluateLive(cpu, live({ cpuLoadPercent: 20, liveSampledAt: at(12) }), st, at(12), true);
  check('two good samples clear', r.verdict === 'ok' && r.clear);
  check('the same sample seen again is not counted', m.evaluateLive(cpu, live({ cpuLoadPercent: 99 }), m.EMPTY_STATE, at(0), false).verdict === 'skip');
  check('a sample older than 15 minutes is not evidence', m.evaluateLive(cpu, live({ cpuLoadPercent: 99, liveSampledAt: at(-20) }), m.EMPTY_STATE, at(0), true).verdict === 'skip');

  const disk = rule('disk', 'DISK_FREE', { minFreePercent: 10, minFreeMb: 5000 });
  check('disk under the percentage breaches', m.evaluateLive(disk, live({ systemDiskFreeMb: 9_000 }), m.EMPTY_STATE, at(0), true).verdict === 'breach');
  check('disk under the MB floor breaches even above the percentage', m.evaluateLive(disk, live({ systemDiskTotalMb: 20_000, systemDiskFreeMb: 4_000 }), m.EMPTY_STATE, at(0), true).verdict === 'breach');
  check('disk with no total reported is skipped, not breached', m.evaluateLive(disk, live({ systemDiskTotalMb: null }), m.EMPTY_STATE, at(0), true).verdict === 'skip');

  const mem = rule('mem', 'MEMORY_HIGH', { percent: 90, samples: 1 });
  check('memory 95% used breaches', m.evaluateLive(mem, live({ memoryFreeMb: 400 }), m.EMPTY_STATE, at(0), true).verdict === 'breach');

  const rb = rule('reboot', 'REBOOT_PENDING', { hours: 72 });
  let s2 = m.evaluateLive(rb, live({ rebootRequired: true }), m.EMPTY_STATE, at(0), false);
  check('restart pending: starts counting, no alert yet', s2.verdict === 'pending' && s2.state.breachSince?.getTime() === at(0).getTime());
  s2 = m.evaluateLive(rb, live({ rebootRequired: true }), s2.state, at(73 * 60), false);
  check('restart pending for 73 h: breach, and says since when rem0te saw it', s2.verdict === 'breach' && s2.detail.note.includes('rem0te first saw'));
  check('restart done clears', (() => { const x = m.evaluateLive(rb, live({ rebootRequired: false }), s2.state, at(74 * 60), false); return x.verdict === 'ok' && x.clear; })());
}
{
  const sv = rule('spooler', 'SERVICE_STOPPED', { service: 'Spooler' });
  check('a stopped service breaches', m.evaluateService(sv, { name: 'Spooler', status: 'Stopped', startType: 'Automatic' }, 'PC1', m.EMPTY_STATE, at(0)).verdict === 'breach');
  check('a running service clears', (() => { const v = m.evaluateService(sv, { name: 'Spooler', status: 'Running', startType: 'Automatic' }, 'PC1', m.EMPTY_STATE, at(0)); return v.verdict === 'ok' && v.clear; })());
  check('a disabled service is ignored by default', m.evaluateService(sv, { name: 'Spooler', status: 'Stopped', startType: 'Disabled' }, 'PC1', m.EMPTY_STATE, at(0)).verdict === 'ok');
  check('a missing service is not an alert unless asked', m.evaluateService(sv, { name: 'Spooler', status: 'Missing', startType: null }, 'PC1', m.EMPTY_STATE, at(0)).verdict === 'ok');
  check('…and is one with alertIfMissing', m.evaluateService(rule('s', 'SERVICE_STOPPED', { service: 'Spooler', alertIfMissing: true }), { name: 'Spooler', status: 'Missing', startType: null }, 'PC1', m.EMPTY_STATE, at(0)).verdict === 'breach');
  const p1 = m.evaluateService(sv, { name: 'Spooler', status: 'StartPending', startType: 'Automatic' }, 'PC1', m.EMPTY_STATE, at(0));
  check('a service mid-start gets one more report', p1.verdict === 'pending');
  check('no report for the service: skip', m.evaluateService(sv, undefined, 'PC1', m.EMPTY_STATE, at(0)).verdict === 'skip');
}
{
  const ev = rule('disk-errors', 'EVENT_MATCH', { log: 'System', ids: [7], threshold: 2, clearAfterMinutes: 60 });
  const rep = (count) => ({ key: 'disk-errors', checkedAt: at(0).toISOString(), count, newestAt: null, sample: null });
  check('below the threshold: no alert', m.evaluateEvents(ev, rep(1), 'PC1', m.EMPTY_STATE, at(0)).verdict === 'ok');
  const b = m.evaluateEvents(ev, rep(3), 'PC1', m.EMPTY_STATE, at(0));
  check('at the threshold: breach', b.verdict === 'breach' && b.detail.count === 3);
  check('quiet for 30 min: not cleared yet', !m.evaluateEvents(ev, rep(0), 'PC1', b.state, at(30)).clear);
  check('quiet for 61 min: cleared (the sweep passes no report)', m.evaluateEvents(ev, undefined, 'PC1', b.state, at(61)).clear);
}

// ── Site outages ────────────────────────────────────────────────────────────
check('2 of 2 offline is not a site outage (too small)', m.outageDecision({ active: 2, offline: 2, open: false }) === 'none');
check('3 of 10 offline is not an outage', m.outageDecision({ active: 10, offline: 3, open: false }) === 'none');
check('5 of 8 offline is', m.outageDecision({ active: 8, offline: 5, open: false }) === 'raise');
check('an open outage holds at 3 of 8 (hysteresis)', m.outageDecision({ active: 8, offline: 3, open: true }) === 'hold');
check('and clears at 1 of 8', m.outageDecision({ active: 8, offline: 1, open: true }) === 'clear');
check('offline alerts wait at least a few minutes so they can be grouped', m.OUTAGE.holdMs >= 120_000);

// ── Maintenance windows ─────────────────────────────────────────────────────
{
  const alert = { customerId: 'b1', siteId: 's1', endpointId: 'e1', ruleKey: 'offline' };
  const sup = (o) => ({ id: 'w', scopeKey: 'b:b1', ruleKeys: [], startsAt: at(-10), endsAt: at(60), revokedAt: null, ...o });
  check('a business window covers its computers', m.suppressionFor(alert, [sup()], at(0))?.id === 'w');
  check('another business\'s window does not', m.suppressionFor(alert, [sup({ scopeKey: 'b:b2' })], at(0)) === null);
  check('a window naming other monitors does not', m.suppressionFor(alert, [sup({ ruleKeys: ['disk-free'] })], at(0)) === null);
  check('a window naming this monitor does', m.suppressionFor(alert, [sup({ ruleKeys: ['offline'] })], at(0)) !== null);
  check('a revoked window does not', m.suppressionFor(alert, [sup({ revokedAt: at(-1) })], at(0)) === null);
  check('a window that has not started does not', m.suppressionFor(alert, [sup({ startsAt: at(5) })], at(0)) === null);
  check('an ended window does not', m.suppressionFor(alert, [sup({ endsAt: at(0) })], at(0)) === null);
  check('a computer window covers that computer only', m.suppressionFor(alert, [sup({ scopeKey: 'e:e1' })], at(0)) !== null && m.suppressionFor({ ...alert, endpointId: 'e2' }, [sup({ scopeKey: 'e:e1' })], at(0)) === null);
}

// ── Escalation ──────────────────────────────────────────────────────────────
{
  const levels = [
    { afterMinutes: 0, minSeverity: 'WARNING', destinations: [{ label: 'a', url: 'https://x.example/a' }] },
    { afterMinutes: 30, minSeverity: 'CRITICAL', destinations: [{ label: 'b', url: 'https://x.example/b' }] },
    { afterMinutes: 60, minSeverity: 'WARNING', destinations: [{ label: 'c', url: 'https://x.example/c' }] },
  ];
  const a = (sev, lvl) => ({ severity: sev, notifyFrom: at(0), escalationLevel: lvl });
  check('level 0 fires at once', JSON.stringify(m.dueLevels(levels, a('WARNING', 0), at(0)).map((d) => d.index)) === '[0]');
  check('nothing more until 30 min', m.dueLevels(levels, a('WARNING', 1), at(29)).length === 0);
  const d = m.dueLevels(levels, a('WARNING', 1), at(61));
  check('a WARNING passes over the CRITICAL-only level, then reaches level 2', d.length === 2 && d[0].skip && !d[1].skip && d[1].index === 2, JSON.stringify(d));
  check('INFO below every floor fires nothing (all skipped)', m.dueLevels(levels, a('INFO', 0), at(0)).every((x) => x.skip));
  check('levels must go up in time', !m.NotifyPolicyInput.safeParse({ scope: 'global', levels: [levels[1], levels[0]] }).success);
  check('a destination must be a URL', !m.NotifyPolicyInput.safeParse({ scope: 'global', levels: [{ afterMinutes: 0, destinations: [{ label: 'x', url: 'not a url' }] }] }).success);
}

// ── Change history and software ─────────────────────────────────────────────
{
  const before = { manufacturer: 'Dell', model: 'OptiPlex 7090', memoryTotalGb: 16, osBuild: '19045', disks: [{ drive: 'C:', totalBytes: 512e9 }], networks: [{ name: 'Ethernet', mac: 'AA' }], software: [{ name: '7-Zip', version: '23.01', publisher: 'Igor' }, { name: 'Chrome', version: '120', publisher: 'Google' }] };
  check('the first inventory pass records nothing', m.diffInventory(null, before).length === 0);
  check('an identical pass records nothing', m.diffInventory(before, before).length === 0);
  const after = { ...before, memoryTotalGb: 32, osBuild: '22631', disks: [{ drive: 'C:', totalBytes: 1024e9 }, { drive: 'D:', totalBytes: 2000e9 }], networks: [], software: [{ name: '7-Zip', version: '24.08', publisher: 'Igor' }, { name: 'AnyDesk', version: '8', publisher: 'AnyDesk' }] };
  const ch = m.diffInventory(before, after);
  const has = (cat, change, subj) => ch.some((c) => c.category === cat && c.change === change && c.subject.includes(subj));
  check('memory upgrade is a hardware change', has('hardware', 'changed', 'memory'));
  check('OS build change is recorded', has('os', 'changed', 'OS build'));
  check('disk capacity change and a new disk', has('disk', 'changed', 'C:') && has('disk', 'added', 'D:'));
  check('an adapter that disappeared is recorded', has('network', 'removed', 'Ethernet'));
  check('software updated, installed and removed', has('software', 'changed', '7-Zip') && has('software', 'added', 'AnyDesk') && has('software', 'removed', 'Chrome'));
  const partial = m.diffInventory(before, { manufacturer: 'Dell', software: null, disks: null, networks: null });
  check('a pass that did not report a list does not "remove" everything in it', partial.length === 0, JSON.stringify(partial));
  const sw = m.sanitizeSoftware([{ name: 'Zed\u0001', version: '1', publisher: 'P', installedOn: '20260101' }, { name: 'zed\u0001', publisher: 'p' }, { name: '' }, { name: 'Alpha', installedOn: '2026-01-01' }, 'junk']);
  check('software: control characters stripped, duplicates and blanks dropped, sorted', sw.length === 2 && sw[0].name === 'Alpha' && sw[1].name === 'Zed', JSON.stringify(sw));
  check('software: InstallDate kept only as yyyyMMdd → ISO date', sw[1].installedOn === '2026-01-01' && sw[0].installedOn === null);
  check('software: capped at 500', m.sanitizeSoftware(Array.from({ length: 900 }, (_, i) => ({ name: `App ${i}` }))).length === 500);
  check('software: absent is undefined (not "empty")', m.sanitizeSoftware(undefined) === undefined);
}

// ── The heartbeat's monitor block, in PowerShell (optional) ─────────────────
// pwsh on PATH (GitHub's ubuntu runners have it) or PWSH=/path/to/pwsh.
const pwsh = process.env.PWSH || (spawnSync('pwsh', ['-v']).status === 0 ? 'pwsh' : null);
if (!pwsh) console.log('  (pwsh not found: the monitor block is not executed)');
if (pwsh) {
  const w = require(join(here, '..', 'dist', 'public', 'windows-script.js'));
  const script = w.buildSignedWindowsScript('0.29.0');
  const hb = /\$hbBody = @'\r?\n([\s\S]*?)\r?\n'@/.exec(script)[1];
  const blk = hb.slice(hb.indexOf('# ---- Monitoring (0.29)'), hb.indexOf('# Apply a staged RustDesk upgrade.'));
  const dir = mkdtempSync(join(tmpdir(), 'rem0te-psmon-'));
  const cfg = { data: { monitor: { v: 1, services: ['Spooler', 'NoSuch', 'bad name;rm', 'W32Time'], events: [
    { key: 'disk-errors', log: 'System', ids: [7, 11], levels: [], provider: null, since: '2026-11-10T10:00:00.000Z' },
    { key: 'quiet', log: 'Application', ids: [], levels: [1, 2], provider: 'MyApp', since: null },
    { key: 'evil', log: 'C:\\x', ids: [1], levels: [], provider: null, since: null },
    { key: 'failing', log: 'Setup', ids: [5], levels: [], provider: null, since: null },
  ] } } };
  writeFileSync(join(dir, 'cfg.json'), JSON.stringify(cfg));
  writeFileSync(join(dir, 'run.ps1'), `
$ErrorActionPreference='Continue'
$id='123456789'; $state=[pscustomobject]@{ agentSecret='secretsecretsecret'; host='portal.test' }
$resp = Get-Content -Raw '${join(dir, 'cfg.json')}' | ConvertFrom-Json
function Get-Service { param($Name, $ErrorAction) if ($Name -eq 'Spooler') { [pscustomobject]@{ Status='Stopped'; StartType='Automatic' } } elseif ($Name -eq 'W32Time') { [pscustomobject]@{ Status='Running'; StartType='Manual' } } else { $null } }
function Get-WinEvent { param($FilterHashtable, $MaxEvents, $ErrorAction)
  Add-Content -LiteralPath '${join(dir, 'filters.txt')}' -Value ($FilterHashtable | ConvertTo-Json -Compress -Depth 4)
  if ($FilterHashtable.LogName -eq 'System') { return @([pscustomobject]@{ Id=7; Level=2; ProviderName='disk'; TimeCreated=(Get-Date); Message=('x'*400) }, [pscustomobject]@{ Id=11; Level=2; ProviderName='disk'; TimeCreated=(Get-Date).AddMinutes(-1); Message='y' }) }
  if ($FilterHashtable.LogName -eq 'Setup') { throw (New-Object System.Management.Automation.ErrorRecord ([Exception]'denied'), 'AccessDenied', 'PermissionDenied', $null) }
  throw (New-Object System.Management.Automation.ErrorRecord ([Exception]'none'), 'NoMatchingEventsFound,Microsoft.PowerShell.Commands.GetWinEventCommand', 'ObjectNotFound', $null) }
function Invoke-RestMethod { param($Uri,$Method,$Body,$ContentType,[switch]$UseBasicParsing,$TimeoutSec,$ErrorAction) Set-Content -LiteralPath '${join(dir, 'body.json')}' -Value $Body; Set-Content -LiteralPath '${join(dir, 'uri.txt')}' -Value $Uri }
${blk}
`);
  const r = spawnSync(pwsh, ['-NoProfile', '-File', join(dir, 'run.ps1')], { encoding: 'utf8' });
  let body = null, filters = [];
  try { body = JSON.parse(readFileSync(join(dir, 'body.json'), 'utf8')); filters = readFileSync(join(dir, 'filters.txt'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { /* checked below */ }
  check('pwsh: the monitor block runs and posts to /enrollment/monitor-report', r.status === 0 && !!body && readFileSync(join(dir, 'uri.txt'), 'utf8').trim() === 'https://portal.test/api/v1/enrollment/monitor-report', r.stderr);
  if (body) {
    const names = body.services.map((s) => s.name);
    check('pwsh: a service name failing the charset is never passed to Get-Service', JSON.stringify(names) === JSON.stringify(['Spooler', 'NoSuch', 'W32Time']), JSON.stringify(names));
    check('pwsh: a service that is not installed reports Missing', body.services.find((s) => s.name === 'NoSuch')?.status === 'Missing');
    check('pwsh: a log outside the allowed list is never queried', !filters.some((f) => f.LogName === 'C:\\x'));
    check('pwsh: since is honoured; ids and levels are passed', filters[0]?.StartTime?.startsWith('2026-11-10T10:00:00') && JSON.stringify(filters[0].Id) === '[7,11]' && JSON.stringify(filters[1].Level) === '[1,2]', JSON.stringify(filters));
    const ev = Object.fromEntries(body.events.map((e) => [e.key, e]));
    check('pwsh: matches are counted and one sample kept, clamped to 300', ev['disk-errors']?.count === 2 && ev['disk-errors'].sample.message.length === 300);
    check('pwsh: no matches is a count of 0, not an error', ev.quiet?.count === 0);
    check('pwsh: a query that failed is left out (state unchanged)', !ev.failing && !ev.evil);
    const san = m.sanitizeReport(body, { services: ['Spooler', 'NoSuch', 'W32Time'], eventKeys: ['disk-errors', 'quiet'] });
    check('pwsh → server: the report survives sanitising intact', san.services.length === 3 && san.events.length === 2);
  }
  rmSync(dir, { recursive: true, force: true });
}

console.log(`unit-monitoring: ${passed} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1); }
