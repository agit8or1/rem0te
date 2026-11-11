#!/usr/bin/env node
// Unit tests for rule-based device groups (0.34), run against dist with no
// database:
//
//   - a rule is the device list's own filters, parsed by the list's own
//     parser: it round-trips (parse → store → parse gives the same filters),
//     unknown keys and the refused list filters (search, businessId, groupId,
//     status) are refused by name, values the list refuses are refused, and
//     an empty rule is refused;
//   - every value is closed: an enum member, an id, a bounded day count, a
//     dotted version or a charset-checked term — SQL-looking input is refused
//     before anything could use it;
//   - a rule read back from the database that no longer parses is null
//     (matches nothing), never "no conditions";
//   - the new list filters parse the same way on the list itself and in a
//     saved view (one parser), and versions compare numerically;
//   - bulk: endpointIds XOR targetGroupId; a group is never its own target.
//
// Build first: pnpm --filter @reboot-remote/api build
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const G = require(join(here, '..', 'dist', 'device-views', 'group-rule.js'));
const R = require(join(here, '..', 'dist', 'device-views', 'rules.js'));
const Q = require(join(here, '..', 'dist', 'endpoints', 'list-query.js'));

let pass = 0, fail = 0;
const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const refusal = (fn) => { try { fn(); return null; } catch (e) { return e.getResponse?.() ?? { message: e.message }; } };
const J = JSON.stringify;
const SITE = 'cmsiteabcd0001', G1 = 'cmgroupabc0001';

section('A rule round-trips through the list’s own parser');
{
  const raw = {
    online: 'offline', siteId: SITE, platform: 'windows', os: 'Windows 11', tag: 'kiosk', patches: 'pending',
    rustdeskMin: '1.2', rustdeskMax: '1.4.1', notSeenDays: '7', restartPending: true, agent: 'signed', alerts: 'critical',
  };
  const stored = G.parseRule(raw);
  check(J(stored) === J({ siteId: SITE, online: 'offline', alerts: 'critical', restartPending: true, agent: 'signed', platform: 'windows', os: 'Windows 11', tag: 'kiosk', patches: 'pending', rustdeskMin: '1.2', rustdeskMax: '1.4.1', notSeenDays: '7' }),
    'stored in list-filter order, every value a string or true', J(stored));
  check(J(G.parseRule(stored)) === J(stored), 'parse(stored) === stored (idempotent)');
  const f = G.ruleFilters(stored);
  check(f && f.notSeenDays === 7 && f.platform === 'windows' && f.restartPending === true && f.status === undefined, 'read back as list filters: days a number, no status constraint', J(f));
  check(J(Q.storedForm(f, G.RULE_KEYS)) === J(stored), 'storedForm(ruleFilters(stored)) === stored');
  check(J(G.parseRule({ online: 'online', restartPending: false, tag: '' })) === '{"online":"online"}', 'false and empty are "no condition" and are dropped');
  check(J(G.parseRule({ seenWithinDays: 30 })) === '{"seenWithinDays":"30"}', 'a whole-number day count may be sent as a number');
  check(G.parseRule({ os: '  ubuntu ' }).os === 'ubuntu', 'terms are trimmed as the list trims them');
}

section('Refused: unknown keys, the list filters a rule may not carry, empty rules');
{
  for (const [bad, why] of [
    [{ search: 'printer' }, 'search (free text)'], [{ businessId: SITE }, 'businessId (the group’s own)'], [{ groupId: G1 }, 'groupId (no nesting)'],
    [{ status: 'archived' }, 'status'], [{ customerId: SITE }, 'an unknown key'], [{ online: 'online', sql: 'x' }, 'an unknown key beside a good one'],
    [{ page: '2' }, 'page'], [{ sort: 'name' }, 'sort'],
  ]) {
    const r = refusal(() => G.parseRule(bad));
    check(r?.code === 'INVALID_RULE', `refused: ${why}`, J(r));
  }
  check(/search/.test(refusal(() => G.parseRule({ search: 'x' }))?.message ?? ''), 'a refused key is named in the message');
  for (const [bad, why] of [[{}, 'an empty rule'], [{ online: '' }, 'a rule whose only condition is empty'], [null, 'null'], [[], 'an array'], ['online', 'a string'], [{ toString: 1 }, 'a prototype-ish key']]) {
    check(refusal(() => G.parseRule(bad))?.code === 'INVALID_RULE', `refused: ${why}`);
  }
}

section('Refused: values the list refuses — every value is closed');
{
  for (const [bad, why] of [
    [{ online: 'maybe' }, 'online not online/offline'], [{ platform: 'beos' }, 'an unknown platform'], [{ patches: 'some' }, 'an unknown patch state'],
    [{ alerts: 'all' }, 'an unknown alert state'], [{ agent: 'rogue' }, 'an unknown agent type'], [{ restartPending: 'yes' }, 'restartPending not true/false'],
    [{ siteId: "x' OR '1'='1" }, 'a non-id siteId'], [{ siteId: 'short' }, 'a too-short siteId'],
    [{ os: "x'; DROP TABLE \"Endpoint\"; --" }, 'an OS term with quotes and semicolons'], [{ os: '%' }, 'an OS term that is a LIKE wildcard'], [{ os: 'a\\b' }, 'an OS term with a backslash'],
    [{ tag: 'a\u0000b' }, 'a tag with a control character'],
    [{ rustdeskMin: '1.4; select 1' }, 'a version with SQL in it'], [{ rustdeskMin: '1.x' }, 'a non-numeric version'], [{ rustdeskMin: '1.2.3.4.5' }, 'a version with five parts'],
    [{ rustdeskMin: '1.5', rustdeskMax: '1.4' }, 'min above max'],
    [{ notSeenDays: '0' }, 'zero days'], [{ notSeenDays: '-1' }, 'negative days'], [{ notSeenDays: '3651' }, 'more than ten years'], [{ notSeenDays: '1e3' }, 'days in exponent form'], [{ seenWithinDays: 1.5 }, 'fractional days'],
    [{ online: { $ne: 1 } }, 'an object value'], [{ online: ['online'] }, 'an array value'], [{ notSeenDays: 7.0001 }, 'a non-integer number'],
  ]) {
    const r = refusal(() => G.parseRule(bad));
    check(r?.code === 'INVALID_RULE', `refused: ${why}`, J(r));
  }
  check(G.parseRule({ tag: 'Front desk / 2nd floor' }).tag === 'Front desk / 2nd floor', 'a tag is any printable text (matched exactly, as a bound parameter)');
  check(G.parseRule({ os: 'Server 2022 (x64)' }).os === 'Server 2022 (x64)', 'an OS term may hold letters, digits, spaces, dots, brackets');
}

section('A stored rule that no longer parses matches nothing');
{
  check(G.ruleFilters({ online: 'sometimes' }) === null, 'a bad value → null');
  check(G.ruleFilters({ search: 'x' }) === null, 'a refused key → null');
  check(G.ruleFilters({}) === null, 'an empty object → null (never "every computer")');
  check(G.ruleFilters(null) === null && G.ruleFilters('{"online":"online"}') === null, 'null or a JSON string → null');
  check(G.ruleNeedsAlerts(G.ruleFilters({ alerts: 'any' })) === true && G.ruleNeedsAlerts(G.ruleFilters({ online: 'online' })) === false && G.ruleNeedsAlerts(null) === false, 'ruleNeedsAlerts');
}

section('One parser: the list, a saved view and a rule accept the same new filters');
{
  const q = Q.parseListQuery({ platform: 'linux', patches: 'stale', rustdeskMin: '1.3', notSeenDays: '30', os: 'ubuntu', tag: 'lab' });
  check(q.platform === 'linux' && q.patches === 'stale' && q.rustdeskMin === '1.3' && q.notSeenDays === 30 && q.os === 'ubuntu' && q.tag === 'lab', 'the list parses them', J(q));
  check(refusal(() => Q.parseListQuery({ platform: 'beos' })) !== null && refusal(() => Q.parseListQuery({ os: "'" })) !== null, 'the list refuses what a rule refuses');
  const v = R.normalizeViewFilters({ platform: 'macos', seenWithinDays: '7', online: 'online' });
  check(J(v) === J({ online: 'online', platform: 'macos', seenWithinDays: '7' }), 'a saved view stores them too', J(v));
  check(refusal(() => R.normalizeViewFilters({ groupRule: { customerId: 'x' } })) !== null, 'a view cannot smuggle the internal groupRule');
  check(Q.parseListQuery({ groupRule: { customerId: SITE, rule: {} } }).groupRule === undefined,
    'parseListQuery never reads groupRule from a request');
  check(Q.LIST_FILTER_KEYS.every((k) => G.RULE_KEYS.includes(k) || k in G.RULE_REFUSED), 'every list filter is either allowed in a rule or refused by name');
  check(G.RULE_KEYS.every((k) => Q.LIST_FILTER_KEYS.includes(k)), 'every rule key is a list filter');
}

section('Versions compare as numbers');
{
  check(Q.compareVersions('1.10', '1.9') > 0 && Q.compareVersions('1.4', '1.4.0') === 0 && Q.compareVersions('1.3.9', '1.4') < 0, '1.10 > 1.9; 1.4 = 1.4.0; 1.3.9 < 1.4');
  check(J(Q.versionParts('1.4.2')) === '[1,4,2]' && Q.versionParts('1.4.2-nightly') === null && Q.versionParts(null) === null, 'versionParts: dotted numbers only');
}

section('Bulk on a group: endpointIds XOR targetGroupId');
{
  const b = R.parseBulk({ action: 'inventory.refresh', targetGroupId: G1 });
  check(b.targetGroupId === G1 && b.endpointIds === undefined, 'targetGroupId alone parses');
  check(refusal(() => R.parseBulk({ action: 'inventory.refresh', targetGroupId: G1, endpointIds: [SITE] }))?.code === 'INVALID_REQUEST', 'both refused');
  check(refusal(() => R.parseBulk({ action: 'inventory.refresh' }))?.code === 'INVALID_REQUEST', 'neither refused');
  check(refusal(() => R.parseBulk({ action: 'inventory.refresh', targetGroupId: "x' or 1=1" }))?.code === 'INVALID_REQUEST', 'a non-id target refused');
  check(refusal(() => R.parseBulk({ action: 'group.add', groupId: G1, targetGroupId: G1 }))?.code === 'INVALID_REQUEST', 'a group is never its own target');
  check(R.parseBulk({ action: 'group.add', groupId: G1, targetGroupId: 'cmgroupabc0002' }).groupId === G1, 'members of one group into another parses');
}

console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
