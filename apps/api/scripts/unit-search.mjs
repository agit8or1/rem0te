#!/usr/bin/env node
/**
 * Global search (0.33): query parsing, LIKE escaping, ranking and the
 * address heuristic. Pure: no database, no API. Needs a built dist
 * (`npx nest build`).
 *
 *   node scripts/unit-search.mjs
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const Q = require(path.join(dist, 'search/query.js'));

let pass = 0, fail = 0; const failures = [];
const check = (c, m, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${m}`); } else { fail++; failures.push(m); console.log(`  \x1b[31m✗\x1b[0m ${m}${d ? `\n      ${d}` : ''}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const code = (fn) => { try { fn(); return null; } catch (e) { return e.getResponse?.().code ?? e.message; } };

section('parseSearchQuery');
check(Q.parseSearchQuery('  ab ') === 'ab', 'trims');
check(Q.parseSearchQuery('a   b\tc') === 'a b c', 'collapses whitespace');
check(code(() => Q.parseSearchQuery(undefined)) === 'INVALID_QUERY', 'missing is INVALID_QUERY');
check(code(() => Q.parseSearchQuery(['ab', 'cd'])) === 'INVALID_QUERY', 'an array (q given twice) is INVALID_QUERY');
check(code(() => Q.parseSearchQuery(42)) === 'INVALID_QUERY', 'a non-string is INVALID_QUERY');
check(code(() => Q.parseSearchQuery('a')) === 'QUERY_TOO_SHORT', 'one character is too short');
check(code(() => Q.parseSearchQuery(' a ')) === 'QUERY_TOO_SHORT', 'one character padded with spaces is too short');
check(code(() => Q.parseSearchQuery('​​a')) === 'QUERY_TOO_SHORT', 'zero-width characters do not count');
check(code(() => Q.parseSearchQuery('a\u0000\u0007')) === 'QUERY_TOO_SHORT', 'control characters do not count');
check(Q.parseSearchQuery('a‮b') === 'ab', 'a bidi override is removed');
check(code(() => Q.parseSearchQuery('x'.repeat(Q.MAX_QUERY + 1))) === 'QUERY_TOO_LONG', `${Q.MAX_QUERY + 1} characters is too long`);
check(Q.parseSearchQuery('x'.repeat(Q.MAX_QUERY)).length === Q.MAX_QUERY, `${Q.MAX_QUERY} characters is accepted`);
check(Q.MIN_QUERY === 2 && Q.MAX_QUERY === 100 && Q.GROUP_CAP === 8, 'limits: 2–100 characters, 8 per group');

section('likeEscape / likePatterns');
check(Q.likeEscape('50%_off\\x') === '50\\%\\_off\\\\x', "'%', '_' and '\\' are escaped");
check(Q.likeEscape('plain-text.1') === 'plain-text.1', 'ordinary text is unchanged');
{
  const p = Q.likePatterns('AB%c');
  check(p.exact === 'ab%c' && p.prefix === 'ab\\%c%' && p.contains === '%ab\\%c%', 'patterns are lower-cased; exact is not escaped, prefix and contains are', JSON.stringify(p));
}

section('rankOf');
check(Q.rankOf('PC-01', 'pc-01') === 0, 'exact (any case) is 0');
check(Q.rankOf('PC-010', 'pc-01') === 1, 'prefix is 1');
check(Q.rankOf('X-PC-01', 'pc-01') === 2, 'anywhere is 2');
check(Q.rankOf('nope', 'pc') === null && Q.rankOf(null, 'pc') === null, 'no match or no value is null');

section('nameWords');
check(JSON.stringify(Q.nameWords('jane doe')) === '["jane","doe"]', 'splits words');
check(JSON.stringify(Q.nameWords('a a b')) === '["a","b"]', 'deduplicates');
check(Q.nameWords('a b c d e f g').length === 5, 'at most five words');

section('looksLikeAddress');
for (const s of ['10.0.0.5', '192.168', '10.1.', 'fe80::1', '2001:db8::/32']) check(Q.looksLikeAddress(s), `"${s}" is address-like`);
for (const s of ['pc-1234', 'abc', '1234', 'jdoe', 'beef.cafe', '10.0.0.5"', '10\\0']) check(!Q.looksLikeAddress(s), `"${s}" is not (no separator, no digit, or a character JSON would escape)`);

section('GROUP_CAPABILITY names each list page’s gate');
check(JSON.stringify(Q.GROUP_CAPABILITY) === JSON.stringify({ computers: 'computers:view', businesses: null, sites: 'computers:view', users: 'users:view', alerts: 'monitoring:alerts' }), 'computers/sites computers:view, users users:view, alerts monitoring:alerts, businesses none', JSON.stringify(Q.GROUP_CAPABILITY));
check(JSON.stringify(Q.GROUPS) === JSON.stringify(Object.keys(Q.GROUP_CAPABILITY)), 'every group has a gate entry');

console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
if (fail) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
