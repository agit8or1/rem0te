#!/usr/bin/env node
// Managed Secure Access, item by item (0.91, UX P1-5): apps/api/src/msa/access-facts.ts,
// run against dist (npx nest build first).
//
//   node scripts/unit-msa-access-facts.mjs
//
// The twelve items of directive §12, in order, for an unmanaged computer
// with the switch off and on, a verified managed one, an enforcement
// failure, an old agent, a standard agent and Linux. Nothing here may say
// "Yes" for a control the computer does not enforce.

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const F = require(join(here, '..', 'dist', 'msa', 'access-facts.js'));

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => { if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); } };

const KEYS = ['support', 'readiness', 'enabled', 'agent', 'enforcement', 'credential', 'consent', 'clipboard', 'files', 'expiration', 'revocation', 'termination'];
check('twelve items in the directive\'s order', JSON.stringify(F.FACT_KEYS) === JSON.stringify(KEYS));

const base = { switchOn: false, readiness: { state: 'compatible', label: 'Compatible' }, managed: null, agentVersion: '0.90.0', windows: true, signedAgent: true };
const by = (input) => Object.fromEntries(F.accessFacts(input).map((f) => [f.key, f]));
const ENFORCED = ['credential', 'expiration', 'revocation', 'termination'];

{
  const f = by(base);
  check('every item has a label, an answer and words', Object.values(f).every((x) => x.label && ['yes', 'no', 'partial', 'unknown'].includes(x.answer) && x.text.length > 10));
  check('switch off: Enabled is No, and says the permanent password\'s protections apply', f.enabled.answer === 'no' && /not switched on/i.test(f.enabled.text));
  for (const k of [...ENFORCED, 'clipboard', 'files', 'consent']) check(`switch off: ${k} is No`, f[k].answer === 'no', f[k].answer);
  check('switch off: support and readiness still answer', f.support.answer === 'yes' && f.readiness.answer === 'yes');
}
{
  const f = by({ ...base, switchOn: true });
  check('switch on, not managed: Enabled is No, and only a Platform Admin can move it in', f.enabled.answer === 'no' && /Platform Admin/.test(f.enabled.text));
  for (const k of ENFORCED) check(`switch on, not managed: ${k} is No (nothing is enforced yet)`, f[k].answer === 'no');
}
{
  const f = by({ ...base, switchOn: true, readiness: { state: 'managed_verified', label: 'Managed (verified)' }, managed: { state: 'verified', verifiedAt: new Date() } });
  check('verified: Enabled is Yes', f.enabled.answer === 'yes');
  for (const k of ENFORCED) check(`verified: ${k} is Yes`, f[k].answer === 'yes', f[k].answer);
  check('verified: consent is only Partly (the agent cannot see the prompt accepted)', f.consent.answer === 'partial' && /cannot see/.test(f.consent.text));
  check('verified: clipboard and files are Partly (per Connect), and tunnels and restart are never allowed', f.clipboard.answer === 'partial' && f.files.answer === 'partial' && /never allowed/.test(f.files.text));
  check('verified: termination says what the agent cannot see', /cannot see who is connected/.test(f.termination.text));
  check('verified: the time limit is the grant schema\'s maximum', /at most 8 hours/.test(f.expiration.text));
}
{
  const f = by({ ...base, switchOn: true, readiness: { state: 'enforcement_failure', label: 'Enforcement failed' }, managed: { state: 'enforcement_failure', verifiedAt: null } });
  check('enforcement failure: Enabled is Partly, and Connect is refused', f.enabled.answer === 'partial' && /refused/.test(f.enabled.text));
  check('enforcement failure: enforcement is No', f.enforcement.answer === 'no');
  for (const k of ENFORCED) check(`enforcement failure: ${k} is No`, f[k].answer === 'no');
}
{
  const f = by({ ...base, switchOn: true, managed: { state: 'pending', verifiedAt: null } });
  check('pending (not verified): nothing enforced is Yes', ENFORCED.every((k) => f[k].answer === 'no') && f.enabled.answer === 'partial');
}
{
  const f = by({ ...base, switchOn: true, managed: { state: 'verified', verifiedAt: new Date() }, agentVersion: '0.72.5' });
  check('agent 0.72 (enforces, no sessions): agent is Partly and termination is No', f.agent.answer === 'partial' && f.termination.answer === 'no');
  check('the agent line names the three minimums', /0\.69\.0/.test(f.agent.text) && /0\.72\.0/.test(f.agent.text) && /0\.73\.0/.test(f.agent.text));
}
{
  check('no agent version: agent is Unknown', by({ ...base, agentVersion: null }).agent.answer === 'unknown');
  check('agent 0.60: agent is No', by({ ...base, agentVersion: '0.60.0' }).agent.answer === 'no');
  check('standard agent: support is No and says signed', by({ ...base, signedAgent: false }).support.answer === 'no' && /signed agent/.test(by({ ...base, signedAgent: false }).support.text));
  check('Linux: support is No and says Windows only', by({ ...base, windows: false }).support.answer === 'no' && /Windows only/.test(by({ ...base, windows: false }).support.text));
}
const src = readFileSync(join(here, '..', 'src', 'msa', 'access-facts.ts'), 'utf8');
check('access-facts.ts imports only pure msa modules', [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]).every((m) => ['./readiness', './managed', './grant'].includes(m)));
check('access-facts.ts reads no clock and no switch', !/Date\.now\(|new Date\(\)|msaGrantsEnabled|process\.env/.test(src));
const svc = readFileSync(join(here, '..', 'src', 'msa', 'msa.service.ts'), 'utf8');
check('only the device view reads the facts (no route acts on them)', (svc.match(/accessFacts\(/g) ?? []).length === 1);

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
