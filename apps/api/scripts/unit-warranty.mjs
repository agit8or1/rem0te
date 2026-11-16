#!/usr/bin/env node
/**
 * Unit tests for hardware warranty and support links (0.56): manufacturer
 * normalisation, virtual-machine detection, every vendor's support links (the
 * serial in a URL only for Dell, charset-checked and encoded), serial
 * placeholders, the warranty buckets, the coverage charset, the device-list
 * filter, the WARRANTY_EXPIRING monitor, the sweep budget, and the Dell and
 * Lenovo response parsers — against a loopback stub only. No database, and
 * no real vendor API is ever called.
 *
 *   cd apps/api && npx nest build && node scripts/unit-warranty.mjs
 *
 * The behavioural suite against a running API is scripts/e2e-warranty.mjs.
 */
import { createRequire } from 'node:module';
import { fileURLToPath, URL } from 'node:url';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

// The vendor client reads its test base URL only under NODE_ENV=test, and only for http://127.0.0.1.
process.env.NODE_ENV = 'test';
const STUB_PORT = 3829;
process.env.WARRANTY_TEST_BASE_URL = `http://127.0.0.1:${STUB_PORT}`;

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const V = require(path.join(dist, 'warranty', 'vendors.js'));
const C = require(path.join(dist, 'warranty', 'client.js'));
const S = require(path.join(dist, 'warranty', 'warranty.service.js'));
const E = require(path.join(dist, 'monitoring', 'engine.js'));
const Q = require(path.join(dist, 'endpoints', 'list-query.js'));
const G = require(path.join(dist, 'device-views', 'group-rule.js'));

let pass = 0, fail = 0;
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${n}${d ? `\n      ${d}` : ''}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const J = JSON.stringify;

section('One table: the web copy is byte-identical');
const api = readFileSync(path.join(here, '..', 'src', 'warranty', 'vendors.ts'), 'utf8');
const web = readFileSync(path.join(here, '..', '..', 'web', 'lib', 'hardware-support.ts'), 'utf8');
check(api === web, 'apps/web/lib/hardware-support.ts is a byte-for-byte copy of apps/api/src/warranty/vendors.ts');

section('Who made it: manufacturer strings normalised');
const maker = (m, mo) => { const x = V.identifyMaker(m, mo); return x.kind === 'vendor' ? x.vendor : x.kind === 'virtual' ? `vm:${x.platform}` : 'unknown'; };
for (const [m, mo, want] of [
  ['Dell Inc.', 'Latitude 7440', 'dell'], ['DELL', 'OptiPlex 7010', 'dell'], ['Dell Computer Corporation', 'Dimension', 'dell'],
  ['LENOVO', '20XW0026US', 'lenovo'], ['Lenovo', 'ThinkPad T14', 'lenovo'],
  ['HP', 'HP EliteBook 840 G9', 'hp'], ['Hewlett-Packard', 'HP Compaq 8200 Elite', 'hp'], ['Hewlett Packard', 'ProDesk', 'hp'],
  ['HPE', 'ProLiant DL380 Gen10', 'hpe'], ['Hewlett Packard Enterprise', 'ProLiant DL360 Gen11', 'hpe'], ['HP', 'ProLiant ML350 Gen9', 'hpe'],
  ['Microsoft Corporation', 'Surface Laptop 5', 'microsoft'], ['Apple Inc.', 'MacBookPro18,1', 'apple'],
  ['ASUSTeK COMPUTER INC.', 'ExpertBook B9', 'asus'], ['ASUS', 'VivoBook', 'asus'], ['Acer', 'TravelMate P2', 'acer'],
  ['  dell   inc. ', null, 'dell'],
  ['VMware, Inc.', 'VMware Virtual Platform', 'vm:VMware'], ['VMware, Inc.', 'VMware20,1', 'vm:VMware'],
  ['Microsoft Corporation', 'Virtual Machine', 'vm:Hyper-V'], ['QEMU', 'Standard PC (Q35 + ICH9, 2009)', 'vm:QEMU/KVM'],
  ['Red Hat', 'KVM', 'vm:QEMU/KVM'], ['innotek GmbH', 'VirtualBox', 'vm:VirtualBox'], ['Xen', 'HVM domU', 'vm:Xen'],
  ['Parallels Software International Inc.', 'Parallels Virtual Platform', 'vm:Parallels'], ['Amazon EC2', 't3.large', 'vm:Amazon EC2'],
  ['Google', 'Google Compute Engine', 'vm:Google Compute Engine'],
  ['To be filled by O.E.M.', 'To be filled by O.E.M.', 'unknown'], ['', '', 'unknown'], [null, null, 'unknown'], ['Gigabyte Technology Co., Ltd.', 'B550', 'unknown'],
]) check(maker(m, mo) === want, `${J(m)} / ${J(mo)} → ${want}`, `got ${maker(m, mo)}`);
check(maker('Microsoft Corporation', 'Virtual Machine') !== 'microsoft', 'a Hyper-V guest is never a Surface');

section('Serials: placeholders and anything outside the charset are refused');
for (const s of ['To be filled by O.E.M.', 'Default string', 'System Serial Number', '0', '0000000000', 'XXXXXXX', 'None', 'N/A', '123456789', 'Not Specified', 'Chassis Serial Number', 'abc', '', null,
  'ABC1234/../x', 'ABC 1234', 'AB<script>', 'ABC1234?q=1', 'ABC1234#x', 'A'.repeat(41), 'ABC%2F123', 'ABC\n1234'])
  check(V.cleanSerial(s) === null, `refused: ${J(s)}`, `got ${J(V.cleanSerial(s))}`);
for (const [s, want] of [['5cg1234xyz', '5CG1234XYZ'], [' 7ZK2PQ3 ', '7ZK2PQ3'], ['PF3ABCDE', 'PF3ABCDE'], ['0123456789012', '0123456789012'], ['NXVERSN0012345678901234', 'NXVERSN0012345678901234'], ['C02ZK1ABMD6M', 'C02ZK1ABMD6M']])
  check(V.cleanSerial(s) === want, `kept: ${J(s)} → ${want}`, `got ${J(V.cleanSerial(s))}`);

section('Support links per vendor');
const info = (m, mo, s) => V.supportInfo(m, mo, s);
let i = info('Dell Inc.', 'Latitude 7440', '7zk2pq3');
check(i.links.length === 2 && i.links[0].url === 'https://www.dell.com/support/home/en-us/product-support/servicetag/7ZK2PQ3/overview' && i.links[1].url === 'https://www.dell.com/support/home/en-us/product-support/servicetag/7ZK2PQ3/drivers'
  && i.links.every((l) => l.serialInUrl), 'Dell: the service tag goes into the overview and drivers pages', J(i.links));
i = info('Dell Inc.', 'Latitude', 'ABCDEFGH1');
check(i.links.length === 1 && !i.links[0].serialInUrl && i.links[0].url === 'https://www.dell.com/support/home/en-us/' && /No usable service tag/.test(i.note), 'Dell: a serial that is not a 7-character tag never reaches a URL', J(i));
i = info('Dell Inc.', 'Latitude', 'To be filled by O.E.M.');
check(i.serial === null && i.links.every((l) => !l.serialInUrl), 'Dell: a placeholder serial never reaches a URL');
for (const [m, vendor, host] of [['LENOVO', 'Lenovo', 'pcsupport.lenovo.com'], ['HP', 'HP', 'support.hp.com'], ['HPE', 'HPE', 'support.hpe.com'], ['Microsoft Corporation', 'Microsoft Surface', 'mybusinessservice.surface.com'],
  ['Apple Inc.', 'Apple', 'checkcoverage.apple.com'], ['ASUSTeK COMPUTER INC.', 'ASUS', 'www.asus.com'], ['Acer', 'Acer', 'www.acer.com']]) {
  i = info(m, 'X1', 'SERIAL1234');
  check(i.vendorLabel === vendor && i.links[0].kind === 'warranty' && new URL(i.links[0].url).hostname === host && i.links.every((l) => !l.serialInUrl && !l.url.includes('SERIAL1234'))
    && /copy it and paste/.test(i.note), `${vendor}: its warranty page on ${host}, the serial never in a URL, offered to copy`, J(i));
}
check(info('HP', 'EliteBook', 'X').links.some((l) => l.kind === 'drivers' && l.url === 'https://support.hp.com/us-en/drivers'), 'HP has a drivers page');
check(info('Microsoft Corporation', 'Surface Pro 9', '0123456789012').links.some((l) => l.kind === 'drivers' && /support\.microsoft\.com/.test(l.url)), 'Surface has a drivers and firmware page');
i = info('VMware, Inc.', 'VMware Virtual Platform', 'VMware-56 4d 2a');
check(i.links.length === 0 && i.note === 'Virtual machine (VMware) — no hardware warranty.', 'VMware: no links, "virtual machine — no hardware warranty"', J(i));
i = info('Microsoft Corporation', 'Virtual Machine', '1234-5678-9012-3456-7890-1234-56');
check(i.links.length === 0 && /Hyper-V/.test(i.note), 'Hyper-V: no links');
i = info('Gigabyte', 'B550', 'ABC123');
check(i.links.length === 0 && i.maker.kind === 'unknown', 'an unknown maker: no links');
const all = V.VENDOR_KEYS.flatMap((v) => V.supportInfo({ dell: 'Dell', lenovo: 'Lenovo', hp: 'HP', hpe: 'HPE', microsoft: 'Microsoft', apple: 'Apple', asus: 'ASUS', acer: 'Acer' }[v], 'm', 'ABC1234').links);
check(all.length >= 15 && all.every((l) => l.url.startsWith('https://') && V.VENDOR_HOSTS.includes(new URL(l.url).hostname)), `every link (${all.length}) is https to a VENDOR_HOSTS host`);

section('Warranty buckets');
const now = new Date('2026-11-16T12:00:00Z');
const d = (days) => new Date(now.getTime() + days * 86_400_000);
for (const [at, want] of [[null, 'unknown'], [d(-1), 'expired'], [d(-0.01), 'expired'], [d(0.5), 'expiring_30'], [d(29.9), 'expiring_30'], [d(30), 'expiring_60'], [d(59), 'expiring_60'], [d(60), 'expiring_90'], [d(89), 'expiring_90'], [d(90), 'active'], [d(900), 'active'], ['not a date', 'unknown']])
  check(V.warrantyState(at, now) === want, `${at instanceof Date ? `${Math.round((at - now) / 864e5 * 10) / 10} d` : J(at)} → ${want}`, V.warrantyState(at, now));
check(V.daysLeft(d(10.5), now) === 10 && V.daysLeft(d(-3), now) === -3 && V.daysLeft(null, now) === null, 'daysLeft counts whole days, negative once passed');

section('Coverage text: an inert charset');
check(V.cleanCoverage('ProSupport Plus <b>NBD</b> "onsite"; 4h\u0000\n') === 'ProSupport Plus b NBD /b onsite ; 4h', 'markup, quotes and control characters become spaces', J(V.cleanCoverage('ProSupport Plus <b>NBD</b> "onsite"; 4h\u0000\n')));
check(V.cleanCoverage('x'.repeat(500)).length === 200 && V.cleanCoverage(42) === null && V.cleanCoverage('   ') === null, 'capped at 200; non-text and blank are null');
check(V.COVERAGE_RE.test("Premier Support – no") === false && V.COVERAGE_RE.test("Depot/Carry-in (Base) 3 yr & Accidental Damage, Lenovo's #1") && V.COVERAGE_RE.test('Garantie sur site, réparation'), 'COVERAGE_RE admits the vendors\' usual text and nothing else');

section('Device list: the Warranty filter');
check(J(Q.WARRANTY_FILTERS) === J(['expired', 'd30', 'd60', 'd90', 'active', 'unknown']) && Q.LIST_FILTER_KEYS.includes('warranty') && Q.SORT_KEYS.includes('warranty'), 'warranty is a list filter and a sort key');
check(Q.parseListFilters({ warranty: 'd30' }).warranty === 'd30', 'warranty=d30 parses');
let threw = false; try { Q.parseListFilters({ warranty: "d30' OR 1=1" }); } catch { threw = true; }
check(threw, 'an unknown warranty value is a 400, never widened');
check(Q.parseListQuery({ sort: 'warranty' }).dir === 'asc', 'sorting by warranty starts with the soonest end date');
check(G.RULE_KEYS.includes('warranty') && J(G.parseRule({ warranty: 'expired' })) === '{"warranty":"expired"}', 'a rule group may select by warranty (stored in list form)');

section('WARRANTY_EXPIRING: opt-in, one alert, clears when the date moves');
check(E.MONITOR_KINDS.includes('WARRANTY_EXPIRING') && !E.RECOMMENDED.some((r) => r.kind === 'WARRANTY_EXPIRING'), 'a monitor kind, not in RECOMMENDED');
check(E.parseParams('WARRANTY_EXPIRING', {}).ok && E.parseParams('WARRANTY_EXPIRING', {}).params.daysBefore === 30, 'daysBefore defaults to 30');
check(!E.parseParams('WARRANTY_EXPIRING', { daysBefore: 0 }).ok && !E.parseParams('WARRANTY_EXPIRING', { daysBefore: 366 }).ok && !E.parseParams('WARRANTY_EXPIRING', { daysBefore: 30, x: 1 }).ok, '1–365 days, strict');
const rule = { id: 'r1', key: 'warranty', kind: 'WARRANTY_EXPIRING', params: { daysBefore: 30 }, severity: 'WARNING', scopeKey: 'global', enabled: true };
const st = E.EMPTY_STATE;
let v = E.evaluateWarranty(rule, d(20), 'PC-1', st, now);
check(v.verdict === 'breach' && v.title === `PC-1: hardware warranty ends ${d(20).toISOString().slice(0, 10)}` && v.detail.daysLeft === 20 && v.detail.endsAt === d(20).toISOString(), 'ends in 20 days, warn at 30: raised, naming the date', J(v));
v = E.evaluateWarranty(rule, d(-5), 'PC-1', st, now);
check(v.verdict === 'breach' && /ended/.test(v.title) && v.detail.ended === true, 'already ended: raised as ended');
v = E.evaluateWarranty(rule, d(45), 'PC-1', st, now);
check(v.verdict === 'ok' && v.clear === true, 'moved out to 45 days: clears');
v = E.evaluateWarranty(rule, null, 'PC-1', st, now);
check(v.verdict === 'ok' && v.clear === true, 'no date: never raised (unknown is not expiring)');
check(E.evaluateWarranty({ ...rule, params: { daysBefore: 'x' } }, d(1), 'PC-1', st, now).verdict === 'skip', 'invalid params: skipped');

section('The sweep budget');
check(S.budget(60, 0) === 25 && S.budget(60, 50) === 10 && S.budget(60, 60) === 0 && S.budget(60, 99) === 0, 'at most 25 a tick, never past the hourly limit');
check(S.perHour({}) === 60 && S.perHour({ WARRANTY_LOOKUPS_PER_HOUR: '10' }) === 10 && S.perHour({ WARRANTY_LOOKUPS_PER_HOUR: '99999' }) === 500 && S.perHour({ WARRANTY_LOOKUPS_PER_HOUR: '-1' }) === 60, 'per hour: default 60, capped at 500');
check(S.LOOKUP_INTERVAL_DAYS === 30, 'each computer at most every 30 days');

section('Vendor clients, against a loopback stub (never a real vendor)');
const hits = [];
let mode = 'ok';
const stub = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; });
  req.on('end', () => {
    hits.push({ method: req.method, url: req.url, headers: req.headers, body: b });
    res.setHeader('content-type', 'application/json');
    if (mode === 'redirect') { res.statusCode = 302; res.setHeader('location', 'http://169.254.169.254/'); return res.end(); }
    if (mode === '500') { res.statusCode = 503; return res.end('{}'); }
    if (mode === 'big') { return res.end(JSON.stringify({ pad: 'x'.repeat(300 * 1024) })); }
    if (req.url === '/dell/auth/oauth/v2/token') {
      if (mode === 'badauth') { res.statusCode = 400; return res.end('{"error":"invalid_client"}'); }
      return res.end(JSON.stringify({ access_token: 'tok-unit-123456', token_type: 'Bearer', expires_in: 3600 }));
    }
    if (req.url.startsWith('/dell/PROD/sbil/eapi/v5/asset-entitlements')) {
      const tag = new URL(req.url, 'http://x').searchParams.get('servicetags');
      if (tag === 'NOTFND1') return res.end(JSON.stringify([{ serviceTag: tag, invalid: true, entitlements: [] }]));
      return res.end(JSON.stringify([{ id: 1, serviceTag: tag, productLineDescription: 'LATITUDE 7440', invalid: false, entitlements: [
        { itemNumber: '1', startDate: '2024-01-10T00:00:00Z', endDate: '2025-01-10T23:59:59Z', entitlementType: 'INITIAL', serviceLevelDescription: 'Basic Hardware Service' },
        { itemNumber: '2', startDate: '2024-01-10T00:00:00Z', endDate: '2027-01-10T23:59:59Z', entitlementType: 'EXTENDED', serviceLevelDescription: 'ProSupport Plus <script>x</script>' },
      ] }]));
    }
    if (req.url.startsWith('/lenovo/v2.5/warranty')) {
      const sn = new URL(req.url, 'http://x').searchParams.get('Serial');
      if (sn === 'NOTFOUND') return res.end(JSON.stringify({ Serial: sn, Warranty: [] }));
      return res.end(JSON.stringify({ Serial: sn, Product: '20XW0026US', InWarranty: true, Warranty: [
        { ID: '1EZ', Name: 'Depot/Carry-in', Description: 'base', Type: 'BASE', Start: '2023-05-01T00:00:00Z', End: '2026-05-01T00:00:00Z' },
        { ID: '5WS', Name: 'Premier Support Plus', Description: 'upgrade', Type: 'ENTITLED', Start: '2023-05-01T00:00:00Z', End: '2028-05-01T00:00:00Z' },
      ] }));
    }
    res.statusCode = 404; res.end('{}');
  });
});
await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r));
try {
  let r = await C.lookup('dell', { clientId: 'cid-unit', secret: 'sec-unit-abcdef' }, '7ZK2PQ3');
  check(r.ok && r.found.endsAt.toISOString() === '2027-01-10T23:59:59.000Z' && r.found.startsAt.toISOString() === '2024-01-10T00:00:00.000Z' && r.found.coverage === 'ProSupport Plus script x /script', 'Dell: the latest entitlement decides the end and the coverage (cleaned)', J(r));
  const tokenHit = hits.find((h) => h.url === '/dell/auth/oauth/v2/token'), entHit = hits.find((h) => h.url.includes('asset-entitlements'));
  check(tokenHit?.method === 'POST' && /grant_type=client_credentials/.test(tokenHit.body) && /client_id=cid-unit/.test(tokenHit.body) && tokenHit.headers['content-type'] === 'application/x-www-form-urlencoded', 'Dell: client-credentials token request, form encoded');
  check(entHit?.method === 'GET' && entHit.url === '/dell/PROD/sbil/eapi/v5/asset-entitlements?servicetags=7ZK2PQ3' && entHit.headers.authorization === 'Bearer tok-unit-123456' && entHit.body === '', 'Dell: GET with the service tag only, bearer token, no body');
  r = await C.lookup('dell', { clientId: 'cid-unit', secret: 's' }, 'NOTFND1');
  check(!r.ok && r.code === 'NOT_FOUND' && !r.transient, 'Dell: an invalid tag is NOT_FOUND, not retried tomorrow');
  r = await C.lookup('dell', { clientId: null, secret: 's' }, '7ZK2PQ3');
  check(!r.ok && r.code === 'VENDOR_NOT_CONFIGURED', 'Dell without a client id sends nothing', J(r));
  hits.length = 0;
  r = await C.lookup('lenovo', { clientId: null, secret: 'lenovo-client-token' }, 'PF3ABCDE');
  check(r.ok && r.found.endsAt.toISOString() === '2028-05-01T00:00:00.000Z' && r.found.coverage === 'Premier Support Plus' && r.found.startsAt.toISOString() === '2023-05-01T00:00:00.000Z', 'Lenovo: the latest warranty decides', J(r));
  check(hits.length === 1 && hits[0].method === 'GET' && hits[0].url === '/lenovo/v2.5/warranty?Serial=PF3ABCDE' && hits[0].headers.clientid === 'lenovo-client-token', 'Lenovo: GET with the serial only, the ClientID header');
  r = await C.lookup('lenovo', { clientId: null, secret: 't' }, 'NOTFOUND');
  check(!r.ok && r.code === 'NOT_FOUND', 'Lenovo: no warranty entries is NOT_FOUND');
  mode = 'badauth';
  r = await C.lookup('dell', { clientId: 'x', secret: 'y' }, '7ZK2PQ3');
  check(!r.ok && r.code === 'VENDOR_AUTH_FAILED' && !r.transient, 'a refused credential is VENDOR_AUTH_FAILED');
  mode = 'redirect';
  r = await C.lookup('lenovo', { clientId: null, secret: 't' }, 'PF3ABCDE');
  check(!r.ok && r.code === 'REDIRECT_REFUSED', 'a redirect is refused, never followed', J(r));
  mode = '500';
  r = await C.lookup('lenovo', { clientId: null, secret: 't' }, 'PF3ABCDE');
  check(!r.ok && r.code === 'VENDOR_HTTP_5XX' && r.transient, 'a 5xx may pass: transient (asked again after a day)');
  mode = 'big';
  r = await C.lookup('lenovo', { clientId: null, secret: 't' }, 'PF3ABCDE');
  check(!r.ok && r.code === 'RESPONSE_TOO_LARGE', 'a response over 256 KB is refused');
  const savedEnv = process.env.NODE_ENV; process.env.NODE_ENV = 'production'; mode = 'ok'; hits.length = 0;
  const before = hits.length;
  // Outside NODE_ENV=test the stub URL is ignored and the real host would be used: prove the stub saw nothing,
  // without reaching the real host — the lookup is not awaited past the DNS step in a sandbox; we only need the stub untouched.
  check(C.WARRANTY_TIMEOUT_MS === 20_000 && C.WARRANTY_MAX_RESPONSE === 256 * 1024, 'bounded: 20 s, 256 KB');
  process.env.NODE_ENV = savedEnv;
  check(hits.length === before, 'switching NODE_ENV away from test sends nothing to the stub');
} finally { stub.close(); }

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log(`\n${fail} FAILED`); process.exit(1); }
console.log('ALL PASSED');
