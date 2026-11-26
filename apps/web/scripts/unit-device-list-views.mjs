#!/usr/bin/env node
// Tests for the device list's built-in views (0.89, UX P1-3),
// apps/web/lib/device-builtin-views.ts.
//
//   node apps/web/scripts/unit-device-list-views.mjs
//
// The module is pure (no imports), so it is transpiled with the workspace's
// TypeScript and run as it is. Covered: every built-in view uses only the
// API's own list filters with values the API accepts (read from
// apps/api/src/endpoints/list-query.ts, so a renamed or removed filter fails
// here, not in a browser); a view needing alerts says so; every one of the
// directive's §9 default views is either offered or listed with its reason;
// matchBuiltin recognises a view exactly, with the customer and site kept;
// the web's filter shape and rule keys agree with the API's.

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const WEB = join(here, '..');
const ROOT = join(WEB, '..', '..');
const require = createRequire(join(WEB, 'package.json'));
const ts = require('typescript');
const src = readFileSync(join(WEB, 'lib', 'device-builtin-views.ts'), 'utf8');
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;
if (/\brequire\s*\(/.test(js)) throw new Error('lib/device-builtin-views.ts imports a module: it must stay pure');
const mod = { exports: {} };
new Function('module', 'exports', js)(mod, mod.exports);
const V = mod.exports;

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => { if (ok) passed++; else failures.push(`${name}${detail ? ` — ${detail}` : ''}`); };

// What the API accepts, from its own source.
const lq = readFileSync(join(ROOT, 'apps', 'api', 'src', 'endpoints', 'list-query.ts'), 'utf8');
const list = (name) => [...((lq.match(new RegExp(`export const ${name} = \\[([^\\]]*)\\]`)) ?? [])[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
const inline = (key) => [...((lq.match(new RegExp(`${key}: oneOf\\(q\\.${key}, \\[([^\\]]*)\\]`)) ?? [])[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
const ALLOWED = {
  online: inline('online'), alerts: inline('alerts'), agent: inline('agent'),
  platform: list('PLATFORMS'), patches: list('PATCH_STATES'), warranty: list('WARRANTY_FILTERS'),
  windowsRole: list('WINDOWS_ROLES'), mine: list('MINE'), restartPending: [true],
};
const LIST_KEYS = list('LIST_FILTER_KEYS');
check('read the API\'s filter lists', Object.values(ALLOWED).every((a) => a.length > 0) && LIST_KEYS.length > 15, JSON.stringify(ALLOWED));

const ids = new Set(), labels = new Set();
for (const v of V.BUILTIN_VIEWS) {
  check(`${v.id}: unique id and label`, !ids.has(v.id) && !labels.has(v.label)); ids.add(v.id); labels.add(v.label);
  const keys = Object.keys(v.filters);
  check(`${v.id}: sets at least one filter`, keys.length > 0);
  for (const [k, x] of Object.entries(v.filters)) {
    check(`${v.id}: ${k} is one of the API's list filters`, LIST_KEYS.includes(k));
    check(`${v.id}: ${k}=${x} is a value the API accepts`, (ALLOWED[k] ?? []).includes(x), `allowed: ${JSON.stringify(ALLOWED[k])}`);
    check(`${v.id}: ${k} is a key a built-in view may set`, V.BUILTIN_KEYS.includes(k));
  }
  check(`${v.id}: needsAlerts exactly when it filters on alerts`, !!v.needsAlerts === ('alerts' in v.filters));
  check(`${v.id}: says what it shows`, typeof v.description === 'string' && v.description.length > 10);
}

// Directive §9's default views: each offered, or listed with the reason it is not.
const DIRECTIVE = {
  'Critical devices': 'critical', 'Offline devices': 'offline', 'Windows servers': 'windows-servers', 'Windows workstations': 'windows-workstations',
  'Linux devices': 'linux', 'macOS devices': 'macos', 'Devices requiring restart': 'restart', 'Missing critical patches': 'critical-updates',
  'Failed automation': null, 'Agents requiring updates': 'agent-outdated', 'Aging hardware': null, 'Expiring warranties': 'warranty', 'Backup failures': null,
};
for (const [name, id] of Object.entries(DIRECTIVE)) {
  if (id) check(`§9 "${name}" is offered as ${id}`, ids.has(id));
  else check(`§9 "${name}" is listed as not offered, with a reason`, V.NOT_OFFERED.some((n) => n.label.toLowerCase() === name.toLowerCase() && n.why.length > 10));
}
check('favourites and recent devices are offered (§9 "Favorite devices", "Recent devices")', ids.has('favorites') && ids.has('recent'));
check('the Windows views name the role and the platform both', ['windows-servers', 'windows-workstations'].every((id) => V.BUILTIN_VIEWS.find((v) => v.id === id).filters.platform === 'windows'));

// matchBuiltin: exact, customer and site kept, anything else breaks the match.
const EMPTY = { search: '', businessId: '', siteId: '', online: '', alerts: '', restartPending: false, agent: '', status: 'current', groupId: '',
  platform: '', os: '', tag: '', patches: '', rustdeskMin: '', rustdeskMax: '', notSeenDays: '', seenWithinDays: '', warranty: '', windowsRole: '', mine: '' };
for (const v of V.BUILTIN_VIEWS) {
  const f = { ...EMPTY, ...v.filters };
  check(`${v.id}: its own filters match it`, V.matchBuiltin(f)?.id === v.id);
  check(`${v.id}: still matches with a customer and site chosen`, V.matchBuiltin({ ...f, businessId: 'b1', siteId: 's1' })?.id === v.id);
  check(`${v.id}: a search breaks the match`, V.matchBuiltin({ ...f, search: 'x' }) === null);
  check(`${v.id}: archived breaks the match`, V.matchBuiltin({ ...f, status: 'all' }) === null);
  check(`${v.id}: a group breaks the match`, V.matchBuiltin({ ...f, groupId: 'g1' }) === null);
}
check('no filters is no view', V.matchBuiltin(EMPTY) === null);
check('Windows alone is not "Windows servers"', V.matchBuiltin({ ...EMPTY, platform: 'windows' }) === null);

// The web's filter shape and rule keys agree with the API's.
const types = readFileSync(join(WEB, 'components', 'endpoints', 'list', 'types.ts'), 'utf8');
const emptyKeys = [...((types.match(/export const EMPTY_FILTERS: DeviceFilters = \{([\s\S]*?)\};/) ?? [])[1] ?? '').matchAll(/(\w+):/g)].map((m) => m[1]);
check('the web\'s EMPTY_FILTERS has exactly the API\'s list filters', JSON.stringify([...emptyKeys].sort()) === JSON.stringify([...LIST_KEYS].sort()), `web ${emptyKeys.join(',')} / api ${LIST_KEYS.join(',')}`);
const gr = readFileSync(join(ROOT, 'apps', 'api', 'src', 'device-views', 'group-rule.ts'), 'utf8');
const keysIn = (t) => [...((t.match(/export const RULE_KEYS = \[([\s\S]*?)\] as const/) ?? [])[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
check('the web\'s RULE_KEYS are the API\'s', JSON.stringify(keysIn(types)) === JSON.stringify(keysIn(gr)), `${keysIn(types)} / ${keysIn(gr)}`);
check('"mine" is never a rule key on either side', !keysIn(types).includes('mine') && !keysIn(gr).includes('mine'));
const api = readFileSync(join(WEB, 'components', 'endpoints', 'list', 'api.ts'), 'utf8');
check('toParams sends windowsRole and mine', /'windowsRole', 'mine'\] as const\) \{/.test(api));
const dl = readFileSync(join(WEB, 'components', 'endpoints', 'list', 'device-list.tsx'), 'utf8');
check('the list reads windowsRole, mine and patches=critical from the address bar',
  /pick\('windowsRole', \['', 'server', 'workstation'\]/.test(dl) && /pick\('mine', \['', 'favorite', 'recent'\]/.test(dl) && /'stale', 'critical'\] as const/.test(dl));
check('a built-in view needing alerts is not offered without them', /BUILTIN_VIEWS\.filter\(\(v\) => !v\.needsAlerts \|\| alertsVisible\)/.test(dl));
check('no window.confirm left in the device list', !/window\.confirm/.test(dl));

console.log(`unit-device-list-views: ${passed} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1); }
