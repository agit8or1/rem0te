#!/usr/bin/env node
/**
 * 0.49: Settings → Confirm it is you — the catalog (confirm-catalog.ts), the
 * resolution in review.ts (assertFresh, confirmRequired) and
 * ConfirmPolicyService's rules, against an in-memory Prisma. No database.
 * Needs `nest build` (dist/). Replaces 0.47's unit-routine-confirm.mjs.
 *
 * The e2e suites run on fresh databases, which have no ConfirmPolicy rows, so
 * they keep proving that everything asks. This proves the other half: a key
 * set to 'off' skips, and nothing else ever does. The behavioural proof over
 * HTTP is e2e-confirm-policy.mjs.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = (f) => {
  for (const base of [path.join(here, '..', 'dist'), path.join(here, '..', 'dist', 'src')]) {
    try { return require(path.join(base, f)); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
  }
  throw new Error(`dist/${f} not found: run nest build first`);
};
const R = dist('security-controls/review.js');
const C = dist('security-controls/confirm-catalog.js');
const { ConfirmPolicyService } = dist('security-controls/confirm-policy.service.js');

let pass = 0; const fails = [];
const check = (name, ok, detail = '') => { if (ok) pass++; else fails.push(name); console.log(`${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `\n    ${detail}`}`); };
const code = (e) => e?.response?.code ?? e?.getResponse?.()?.code;
const refuses = (f, want = 'STEP_UP_REQUIRED') => { try { f(); return false; } catch (e) { return code(e) === want; } };
const refusesAsync = async (f, want) => { try { await f(); return false; } catch (e) { return want ? code(e) === want || e?.status === want : true; } };

const KEYS = C.CONFIRM_KEYS;
const ALWAYS = C.ALWAYS_ASK_KEYS;

// ── The catalog ────────────────────────────────────────────────────────────
check('the catalog has unique keys', new Set(KEYS).size === KEYS.length);
check('every function has a known group, a label, a description, a prompt and default ask',
  C.CONFIRM_CATALOG.every((f) => C.CONFIRM_GROUPS.includes(f.group) && f.label && f.description && f.prompt && f.default === 'ask'));
check('every group has at least one function', C.CONFIRM_GROUPS.every((g) => C.CONFIRM_CATALOG.some((f) => f.group === g)));
check('no always-ask key is in the configurable catalog', ALWAYS.every((k) => !KEYS.includes(k)));
check('the always-ask set is passkey.manage, fresh.auth.passkey and confirm.relax',
  JSON.stringify([...ALWAYS].sort()) === JSON.stringify(['confirm.relax', 'fresh.auth.passkey', 'passkey.manage']));
check('the always-ask note names own password, authenticator, passkeys and the step-up',
  ['password', 'authenticator', 'passkeys', 'step-up'].every((w) => C.ALWAYS_ASK_NOTE.some((l) => l.toLowerCase().includes(w))));
check('every key fits 0071\'s key charset', KEYS.every((k) => /^[a-z][a-z.]{1,63}$/.test(k)));
check('the seven 0.47 everyday keys are all in the catalog', C.LEGACY_ROUTINE_KEYS.length === 7 && C.LEGACY_ROUTINE_KEYS.every((k) => KEYS.includes(k)));

// 0071 must map exactly those seven, and only where routineConfirm was 'off'.
const mig = readFileSync(path.join(here, '..', 'prisma', 'migrations', '0071_confirm_policy', 'migration.sql'), 'utf8');
const firstArray = mig.match(/unnest\(ARRAY\[([\s\S]*?)\]\)/)[1].match(/'([a-z.]+)'/g).map((s) => s.slice(1, -1));
check('0071 sets exactly the seven everyday keys off', JSON.stringify(firstArray) === JSON.stringify([...C.LEGACY_ROUTINE_KEYS]), JSON.stringify(firstArray));
check("0071 does so only where routineConfirm was 'off'", /"routineConfirm" = 'off'\);/.test(mig));
check('0071 CHECKs the value', /CHECK \("value" IN \('ask', 'off'\)\)/.test(mig));
check('0071 drops both old settings', /DROP COLUMN "routineConfirm"/.test(mig) && /DROP COLUMN "stepUpActions"/.test(mig));

// ── Resolution ─────────────────────────────────────────────────────────────
R.resetConfirmPolicy();
check('before the policy is read, every key asks', KEYS.every((k) => R.confirmRequired(k)) && refuses(() => R.assertFresh(null, { action: 'software.catalog' })));

R.setConfirmPolicy(KEYS.map((k) => ({ key: k, value: 'off' })));
check("with every key 'off', every catalog key passes without a fresh method", KEYS.every((k) => !refuses(() => R.assertFresh(null, { action: k }))));
check("with every key 'off', the always-ask keys still ask", ALWAYS.every((k) => R.confirmRequired(k) && refuses(() => R.assertFresh(null, { action: k }))));
check('an unknown key asks', R.confirmRequired('made.up') && refuses(() => R.assertFresh(null, { action: 'made.up' })));
check('a phishing-resistant check still asks, and still wants a passkey', refuses(() => R.assertFresh(null, { action: 'temporary.access', phishingResistant: true }))
  && refuses(() => R.assertFresh('password', { action: 'temporary.access', phishingResistant: true })) && !refuses(() => R.assertFresh('passkey', { action: 'temporary.access', phishingResistant: true })));
check('confirmValues reports them all off', Object.values(R.confirmValues()).every((v) => v === 'off'));

R.setConfirmPolicy([{ key: 'software.catalog', value: 'off' }, { key: 'passkey.manage', value: 'off' }, { key: 'confirm.relax', value: 'off' }, { key: 'made.up', value: 'off' }]);
check('one key off: only that key skips', !R.confirmRequired('software.catalog') && KEYS.filter((k) => k !== 'software.catalog').every((k) => R.confirmRequired(k)));
check('a row naming an always-ask or unknown key is ignored', R.confirmRequired('passkey.manage') && R.confirmRequired('confirm.relax') && R.confirmRequired('made.up'));
check("with a key 'ask', a fresh method still passes", !refuses(() => R.assertFresh('totp', { action: 'apikey.create' })));

let odd = true;
for (const v of ['OFF', 'Off', 'no', '', null, undefined, 0, false, {}, 'ask']) {
  R.setConfirmPolicy([{ key: 'software.catalog', value: v }]);
  if (!R.confirmRequired('software.catalog')) { odd = false; check(`a value of ${JSON.stringify(v)} asks`, false); }
}
check('any value but exactly "off" asks', odd);

// ── ConfirmPolicyService ───────────────────────────────────────────────────
function fakePrisma(rows = []) {
  const store = new Map(rows.map((r) => [r.key, { ...r }]));
  const p = {
    store,
    confirmPolicy: {
      findMany: async () => [...store.values()].map(({ key, value }) => ({ key, value })),
      upsert: ({ where, update, create }) => ({ run: () => { store.set(where.key, store.has(where.key) ? { ...store.get(where.key), ...update } : { ...create }); } }),
    },
    $transaction: async (ops) => { for (const o of ops) o.run(); },
  };
  return p;
}
const audits = [];
const audit = { log: async (e) => { audits.push(e); } };
const admin = { userId: 'u-admin', isPlatformAdmin: true, ip: '127.0.0.1' };
const owner = { userId: 'u-owner', isPlatformAdmin: false, ip: '127.0.0.1' };

R.resetConfirmPolicy();
const prisma = fakePrisma();
const svc = new ConfirmPolicyService(prisma, audit);
const v0 = svc.view(await svc.load(), owner);
check('the view lists every catalog key with its value, the groups and the always-ask note',
  v0.catalog.length === KEYS.length && v0.catalog.every((f) => f.value === 'ask') && v0.groups.length === C.CONFIRM_GROUPS.length && v0.alwaysAsk.length >= 5);
check('canChange is false for anyone but a Platform Admin', v0.canChange === false && svc.view(await svc.load(), admin).canChange === true);

check('a non-admin is refused', await refusesAsync(() => svc.set(owner, { values: { 'software.catalog': 'ask' } }, 'passkey')));
check('an always-ask key is refused', await refusesAsync(() => svc.set(admin, { values: { 'passkey.manage': 'off' } }, 'passkey'), 'CONFIRM_ALWAYS_ASKS')
  && await refusesAsync(() => svc.set(admin, { values: { 'confirm.relax': 'off' } }, 'passkey'), 'CONFIRM_ALWAYS_ASKS'));
check('an unknown key is refused', await refusesAsync(() => svc.set(admin, { values: { 'made.up': 'off' } }, 'passkey'), 'UNKNOWN_CONFIRM_KEY'));
check('a bad value is refused', await refusesAsync(() => svc.set(admin, { values: { 'software.catalog': 'every' } }, 'passkey'), 'INVALID_CONFIRM_VALUE'));
check('an empty or malformed body is refused', await refusesAsync(() => svc.set(admin, { values: {} }, 'passkey'), 'INVALID_CONFIRM_POLICY')
  && await refusesAsync(() => svc.set(admin, { value: 'off' }, 'passkey'), 'INVALID_CONFIRM_POLICY') && await refusesAsync(() => svc.set(admin, null, 'passkey'), 'INVALID_CONFIRM_POLICY'));
check('nothing was written by a refusal', prisma.store.size === 0 && audits.length === 0);

check('relaxing without a fresh confirmation is refused (confirm.relax)', await refusesAsync(() => svc.set(admin, { values: { 'software.catalog': 'off' } }, null), 'STEP_UP_REQUIRED') && prisma.store.size === 0);
// Even when every other key is off, relaxing asks.
const out = await svc.set(admin, { values: { 'software.catalog': 'off', 'actions.direct': 'off' } }, 'totp');
check('relaxing with a fresh confirmation is written, and takes effect at once', out.values['software.catalog'] === 'off' && !R.confirmRequired('software.catalog') && !R.confirmRequired('actions.direct'));
check('the audit row names the changed keys before and after', audits.length === 1 && audits[0].action === 'CONFIRM_POLICY_CHANGED'
  && JSON.stringify(audits[0].meta) === JSON.stringify({ before: { 'software.catalog': 'ask', 'actions.direct': 'ask' }, after: { 'software.catalog': 'off', 'actions.direct': 'off' } }), JSON.stringify(audits[0]?.meta));
check('relaxing a further key still needs a fresh confirmation', await refusesAsync(() => svc.set(admin, { values: { 'apikey.create': 'off' } }, null), 'STEP_UP_REQUIRED'));
const back = await svc.set(admin, { values: { 'software.catalog': 'ask' } }, null);
check('asking again needs no fresh confirmation', back.values['software.catalog'] === 'ask' && R.confirmRequired('software.catalog') && audits.length === 2);
const mixed = await refusesAsync(() => svc.set(admin, { values: { 'actions.direct': 'ask', 'patching.policy': 'off' } }, null), 'STEP_UP_REQUIRED');
check('a mixed change that relaxes anything needs a fresh confirmation, and writes nothing', mixed && prisma.store.get('actions.direct').value === 'off');
const same = await svc.set(admin, { values: { 'actions.direct': 'off' } }, null);
check('a change to the value it already has asks nothing and writes no audit row', same.values['actions.direct'] === 'off' && audits.length === 2);

// A row the database has but the catalog does not is ignored on load.
prisma.store.set('made.up', { key: 'made.up', value: 'off' });
prisma.store.set('passkey.manage', { key: 'passkey.manage', value: 'off' });
await svc.load();
check('rows outside the catalog are ignored on load', R.confirmRequired('made.up') && R.confirmRequired('passkey.manage'));

// A failed read keeps the last policy (and an unread one asks).
const broken = new ConfirmPolicyService({ confirmPolicy: { findMany: async () => { throw new Error('down'); } } }, audit);
broken.log = { warn: () => {} };
await broken.load();
check('a failed read keeps the last policy read', !R.confirmRequired('actions.direct'));
R.resetConfirmPolicy();
await broken.load();
check('a failed first read asks for everything', KEYS.every((k) => R.confirmRequired(k)));

console.log(`\n${fails.length ? '✗' : '✓'} ${pass} confirm-policy checks passed${fails.length ? `, ${fails.length} failed` : ''}`);
process.exit(fails.length ? 1 : 0);
