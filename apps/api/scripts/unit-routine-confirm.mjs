#!/usr/bin/env node
/**
 * 0.46.1: everyday changes and the "confirm it is you" step-up
 * (security-controls/review.ts). No database. Needs `nest build` (dist/).
 *
 * The e2e suites run on fresh databases, where routineConfirm is 'every', so
 * they keep proving the strict path. This proves the other half: with 'off'
 * only the listed everyday actions pass without a fresh method, and nothing
 * else ever does.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const R = require(path.join(here, '..', 'dist', 'security-controls/review.js'));

let pass = 0; const fails = [];
const check = (name, ok) => { if (ok) pass++; else fails.push(name); console.log(`${ok ? '✓' : '✗'} ${name}`); };
const refuses = (f) => { try { f(); return false; } catch (e) { return e?.response?.code === 'STEP_UP_REQUIRED' || e?.getResponse?.()?.code === 'STEP_UP_REQUIRED'; } };

// Before the setting is read: ask, for everything.
check('before the setting is read, an everyday change asks', R.routineConfirmRequired() === true && refuses(() => R.assertFresh(null, { routine: 'software.catalog' })));

R.setRoutineConfirm('off');
check("with 'off', every listed everyday action passes without a fresh method",
  R.ROUTINE_ACTIONS.every((a) => !refuses(() => R.assertFresh(null, { action: a, routine: a }))));
check("with 'off', a non-routine call still asks", refuses(() => R.assertFresh(null)) && refuses(() => R.assertFresh(null, { action: 'apikey.create' })));
check("with 'off', a phishing-resistant check still asks", refuses(() => R.assertFresh('password', { phishingResistant: true })));
check("with 'off', a fresh method still passes a non-routine call", !refuses(() => R.assertFresh('totp')));

R.setRoutineConfirm('every');
check("with 'every', an everyday change asks", refuses(() => R.assertFresh(null, { routine: 'actions.direct' })) && !refuses(() => R.assertFresh('passkey', { routine: 'actions.direct' })));

for (const v of ['OFF', 'no', '', null, undefined, 0, false, {}]) {
  R.setRoutineConfirm(v);
  if (!refuses(() => R.assertFresh(null, { routine: 'software.catalog' }))) { check(`a value of ${JSON.stringify(v)} asks`, false); break; }
}
check('any value but exactly "off" asks', fails.every((f) => !f.startsWith('a value of')));

check('the list is the seven everyday actions', JSON.stringify(R.ROUTINE_ACTIONS) === JSON.stringify(['actions.direct', 'scripts.direct', 'software.catalog', 'agent.migrate', 'agent.autoupdate.computer', 'agent.autoupdate.business', 'patching.policy']));

console.log(`\n${fails.length ? '✗' : '✓'} ${pass} routine-confirm checks passed${fails.length ? `, ${fails.length} failed` : ''}`);
process.exit(fails.length ? 1 : 0);
