#!/usr/bin/env node
/**
 * Navigation preferences and items (0.87, §96): the closed lists and parsing
 * in navigation/model.ts. Pure: no database. Needs a built dist (`npx nest build`).
 *
 *   node scripts/unit-navigation.mjs
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const M = require(path.join(dist, 'navigation/model.js'));

let pass = 0, fail = 0; const failures = [];
const check = (c, m, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${m}`); } else { fail++; failures.push(m); console.log(`  \x1b[31m✗\x1b[0m ${m}${d ? `\n      ${d}` : ''}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const j = JSON.stringify;

section('Closed lists');
check(j(M.MODES) === j(['standard', 'advanced']), 'modes: standard, advanced');
check(j(M.DENSITIES) === j(['comfortable', 'compact']), 'densities: comfortable, compact');
check(j(M.GROUP_IDS) === j(['dashboard', 'devices', 'remote', 'monitoring', 'patching', 'automation', 'reports', 'security', 'admin']), 'nine groups, in menu order');
check(j(M.LISTS) === j(['favorite', 'recent']) && j(M.KINDS) === j(['device', 'business', 'site', 'script', 'page']), 'lists and kinds');
check(M.FAVORITE_CAP === 50 && M.RECENT_CAP === 15 && M.PINNED_CAP === 9, 'caps: 50 favourites, 15 recent, 9 pinned');
check(M.DEFAULT_PREFS.mode === 'standard' && M.DEFAULT_PREFS.density === 'comfortable' && M.DEFAULT_PREFS.sidebarCollapsed === false, 'defaults: Standard, comfortable, expanded');

section('refOk: a page is a console path, a record an id');
for (const p of ['/', '/endpoints', '/settings/security/containment', '/reports/patch-compliance', '/a/b/c/d/e/f']) check(M.refOk('page', p), `page ${p} is accepted`);
for (const p of ['', 'endpoints', '//evil.example.com', 'https://evil.example.com', '/endpoints/', '/Endpoints', '/a/../b', '/a?b=1', '/a#b', '/a b', '/-a', '/a/b/c/d/e/f/g', `/${'a'.repeat(42)}`, 'javascript:alert(1)', '/a\\b', '/ä']) {
  check(!M.refOk('page', p), `page ${j(p)} is refused`);
}
for (const id of ['cmwwgmmm60008ovhp1ht6wwa0', 'a1b2c3d4', 'seed-business-1', 'x'.repeat(64)]) check(M.refOk('device', id), `record id ${id.slice(0, 20)} is accepted`);
for (const id of ['short', 'x'.repeat(65), '../etc/passwd', 'a b c d e', 'abc$defgh', '/endpoints/abc']) check(!M.refOk('device', id), `record id ${j(id.slice(0, 20))} is refused`);

section('PrefsDto: strict');
const ok = (b) => M.PrefsDto.safeParse(b).success;
check(ok({}), 'an empty update is valid');
check(ok({ mode: 'advanced', sidebarCollapsed: true, pinnedGroups: ['devices'], density: 'compact', contextBusinessId: null }), 'every field');
check(!ok({ mode: 'Advanced' }), 'mode is case-sensitive');
check(!ok({ pinnedGroups: ['settings'] }), 'a group the menu does not have is refused');
check(!ok({ pinnedGroups: Array(10).fill('devices') }), 'more than nine groups is refused');
check(!ok({ theme: 'dark' }), 'an unknown field is refused');
check(!ok({ contextBusinessId: 'x' }), 'a malformed customer id is refused');
check(!ok(null) && !ok([]) && !ok('x'), 'a body that is not an object is refused');

section('ItemDto');
const item = (b) => M.ItemDto.safeParse(b).success;
check(item({ kind: 'page', ref: '/endpoints' }) && item({ kind: 'device', ref: 'cmwwgmmm60008ovhp1ht6wwa0' }), 'a page and a device');
check(!item({ kind: 'page', ref: 'https://evil.example.com' }), 'an external URL is refused');
check(!item({ kind: 'user', ref: 'cmwwgmmm60008ovhp1ht6wwa0' }), 'an unknown kind is refused');
check(!item({ kind: 'device', ref: 'cmwwgmmm60008ovhp1ht6wwa0', title: 'x' }), 'a name cannot be sent with it');

section('canonicalGroups');
check(j(M.canonicalGroups(['security', 'devices', 'security', 'nope'])) === j(['devices', 'security']), 'distinct, known, in menu order');

console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
if (fail) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1); }
