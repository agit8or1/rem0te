#!/usr/bin/env node
/**
 * Unit tests for technician presets and the launch policy (v0.23) — no
 * database, no network. The launch policy is exercised through the real
 * AccessPolicyService with in-memory stand-ins for Prisma, the policy store
 * and the abuse guard, so every branch of evaluateLaunch runs here in CI.
 * The behavioural suite against a running API is scripts/e2e-presets.mjs.
 *
 *   cd apps/api && npx nest build && node scripts/unit-presets.mjs
 */
/* global structuredClone */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const P = require(path.join(dist, 'security-controls', 'presets.js'));
const { AccessPolicyService } = require(path.join(dist, 'security-controls', 'access-policy.service.js'));
const { technicianGrantAllows } = require(path.join(dist, 'rbac', 'access-control.service.js'));
const { assertIndependentReviewer, assertFresh } = require(path.join(dist, 'security-controls', 'review.js'));

let n = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);

const tier = (k) => P.BUILT_IN_PRESETS.find((p) => p.tier === k).policy;

// ── Presets ─────────────────────────────────────────────────────────────────
t('L1 grants inventory, its alerts (0.29) and support requests only', () => {
  assert.deepEqual(P.presetCapabilities(tier('L1')).sort(), ['computers:view', 'monitoring:alerts', 'support:requests']);
  const p = tier('L1');
  for (const k of ['eventLogs', 'remoteViewOnly', 'remoteControl', 'elevation', 'unattended', 'clipboard', 'fileTransfer', 'patches', 'fixRequests']) assert.equal(p[k], 'off', k);
  assert.equal(p.diagnostics, 'off');
});
t('L2 adds event logs, basic diagnostics, view-only, control-by-request, low-risk fix requests', () => {
  const p = tier('L2');
  assert.deepEqual(P.presetCapabilities(p).sort(), ['computers:event_logs', 'computers:view', 'monitoring:alerts', 'support:requests']);
  assert.equal(p.diagnostics, 'basic'); assert.equal(p.remoteViewOnly, 'allowed'); assert.equal(p.remoteControl, 'request');
  assert.equal(p.fixRequests, 'low_risk'); assert.equal(p.elevation, 'off'); assert.equal(p.standardWorkstationsOnly, true);
});
t('L3 adds advanced diagnostics and elevation / patches / higher-risk fixes by request', () => {
  const p = tier('L3');
  assert.equal(p.diagnostics, 'advanced'); assert.equal(p.elevation, 'request'); assert.equal(p.patches, 'request');
  assert.equal(p.fixRequests, 'higher_risk'); assert.equal(p.standardWorkstationsOnly, false); assert.equal(p.remoteControl, 'request');
});
t('every tier: unattended, clipboard, file transfer, scripts, fleet, approval, credential, enrollment off', () => {
  for (const k of ['L1', 'L2', 'L3']) {
    const p = tier(k);
    for (const f of ['unattended', 'clipboard', 'fileTransfer', 'scripts', 'fleetExecution', 'fixApproval', 'credentialReveal', 'enrollment']) assert.equal(p[f], 'off', `${k}.${f}`);
  }
});
t('no preset — nor any valid policy — yields a launch, credential or admin capability', () => {
  const maximal = { ...tier('L3'), inventoryView: 'allowed', supportRequests: 'allowed', eventLogs: 'allowed', remoteViewOnly: 'allowed', remoteControl: 'allowed', elevation: 'allowed' };
  for (const p of [tier('L1'), tier('L2'), tier('L3'), maximal]) {
    for (const c of P.NEVER_FROM_PRESET) assert.ok(!P.presetCapabilities(p).includes(c), c);
  }
});
t('preset policy schema refuses turning on a locked control', () => {
  assert.equal(P.PresetPolicy.safeParse({ ...tier('L3'), credentialReveal: 'allowed' }).success, false);
  assert.equal(P.PresetPolicy.safeParse({ ...tier('L3'), fixApproval: 'allowed' }).success, false);
  assert.equal(P.PresetPolicy.safeParse({ ...tier('L3'), extra: 1 }).success, false);
});
t('presetWidening detects every widening and ignores tightening', () => {
  assert.deepEqual(P.presetWidening(tier('L2'), tier('L1')), []);
  const w = P.presetWidening(tier('L1'), tier('L2'));
  for (const k of ['eventLogs', 'diagnostics', 'remoteViewOnly', 'remoteControl', 'fixRequests', 'maxSessionMinutes']) assert.ok(w.some((x) => x.startsWith(k)), k);
  assert.ok(P.presetWidening(tier('L2'), tier('L3')).some((x) => x.startsWith('standardWorkstationsOnly')));
});

// ── Platform / business controls ───────────────────────────────────────────
const D = P.DEFAULT_CONTROLS;
t('defaults: consent required, unattended / clipboard / file transfer off, minimum protected classes', () => {
  assert.equal(D.attendedConsent, 'required'); assert.equal(D.unattendedAccess, 'off');
  assert.equal(D.clipboard, 'off'); assert.equal(D.fileTransfer, 'off');
  for (const c of P.PROTECTED_CLASSES_MINIMUM) assert.ok(D.protectedClasses.includes(c));
  assert.ok(P.AccessControls.safeParse(D).success);
});
t('wideningOf: thresholds up, window down, class removed, destinations changed', () => {
  const up = structuredClone(D); up.thresholds.L2.devices += 1;
  assert.ok(P.wideningOf(D, up).some((x) => x.startsWith('thresholds.L2.devices')));
  const win = { ...structuredClone(D), windowMinutes: 30 };
  assert.ok(P.wideningOf(D, win).some((x) => x.startsWith('windowMinutes')));
  const cls = { ...structuredClone(D), protectedClasses: D.protectedClasses.filter((c) => c !== 'HYPERVISOR') };
  assert.ok(P.wideningOf(D, cls).some((x) => x.includes('HYPERVISOR')));
  const dest = { ...structuredClone(D), alertDestinations: [{ kind: 'webhook', url: 'https://alerts.example.com/hook', label: 'soc' }] };
  assert.ok(P.wideningOf(D, dest).includes('alertDestinations changed'));
  const down = structuredClone(D); down.thresholds.L2.devices -= 1; down.unattendedAccess = 'off';
  assert.deepEqual(P.wideningOf(D, down), []);
  const unatt = { ...structuredClone(D), unattendedAccess: 'request' };
  assert.ok(P.wideningOf(D, unatt).some((x) => x.startsWith('unattendedAccess')));
});
t('a business policy can only tighten', () => {
  const loose = { ...structuredClone(D), attendedConsent: 'not_required', maxSessionMinutes: 120 };
  const e = P.effectiveControls(loose, { attendedConsent: 'required', maxSessionMinutes: 30, protectedClasses: ['SERVER'] });
  assert.equal(e.attendedConsent, 'required'); assert.equal(e.maxSessionMinutes, 30); assert.ok(e.protectedClasses.includes('SERVER'));
  const e2 = P.effectiveControls(D, { attendedConsent: 'not_required', maxSessionMinutes: 480, unattendedAccess: 'request' });
  assert.equal(e2.attendedConsent, 'required'); assert.equal(e2.maxSessionMinutes, D.maxSessionMinutes); assert.equal(e2.unattendedAccess, 'off');
  assert.equal(P.BusinessControls.safeParse({ thresholds: D.thresholds }).success, false, 'thresholds are not a business field');
});
t('webhook URLs are redacted and round-trip by ref', () => {
  const c = { ...structuredClone(D), alertDestinations: [{ kind: 'webhook', url: 'https://hooks.example.com/T0/SECRET', label: 'soc' }] };
  const r = P.redactControls(c);
  assert.ok(!JSON.stringify(r).includes('SECRET'));
  assert.equal(r.alertDestinations[0].origin, 'https://hooks.example.com');
  const back = P.restoreDestinations({ ...r }, c);
  assert.equal(back.alertDestinations[0].url, 'https://hooks.example.com/T0/SECRET');
  assert.throws(() => P.restoreDestinations({ alertDestinations: [{ ref: 'deadbeef0000' }] }, c));
});

// ── Pairwise grants ─────────────────────────────────────────────────────────
t('capability and computer scope must come from the same grant', () => {
  const tech = { sources: [
    { capabilities: ['computers:view', 'computers:event_logs'], endpointIds: ['A'] },
    { capabilities: ['computers:view'], endpointIds: null },
  ] };
  assert.equal(technicianGrantAllows(tech, 'computers:event_logs', 'A'), true);
  assert.equal(technicianGrantAllows(tech, 'computers:event_logs', 'B'), false, 'event logs from grant 1 must not combine with all-computers scope from grant 2');
  assert.equal(technicianGrantAllows(tech, 'computers:view', 'B'), true);
  assert.equal(technicianGrantAllows(tech, null, 'Z'), true);
});

// ── Review ─────────────────────────────────────────────────────────────────
t('independent review refuses the requester, non-reviewers and technician context', () => {
  const admin = { userId: 'a', isPlatformAdmin: true, platformPermissions: [] };
  assert.throws(() => assertIndependentReviewer(admin, 'a', 'x'), /own/);
  assert.doesNotThrow(() => assertIndependentReviewer(admin, 'b', 'x'));
  assert.throws(() => assertIndependentReviewer({ userId: 'c', isPlatformAdmin: false, platformPermissions: ['technicians:manage'] }, 'b', 'x'));
  assert.doesNotThrow(() => assertIndependentReviewer({ userId: 'c', isPlatformAdmin: false, platformPermissions: ['approvals:review'] }, 'b', 'x'));
  assert.throws(() => assertIndependentReviewer({ ...admin, technician: { sources: [] } }, 'b', 'x'));
});
t('fresh auth: required always; a protected exception needs a passkey', () => {
  assert.throws(() => assertFresh(null));
  assert.doesNotThrow(() => assertFresh('password'));
  assert.throws(() => assertFresh('totp', { phishingResistant: true }));
  assert.doesNotThrow(() => assertFresh('passkey', { phishingResistant: true }));
});

// ── Launch policy ───────────────────────────────────────────────────────────
function harness({ controls = D, paused = false, temporary = [], devices = [] } = {}) {
  const prisma = {
    technicianDevice: { findFirst: async ({ where }) => devices.find((d) => d.id === where.id && d.userId === where.userId && d.isManagedAdminWorkstation) ?? null },
    temporaryAccessRequest: { findFirst: async ({ where }) => temporary.find((x) => x.userId === where.userId && x.endpointId === where.endpointId && x.mode === where.mode && x.expiresAt > new Date()) ?? null },
  };
  const store = { effective: async () => controls, platform: async () => controls };
  const abuse = { isPaused: async () => paused };
  return new AccessPolicyService(prisma, store, abuse, {}, { blocking: async () => null }); // 0.28: nothing paused
}
const src = (k, extra = {}) => ({ assignmentId: `as-${k}`, presetId: k ? `p-${k}` : null, presetTier: k, presetPolicy: k ? tier(k) : null, capabilities: k ? P.presetCapabilities(tier(k)) : [], endpointIds: null, ...extra });
const techActor = (...sources) => ({ userId: 'u1', isPlatformAdmin: false, technician: { sources }, capabilities: [] });
const ep = (o = {}) => ({ id: 'E1', customerId: 'B1', deviceClass: 'WORKSTATION', sessionEnforcement: null, accessMode: 'ASSIGNED_USERS', ...o });
const enforcing = { viewOnly: true, attendedConsent: true };

t('L1: no view-only, no control', async () => {
  const s = harness();
  assert.equal((await s.evaluateLaunch(techActor(src('L1')), ep(), 'view_only', { via: 'browser' })).reason, 'view_only_not_granted');
  assert.equal((await s.evaluateLaunch(techActor(src('L1')), ep(), 'control', { via: 'browser' })).reason, 'control_not_granted');
});
t('L2 view-only: blocked with a reason when the endpoint cannot enforce it — never falls back', async () => {
  const s = harness();
  const d = await s.evaluateLaunch(techActor(src('L2')), ep(), 'view_only', { via: 'browser' });
  assert.equal(d.ok, false); assert.equal(d.status, 'unavailable'); assert.equal(d.reason, 'endpoint_cannot_enforce_view_only');
  assert.match(d.message, /blocked/);
});
t('L2 view-only on an endpoint that enforces view-only and consent: allowed, no credential', async () => {
  const d = await harness().evaluateLaunch(techActor(src('L2')), ep({ sessionEnforcement: enforcing }), 'view_only', { via: 'browser' });
  assert.equal(d.ok, true); assert.equal(d.revealCredential, false); assert.equal(d.maxSessionMinutes, 60);
});
t('L2 view-only is for standard workstations only', async () => {
  const d = await harness().evaluateLaunch(techActor(src('L2')), ep({ deviceClass: 'SERVER', sessionEnforcement: enforcing }), 'view_only', { via: 'browser' });
  assert.equal(d.reason, 'view_only_not_granted');
  const d3 = await harness().evaluateLaunch(techActor(src('L3')), ep({ deviceClass: 'SERVER', sessionEnforcement: enforcing }), 'view_only', { via: 'browser' });
  assert.equal(d3.ok, true);
});
t('L2 control: needs an activated temporary grant, then consent enforcement', async () => {
  assert.equal((await harness().evaluateLaunch(techActor(src('L2')), ep(), 'control', { via: 'browser' })).reason, 'temporary_grant_required');
  const grant = [{ userId: 'u1', endpointId: 'E1', mode: 'CONTROL', expiresAt: new Date(Date.now() + 60_000) }];
  assert.equal((await harness({ temporary: grant }).evaluateLaunch(techActor(src('L2')), ep(), 'control', { via: 'browser' })).reason, 'endpoint_cannot_enforce_consent');
  const ok = await harness({ temporary: grant }).evaluateLaunch(techActor(src('L2')), ep({ sessionEnforcement: enforcing }), 'control', { via: 'browser' });
  assert.equal(ok.ok, true); assert.equal(ok.revealCredential, false, 'preset-backed control never reveals the permanent password');
  const expired = [{ ...grant[0], expiresAt: new Date(Date.now() - 1000) }];
  assert.equal((await harness({ temporary: expired }).evaluateLaunch(techActor(src('L2')), ep({ sessionEnforcement: enforcing }), 'control', { via: 'browser' })).reason, 'temporary_grant_required');
});
t('elevation and unattended are never granted', async () => {
  assert.equal((await harness().evaluateLaunch(techActor(src('L3')), ep({ sessionEnforcement: enforcing }), 'elevated', { via: 'browser' })).reason, 'elevation_unavailable');
  assert.equal((await harness().evaluateLaunch(techActor(src('L3')), ep(), 'unattended', { via: 'browser' })).reason, 'unattended_off');
  assert.equal((await harness().evaluateLaunch({ userId: 'm', isPlatformAdmin: true, capabilities: [] }, ep(), 'unattended', { via: 'browser' })).reason, 'unattended_off');
});
t('a paused identity gets nothing, whoever it is', async () => {
  for (const a of [techActor(src('L3')), { userId: 'admin', isPlatformAdmin: true, capabilities: [] }]) {
    assert.equal((await harness({ paused: true }).evaluateLaunch(a, ep(), 'control', { via: 'browser' })).reason, 'identity_paused');
  }
});
t('protected classes: denied to everyone, including a Platform Admin, without an exception', async () => {
  const admin = { userId: 'admin', isPlatformAdmin: true, capabilities: [] };
  for (const cls of P.PROTECTED_CLASSES_MINIMUM) {
    const d = await harness().evaluateLaunch(admin, ep({ deviceClass: cls }), 'control', { via: 'browser' });
    assert.equal(d.reason, 'protected_device_class', cls);
  }
});
t('protected exception still needs a managed workstation via the launcher', async () => {
  const admin = { userId: 'admin', isPlatformAdmin: true, capabilities: [] };
  const ex = [{ userId: 'admin', endpointId: 'E1', mode: 'PROTECTED_EXCEPTION', expiresAt: new Date(Date.now() + 60_000) }];
  assert.equal((await harness({ temporary: ex }).evaluateLaunch(admin, ep({ deviceClass: 'BACKUP_SERVER' }), 'control', { via: 'browser' })).reason, 'protected_requires_managed_workstation');
  const dev = [{ id: 'D1', userId: 'admin', isManagedAdminWorkstation: true }];
  assert.equal((await harness({ temporary: ex, devices: dev }).evaluateLaunch(admin, ep({ deviceClass: 'BACKUP_SERVER' }), 'control', { via: 'launcher', technicianDeviceId: 'D1' })).ok, true);
  assert.equal((await harness({ temporary: ex, devices: dev }).evaluateLaunch({ ...admin, userId: 'other' }, ep({ deviceClass: 'BACKUP_SERVER' }), 'control', { via: 'launcher', technicianDeviceId: 'D1' })).ok, false, 'someone else\'s workstation');
});
t('custom (pre-0.23) assignment with connect keeps its behaviour; with only view it gets nothing', async () => {
  const custom = src(null, { capabilities: ['computers:view', 'computers:connect'] });
  const d = await harness().evaluateLaunch(techActor(custom), ep(), 'control', { via: 'browser' });
  assert.equal(d.ok, true); assert.equal(d.path, 'legacy_assignment'); assert.equal(d.revealCredential, true);
  const viewOnly = src(null, { capabilities: ['computers:view'] });
  assert.equal((await harness().evaluateLaunch(techActor(viewOnly), ep(), 'control', { via: 'browser' })).ok, false);
});
t('a connect grant scoped to other computers does not open this one', async () => {
  const custom = src(null, { capabilities: ['computers:view', 'computers:connect'], endpointIds: ['OTHER'] });
  const preset = src('L1');
  assert.equal((await harness().evaluateLaunch(techActor(custom, preset), ep(), 'control', { via: 'browser' })).ok, false);
});
t('tier for thresholds: custom wins, else the highest preset covering the computer', () => {
  const s = harness();
  assert.equal(s.tierFor(techActor(src('L1'), src('L3')), 'E1'), 'L3');
  assert.equal(s.tierFor(techActor(src('L1'), src('L3', { endpointIds: ['X'] })), 'E1'), 'L1');
  assert.equal(s.tierFor(techActor(src('L2'), src(null, { capabilities: ['computers:view'] })), 'E1'), 'custom');
  assert.equal(s.tierFor({ userId: 'a', isPlatformAdmin: true }, 'E1'), 'platformAdmin');
  assert.equal(s.tierFor({ userId: 'm', isPlatformAdmin: false }, 'E1'), 'member');
});

for (const [name, fn] of tests) {
  try { await fn(); n++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}\n    ${e.stack ?? e}`); process.exitCode = 1; }
}
console.log(process.exitCode ? '\n✗ presets unit tests failed' : `\n✓ ${n} presets unit tests passed`);
