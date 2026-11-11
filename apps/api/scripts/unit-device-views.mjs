#!/usr/bin/env node
// Unit tests for device groups, saved views and bulk actions (0.33), run
// against dist with no database:
//
//   - a view's filters are the device list's own parameters, parsed by the
//     list's own parser: unknown keys, bad values and non-ids are refused,
//     false/empty are dropped, nothing else survives;
//   - an update applies no defaults (a PATCH never resets what it did not name);
//   - who may manage a business's groups and shared views;
//   - the bulk selection: de-duplicated, capped at 200 with BULK_TOO_LARGE,
//     ids only, six actions only (0.34: agent.update, agent.migrate with a
//     reason), groupId exactly where it belongs;
//   - the fleet budget stops at the guard's limits, counts a computer once,
//     lets an exempt computer through, and records only what it is told;
//   - a single action's exception becomes a per-computer reason (a 404 never
//     says more than "Computer not found").
//
// Build first: pnpm --filter @reboot-remote/api build
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const R = require(join(here, '..', 'dist', 'device-views', 'rules.js'));
const { BadRequestException, ForbiddenException, NotFoundException } = require('@nestjs/common');

let pass = 0, fail = 0;
const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const refusal = (fn) => { try { fn(); return null; } catch (e) { return e.getResponse?.() ?? { message: e.message }; } };
const ID1 = 'cmabcdefgh0001', ID2 = 'cmabcdefgh0002';

section('View filters: the list’s own parameters, nothing else');
{
  const f = R.normalizeViewFilters({ search: '  printer ', online: 'offline', restartPending: true, agent: '', alerts: null, status: 'current', siteId: ID1, groupId: ID2 });
  check(JSON.stringify(f) === JSON.stringify({ search: 'printer', siteId: ID1, online: 'offline', restartPending: true, groupId: ID2 }), 'trimmed; empty, null and the default status dropped', JSON.stringify(f));
  check(JSON.stringify(R.normalizeViewFilters({ status: 'all', restartPending: false })) === '{"status":"all"}', 'false is "not filtered"; a non-default status is kept');
  check(JSON.stringify(R.normalizeViewFilters({})) === '{}', 'an empty view is valid');
  for (const [bad, why] of [
    [{ page: '2' }, 'page'], [{ pageSize: '200' }, 'pageSize'], [{ sort: 'name' }, 'sort (stored beside the filters, not in them)'],
    [{ customerId: ID1 }, 'an unknown key'], [{ online: 'maybe' }, 'a value the list refuses'], [{ restartPending: 'yes' }, 'restartPending not true/false'],
    [{ siteId: 'x y' }, 'a non-id siteId'], [{ businessId: "'; drop" }, 'a non-id businessId'], [{ search: { $ne: 1 } }, 'an object value'], [{ online: ['online'] }, 'an array value'],
  ]) {
    const r = refusal(() => R.normalizeViewFilters(bad));
    check(r !== null, `refused: ${why}`, JSON.stringify(r));
  }
  check(R.normalizeViewFilters({ search: 'x'.repeat(500) }).search.length === 100, 'search is bounded as the list bounds it (100)');
}

section('View input and update');
{
  const v = R.ViewInput.parse({ name: ' Mine ' });
  check(v.name === 'Mine' && v.sort === 'online' && v.dir === 'asc' && v.density === 'comfortable' && v.shared === false && v.columns.length === 0, 'create fills defaults', JSON.stringify(v));
  const u = R.ViewUpdate.parse({ name: 'New' });
  check(JSON.stringify(u) === '{"name":"New"}', 'update applies NO defaults: a PATCH never resets what it did not name', JSON.stringify(u));
  check(!R.ViewUpdate.safeParse({ shared: true }).success && !R.ViewUpdate.safeParse({ businessId: ID1 }).success, 'update cannot change who a view is for (shared, businessId)');
  check(!R.ViewInput.safeParse({ name: 'x', columns: ['ok', 'not ok!'] }).success, 'column ids are a strict charset');
  check(!R.ViewInput.safeParse({ name: 'x', columns: Array.from({ length: 31 }, (_, i) => `c${i}`) }).success, 'at most 30 columns');
  check(!R.ViewInput.safeParse({ name: 'x', rows: [] }).success, 'a view stores no results (unknown body fields refused)');
  check(!R.ViewInput.safeParse({ name: 'x'.repeat(61) }).success, 'names are at most 60 characters');
}

section('Who may manage groups and shared views');
{
  const tech = (sources, businessId = 'A') => ({ userId: 't', isPlatformAdmin: false, roleType: null, businessId, capabilities: [], technician: { businessId, sources } });
  const M = (a, b = 'A') => R.manageRefusal(a, b);
  check(M({ isPlatformAdmin: true }) === null, 'Platform Admin: yes');
  check(M({ isPlatformAdmin: false, platformPermissions: ['technicians:manage'], businessId: 'Z', roleType: 'BUSINESS_USER' }) === null, 'the MSP (technicians:manage, not acting as a technician): yes');
  check(M({ isPlatformAdmin: false, roleType: 'BUSINESS_OWNER', businessId: 'A' }) === null, 'Business Owner of A: yes for A');
  check(M({ isPlatformAdmin: false, roleType: 'BUSINESS_OWNER', businessId: 'A' }, 'B') !== null, 'Business Owner of A: no for B');
  check(M({ isPlatformAdmin: false, roleType: 'BUSINESS_USER', businessId: 'A', capabilities: ['computers:view', 'computers:edit'] }) !== null, 'Business User with computers:edit: no');
  check(M(tech([{ capabilities: ['computers:view', 'computers:edit'], endpointIds: null }])) === null, 'technician, computers:edit on the whole business: yes');
  check(M(tech([{ capabilities: ['computers:edit'], endpointIds: ['e1'] }, { capabilities: ['computers:view'], endpointIds: null }])) !== null, 'technician: edit on named computers + view on all is NOT edit on all (one grant must carry both)');
  check(M(tech([{ capabilities: ['computers:edit'], endpointIds: null }], 'A'), 'B') !== null, 'technician assigned to A: no for B');
  check(M({ ...tech([{ capabilities: ['computers:edit'], endpointIds: ['e1'] }]), platformPermissions: ['technicians:manage'] }) !== null, 'technicians:manage does not lift a technician context');
}

section('Bulk selection and actions');
{
  check(R.BULK_MAX === 200, 'the cap is 200');
  const ok = Array.from({ length: 200 }, (_, i) => `cmsel${String(i).padStart(6, '0')}`);
  check(R.parseSelection(ok).length === 200, '200 ids are accepted');
  const r201 = refusal(() => R.parseSelection([...ok, 'cmsel9999999']));
  check(r201?.code === 'BULK_TOO_LARGE' && /200/.test(r201.message), '201 is BULK_TOO_LARGE, naming the cap', JSON.stringify(r201));
  check(R.parseSelection([ID1, ID2, ID1]).join() === `${ID1},${ID2}`, 'duplicates collapse, order kept');
  check(refusal(() => R.parseSelection([])) && refusal(() => R.parseSelection('x')) && refusal(() => R.parseSelection(['../etc'])), 'empty, non-list and non-id selections are refused');
  // The cap counts what was SENT: 250 copies of one id are still over it.
  check(refusal(() => R.parseSelection(Array(250).fill(ID1)))?.code === 'BULK_TOO_LARGE', 'the cap counts what was sent, before de-duplication');
  // 0.34 added the Agent card's two actions.
  check(JSON.stringify(R.BULK_ACTIONS) === JSON.stringify(['group.add', 'group.remove', 'inventory.refresh', 'client.update', 'agent.update', 'agent.migrate']), 'exactly six actions');
  check(refusal(() => R.parseBulk({ action: 'agent.migrate', endpointIds: [ID1] }))?.code === 'REASON_REQUIRED', 'agent.migrate needs a reason');
  check(R.parseBulk({ action: 'agent.migrate', endpointIds: [ID1], reason: '  pilot  ' }).reason === 'pilot', 'its reason is trimmed');
  check(refusal(() => R.parseBulk({ action: 'agent.update', endpointIds: [ID1], reason: 'abc' })) !== null, 'a reason on any other action is refused');
  check(refusal(() => R.parseBulk({ action: 'agent.migrate', endpointIds: [ID1], reason: 'x'.repeat(401) })) !== null, 'a reason over 400 characters is refused');
  for (const action of ['connect', 'archive', 'delete', 'restore', 'action.request', 'scripts.run', 'reboot']) {
    check(refusal(() => R.parseBulk({ action, endpointIds: [ID1] })) !== null, `no "${action}"`);
  }
  check(refusal(() => R.parseBulk({ action: 'group.add', endpointIds: [ID1] })) !== null, 'a group action needs groupId');
  check(refusal(() => R.parseBulk({ action: 'inventory.refresh', groupId: ID2, endpointIds: [ID1] })) !== null, 'groupId only on group actions');
  check(refusal(() => R.parseBulk({ action: 'inventory.refresh', endpointIds: [ID1], force: true })) !== null, 'unknown body fields are refused');
  check(R.parseBulk({ action: 'group.remove', groupId: ID2, endpointIds: [ID1] }).groupId === ID2, 'a well-formed group request parses');
}

section('Fleet budget');
{
  const L = { devices: 3, businesses: 1 };
  const b = new R.FleetBudget(['e1'], ['A']);
  check(b.wouldExceed('e1', 'A', L) === null, 'a computer already counted costs nothing');
  check(b.wouldExceed('e2', 'A', L) === null, 'a new computer under the limit is fine');
  b.admitted('e2', 'A'); b.admitted('e3', 'A');
  check(/devices 4 > 3/.test(b.wouldExceed('e4', 'A', L) ?? ''), 'the fourth distinct computer would exceed 3');
  check(b.wouldExceed('e2', 'A', L) === null, 'repeating an admitted one is still fine');
  check(/businesses 2 > 1/.test(new R.FleetBudget([], ['A']).wouldExceed('x', 'B', L) ?? ''), 'a second business would exceed 1');
  const ex = new R.FleetBudget(['e1', 'e2', 'e3'], ['A'], new Set(['e9']));
  check(ex.wouldExceed('e9', 'B', L) === null && ex.wouldExceed('e8', 'A', L) !== null, 'a maintenance exception lets only its computers past');
  const c = new R.FleetBudget([], []);
  c.wouldExceed('e1', 'A', L);
  check(c.wouldExceed('e2', 'A', { devices: 1, businesses: 1 }) === null, 'asking records nothing; only admitted() does');
}

section('A single action’s refusal, per computer');
{
  check(JSON.stringify(R.refusalOf(new NotFoundException('Computer xyz in Birch Corp not found'))) === JSON.stringify({ code: 'NOT_FOUND', reason: 'Computer not found' }), 'a 404 is only ever "Computer not found"');
  check(R.refusalOf(new ForbiddenException({ code: 'IDENTITY_PAUSED', message: 'paused' })).code === 'IDENTITY_PAUSED', 'a coded 403 keeps its code');
  check(R.refusalOf(new ForbiddenException('You do not have permission')).code === 'NOT_ALLOWED', 'an uncoded 403 is NOT_ALLOWED');
  check(R.refusalOf(new BadRequestException({ code: 'LINUX_READ_ONLY', message: 'm' })).code === 'LINUX_READ_ONLY', 'a coded 400 keeps its code');
  const e = R.refusalOf(new Error('connect ECONNREFUSED 10.0.0.5:5432'));
  check(e.code === 'ERROR' && !/10\.0\.0\.5/.test(e.reason), 'an unexpected error says nothing about why');
}

console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
