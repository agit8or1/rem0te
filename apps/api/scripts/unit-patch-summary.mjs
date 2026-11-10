#!/usr/bin/env node
/**
 * The Patches tab's summary and the redacted ticket summary (0.30), against
 * the five reporting cases plus the standard agent and no evidence at all.
 * Pure: no database, no API. Needs a built dist (`npx nest build`).
 *
 *   node scripts/unit-patch-summary.mjs
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const { buildPatchSummary, redactedPatchSummary, STALE_AFTER_MS } = require(path.join(dist, 'patching/summary.js'));
const { PatchSummary } = require(path.join(dist, 'integration/contract.js'));

let pass = 0, fail = 0; const failures = [];
const check = (c, m, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${m}`); } else { fail++; failures.push(m); console.log(`  \x1b[31m✗\x1b[0m ${m}${d ? `\n      ${d}` : ''}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

const NOW = new Date('2026-11-10T12:00:00Z');
const h = (n) => new Date(NOW.getTime() - n * 3600_000);
const CU = { updateId: '11111111-2222-3333-4444-555555555555', revision: 200, kb: 'KB5044284', title: '2026-10 Cumulative Update for Windows 11 (KB5044284)', classification: '0fa1201d-4330-4fa8-8ae9-b877473b6441', severity: 'Critical', downloaded: true, rebootBehavior: 1, userInput: false, eulaAccepted: true, browseOnly: false, sizeBytes: 1 };
const NET = { ...CU, updateId: '66666666-2222-3333-4444-555555555555', kb: 'KB5044033', title: '.NET Framework update (KB5044033)', severity: 'Important' };
const posture = (o = {}) => ({ schema: 'rem0te-patch-posture/1', scannedAt: h(1).toISOString(), updates: [CU, NET], history: [], reboot: { pending: false, sources: [] }, managers: [], autoUpdate: 'enabled', ...o });
const base = (o = {}) => ({ now: NOW, posture: null, postureScannedAt: null, basic: null, lastBootAt: h(48), isOnline: true, lastSeenAt: h(0), signedCapable: true, outcomes: [], ...o });
const out = (state, o = {}) => ({ updateId: CU.updateId, revision: CU.revision, kb: CU.kb, title: CU.title, state, detail: null, resultAt: h(5), ...o });
const valid = (s) => { const r = PatchSummary.safeParse(redactedPatchSummary(s)); return r.success ? true : JSON.stringify(r.error.issues); };
const noTitles = (s) => !JSON.stringify(redactedPatchSummary(s)).includes('Cumulative') && !JSON.stringify(redactedPatchSummary(s)).includes('.NET');

section('Restart required');
{
  const p = posture({ updates: [NET], reboot: { pending: true, sources: ['windows_update'] }, history: [{ updateId: CU.updateId, revision: CU.revision, kb: CU.kb, title: CU.title, result: 'succeeded', operation: 'install', date: h(5).toISOString() }] });
  const s = buildPatchSummary(base({ posture: p, postureScannedAt: h(1), outcomes: [out('restart_required', { detail: 'installed; takes effect after a restart' })] }));
  check(s.rebootRequired === true && s.evidence.source === 'signed_agent_scan' && s.evidence.freshness === 'fresh', 'a pending restart is reported, from the signed scan, fresh');
  check(s.restartedSinceLastInstall === false && s.confirmations[0].state === 'restart_required' && !s.confirmations[0].confirmedByLaterScan, 'not restarted since the install: the KB is not confirmed');
  const r = redactedPatchSummary(s);
  check(r.reboot_required === true && r.awaiting_confirmation_kbs.includes('KB5044284') && r.confirmed_kbs.length === 0, 'the ticket is told: restart required, KB5044284 awaiting confirmation', JSON.stringify(r));
  check(valid(s) === true && noTitles(s), 'the ticket summary matches the contract and carries no update titles', String(valid(s)));
}

section('Restart completed, confirmed by a later scan');
{
  const p = posture({ updates: [NET], history: [{ updateId: CU.updateId, revision: CU.revision, kb: CU.kb, title: CU.title, result: 'succeeded', operation: 'install', date: h(5).toISOString() }] });
  const s = buildPatchSummary(base({ posture: p, postureScannedAt: h(1), lastBootAt: h(3), outcomes: [out('effective')] }));
  check(s.rebootRequired === false && s.restartedSinceLastInstall === true, 'restarted after the install; no restart pending');
  check(s.confirmations[0].confirmedByLaterScan === true && redactedPatchSummary(s).confirmed_kbs[0] === 'KB5044284', 'only `effective` counts as confirmed by a later scan, and the ticket says so');
  check(s.lastBootAt.getTime() === h(3).getTime(), 'last boot is shown');
}

section('Failed update');
{
  const s = buildPatchSummary(base({ posture: posture(), postureScannedAt: h(1), outcomes: [out('failed', { detail: 'download failed 0x80240022' })] }));
  check(s.confirmations[0].state === 'failed' && redactedPatchSummary(s).failed_kbs[0] === 'KB5044284', 'a failed install is reported as failed, by KB');
  check(!JSON.stringify(redactedPatchSummary(s)).includes('0x80240022'), 'the ticket gets the KB, not the error text');
  const again = buildPatchSummary(base({ posture: posture(), postureScannedAt: h(1), outcomes: [out('failed', { detail: 'a later scan offers it again: it did not stay installed' })] }));
  check(again.confirmations[0].confirmedByLaterScan === false, 'offered again by a later scan: not confirmed');
}

section('Offline, and stale evidence');
{
  const s = buildPatchSummary(base({ posture: posture({ scannedAt: h(80).toISOString() }), postureScannedAt: h(80), isOnline: false, lastSeenAt: h(79) }));
  check(s.evidence.freshness === 'stale' && s.evidence.ageHours === 80, 'an 80-hour-old scan is stale, with its age', JSON.stringify(s.evidence));
  check(s.warnings.some((w) => /80 hours old, and the computer is offline/.test(w)), 'the warning names the age and that the computer is offline', JSON.stringify(s.warnings));
  check(s.deploy.possible === false && /stale/.test(s.deploy.reason), 'no deployment is offered from stale evidence');
  check(redactedPatchSummary(s).freshness === 'stale', 'the ticket is told the evidence is stale');
  const offFresh = buildPatchSummary(base({ posture: posture(), postureScannedAt: h(1), isOnline: false, lastSeenAt: h(1) }));
  check(offFresh.evidence.freshness === 'fresh' && offFresh.warnings.some((w) => /offline/.test(w)), 'offline with a fresh scan: fresh, but flagged offline');
  check(STALE_AFTER_MS === 36 * 3600_000, 'stale means older than three missed 12-hour scans');
}

section('Externally managed: WSUS, Intune');
{
  const w = buildPatchSummary(base({ posture: posture({ managers: ['wsus'] }), postureScannedAt: h(1) }));
  check(w.managedBy.state === 'external' && w.managedBy.managers[0].label === 'WSUS' && /WSUS server/.test(w.managedBy.explanation), 'WSUS is named, with what it means');
  check(w.deploy.possible === false && /Managed by WSUS/.test(w.deploy.reason), 'and rem0te will not deploy there');
  const i = buildPatchSummary(base({ posture: posture({ managers: ['mdm_policy'] }), postureScannedAt: h(1) }));
  check(i.managedBy.managers[0].label === 'MDM (Intune) update policy' && /Intune/.test(i.managedBy.explanation), 'Intune is named, with what it means');
  check(redactedPatchSummary(i).managed_by === 'external' && redactedPatchSummary(i).managers[0] === 'MDM (Intune) update policy' && valid(i) === true, 'the ticket is told who manages it');
}

section('Standard agent: read-only, manager unknown');
{
  const s = buildPatchSummary(base({ signedCapable: false, basic: { checkedAt: h(2), rebootRequired: true, updates: [{ title: CU.title, kb: CU.kb, severity: 'Critical' }, { title: 'Defender', kb: null, severity: null }] } }));
  check(s.evidence.source === 'standard_agent_scan' && s.evidence.freshness === 'fresh' && s.pendingCount === 2 && s.relevantKbs[0] === 'KB5044284', 'the standard scan is the evidence; KBs listed');
  check(s.managedBy.state === 'unknown' && /does not read update policy/.test(s.managedBy.explanation), 'who manages patching is unknown, and says why — never "nobody"');
  check(s.deploy.possible === false && /signed agent/.test(s.deploy.reason), 'deploying needs the signed agent');
  check(redactedPatchSummary(s).managed_by === 'unknown' && redactedPatchSummary(s).evidence_source === 'standard_agent_scan' && valid(s) === true, 'the ticket is told: standard agent, manager unknown');
}

section('No evidence');
{
  const s = buildPatchSummary(base({ signedCapable: false }));
  check(s.evidence.source === 'none' && s.evidence.freshness === 'none' && s.rebootRequired === null && s.warnings[0] === 'No update scan has been received from this computer.', 'nothing received: none, unknown restart state, and a warning');
  check(redactedPatchSummary(s).reboot_required === null && valid(s) === true, 'the ticket gets null, not false');
}

section('A signed scan that failed');
{
  const s = buildPatchSummary(base({ posture: posture({ error: 'Windows Update service is disabled', updates: [] }), postureScannedAt: h(1) }));
  check(s.evidence.lastSuccessfulScanAt === null && s.warnings.some((w) => /failed/.test(w)), 'a failed scan is evidence of the computer, not a successful scan');
}

console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
if (fail) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
