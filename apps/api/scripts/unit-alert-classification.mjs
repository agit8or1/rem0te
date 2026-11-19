#!/usr/bin/env node
// Tests for alert classification and event fingerprints (0.66), run against dist:
//
//   node apps/api/scripts/unit-alert-classification.mjs
//
// Pure functions only: src/monitoring/classify.ts and explain.ts, and the
// parts of engine.ts they meet (the recommended disk-errors monitor, the
// report sanitiser). The event samples are realistic: the DS-HOME1 sample is
// the exact text the agent sent on 2026-11-18 (a computer name, no customer
// data); the others are the messages Windows writes for those events.

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const c = require(join(here, '..', 'dist', 'monitoring', 'classify.js'));
const x = require(join(here, '..', 'dist', 'monitoring', 'explain.js'));
const m = require(join(here, '..', 'dist', 'monitoring', 'engine.js'));

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => { if (ok) passed++; else failures.push(`${name}${detail ? ` — ${detail}` : ''}`); };
const J = JSON.stringify;

// The exact DS-HOME1 sample.
const TXR = (n, hive = 'DRIVERS') => `TxR init phase for hive \\??\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy${n}\\Windows\\System32\\config\\${hive} (TM: {00000000-0000-4000-8000-0000000000a5}, RM: {00000000-0000-4000-8000-0000000000a4}) finished with result=0xC00000A2 (Internal code=7).`;
const DS_HOME1 = { eventId: 11, level: 4, provider: 'Microsoft-Windows-Kernel-General', message: TXR(59) };
const ev = (provider, eventId, level, message = '') => ({ provider, eventId, level, message });
const DISK7 = ev('disk', 7, 2, 'The device, \\Device\\Harddisk0\\DR0, has a bad block.');
const DISK11 = ev('disk', 11, 2, 'The driver detected a controller error on \\Device\\Harddisk1\\DR1.');
const DISK51 = ev('disk', 51, 3, 'An error was detected on device \\Device\\Harddisk0\\DR0 during a paging operation.');
const DISK52 = ev('disk', 52, 3, 'The driver has detected that device \\Device\\Harddisk0\\DR0 has predicted that it will fail. Immediately back up your data and replace your hard disk drive. A failure may be imminent.');
const DISK153 = ev('disk', 153, 3, 'The IO operation at logical block address 0x1a2b3c for Disk 0 (PDO name: \\Device\\00000032) was retried.');
const NTFS55 = ev('Microsoft-Windows-Ntfs', 55, 2, 'A corruption was discovered in the file system structure on volume C:.');

const OLD = { severity: 'CRITICAL', params: { log: 'System', ids: [7, 11, 51, 153], levels: [], threshold: 1, clearAfterMinutes: 1440 } };
const NEW = { severity: 'CRITICAL', params: m.DISK_ERRORS_PARAMS };
const cls = (rule, samples, count = samples.length) => c.classifyEvents(rule, { count, samples });

// ── The DS-HOME1 pattern ────────────────────────────────────────────────────
{
  const r = cls(OLD, [DS_HOME1]);
  check('DS-HOME1: the exact event is BENIGN, with nothing to raise', r.class === 'BENIGN' && r.severity === null && r.basis === 'known_benign' && r.matched === 'kernel-general-11-txr-shadow-copy', J(r));
  check('DS-HOME1: it is taken out of the count the threshold sees', r.effectiveCount === 0 && r.benign === 1, J(r));
  const f = c.eventFacts('System', DS_HOME1);
  check('DS-HOME1: structured facts — provider, id, level, status code, component', f.providerKey === 'microsoft-windows-kernel-general' && f.eventId === 11 && f.level === 4 && f.statusCode === '0xC00000A2' && f.component === 'volume-shadow-copy', J(f));
  const r2 = cls(OLD, [{ ...DS_HOME1, message: TXR(60) }]);
  check('another shadow-copy number is the same pattern', r2.class === 'BENIGN' && r2.severity === null, J(r2));
  check('…and the same fingerprint', c.fingerprintOf('System', DS_HOME1) === c.fingerprintOf('System', { ...DS_HOME1, message: TXR(4127) }));
  check('a shadow copy of three digits too', cls(OLD, [{ ...DS_HOME1, message: TXR(123) }]).severity === null);
  const two = cls(OLD, [DS_HOME1, { ...DS_HOME1, message: TXR(59, 'SYSTEM') }], 2);
  check('two harmless events, both sent (a 0.66 agent): nothing to raise', two.class === 'BENIGN' && two.severity === null && two.effectiveCount === 0, J(two));
  const partial = cls(OLD, [DS_HOME1], 2);
  check('DS-HOME1 as it was reported (count 2, one sample): not critical, not hidden — WARNING, partly seen', partial.severity === 'WARNING' && partial.class === 'UNKNOWN' && partial.basis === 'partial' && partial.unseen === 1 && partial.matched === 'kernel-general-11-txr-shadow-copy', J(partial));
  check('the unseen floor never goes above the monitor', cls({ ...OLD, severity: 'INFO' }, [DS_HOME1], 2).severity === 'INFO');
}

// ── Each condition of the pattern is required ───────────────────────────────
{
  check('the same event at Error level is not benign (Kernel-General is not catalogued: the monitor\'s severity stands)', cls(OLD, [{ ...DS_HOME1, level: 2 }]).severity === 'CRITICAL');
  check('another status code is not benign', cls(OLD, [{ ...DS_HOME1, message: TXR(59).replace('0xC00000A2', '0xC000009A') }]).class !== 'BENIGN');
  check('no status code is not benign', cls(OLD, [{ ...DS_HOME1, message: TXR(59).replace('result=0xC00000A2 ', '') }]).class !== 'BENIGN');
  check('an ordinary volume (not a shadow copy) is not benign', cls(OLD, [{ ...DS_HOME1, message: TXR(59).replace('HarddiskVolumeShadowCopy59', 'HarddiskVolume3') }]).class !== 'BENIGN');
  check('another provider with the same id, level and text is not benign', cls(OLD, [{ ...DS_HOME1, provider: 'Microsoft-Windows-Kernel-Boot' }]).class !== 'BENIGN');
  check('the Application log is not the System log', cls({ severity: 'CRITICAL', params: { log: 'Application', ids: [11], levels: [] } }, [DS_HOME1]).class !== 'BENIGN');
  check('another event id is not benign', cls(OLD, [{ ...DS_HOME1, eventId: 12 }]).class !== 'BENIGN');
  check('a message merely mentioning "shadow copy" and TxR in words is not enough (structure, not words)', cls(OLD, [{ ...DS_HOME1, message: 'TxR shadow copy write protected 0xC00000A2' }]).class !== 'BENIGN');
  for (const p of c.KNOWN_BENIGN) {
    check(`benign pattern ${p.id} names every structured field`, typeof p.log === 'string' && p.log && typeof p.provider === 'string' && p.provider && Number.isInteger(p.eventId) && Array.isArray(p.levels) && p.levels.length > 0 && /^0x[0-9A-F]{8}$/.test(p.statusCode) && c.COMPONENTS.includes(p.component) && !p.levels.some((l) => l < 4), J(p));
  }
}

// ── Event ID 11 is not suppressed: genuine storage failures still alert ─────
{
  check('disk 11 (controller error) is CRITICAL', cls(NEW, [DISK11]).severity === 'CRITICAL' && cls(NEW, [DISK11]).matched === 'disk-11-controller-error');
  for (const p of ['atapi', 'iaStorA', 'iaStorAC', 'storahci', 'LSI_SAS2', 'megasas', 'stornvme']) {
    const r = cls(NEW, [ev(p, 11, 2, `The driver detected a controller error on \\Device\\Ide\\IdePort0.`)]);
    check(`${p} 11 (a controller driver's own event 11) is CRITICAL`, r.severity === 'CRITICAL' && r.matched === 'controller-11-error', J(r));
  }
  check('disk 7 (bad block) is CRITICAL', cls(NEW, [DISK7]).severity === 'CRITICAL' && cls(NEW, [DISK7]).class === 'CRITICAL');
  check('disk 51 (paging error) is WARNING', cls(NEW, [DISK51]).severity === 'WARNING');
  check('disk 52 (SMART predicted failure) is CRITICAL', cls(NEW, [DISK52]).severity === 'CRITICAL' && cls(NEW, [DISK52]).matched === 'disk-52-smart-predicted-failure');
  check('NTFS 55 (file system corruption) is CRITICAL, either provider name', cls(NEW, [NTFS55]).severity === 'CRITICAL' && cls(NEW, [{ ...NTFS55, provider: 'Ntfs' }]).severity === 'CRITICAL');
  check('disk 153 once (I/O retried) is WARNING', cls(NEW, [DISK153]).severity === 'WARNING');
  const many = cls(NEW, [DISK153], 6);
  check('disk 153 six times in one report is CRITICAL (recurrence)', many.severity === 'CRITICAL' && many.class === 'CRITICAL' && many.reasons.some((r) => r.startsWith('recurring:')), J(many));
  check('…never above the monitor: under a WARNING monitor it stays WARNING', cls({ ...NEW, severity: 'WARNING' }, [DISK153], 6).severity === 'WARNING');
  check('a catalogued CRITICAL event under an INFO monitor is INFO (the monitor is the ceiling)', cls({ ...NEW, severity: 'INFO' }, [DISK7]).severity === 'INFO');
  const mixed = cls(NEW, [DS_HOME1, DISK7], 2);
  check('a harmless event cannot hide a disk error sent with it', mixed.severity === 'CRITICAL' && mixed.matched === 'disk-7-bad-block' && mixed.effectiveCount === 1, J(mixed));
  const unknownErr = cls(NEW, [ev('Microsoft-Windows-Kernel-Boot', 11, 2, 'something')]);
  check('an unknown provider at Error keeps the monitor\'s severity (unverified, never lowered)', unknownErr.severity === 'CRITICAL' && unknownErr.class === 'UNKNOWN' && unknownErr.basis === 'rule');
}

// ── Informational events that mention disks ─────────────────────────────────
{
  const healthy = ev('Microsoft-Windows-Ntfs', 98, 4, 'Volume C: (\\Device\\HarddiskVolume3) is healthy.  No action is needed.');
  const r = cls(OLD, [healthy]);
  check('an Information event naming a disk is INFORMATIONAL, not critical', r.severity === 'INFO' && r.class === 'INFORMATIONAL' && r.basis === 'level', J(r));
  check('a Verbose one too', cls(OLD, [{ ...healthy, level: 5 }]).severity === 'INFO');
  check('a monitor that asked for Information keeps its severity', cls({ severity: 'CRITICAL', params: { log: 'System', ids: [98], levels: [4] } }, [healthy]).severity === 'CRITICAL');
  check('the corrected monitor never asks for level 4 or 5', !m.DISK_ERRORS_PARAMS.levels.includes(4) && !m.DISK_ERRORS_PARAMS.levels.includes(5) && m.DISK_ERRORS_PARAMS.levels.length > 0);
}

// ── Backup failures and security alerts: never lowered by the classifier ────
{
  const backup = { severity: 'CRITICAL', params: { log: 'Application', ids: [190], levels: [], provider: 'Veeam MP' } };
  const r = cls(backup, [ev('Veeam MP', 190, 2, 'Backup job "Nightly" finished with Failed.')]);
  check('a backup failure monitor (Application log) keeps its severity', r.severity === 'CRITICAL' && r.class === 'UNKNOWN', J(r));
  check('a backup "warning" at Information level under a monitor that named no level is INFORMATIONAL (said so, not hidden)', cls(backup, [ev('Veeam MP', 190, 4, 'Backup job finished with warning.')]).severity === 'INFO');
  const sec = { severity: 'CRITICAL', params: { log: 'Security', ids: [4625], levels: [] } };
  check('a Security-log audit event (level 0) keeps its severity', cls(sec, [ev('Microsoft-Windows-Security-Auditing', 4625, 0, 'An account failed to log on.')]).severity === 'CRITICAL');
  check('the Security log is never lowered by level, even at level 4', cls(sec, [ev('Microsoft-Windows-Security-Auditing', 4625, 4, 'An account failed to log on.')]).severity === 'CRITICAL');
  check('level 0 (LogAlways) is not a quiet level', !c.QUIET_LEVELS.has(0) && c.QUIET_LEVELS.has(4) && c.QUIET_LEVELS.has(5));
}

// ── Fingerprints ────────────────────────────────────────────────────────────
{
  const fp = (s, log = 'System') => c.fingerprintOf(log, s);
  check('a fingerprint is 32 hex characters', c.FINGERPRINT_RE.test(fp(DISK7)));
  check('timestamps do not split a fingerprint', fp(ev('X', 1, 2, 'Failed at 2026-11-18T22:27:13.431Z')) === fp(ev('X', 1, 2, 'Failed at 2026-11-19T01:02:03Z')));
  check('process ids do not split a fingerprint', fp(ev('X', 1, 2, 'process id 4321 stopped')) === fp(ev('X', 1, 2, 'process id 88 stopped')));
  check('temporary paths do not split a fingerprint', fp(ev('X', 1, 2, 'cannot open C:\\Users\\alice\\AppData\\Local\\Temp\\a1b2.tmp now')) === fp(ev('X', 1, 2, 'cannot open C:\\Users\\bob\\AppData\\Local\\Temp\\zz9.tmp now')));
  check('GUIDs do not split a fingerprint', fp(ev('X', 1, 2, 'TM {00000000-0000-4000-8000-0000000000a5}')) === fp(ev('X', 1, 2, 'TM {00000000-0000-0000-0000-000000000000}')));
  check('block addresses do not split a fingerprint', fp(DISK153) === fp({ ...DISK153, message: DISK153.message.replace('0x1a2b3c', '0x99ff00aa11') }));
  check('the status code is kept', fp(DS_HOME1) !== fp({ ...DS_HOME1, message: TXR(59).replace('0xC00000A2', '0xC0000001') }));
  check('the provider is kept', fp(DISK11) !== fp({ ...DISK11, provider: 'atapi' }));
  check('the event id is kept', fp(DISK7) !== fp({ ...DISK7, eventId: 8 }));
  check('the level is kept', fp(DISK7) !== fp({ ...DISK7, level: 3 }));
  check('the log is kept', fp(DISK7) !== fp(DISK7, 'Application'));
  check('the disk number is kept (a different disk is a different problem)', fp(DISK7) !== fp({ ...DISK7, message: DISK7.message.replace('Harddisk0\\DR0', 'Harddisk1\\DR1') }));
  check('an internal code is kept', fp(DS_HOME1) !== fp({ ...DS_HOME1, message: TXR(59).replace('Internal code=7', 'Internal code=9') }));
  check('normalising keeps an 8-digit status code', c.normaliseMessage(TXR(59)).includes('0xc00000a2') && c.normaliseMessage(TXR(59)).includes('harddiskvolumeshadowcopy#'));
  check('duplicate events (same fingerprint) are one decision each, recorded once', new Set(cls(NEW, [DISK7, { ...DISK7 }], 2).samples.map((d) => d.fingerprint)).size === 1);
}

// ── Threshold monitors, and versions ────────────────────────────────────────
{
  const t = c.classifyThreshold('WARNING');
  check('a threshold monitor\'s class follows its severity', t.class === 'WARNING' && t.severity === 'WARNING' && t.basis === 'threshold' && c.classifyThreshold('INFO').class === 'INFORMATIONAL');
  check('the classifier is versioned', Number.isInteger(c.CLASSIFIER_VERSION) && c.CLASSIFIER_VERSION >= 1 && cls(NEW, [DISK7]).v === c.CLASSIFIER_VERSION);
  check('no events: nothing to raise', cls(NEW, [], 0).severity === null);
  check('events but no sample (an agent that sent none): the monitor\'s severity', cls(NEW, [], 3).severity === 'CRITICAL');
  check('samplesOf: a 0.66 report\'s samples, else the one sample', c.samplesOf({ samples: [DISK7, DISK11] }).length === 2 && c.samplesOf({ sample: DISK7 }).length === 1 && c.samplesOf(null).length === 0);
}

// ── The recommended monitor and the report sanitiser ────────────────────────
{
  const rec = m.RECOMMENDED.find((r) => r.key === 'disk-errors');
  check('recommended disk-errors: levels Critical, Error, Warning; no provider (every controller driver logs its own 11)', J(rec.params.levels) === '[1,2,3]' && !('provider' in rec.params) && rec.severity === 'CRITICAL', J(rec));
  check('recommended disk-errors: still 7, 11, 51, 153, plus 52 (SMART) and 55 (NTFS)', [7, 11, 51, 52, 55, 153].every((i) => rec.params.ids.includes(i)));
  check('recommended disk-errors: valid parameters', m.parseParams('EVENT_MATCH', rec.params).ok);
  check('the pre-0.66 parameters are recorded exactly as stored', J(m.DISK_ERRORS_PRE066_PARAMS) === J(OLD.params));
  const asked = { services: [], eventKeys: ['disk-errors'] };
  const now = '2026-11-18T22:29:00Z';
  const r = m.sanitizeReport({ events: [{ key: 'disk-errors', checkedAt: now, count: 7, newestAt: now, sample: DS_HOME1, samples: [...Array(8)].map((_, i) => ({ ...DS_HOME1, message: TXR(50 + i), at: now })) }] }, asked);
  check('sanitiser: at most five samples are kept, each with its time', r.events[0].samples.length === 5 && r.events[0].samples.every((s) => s.at === new Date(now).toISOString()), J(r.events[0].samples.length));
  const old = m.sanitizeReport({ events: [{ key: 'disk-errors', checkedAt: now, count: 2, newestAt: now, sample: DS_HOME1 }] }, asked);
  check('sanitiser: an older agent\'s one sample becomes samples [sample]', old.events[0].samples.length === 1 && old.events[0].samples[0].eventId === 11);
  const none = m.sanitizeReport({ events: [{ key: 'disk-errors', checkedAt: now, count: 0, samples: [DISK7] }] }, asked);
  check('sanitiser: no samples for a count of 0', none.events[0].samples.length === 0);
  const fewer = m.sanitizeReport({ events: [{ key: 'disk-errors', checkedAt: now, count: 1, samples: [DISK7, DISK11] }] }, asked);
  check('sanitiser: never more samples than the count', fewer.events[0].samples.length === 1);
  const rule = { id: 'r1', scopeKey: 'global', key: 'disk-errors', kind: 'EVENT_MATCH', enabled: true, severity: 'CRITICAL', name: 'Disk errors', params: NEW.params };
  const v = m.evaluateEvents(rule, old.events[0], 'DS-HOME1', m.EMPTY_STATE, new Date(now), 0);
  check('evaluateEvents: a classified count of 0 does not breach', v.verdict === 'ok', J(v));
  const v2 = m.evaluateEvents(rule, old.events[0], 'DS-HOME1', m.EMPTY_STATE, new Date(now), 1);
  check('evaluateEvents: the classified count is in the title, the raw count in the detail', v2.verdict === 'breach' && v2.title.includes('1 matching event') && v2.detail.count === 2 && v2.detail.counted === 1, J(v2));
}

// ── The explanation ─────────────────────────────────────────────────────────
{
  const base = { kind: 'EVENT_MATCH', ruleKey: 'disk-errors', title: 'DS-HOME1: 2 matching events in System', rule: { name: 'Disk errors in the System log', severity: 'CRITICAL', params: OLD.params } };
  const partial = cls(OLD, [DS_HOME1], 2);
  const e = x.explainAlert({ ...base, severity: 'WARNING', detail: { log: 'System', count: 2, sample: DS_HOME1, newestAt: '2026-11-18T22:27:13.431Z' }, classification: partial });
  check('explanation: every section is there', ['whatHappened', 'whyGenerated', 'howSerious', 'recommendedAction', 'certainty'].every((k) => typeof e[k] === 'string' && e[k].length > 20), J(e));
  check('explanation (DS-HOME1): says what the event is', /shadow copy/i.test(e.whatHappened) && /0xC00000A2/.test(e.whatHappened), e.whatHappened);
  check('explanation (DS-HOME1): honest that one event was not seen', /cannot be ruled out/.test(e.howSerious) && /not sent by the agent/.test(e.whyGenerated) && e.classification.unseen === 1, `${e.howSerious} | ${e.whyGenerated}`);
  check('explanation (DS-HOME1): names the monitor and what it watches', /Disk errors in the System log/.test(e.whyGenerated) && /event IDs 7, 11, 51, 153/.test(e.whyGenerated) && /any provider/.test(e.whyGenerated));
  const one = x.explainAlert({ ...base, severity: 'CRITICAL', detail: { log: 'System', count: 1, sample: DISK7 }, classification: cls(NEW, [DISK7]) });
  check('explanation (one bad block): never claims the disk is failing from one event', /does not prove/.test(one.howSerious) && /Bad block|bad block/.test(one.whatHappened), one.howSerious);
  const unk = x.explainAlert({ ...base, severity: 'CRITICAL', detail: { log: 'System', count: 1, sample: ev('Foo', 11, 2, 'x') }, classification: cls(NEW, [ev('Foo', 11, 2, 'x')]) });
  check('explanation (an unknown event): says Rem0te does not know it', /Unknown/.test(unk.howSerious) && /Unverified/.test(unk.certainty), unk.howSerious);
  const old = x.explainAlert({ ...base, severity: 'CRITICAL', detail: { log: 'System', count: 1, sample: DISK7 }, classification: null });
  check('explanation: an alert raised before 0.66 (no classification) is still explained', typeof old.whatHappened === 'string' && old.classification.version === 0);
  const thr = x.explainAlert({ kind: 'DISK_FREE', ruleKey: 'disk-free', title: 'PC: system disk 4.0% free', severity: 'WARNING', detail: { freePercent: 4 }, classification: null, rule: { name: 'System disk nearly full', severity: 'WARNING', params: {} } });
  check('explanation: a threshold monitor', /4% free/.test(thr.whatHappened) && thr.classification.basis === 'threshold' && /threshold/.test(thr.certainty));
  const sm = x.explainAlert({ ...base, severity: 'CRITICAL', detail: { log: 'System', count: 1, sample: DISK52 }, classification: cls(NEW, [DISK52]) });
  check('explanation (SMART): the disk\'s own prediction', /predicts that it will fail/.test(sm.howSerious));
}

console.log(`unit-alert-classification: ${passed} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1); }
