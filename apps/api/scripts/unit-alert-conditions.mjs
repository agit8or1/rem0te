#!/usr/bin/env node
// Tests for 0.55's alert conditions and automatic PSA tickets, run against dist:
//
//   cd apps/api && npx nest build && node scripts/unit-alert-conditions.mjs
//
// Pure functions only: the four new monitor kinds' parameters and verdicts
// (every fixed drive, uptime, outstanding security/critical updates, failed
// update installs), the drive dedup keys, the recommended set, the
// automatic-ticket rule (which rule applies, and every reason an alert is
// not ticketed), its retry schedule, the ticket draft it sends (no free text
// beyond a manual alert ticket), and the confirm catalog key. The
// behavioural proof against a running API is scripts/e2e-alert-tickets.mjs.

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const dist = join(here, '..', 'dist');
const m = require(join(dist, 'monitoring', 'engine.js'));
const TK = require(join(dist, 'psa', 'ticket.js'));
const C = require(join(dist, 'security-controls', 'confirm-catalog.js'));
const WH = require(join(dist, 'psa', 'connectors', 'webhook.js'));

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => { if (ok) passed++; else failures.push(`${name}${detail ? ` — ${detail}` : ''}`); };
const T0 = new Date(Date.UTC(2026, 10, 16, 12, 0, 0));
const at = (min) => new Date(T0.getTime() + min * 60_000);
const days = (d) => at(d * 1440);
const rule = (key, kind, params = {}, extra = {}) => ({ id: `r-${key}`, scopeKey: 'global', key, kind, enabled: true, severity: 'WARNING', name: key, params, ...extra });
const GB = 1024 ** 3;
const J = (x) => JSON.stringify(x);

// ── Kinds and parameters ────────────────────────────────────────────────────
{
  for (const k of ['DRIVE_FREE', 'UPTIME_LONG', 'UPDATES_MISSING', 'UPDATE_FAILED']) check(`${k} is a monitor kind`, m.MONITOR_KINDS.includes(k));
  check('the eight 0.29–0.36 kinds are still there, in order', J(m.MONITOR_KINDS.slice(0, 8)) === J(['OFFLINE', 'DISK_FREE', 'CPU_HIGH', 'MEMORY_HIGH', 'SERVICE_STOPPED', 'EVENT_MATCH', 'REBOOT_PENDING', 'AGENT_SILENT']));
  const migration = readFileSync(join(here, '..', 'prisma', 'migrations', '0076_alert_conditions', 'migration.sql'), 'utf8');
  check('0076 adds exactly the four kinds to the enum', ['DRIVE_FREE', 'UPTIME_LONG', 'UPDATES_MISSING', 'UPDATE_FAILED'].every((k) => migration.includes(`ADD VALUE '${k}'`)));
  // The kinds CHECK is re-made by later migrations as kinds are added (0077:
  // WARRANTY_EXPIRING); the newest one is what the database holds.
  const kindsSql = ['0076_alert_conditions', '0077_warranty'].map((d) => readFileSync(join(here, '..', 'prisma', 'migrations', d, 'migration.sql'), 'utf8'))
    .map((s) => (s.match(/"MonitorTicketPolicy_kinds" CHECK \([\s\S]*?::TEXT\[\]/g) ?? []).pop() ?? '').filter(Boolean).pop() ?? '';
  check('the newest ticket-rule CHECK names every monitor kind and no other', m.MONITOR_KINDS.every((k) => kindsSql.includes(`'${k}'`)) && !kindsSql.includes("'SITE_OUTAGE'"), kindsSql.slice(0, 80));

  let p = m.parseParams('DRIVE_FREE', {});
  check('DRIVE_FREE defaults: 10%, every drive, none excepted', p.ok && p.params.minFreePercent === 10 && J(p.params.drives) === '[]' && J(p.params.exceptDrives) === '[]', J(p));
  p = m.parseParams('DRIVE_FREE', { drives: ['d', 'E:'], exceptDrives: ['c'] });
  check('drive letters are normalised to "X:"', p.ok && J(p.params.drives) === J(['D:', 'E:']) && J(p.params.exceptDrives) === J(['C:']), J(p));
  for (const bad of ['C:\\', 'CD', '/', '/mnt/data', '..', 'C;', '1:', 'C:$(x)', '']) check(`a drive "${bad}" is refused (charset)`, !m.parseParams('DRIVE_FREE', { drives: [bad] }).ok);
  check('DRIVE_FREE refuses 0% and 95%', !m.parseParams('DRIVE_FREE', { minFreePercent: 0 }).ok && !m.parseParams('DRIVE_FREE', { minFreePercent: 95 }).ok);
  check('DRIVE_FREE is strict', !m.parseParams('DRIVE_FREE', { minFreePercent: 10, path: '/' }).ok);
  check('UPTIME_LONG defaults to 30 days, 1–365', m.parseParams('UPTIME_LONG', {}).params?.days === 30 && !m.parseParams('UPTIME_LONG', { days: 0 }).ok && !m.parseParams('UPTIME_LONG', { days: 366 }).ok);
  p = m.parseParams('UPDATES_MISSING', {});
  check('UPDATES_MISSING defaults: 30 days, security and critical', p.ok && p.params.days === 30 && J(p.params.classes) === J(['security', 'critical']), J(p));
  check('UPDATES_MISSING refuses an unknown class and an empty list', !m.parseParams('UPDATES_MISSING', { classes: ['drivers'] }).ok && !m.parseParams('UPDATES_MISSING', { classes: [] }).ok);
  check('UPDATE_FAILED defaults to 7 days, 1–90', m.parseParams('UPDATE_FAILED', {}).params?.days === 7 && !m.parseParams('UPDATE_FAILED', { days: 91 }).ok);
  check('the update classes are the patch scan\'s Security and Critical GUIDs',
    m.UPDATE_CLASS_GUID.security === '0fa1201d-4330-4fa8-8ae9-b877473b6441' && m.UPDATE_CLASS_GUID.critical === 'e6cf1350-c01b-414d-a61f-263d14d133b4');

  const rec = Object.fromEntries(m.RECOMMENDED.map((r) => [r.key, r]));
  check('the recommended set is ten monitors with distinct keys', m.RECOMMENDED.length === 10 && new Set(m.RECOMMENDED.map((r) => r.key)).size === 10, m.RECOMMENDED.map((r) => r.key).join(','));
  check('every recommended monitor has valid params', m.RECOMMENDED.every((r) => m.parseParams(r.kind, r.params).ok));
  check('drive-free is recommended without C: (disk-free has it, from the live sample)', rec['drive-free']?.kind === 'DRIVE_FREE' && J(rec['drive-free'].params.exceptDrives) === J(['C:']) && rec['disk-free']?.kind === 'DISK_FREE');
  check('updates-missing (30 days) and update-failed (7 days) are recommended, WARNING', rec['updates-missing']?.params.days === 30 && rec['update-failed']?.params.days === 7 && rec['updates-missing'].severity === 'WARNING' && rec['update-failed'].severity === 'WARNING');
  check('uptime is not recommended (an opt-in nag)', !m.RECOMMENDED.some((r) => r.kind === 'UPTIME_LONG'));
}

// ── DRIVE_FREE ──────────────────────────────────────────────────────────────
{
  const r = rule('drives', 'DRIVE_FREE', { minFreePercent: 10 });
  const ep = { id: 'ep1234567890', name: 'PC-1' };
  const disks = [
    { drive: 'C:', totalBytes: 100 * GB, freeBytes: 50 * GB },
    { drive: 'd:', totalBytes: 100 * GB, freeBytes: 5 * GB },
    { drive: 'E:', totalBytes: 100 * GB, freeBytes: 11 * GB },
    { drive: 'F:', totalBytes: 100 * GB, freeBytes: 20 * GB },
    { drive: '/', totalBytes: 100 * GB, freeBytes: 1 * GB },
    { drive: 'G:\\evil', totalBytes: 100 * GB, freeBytes: 1 },
    { drive: 'H:', totalBytes: 0, freeBytes: 0 },
    { drive: 'I:', totalBytes: 10 * GB, freeBytes: 11 * GB },
    { drive: 'D:', totalBytes: 100 * GB, freeBytes: 99 * GB },
  ];
  const v = m.evaluateDrives(r, ep, { disks, collectedAt: at(-60) }, T0);
  const by = Object.fromEntries((v.drives ?? []).map((d) => [d.drive, d]));
  check('drives: every fixed drive with a letter is judged', v.verdict === 'drives' && J(Object.keys(by).sort()) === J(['C:', 'D:', 'E:', 'F:']), J(v));
  check('drives: a Linux mount, a non-letter, an empty and an impossible drive are left out', !by['/'] && !Object.keys(by).some((k) => k.startsWith('G')) && !by['H:'] && !by['I:']);
  check('drives: the first report of a letter wins (no duplicate)', by['D:']?.verdict === 'breach');
  check('drives: D: at 5% breaches, with the drive in the title and detail', by['D:']?.verdict === 'breach' && /drive D: 5\.0% free/.test(by['D:'].title) && by['D:'].detail.drive === 'D:' && by['D:'].detail.freeMb === 5 * 1024);
  check('drives: E: at 11% holds (between the line and the line plus 2)', by['E:']?.verdict === 'hold');
  check('drives: C: at 50% and F: at 20% are ok', by['C:']?.verdict === 'ok' && by['F:']?.verdict === 'ok');
  check('drives: one dedup key per drive, under the computer\'s prefix', by['D:'].dedupKey === 'drives:ep1234567890:D' && by['D:'].dedupKey.startsWith(m.drivePrefixOf('drives', ep.id)) && m.dedupKeyOf('drives', ep.id) !== by['D:'].dedupKey);
  const only = m.evaluateDrives(rule('d', 'DRIVE_FREE', { drives: ['D'] }), ep, { disks, collectedAt: at(-60) }, T0);
  check('drives: "only these" narrows to D:', J(only.drives.map((d) => d.drive)) === J(['D:']));
  const except = m.evaluateDrives(rule('d', 'DRIVE_FREE', { exceptDrives: ['C:', 'd'] }), ep, { disks, collectedAt: at(-60) }, T0);
  check('drives: "except" leaves C: and D: out', J(except.drives.map((d) => d.drive).sort()) === J(['E:', 'F:']));
  const mb = m.evaluateDrives(rule('d', 'DRIVE_FREE', { minFreePercent: 1, minFreeMb: 25 * 1024 }), ep, { disks, collectedAt: at(-60) }, T0);
  check('drives: minFreeMb breaches F: (20 GB < 25 GB) though it is over 1%', mb.drives.find((d) => d.drive === 'F:')?.verdict === 'breach');
  check('drives: an inventory pass over 48 h old is not evidence', m.evaluateDrives(r, ep, { disks, collectedAt: at(-49 * 60) }, T0).verdict === 'skip');
  check('drives: no inventory, or no drive list, is skip', m.evaluateDrives(r, ep, null, T0).verdict === 'skip' && m.evaluateDrives(r, ep, { disks: null, collectedAt: at(-1) }, T0).verdict === 'skip');
  const many = Array.from({ length: 40 }, (_, i) => ({ drive: `${String.fromCharCode(65 + (i % 26))}:`, totalBytes: GB, freeBytes: 1 }));
  check('drives: at most 26 drives per computer', m.evaluateDrives(r, ep, { disks: many, collectedAt: at(-1) }, T0).drives.length === 26);
}

// ── UPTIME_LONG ─────────────────────────────────────────────────────────────
{
  const r = rule('uptime', 'UPTIME_LONG', { days: 30 });
  const live = (o) => ({ name: 'PC-1', lastBootAt: null, uptimeSeconds: null, liveSampledAt: at(-2), ...o });
  let v = m.evaluateUptime(r, live({ lastBootAt: days(-31) }), T0);
  check('uptime: 31 days up breaches, saying how long', v.verdict === 'breach' && v.title === 'PC-1: not restarted for 31 days' && v.detail.uptimeDays === 31, J(v));
  v = m.evaluateUptime(r, live({ lastBootAt: days(-3) }), T0);
  check('uptime: 3 days up is ok and clears', v.verdict === 'ok' && v.clear === true);
  v = m.evaluateUptime(r, live({ uptimeSeconds: 40 * 86400 }), T0);
  check('uptime: falls back to uptimeSeconds from the sample', v.verdict === 'breach' && v.detail.uptimeDays === 40);
  check('uptime: a stale live sample (offline computer) is skip, never a clear', m.evaluateUptime(r, live({ lastBootAt: days(-3), liveSampledAt: at(-30) }), T0).verdict === 'skip');
  check('uptime: a boot time in the future is skip', m.evaluateUptime(r, live({ lastBootAt: at(60) }), T0).verdict === 'skip');
  check('uptime: no boot time is skip', m.evaluateUptime(r, live({}), T0).verdict === 'skip');
}

// ── UPDATES_MISSING ─────────────────────────────────────────────────────────
const SEC = '0fa1201d-4330-4fa8-8ae9-b877473b6441', CRIT = 'e6cf1350-c01b-414d-a61f-263d14d133b4', DRV = 'ebfc1fc5-71a4-4f7b-9aca-3b9a503104a0';
const gid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const upd = (n, classification, o = {}) => ({ updateId: gid(n), revision: 1, kb: `KB50${String(n).padStart(5, '0')}`, title: `Update ${n}`, classification, downloaded: false, rebootBehavior: 0, userInput: false, eulaAccepted: true, browseOnly: false, sizeBytes: 1000, ...o });
const posture = (o = {}) => ({ schema: 'rem0te-patch-posture/1', scannedAt: at(-60).toISOString(), updates: [], history: [], reboot: { pending: false, sources: [] }, managers: [], autoUpdate: 'enabled', ...o });
{
  const r = rule('missing', 'UPDATES_MISSING', { days: 14 });
  const scan = posture({ updates: [upd(1, SEC), upd(2, CRIT), upd(3, DRV), upd(4, SEC, { browseOnly: true })] });
  let v = m.evaluateMissingUpdates(r, 'PC-1', scan, {}, T0);
  check('missing: first sight records security and critical (not drivers, not optional) from now', v.verdict === 'ok' && J(Object.keys(v.seen).sort()) === J([gid(1), gid(2)]) && v.seen[gid(1)] === T0.toISOString(), J(v));
  const seen = { [gid(1)]: days(-20).toISOString(), [gid(2)]: days(-3).toISOString(), [gid(9)]: days(-50).toISOString() };
  v = m.evaluateMissingUpdates(r, 'PC-1', scan, seen, T0);
  check('missing: one security update seen 20 days ago breaches; the 3-day one does not count', v.verdict === 'breach' && v.detail.count === 1 && v.detail.updates[0].kb === 'KB5000001' && /1 security or critical update outstanding for over 14 days/.test(v.title), J(v));
  check('missing: an update no longer offered is forgotten', !(gid(9) in v.seen) && v.seen[gid(1)] === seen[gid(1)]);
  check('missing: the alert says the age is from when Rem0te first saw it', /first saw/.test(v.detail.note));
  const critOnly = m.evaluateMissingUpdates(rule('c', 'UPDATES_MISSING', { days: 14, classes: ['critical'] }), 'PC-1', scan, seen, T0);
  check('missing: classes narrows to critical', critOnly.verdict === 'ok' && J(Object.keys(critOnly.seen)) === J([gid(2)]));
  v = m.evaluateMissingUpdates(r, 'PC-1', posture({ updates: [upd(2, CRIT)] }), seen, T0);
  check('missing: once installed (not offered) it clears', v.verdict === 'ok');
  check('missing: a stale scan (over 36 h) is skip', m.evaluateMissingUpdates(r, 'PC-1', posture({ scannedAt: at(-37 * 60).toISOString(), updates: [upd(1, SEC)] }), seen, T0).verdict === 'skip');
  check('missing: a failed scan is skip', m.evaluateMissingUpdates(r, 'PC-1', posture({ error: 'WU down', updates: [upd(1, SEC)] }), seen, T0).verdict === 'skip');
  check('missing: no signed scan (a standard agent) is skip', m.evaluateMissingUpdates(r, 'PC-1', null, seen, T0).verdict === 'skip' && m.evaluateMissingUpdates(r, 'PC-1', { schema: 'x' }, seen, T0).verdict === 'skip');
  check('missing: a first-seen date in the future is reset to now', m.evaluateMissingUpdates(r, 'PC-1', scan, { [gid(1)]: days(5).toISOString() }, T0).seen[gid(1)] === T0.toISOString());
}

// ── UPDATE_FAILED ───────────────────────────────────────────────────────────
{
  const r = rule('failed', 'UPDATE_FAILED', { days: 7 });
  const h = (n, result, d, o = {}) => ({ updateId: gid(n), revision: 1, kb: `KB50${String(n).padStart(5, '0')}`, title: `Update ${n}`, result, operation: 'install', date: days(d).toISOString(), ...o });
  let v = m.evaluateFailedUpdates(r, 'PC-1', posture({ history: [h(1, 'failed', -2, { hresult: '0x80070005' })] }), [], T0);
  check('failed: a failed install in Windows Update history 2 days ago breaches', v.verdict === 'breach' && v.detail.count === 1 && v.detail.failures[0].source === 'windows_update' && v.detail.failures[0].hresult === '0x80070005' && v.detail.failures[0].kb === 'KB5000001', J(v));
  v = m.evaluateFailedUpdates(r, 'PC-1', posture({ history: [h(1, 'failed', -9)] }), [], T0);
  check('failed: one older than the window does not count (that is how it clears)', v.verdict === 'ok' && v.clear);
  v = m.evaluateFailedUpdates(r, 'PC-1', posture({ history: [h(1, 'failed', -3), h(1, 'succeeded', -1)] }), [], T0);
  check('failed: a later successful install of the same update forgets it', v.verdict === 'ok');
  v = m.evaluateFailedUpdates(r, 'PC-1', posture({ history: [h(1, 'succeeded', -4), h(1, 'failed', -1)] }), [], T0);
  check('failed: a failure after an earlier success counts', v.verdict === 'breach');
  check('failed: an uninstall that failed is not an install failure', m.evaluateFailedUpdates(r, 'PC-1', posture({ history: [h(1, 'failed', -1, { operation: 'uninstall' })] }), [], T0).verdict === 'ok');
  const dep = (d, updates) => ({ resultAt: days(d), result: { outcome: 'failed', updates } });
  v = m.evaluateFailedUpdates(r, 'PC-1', null, [dep(-1, [{ updateId: gid(5), revision: 1, state: 'failed', hresult: '0x8024402C' }, { updateId: gid(6), revision: 1, state: 'installed' }])], T0);
  check('failed: a Rem0te deployment result that failed breaches, without a scan', v.verdict === 'breach' && v.detail.count === 1 && v.detail.failures[0].source === 'deployment' && v.detail.failures[0].hresult === '0x8024402C', J(v));
  v = m.evaluateFailedUpdates(r, 'PC-1', null, [dep(-2, [{ updateId: gid(5), state: 'failed' }]), dep(-1, [{ updateId: gid(5), state: 'installed' }])], T0);
  check('failed: a later deployment that installed it forgets the failure', v.verdict === 'ok');
  v = m.evaluateFailedUpdates(r, 'PC-1', null, [dep(-1, [{ updateId: gid(5), state: 'failed', hresult: '$(rm -rf /)' }])], T0);
  check('failed: an hresult outside its charset is dropped', v.verdict === 'breach' && v.detail.failures[0].hresult === null);
  check('failed: no scan and no deployment result is skip', m.evaluateFailedUpdates(r, 'PC-1', null, [], T0).verdict === 'skip');
  const lots = Array.from({ length: 30 }, (_, i) => h(100 + i, 'failed', -1));
  check('failed: the detail lists at most ten', m.evaluateFailedUpdates(r, 'PC-1', posture({ history: lots }), [], T0).detail.failures.length === 10);
}

// ── Automatic tickets: the rule ─────────────────────────────────────────────
{
  const g = { scopeKey: 'global', enabled: true, minSeverity: 'WARNING', kinds: [], enabledAt: days(-1) };
  const b = { scopeKey: 'b:biz1', enabled: false, minSeverity: 'CRITICAL', kinds: [], enabledAt: null };
  check('ticket rule: a business\'s own row replaces the global one, even switched off', m.ticketPolicyFor([g, b], 'biz1') === b && m.ticketPolicyFor([g, b], 'biz2') === g && m.ticketPolicyFor([g], null) === g && m.ticketPolicyFor([], 'biz1') === null);
  const A = (o = {}) => ({ kind: 'DRIVE_FREE', severity: 'CRITICAL', state: 'OPEN', firstSeenAt: at(-30), notifyFrom: at(-30), parentOpen: false, customerId: 'biz2', siteId: 's1', endpointId: 'ep1', ruleKey: 'drives', ...o });
  const why = (a, p = g, sups = []) => { const d = m.autoTicketDecision(a, p, sups, T0); return d.ok ? 'ok' : d.reason; };
  check('ticket rule: an open critical alert after the rule was switched on is ticketed', why(A()) === 'ok');
  check('ticket rule: an acknowledged one too (it is still open)', why(A({ state: 'ACKNOWLEDGED' })) === 'ok');
  check('ticket rule: no rule, or switched off', why(A(), null) === 'no_rule' && why(A(), b) === 'off' && why(A(), { ...g, enabledAt: null }) === 'off');
  check('ticket rule: a resolved alert never', why(A({ state: 'RESOLVED' })) === 'resolved');
  check('ticket rule: a site outage (no computer) never', why(A({ kind: 'SITE_OUTAGE', endpointId: null })) === 'no_computer');
  check('ticket rule: the backlog (first seen before it was switched on) never', why(A({ firstSeenAt: days(-2) })) === 'before_rule');
  check('ticket rule: below the severity floor', why(A({ severity: 'INFO' })) === 'severity' && why(A({ severity: 'WARNING' })) === 'ok');
  check('ticket rule: kinds narrows it', why(A(), { ...g, kinds: ['OFFLINE'] }) === 'kind' && why(A({ kind: 'OFFLINE' }), { ...g, kinds: ['OFFLINE'] }) === 'ok');
  check('ticket rule: only after the notify hold (OFFLINE\'s correlation hold, a window\'s end)', why(A({ notifyFrom: at(2) })) === 'held');
  check('ticket rule: not while an open site outage gathers it', why(A({ parentOpen: true })) === 'in_outage');
  const sup = (o = {}) => ({ id: 'w1', scopeKey: 'b:biz2', ruleKeys: [], startsAt: at(-60), endsAt: at(60), revokedAt: null, ...o });
  check('ticket rule: never in a maintenance window', why(A(), g, [sup()]) === 'maintenance');
  check('ticket rule: a window for another monitor or business, or over, does not stop it',
    why(A(), g, [sup({ ruleKeys: ['offline'] })]) === 'ok' && why(A(), g, [sup({ scopeKey: 'b:other' })]) === 'ok' && why(A(), g, [sup({ endsAt: at(-1) })]) === 'ok' && why(A(), g, [sup({ revokedAt: at(-5) })]) === 'ok');
  check('ticket rule: a computer\'s own window stops it', why(A(), g, [sup({ scopeKey: 'e:ep1' })]) === 'maintenance');

  const s = m.TicketPolicyInput.safeParse({ scope: 'business', businessId: 'biz1234567', enabled: true, minSeverity: 'WARNING', kinds: ['DRIVE_FREE'] });
  check('ticket rule input: accepts a business rule with kinds', s.success);
  check('ticket rule input: is strict, closed kinds, closed severity',
    !m.TicketPolicyInput.safeParse({ scope: 'global', enabled: true, url: 'https://x' }).success
      && !m.TicketPolicyInput.safeParse({ scope: 'global', enabled: true, kinds: ['SITE_OUTAGE'] }).success
      && !m.TicketPolicyInput.safeParse({ scope: 'global', enabled: true, minSeverity: 'LOW' }).success
      && !m.TicketPolicyInput.safeParse({ scope: 'site', enabled: true }).success);
  check('ticket rule input: defaults to CRITICAL and every kind', (() => { const d = m.TicketPolicyInput.parse({ scope: 'global', enabled: true }); return d.minSeverity === 'CRITICAL' && d.kinds.length === 0; })());
}

// ── Automatic tickets: retries ──────────────────────────────────────────────
{
  check('retries: four sends at most', m.AUTO_TICKET.maxAttempts === 4);
  check('retries: 5, 30, then 120 minutes', m.autoTicketRetryAt(1, T0)?.getTime() === at(5).getTime() && m.autoTicketRetryAt(2, T0)?.getTime() === at(30).getTime() && m.autoTicketRetryAt(3, T0)?.getTime() === at(120).getTime());
  check('retries: none after the fourth', m.autoTicketRetryAt(4, T0) === null && m.autoTicketRetryAt(9, T0) === null);
  check('retries: an interrupted send is not resent (15 min, then given up)', m.AUTO_TICKET.stuckMs === 15 * 60_000);
  const mig = readFileSync(join(here, '..', 'prisma', 'migrations', '0076_alert_conditions', 'migration.sql'), 'utf8');
  check('the database caps attempts at the same four and holds one row per alert', /CHECK \("attempts" BETWEEN 1 AND 4\)/.test(mig) && /CREATE UNIQUE INDEX "MonitorAlertTicket_alertId_key" ON "MonitorAlertTicket"\("alertId"\)/.test(mig));
  check('the per-business hourly budget defaults to 10', m.AUTO_TICKET.perBusinessPerHour === 10);
}

// ── Automatic tickets: what is sent ─────────────────────────────────────────
{
  const d = TK.buildDraft({
    endpoint: { id: 'ep1', name: 'PC-1', tenantId: 't', customerId: 'b', osVersion: null }, businessName: 'Acme', sourceRef: 'alert:al1',
    alert: { id: 'al1', kind: 'DRIVE_FREE', ruleKey: 'drives', severity: 'CRITICAL', title: 'PC-1: drive D: 4.0% free', detail: { secret: 'S3CR3T-DETAIL' }, firstSeenAt: T0.toISOString() },
  }, { link: 'https://rmm.example.test/alerts?alert=al1', requestedBy: TK.AUTO_REQUESTER, ai: null });
  check('draft: the subject is the manual alert subject', d.subject === '[Rem0te] PC-1 — alert: PC-1: drive D: 4.0% free (critical)', d.subject);
  check('draft: requested by "Rem0te monitoring (automatic)", no note, no AI', d.requestedBy === 'Rem0te monitoring (automatic)' && d.note === null && d.ai === null && !/Note:|AI explanation/.test(d.body));
  check('draft: the alert detail is never sent (the same as a manual alert ticket)', !JSON.stringify(d).includes('S3CR3T-DETAIL'));
  const body = JSON.parse(WH.webhookBody(d, T0));
  check('draft: the webhook carries the alert id, kind, severity, title and source_ref', body.ticket.alert.id === 'al1' && body.ticket.alert.kind === 'DRIVE_FREE' && body.ticket.source_ref === 'alert:al1' && body.ticket.event === null);
}

// ── Confirm it is you ───────────────────────────────────────────────────────
{
  const f = C.CONFIRM_CATALOG.find((x) => x.key === 'monitoring.autoticket');
  check('confirm: monitoring.autoticket is in the catalog, under Monitoring & notifications, off by default (0.64), like every function', !!f && f.group === 'Monitoring & notifications' && f.default === 'off');
  check('confirm: it is configurable, not always-ask', !C.ALWAYS_ASK.some((x) => x.key === 'monitoring.autoticket'));
}

console.log(`unit-alert-conditions: ${passed} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1); }
