#!/usr/bin/env node
// Unit tests for group-scoped policies (0.35), run against dist with no
// database:
//
//   - precedence: computer > device group > site > business > global, for
//     the shared resolver, for monitor inheritance (effectiveRules) and for
//     client-update policies (resolvePolicy / effectivePolicy);
//   - two groups a computer is in: the lower priority wins (1 first),
//     whatever order the rows arrive in — every permutation is tried;
//   - a group policy only applies to a computer in that group AND in the
//     policy's business; a group the computer left no longer applies;
//   - a disabled group monitor switches an inherited monitor off, and a
//     disabled group client-update policy beats an enabled business one;
//   - what beat what, and why, is reported (outranked / outcome / explain).
//
// Build first: pnpm --filter @reboot-remote/api build
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const P = require(join(here, '..', 'dist', 'group-policy', 'precedence.js'));
const M = require(join(here, '..', 'dist', 'monitoring', 'engine.js'));
const C = require(join(here, '..', 'dist', 'client-updates', 'policy.js'));

let pass = 0, fail = 0;
const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const J = JSON.stringify;
const perms = (a) => (a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p])));

section('The shared resolver');
{
  const cands = [
    { id: 'p-global', scope: 'global' }, { id: 'p-biz', scope: 'business' }, { id: 'p-site', scope: 'site' },
    { id: 'p-g5', scope: 'group', priority: 5 }, { id: 'p-g2', scope: 'group', priority: 2 }, { id: 'p-ep', scope: 'endpoint' },
  ];
  const orders = perms(cands);
  const want = ['p-ep', 'p-g2', 'p-g5', 'p-site', 'p-biz', 'p-global'];
  check(`computer > group (priority 1 first) > site > business > global, in all ${orders.length} input orders`,
    orders.every((o) => J(P.resolve(o).ranked.map((x) => x.id)) === J(want)), J(P.resolve(cands).ranked.map((x) => x.id)));
  const noEp = P.resolve(cands.filter((c) => c.scope !== 'endpoint'));
  check('without a computer policy, the group with priority 2 wins over priority 5', noEp.winner.id === 'p-g2');
  check('the loser between groups is marked "priority", the broader ones "more_specific"',
    noEp.ranked.find((x) => x.id === 'p-g5').outcome.reason === 'priority' && noEp.ranked.find((x) => x.id === 'p-site').outcome.reason === 'more_specific'
      && noEp.ranked.every((x) => x.id === 'p-g2' || x.outcome.by === 'p-g2'), J(noEp.ranked.map((x) => [x.id, x.outcome])));
  const tie = P.resolve([{ id: 'zz', scope: 'group', priority: 3 }, { id: 'aa', scope: 'group', priority: 3 }]);
  check('an equal priority (which the database refuses) is still decided, by id, not by input order',
    tie.winner.id === 'aa' && P.resolve([{ id: 'aa', scope: 'group', priority: 3 }, { id: 'zz', scope: 'group', priority: 3 }]).winner.id === 'aa' && tie.ranked[1].outcome.reason === 'tie_id');
  check('nothing applicable: no winner', P.resolve([]).winner === null);
  check('comparePrecedence never calls two different policies equal',
    cands.every((a) => cands.every((b) => a.id === b.id || P.comparePrecedence(a, b) !== 0)));
  check('priority bounds are 1–999', P.PRIORITY_MIN === 1 && P.PRIORITY_MAX === 999);

  const ep = { id: 'e1', customerId: 'A', siteId: 's1', groupIds: new Set(['g1']) };
  check('a group policy applies to a member of that group in the same business', P.applies({ scope: 'group', customerId: 'A', groupId: 'g1' }, ep));
  check('…not to a computer outside the group', !P.applies({ scope: 'group', customerId: 'A', groupId: 'g2' }, ep));
  check('…and not to a member if the policy is another business’s (defence in depth: the trigger refuses it)', !P.applies({ scope: 'group', customerId: 'B', groupId: 'g1' }, ep));
  check('…and not to a computer in no business', !P.applies({ scope: 'group', customerId: 'A', groupId: 'g1' }, { ...ep, customerId: null }));
  check('membership may be an array or a set', P.applies({ scope: 'group', customerId: 'A', groupId: 'g1' }, { ...ep, groupIds: ['g1'] }));

  const ex = P.explain(noEp, (p) => p.id);
  check('explain names the winning group, its priority, the group it beat on priority and the broader ones',
    /p-g2 applies because the computer is in that group, at priority 2/.test(ex) && /p-g5 \(priority 5\) on priority/.test(ex) && /more specific than p-site, p-biz, p-global/.test(ex), ex);
}

section('Monitors: group scope in inheritance');
{
  const ep = { id: 'ep1', customerId: 'biz1', siteId: 'site1' };
  const scopes = M.scopesFor(ep, ['gB', 'gA']);
  check('scopesFor puts groups between site and computer, sorted', J(scopes) === J(['global', 'b:biz1', 's:site1', 'g:gA', 'g:gB', 'e:ep1']), J(scopes));
  check('scopesFor without groups is unchanged', J(M.scopesFor(ep)) === J(['global', 'b:biz1', 's:site1', 'e:ep1']));
  check('a computer in no business gets no group scopes', J(M.scopesFor({ id: 'x', customerId: null, siteId: null }, ['gA'])) === J(['global', 'e:x']));
  check('scopeKeyOf / scopeOfKey know the group scope', M.scopeKeyOf({ scope: 'group', id: 'gA' }) === 'g:gA' && M.scopeOfKey('g:gA') === 'group' && M.scopeOfKey('x:1') === null);
  const r = (id, scopeKey, extra = {}) => ({ id, scopeKey, key: 'disk', kind: 'DISK_FREE', enabled: true, severity: 'WARNING', params: { minFreePercent: 10 }, name: id, ...extra });
  const rules = [r('global', 'global'), r('biz', 'b:biz1'), r('site', 's:site1'), r('gA', 'g:gA', { priority: 7 }), r('gB', 'g:gB', { priority: 2 })];
  const all = perms(rules);
  check(`two group monitors with one key: priority 2 beats 7, in all ${all.length} row orders`,
    all.every((o) => { const e = M.effectiveRules(o, scopes); return e.length === 1 && e[0].id === 'gB'; }));
  const win = M.effectiveRules(rules, scopes)[0];
  check('it records what it beat: group gA on priority, the site, business and global as broader',
    win.inheritedFrom === 'g:gB' && J(win.outranked.map((o) => [o.scopeKey, o.reason])) === J([['g:gA', 'priority'], ['s:site1', 'more_specific'], ['b:biz1', 'more_specific'], ['global', 'more_specific']]),
    J(win.outranked));
  check('overrides lists the same scopes, in precedence order', J(win.overrides) === J(['g:gA', 's:site1', 'b:biz1', 'global']));
  check('a computer monitor still beats every group', M.effectiveRules([...rules, r('mine', 'e:ep1')], scopes)[0].id === 'mine');
  check('a computer that left gB follows gA', M.effectiveRules(rules, M.scopesFor(ep, ['gA']))[0].id === 'gA');
  check('a computer in neither group follows the site', M.effectiveRules(rules, M.scopesFor(ep, []))[0].id === 'site');
  check('a group monitor beats the site even with a large priority number', M.effectiveRules([r('site', 's:site1'), r('gA', 'g:gA', { priority: 999 })], scopes)[0].id === 'gA');
  check('a disabled group monitor switches the inherited one off for its members',
    M.effectiveRules([r('biz', 'b:biz1'), r('gA', 'g:gA', { priority: 1, enabled: false })], scopes).length === 0
      && M.effectiveRules([r('biz', 'b:biz1'), r('gA', 'g:gA', { priority: 1, enabled: false })], M.scopesFor(ep, [])).length === 1);
  check('a rule at a scope key this build does not know is ignored, not ranked', M.effectiveRules([r('odd', 'x:ep1'), r('biz', 'b:biz1')], [...scopes, 'x:ep1'])[0].id === 'biz');
}

section('Client updates: group policies');
{
  const pol = (id, extra) => ({ id, customerId: 'A', siteId: null, groupId: null, priority: null, enabled: true, timeZone: 'UTC', windows: [], skipActiveSession: true, skipLoggedOnUser: false, ...extra });
  const list = [
    pol('bA', {}), pol('sA1', { siteId: 'site1', enabled: false }),
    pol('gKiosk', { groupId: 'kiosk', priority: 1, enabled: false }), pol('gTill', { groupId: 'till', priority: 4 }),
    pol('bB', { customerId: 'B' }), pol('gB', { customerId: 'B', groupId: 'other', priority: 1 }),
  ];
  const eff = (siteId, groups, cid = 'A') => C.effectivePolicy(list, cid, siteId, groups)?.id ?? null;
  check('no group: site override, else business (unchanged from 0.32)', eff('site1', []) === 'sA1' && eff(null, []) === 'bA' && eff('site9', []) === 'bA');
  check('a group policy beats the site override', eff('site1', ['till']) === 'gTill');
  check('in two groups: priority 1 (kiosk, off) beats priority 4 (till, on) — off wins, as an override does', eff('site1', ['till', 'kiosk']) === 'gKiosk' && eff(null, new Set(['kiosk', 'till'])) === 'gKiosk');
  check('every row order gives the same answer', perms(list).every((o) => C.effectivePolicy(o, 'A', 'site1', ['till', 'kiosk'])?.id === 'gKiosk'));
  check('another business’s group policy never applies, even with a matching group id', eff(null, ['other']) === 'bA' && eff(null, ['other'], 'B') === 'gB');
  check('the computer leaving the group drops the group policy', eff(null, ['kiosk']) === 'gKiosk' && eff(null, []) === 'bA');
  check('policyScope', C.policyScope({ siteId: null, groupId: 'g' }) === 'group' && C.policyScope({ siteId: 's', groupId: null }) === 'site' && C.policyScope({ siteId: null, groupId: null }) === 'business');
  const res = C.resolvePolicy(list, { id: 'e', customerId: 'A', siteId: 'site1', groupIds: ['kiosk', 'till'] });
  check('resolvePolicy ranks every applicable policy with its outcome',
    J(res.ranked.map((p) => [p.id, p.outcome.reason])) === J([['gKiosk', 'won'], ['gTill', 'priority'], ['sA1', 'more_specific'], ['bA', 'more_specific']]), J(res.ranked.map((p) => [p.id, p.outcome])));
  const why = C.explainPolicy(res, { group: (g) => ({ kiosk: 'Kiosks', till: 'Tills' })[g], site: () => 'Leeds' });
  check('explainPolicy reads as a sentence with names', /^the policy of group Kiosks applies because the computer is in that group, at priority 1; it is ahead of the policy of group Tills \(priority 4\) on priority, 1 first; and it is more specific than the override for site Leeds, the business policy\.$/.test(why), why);
  const parsed = C.PolicyInput.safeParse({ businessId: 'cmbusiness001', groupId: 'cmgroup00001', priority: 0, enabled: false, timeZone: 'UTC', windows: [{ days: [1], start: '22:00', end: '05:00' }] });
  check('PolicyInput refuses priority 0', !parsed.success);
  check('PolicyInput accepts a group with priority 1', C.PolicyInput.safeParse({ businessId: 'cmbusiness001', groupId: 'cmgroup00001', priority: 1, enabled: false, timeZone: 'UTC', windows: [{ days: [1], start: '22:00', end: '05:00' }] }).success);
  check('RuleInput accepts scope "group"; RulePatch accepts a priority', M.RuleInput.safeParse({ scope: 'group', groupId: 'cmgroup00001', priority: 3, key: 'k', kind: 'OFFLINE', name: 'n' }).success && M.RulePatch.safeParse({ priority: 2 }).success && !M.RulePatch.safeParse({ priority: 1000 }).success);
}

console.log(`\nunit-group-policy: ${pass} passed, ${fail} failed`);
if (fail) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
