#!/usr/bin/env node
// Patching, guided (0.94, UX P1-8): apps/web/lib/patch-lifecycle.ts.
//
//   node apps/web/scripts/unit-patch-lifecycle.mjs
//
// The module is pure, so it is transpiled with the workspace's TypeScript and
// run as it is. Covered: eleven stages with distinct labels and evidence;
// every per-update state the API returns has one label; every update manager
// the agent detects has a plain-English owner; a stage is "done" only from a
// fact and "not reported" where Rem0te cannot see it; templates fill in only
// what they may, never devices, reboots or restarts, and never submit.

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const WEB = join(here, '..');
const ROOT = join(WEB, '..', '..');
const API = join(ROOT, 'apps', 'api', 'src');
const require = createRequire(join(WEB, 'package.json'));
const ts = require('typescript');
const src = readFileSync(join(WEB, 'lib', 'patch-lifecycle.ts'), 'utf8');
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;
if (/\brequire\s*\(/.test(js)) throw new Error('lib/patch-lifecycle.ts imports a module: it must stay pure');
const mod = { exports: {} };
new Function('module', 'exports', js)(mod, mod.exports);
const L = mod.exports;

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => { if (ok) passed++; else failures.push(`${name}${detail ? ` — ${detail}` : ''}`); };
const read = (...p) => readFileSync(join(...p), 'utf8');

// The eleven stages (directive §14), in order.
const IDS = ['scan_requested', 'scan_completed', 'approved', 'downloaded', 'install_started', 'install_succeeded', 'restart_required', 'restart_completed', 'verified', 'failed', 'unknown'];
check('exactly the eleven stages, in order', JSON.stringify(L.PATCH_STAGES.map((s) => s.id)) === JSON.stringify(IDS));
check('eleven distinct labels', new Set(L.PATCH_STAGES.map((s) => s.label.toLowerCase())).size === 11);
check('each stage says what it means and what proves it', L.PATCH_STAGES.every((s) => s.means.length > 20 && s.evidence.length > 20 && /[.]$/.test(s.means) && /[.]$/.test(s.evidence)));
check('downloaded, started and restart completed say what Rem0te cannot see',
  /does not see downloads/.test(L.stageById('downloaded').evidence) && /does not report progress/.test(L.stageById('install_started').evidence) && /never sees the restart/.test(L.stageById('restart_completed').evidence));
check('verified needs a later scan, never a result alone', /later scan/.test(L.stageById('verified').means) && /never counts as verified/.test(L.stageById('verified').evidence));
check('unknown is never healthy', /never shown as healthy/.test(L.stageById('unknown').evidence));

// Per-update states: exactly the API's.
const posture = read(API, 'patching', 'posture.ts');
const union = posture.match(/export type UpdateState =([^;]+);/)[1].match(/'([a-z_]+)'/g).map((x) => x.slice(1, -1));
check('UPDATE_STATE names every per-update state the API returns, and no other', JSON.stringify([...union].sort()) === JSON.stringify(Object.keys(L.UPDATE_STATE).sort()), `api: ${union.join(',')}`);
check('per-update labels are distinct', new Set(Object.values(L.UPDATE_STATE).map((v) => v.label)).size === Object.keys(L.UPDATE_STATE).length);
check('per-update stages are real stage ids', Object.values(L.UPDATE_STATE).every((v) => v.stage === null || IDS.includes(v.stage)));
check('effective is "verified after install", and an unrecognised state is unknown', L.UPDATE_STATE.effective.stage === 'verified' && L.updateStateOf('nonsense').stage === 'unknown' && L.updateStateOf('nonsense').variant === 'destructive');
check('handed out is "installation started", never "installed"', L.UPDATE_STATE.delivered.stage === 'install_started' && !/installed|succeeded/i.test(L.UPDATE_STATE.delivered.label));

// Ownership.
const managers = posture.match(/export const MANAGERS = \[([^\]]+)\]/)[1].match(/'([a-z_]+)'/g).map((x) => x.slice(1, -1));
check('OWNERSHIP explains every manager the agent detects, and no other', JSON.stringify([...managers].sort()) === JSON.stringify(Object.keys(L.OWNERSHIP).sort()), managers.join(','));
check('every owner: what it is, that Rem0te never installs or overrides, where to change it',
  Object.values(L.OWNERSHIP).every((o) => o.whatItIs.length > 20 && /never installs updates here/.test(o.whatRem0teDoes) && o.whereToChange.length > 10));
check('WSUS, Intune and Windows Update for Business are named in plain English', /WSUS/.test(L.OWNERSHIP.wsus.title) && /Intune/.test(L.OWNERSHIP.mdm_policy.title) && /Windows Update for Business/.test(L.OWNERSHIP.wufb_policy.title));
const ext = L.ownershipSummary('external', [{ id: 'wsus', label: 'WSUS' }, { id: 'something_new', label: 'Something new' }]);
check('external: every manager listed, an unknown one still never patched', ext.owners.length === 2 && /never installs updates here/.test(ext.owners[1].whatRem0teDoes) && /no deployment, policy or template installs here/.test(ext.detail));
const unk = L.ownershipSummary('unknown', []);
check('unknown is never read as free to patch', /does not assume it is free to patch/.test(unk.detail) && !/able to deploy/.test(unk.headline));

// One device's lifecycle.
const base = { signed: true, scanRequestedAt: null, scanPending: false, scannedAt: null, scanError: null, offered: 0, downloaded: 0, installState: null, installed: 0, installFailed: 0, restartRequired: false, restartedSinceInstall: null, verified: 0, rebootPendingNow: null };
const at = (f) => Object.fromEntries(L.deviceLifecycle({ ...base, ...f }).map((r) => [r.stage.id, r.status]));
let s = at({});
check('nothing known: unknown is now and nothing is done', s.unknown === 'now' && !Object.values(s).includes('done'));
check('always eleven rows', L.deviceLifecycle(base).length === 11);
s = at({ signed: false, scannedAt: '2026-11-28T00:00:00Z' });
check('standard agent: every stage "not reported", unknown now', s.unknown === 'now' && IDS.filter((i) => i !== 'unknown').every((i) => s[i] === 'not_reported'));
s = at({ scanRequestedAt: 'x', scanPending: true });
check('a pending scan is now; the scan is not completed', s.scan_requested === 'now' && s.scan_completed === 'not_seen');
s = at({ scannedAt: 'x', offered: 3, downloaded: 0 });
check('downloaded is never done without Windows saying so', s.downloaded === 'not_reported' && s.scan_completed === 'done' && s.unknown === 'not_seen');
s = at({ scannedAt: 'x', offered: 3, downloaded: 2 });
check('downloaded at the last scan', s.downloaded === 'done');
s = at({ scannedAt: 'x', scanError: 'WU down' });
check('a failed scan is failed, not completed', s.scan_completed === 'failed' && s.failed === 'failed');
s = at({ scannedAt: 'x', installState: 'awaiting_approval' });
check('awaiting approval: approval is now, nothing started', s.approved === 'now' && s.install_started === 'not_seen');
s = at({ scannedAt: 'x', installState: 'handed_out' });
check('handed out: started is now, not succeeded', s.approved === 'done' && s.install_started === 'now' && s.install_succeeded === 'not_seen' && s.verified === 'not_seen');
s = at({ scannedAt: 'x', installState: 'restart_required', installed: 2, restartRequired: true, restartedSinceInstall: false });
check('installed, restart required: restart is now, not completed, verification waits', s.install_succeeded === 'done' && s.restart_required === 'now' && s.restart_completed === 'not_seen' && s.verified === 'now');
s = at({ scannedAt: 'x', installState: 'restart_required', installed: 2, restartRequired: true, restartedSinceInstall: true, verified: 2 });
check('rebooted and scanned: restart done, verified done', s.restart_required === 'done' && s.restart_completed === 'done' && s.verified === 'done');
s = at({ scannedAt: 'x', installState: 'succeeded', installed: 1, restartedSinceInstall: null });
check('no boot time reported: restart completed is "not reported", never done', s.restart_completed === 'not_reported');
s = at({ scannedAt: 'x', installState: 'failed', installFailed: 2 });
check('a failed install: failed, not succeeded', s.failed === 'failed' && s.install_succeeded === 'not_seen');
s = at({ scannedAt: 'x', installState: 'uncertain' });
check('an uncertain outcome is unknown', s.unknown === 'now' && s.install_succeeded === 'not_seen');
s = at({ scannedAt: 'x', installState: 'canceled' });
check('a canceled plan was never approved-and-run', s.approved === 'not_seen' && s.install_started === 'not_seen');

// Templates.
check('two templates: workstations and servers', JSON.stringify(L.POLICY_TEMPLATES.map((t) => t.id)) === JSON.stringify(['workstations', 'servers']));
check('a template carries only the fields it may fill in', L.POLICY_TEMPLATES.every((t) => JSON.stringify(Object.keys(t).sort()) === JSON.stringify([...L.TEMPLATE_FIELDS].sort())));
check('no template names devices, rings, a reboot, a restart, the RustDesk exception, a reason or an expiry',
  L.POLICY_TEMPLATES.every((t) => L.NEVER_FROM_TEMPLATE.every((k) => !(k in t))) && L.NEVER_FROM_TEMPLATE.includes('reboot') && L.NEVER_FROM_TEMPLATE.includes('restart'));
const patchingLib = read(WEB, 'lib', 'patching.ts');
const classIds = [...patchingLib.matchAll(/'([0-9a-f-]{36})': '/g)].map((m) => m[1]);
check('template classes are real classes, never drivers', L.POLICY_TEMPLATES.every((t) => t.classes.length > 0 && t.classes.every((c) => classIds.includes(c)) && !t.classes.includes('ebfc1fc5-71a4-4f7b-9aca-3b9a503104a0')));
check('template windows fit the policy document (monthly offset ≤ 14, start ≠ end, HH:MM)',
  L.POLICY_TEMPLATES.every((t) => /^\d\d:\d\d$/.test(t.window.start) && /^\d\d:\d\d$/.test(t.window.end) && t.window.start !== t.window.end && (t.window.kind === 'weekly' ? t.window.days.length > 0 : t.window.offsetDays >= 0 && t.window.offsetDays <= 14)));
check('a staged template has a soak; the servers one tests on one device first', L.POLICY_TEMPLATES.find((t) => t.id === 'servers').testFirst === true && L.POLICY_TEMPLATES.every((t) => !t.testFirst || t.soakHours > 0));
const prev = L.templatePreview(L.POLICY_TEMPLATES[0], (c) => c);
check('the preview says restarts and devices are not set', prev.some((l) => /Restarts: not set by the template/.test(l)) && prev.some((l) => /Devices: not set by the template/.test(l)));
check('every template explains that it sets no restart', L.POLICY_TEMPLATES.every((t) => /No restart is set/.test(t.why)));

// The forms.
const C = (p) => read(WEB, 'components', ...p.split('/'));
const picker = C('patching/policy-template.tsx');
check('the picker previews first; only "Fill in the form" calls onApply, and it never submits', /onClick=\{\(\) => \{ onApply\(t\); setApplied\(t\.id\); \}\}/.test(picker) && (picker.match(/onApply\(/g) || []).length === 1 && !/useMutation|patchingApi|fetch\(/.test(picker));
for (const [file, id] of [['patching/patch-policies.tsx', 'pol'], ['patching/company-policies.tsx', 'ser']]) {
  const f = C(file);
  const m = f.match(new RegExp(`<PolicyTemplatePicker id="${id}" onApply=\\{\\(t\\) => \\{([\\s\\S]*?)\\}\\} />`));
  check(`${file}: the template picker is in the form`, !!m);
  const body = m?.[1] ?? '';
  check(`${file}: applying a template never touches devices, the test device, reboot, restart, reason or submit`,
    !!body && !/setPicked|setRingOf|setCanary|setReboot|setRestart|setReason|mutate|ignoreRemoteSession/.test(body) && /setClasses/.test(body) && /templateWindow/.test(body));
}
const tab = C('endpoints/endpoint-patches.tsx');
check('the Patches tab shows the lifecycle and plain-English ownership', /<PatchLifecycleCard facts=\{\{/.test(tab) && /<UpdateOwnership state="external" managers=\{p\.managers\} \/>/.test(tab));
const dep = read(WEB, 'app', '(app)', 'patching', '[id]', 'page.tsx');
check('the deployment page labels states from the shared map, not its own', /updateStateOf\(s\.state\)/.test(dep) && !/const STATE: Record<string/.test(dep));
const card = C('patching/patch-lifecycle-card.tsx');
check('nothing new requests, approves, installs or restarts', [src, card, picker].every((t) => !/useMutation|Api\.|fetch\(/.test(t)));
check('no new hex colour, amber, yellow, orange or emerald, and no text under 12 px',
  [src, card, picker].every((t) => !/#[0-9a-fA-F]{3,6}\b|\b(amber|yellow|orange|emerald)-|text-\[(?:[0-9]|1[01])px\]/.test(t)));

if (failures.length) console.error(failures.map((f) => `✗ ${f}`).join('\n'));
console.log(`unit-patch-lifecycle: ${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
