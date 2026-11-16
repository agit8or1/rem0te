#!/usr/bin/env node
/**
 * Unit tests for 0.61's warranty vendors: the HP Inc. Warranty API (token,
 * one-serial batch job, bounded polling, results) and the Apple Business
 * Manager API (ES256 client assertion, token, AppleCare coverage), plus the
 * "why is there no date" reasons — against a loopback stand-in only. The
 * stand-in follows the vendors' published examples; NO real HP or Apple API
 * is ever called, and every serial here is synthetic.
 *
 *   cd apps/api && npx nest build && node scripts/unit-warranty-vendors.mjs
 *
 * The behavioural suite against a running API is scripts/e2e-warranty-vendors.mjs.
 * Port 3884 (the stand-in). Never a production port.
 */
import { createRequire } from 'node:module';
import { fileURLToPath, URL, URLSearchParams } from 'node:url';
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

process.env.NODE_ENV = 'test';
const STUB_PORT = 3884;
process.env.WARRANTY_TEST_BASE_URL = `http://127.0.0.1:${STUB_PORT}`;

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const V = require(path.join(dist, 'warranty', 'vendors.js'));
const C = require(path.join(dist, 'warranty', 'client.js'));

let pass = 0, fail = 0;
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${n}${d ? `\n      ${d}` : ''}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const J = JSON.stringify;
const DAY = 86_400_000;

section('One table, and the lookup list');
const api = readFileSync(path.join(here, '..', 'src', 'warranty', 'vendors.ts'), 'utf8');
const web = readFileSync(path.join(here, '..', '..', 'web', 'lib', 'hardware-support.ts'), 'utf8');
check(api === web, 'apps/web/lib/hardware-support.ts is still a byte-for-byte copy');
check(J(V.LOOKUP_VENDORS) === J(['dell', 'lenovo', 'hp', 'apple']) && C.LOOKUP_VENDORS === V.LOOKUP_VENDORS, 'lookups: Dell, Lenovo, HP, Apple — one list, re-exported by the client');
check(J(Object.keys(V.NO_LOOKUP_REASON).sort()) === J(['acer', 'asus', 'hpe', 'microsoft']), 'no lookup, each with a stated reason: HPE, Microsoft, ASUS, Acer');
check(V.VENDOR_KEYS.every((k) => V.isLookupVendor(k) !== Object.hasOwn(V.NO_LOOKUP_REASON, k)), 'every vendor is exactly one of the two');
check(J([...C.LOOKUP_HOSTS].sort()) === J(['account.apple.com', 'api-business.apple.com', 'apigtwb2c.us.dell.com', 'supportapi.lenovo.com', 'warranty.api.hp.com']), 'the client names five vendor hosts');
check(V.WARRANTY_SOURCE_LABEL.hp === 'HP Warranty API' && V.WARRANTY_SOURCE_LABEL.apple === 'Apple Business Manager', 'HP and Apple have source labels');

section('HP vs HPE: who looks it up');
const maker = (m, mo) => { const x = V.identifyMaker(m, mo); return x.kind === 'vendor' ? x.vendor : x.kind; };
for (const [m, mo, want] of [
  ['Hewlett-Packard', 'HP Z440 Workstation', 'hp'], ['Hewlett-Packard', 'HP Z840 Workstation', 'hp'], ['HP', 'HP EliteDesk 800 G6', 'hp'],
  ['HP', 'ProLiant DL380 Gen10', 'hpe'], ['Hewlett-Packard', 'ProLiant ML350p Gen8', 'hpe'], ['HPE', 'Synergy 480 Gen10', 'hpe'], ['Apple Inc.', 'Mac14,2', 'apple'],
]) check(maker(m, mo) === want, `${m} / ${mo} → ${want}`, maker(m, mo));

section('Why there is no date');
const gap = (o) => V.warrantyGap({ hasInventory: true, manufacturer: 'Hewlett-Packard', model: 'HP Z440 Workstation', serial: 'CZC5123ABC', enabled: [], lookupResult: null, lookupAt: null, ...o });
let g = gap({ hasInventory: false });
check(g.reason === 'no_inventory' && !g.settings, 'no inventory yet', J(g));
g = gap({ manufacturer: 'VMware, Inc.', model: 'VMware20,1' });
check(g.reason === 'virtual' && /no hardware warranty/.test(g.text), 'a virtual machine', J(g));
g = gap({ manufacturer: 'Contoso Systems', model: 'X1' });
check(g.reason === 'unknown_maker', 'an unknown manufacturer', J(g));
g = gap({ manufacturer: 'HPE', model: 'ProLiant DL360 Gen11' });
check(g.reason === 'no_lookup' && /HPE publishes no warranty API/.test(g.text) && /by hand/.test(g.text) && !g.settings, 'HPE: the vendor has no lookup, said plainly', J(g));
for (const [m, mo] of [['Microsoft Corporation', 'Surface Pro 9'], ['ASUSTeK COMPUTER INC.', 'ExpertBook'], ['Acer', 'TravelMate']]) {
  g = gap({ manufacturer: m, model: mo });
  check(g.reason === 'no_lookup' && /publishes no/.test(g.text), `${m}: no lookup`, J(g));
}
g = gap({ serial: 'To be filled by O.E.M.' });
check(g.reason === 'no_serial', 'HP with a placeholder serial: serial missing', J(g));
g = gap({ serial: null });
check(g.reason === 'no_serial', 'HP with no serial: serial missing', J(g));
g = gap({});
check(g.reason === 'not_configured' && g.settings && /Settings → Warranty/.test(g.text) && /HP/.test(g.text), 'HP with a serial and the HP lookup off: not switched on, fix in Settings', J(g));
g = gap({ enabled: ['dell'] });
check(g.reason === 'not_configured', 'another vendor\'s lookup being on does not count', J(g));
g = gap({ enabled: ['hp'] });
check(g.reason === 'waiting' && !g.settings, 'HP on, never asked: waiting', J(g));
g = gap({ enabled: ['hp'], lookupAt: new Date(), lookupResult: 'OK' });
check(g.reason === 'waiting', 'an answer later cleared by hand: waiting again', J(g));
g = gap({ enabled: ['hp'], lookupAt: new Date(), lookupResult: 'NOT_FOUND' });
check(g.reason === 'not_found' && /no warranty record/.test(g.text), 'asked, no record', J(g));
g = gap({ enabled: ['hp'], lookupAt: new Date(), lookupResult: 'VENDOR_AUTH_FAILED' });
check(g.reason === 'failed' && g.settings && /refused the credential/.test(g.text), 'a refused credential: failed, fix in Settings', J(g));
g = gap({ enabled: ['hp'], lookupAt: new Date(), lookupResult: 'VENDOR_PENDING' });
check(g.reason === 'failed' && !g.settings && /had not finished/.test(g.text), 'an unfinished HP job: failed, asked again within a day', J(g));
g = gap({ enabled: ['hp'], lookupAt: new Date(), lookupResult: 'VENDOR_HTTP_418' });
check(/HTTP 418/.test(g.text), 'an unlisted HTTP code is described', g.text);
check(V.lookupResultText('SOMETHING_NEW') === 'SOMETHING_NEW', 'an unknown code is shown as itself');
check(V.WARRANTY_GAPS.every((r) => typeof V.WARRANTY_GAP_LABEL[r] === 'string'), 'every reason has a label');

// ── The stand-in ─────────────────────────────────────────────────────────────
const HP_KEY = 'hp-app-key-0001', HP_SECRET = 'hp-app-secret-0001';
const { privateKey: APPLE_PRIV, publicKey: APPLE_PUB } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const APPLE_PEM = APPLE_PRIV.export({ type: 'pkcs8', format: 'pem' }).toString();
const APPLE_SEC1 = APPLE_PRIV.export({ type: 'sec1', format: 'pem' }).toString();
const APPLE_CLIENT = 'BUSINESSAPI.11111111-2222-3333-4444-555555555555', APPLE_KID = 'aaaabbbb-cccc-dddd-eeee-ffff00001111';
let hits = [];
let mode = {};
let tokenSeq = 0;
const jobs = new Map();
const stub = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; });
  req.on('end', () => {
    hits.push({ method: req.method, url: req.url, headers: req.headers, body: b });
    res.setHeader('content-type', 'application/json');
    const u = new URL(req.url, 'http://x');
    const send = (code, obj) => { res.statusCode = code; res.end(typeof obj === 'string' ? obj : J(obj)); };
    // HP: token (Basic), job create, status, results.
    if (u.pathname === '/hp/oauth/v1/token') {
      if (mode.hpToken === 429) return send(429, { error: 'too_many_requests' });
      if (req.headers.authorization !== `Basic ${Buffer.from(`${HP_KEY}:${HP_SECRET}`).toString('base64')}` || b !== 'grant_type=client_credentials') return send(401, { error: 'invalid_client' });
      return send(200, { access_token: `hp-token-${++tokenSeq}`, expires_in: '3599', scope: 'warranty' });
    }
    const hpAuth = () => /^Bearer hp-token-\d+$/.test(req.headers.authorization ?? '') && !(mode.hpRevoked ?? []).includes(req.headers.authorization.slice(7));
    if (u.pathname === '/hp/productwarranty/v2/jobs' && req.method === 'POST') {
      if (!hpAuth()) return send(401, {});
      if (mode.hpJob === 429) return send(429, {});
      if (mode.hpJob === 500) return send(503, {});
      let items; try { items = JSON.parse(b); } catch { return send(400, {}); }
      const id = `0b6a9c1e-0000-4000-8000-${String(jobs.size + 1).padStart(12, '0')}`;
      jobs.set(id, { items, polls: 0 });
      return send(200, { jobId: mode.hpBadJobId ? '../../etc' : id, estimatedTime: 1 });
    }
    const jm = u.pathname.match(/^\/hp\/productwarranty\/v2\/jobs\/([0-9a-f-]+)(\/results)?$/);
    if (jm) {
      if (!hpAuth()) return send(401, {});
      const job = jobs.get(jm[1]);
      if (!job) return send(404, {});
      if (!jm[2]) {
        job.polls++;
        if (mode.hpStatus === 'never') return send(200, { jobId: jm[1], status: 'IN_PROGRESS', productsProcessed: 0 });
        if (mode.hpStatus === 'failed') return send(200, { jobId: jm[1], status: 'FAILED' });
        return send(200, { jobId: jm[1], status: job.polls >= 2 ? 'Completed' : 'IN_PROGRESS', productsProcessed: job.polls >= 2 ? 1 : 0 });
      }
      const sn = job.items[0]?.sn;
      if (mode.hpResult === 'none') return send(200, [{ product: { serialNumber: sn, productNumber: null }, offers: [], status: 'Not Found' }]);
      if (mode.hpResult === 'garbage') return send(200, '<html>oops</html>');
      return send(200, [{
        product: { serialNumber: sn, productDescription: 'HP Z440 Workstation', productNumber: null, countryCode: 'US' },
        offers: [
          { offerDescription: 'Wty: HP HW Maintenance Onsite Support', serviceObligationTypeCode: 'W', serviceObligationLineItemStartDate: '2016-03-01', serviceObligationLineItemEndDate: '2019-02-28' },
          { offerDescription: 'HP Care Pack <script>x</script> Next Business Day', serviceObligationTypeCode: 'C', serviceObligationLineItemStartDate: '2019-03-01', serviceObligationLineItemEndDate: new Date(Date.now() + 100 * DAY).toISOString().slice(0, 10) },
          { offerDescription: 'Wty: HP Support for Initial Setup', serviceObligationTypeCode: 'W', serviceObligationLineItemStartDate: '2016-03-01', serviceObligationLineItemEndDate: '2016-05-30' },
        ],
      }]);
    }
    // Apple: token (client assertion), coverage.
    if (u.pathname === '/apple-auth/auth/oauth2/token') {
      const f = new URLSearchParams(b);
      const a = (f.get('client_assertion') ?? '').split('.');
      let ok = a.length === 3 && f.get('grant_type') === 'client_credentials' && f.get('client_id') === APPLE_CLIENT && f.get('scope') === 'business.api'
        && f.get('client_assertion_type') === 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
      if (ok) {
        const head = JSON.parse(Buffer.from(a[0], 'base64url')); const claims = JSON.parse(Buffer.from(a[1], 'base64url'));
        const sigOk = verify('sha256', Buffer.from(`${a[0]}.${a[1]}`), { key: mode.applePub ?? APPLE_PUB, dsaEncoding: 'ieee-p1363' }, Buffer.from(a[2], 'base64url'));
        const now = Date.now() / 1000;
        ok = sigOk && head.alg === 'ES256' && head.kid === APPLE_KID && claims.iss === APPLE_CLIENT && claims.sub === APPLE_CLIENT
          && claims.aud === 'https://account.apple.com/auth/oauth2/v2/token' && claims.iat <= now + 5 && claims.exp > now && claims.exp - claims.iat <= 600 && typeof claims.jti === 'string';
        mode.lastAssertion = { head, claims };
      }
      if (!ok) return send(400, { error: 'invalid_client' });
      return send(200, { access_token: `apple-token-${++tokenSeq}`, token_type: 'Bearer', expires_in: 3600 });
    }
    const am = u.pathname.match(/^\/apple\/v1\/orgDevices\/([A-Za-z0-9-]+)\/appleCareCoverage$/);
    if (am) {
      if (!/^Bearer apple-token-\d+$/.test(req.headers.authorization ?? '')) return send(401, {});
      if (mode.apple === 429) return send(429, {});
      if (am[1] === 'NOTINORG01') return send(404, { errors: [{ status: '404', code: 'NOT_FOUND' }] });
      return send(200, { data: [
        { type: 'appleCareCoverage', id: am[1], attributes: { startDateTime: '2025-02-02T00:00:00Z', endDateTime: '2026-02-02T00:00:00Z', description: 'Limited Warranty', status: 'EXPIRED', isCanceled: false, paymentType: 'NONE' } },
        { type: 'appleCareCoverage', id: '0000000001', attributes: { startDateTime: '2025-04-17T00:00:00Z', endDateTime: new Date(Date.now() + 300 * DAY).toISOString(), description: 'AppleCare+ for Business', status: 'ACTIVE', isCanceled: false, paymentType: 'SUBSCRIPTION' } },
        { type: 'appleCareCoverage', id: '0000000002', attributes: { startDateTime: '2025-04-17T00:00:00Z', endDateTime: '2031-01-01T00:00:00Z', description: 'Cancelled plan', status: 'INACTIVE', isCanceled: true } },
        { type: 'appleCareCoverage', id: 'abe-1', attributes: { startDateTime: '2025-04-17T00:00:00Z', endDateTime: null, description: 'AppleCare+ for Business Essentials', status: 'ACTIVE', isCanceled: false } },
      ], links: { self: 'x' }, meta: { paging: { limit: 100 } } });
    }
    send(404, {});
  });
});

async function main() {
  await new Promise((r, j) => { stub.once('error', j); stub.listen(STUB_PORT, '127.0.0.1', r); });
  const hp = { clientId: HP_KEY, secret: HP_SECRET };

  section('HP: token, one-serial job, polling, results');
  hits = []; mode = {}; C.clearTokenCache();
  let r = await C.lookup('hp', hp, 'CZC5123ABC');
  check(r.ok && r.found.coverage === 'HP Care Pack script x /script Next Business Day' && r.found.startsAt.toISOString().slice(0, 10) === '2016-03-01'
    && Math.round((r.found.endsAt - Date.now()) / DAY) >= 99, 'the latest-ending offer decides the end and coverage; the earliest start is the start; vendor text cleaned', J(r));
  const create = hits.find((h) => h.method === 'POST' && h.url === '/hp/productwarranty/v2/jobs');
  check(!!create && create.body === J([{ sn: 'CZC5123ABC' }]) && create.headers['content-type'] === 'application/json', 'the job carries the serial and nothing else (no product number, no country)', create?.body);
  check(hits[0].url === '/hp/oauth/v1/token' && hits[0].method === 'POST', 'a token first, with HTTP Basic');
  check(hits.filter((h) => /\/jobs\/[0-9a-f-]+$/.test(h.url)).length === 2 && hits.at(-1).url.endsWith('/results'), 'polled until Completed (any case), then the results', J(hits.map((h) => h.url)));
  hits = [];
  r = await C.lookup('hp', hp, 'CZC5123ABD');
  check(r.ok && !hits.some((h) => h.url.includes('/oauth/')), 'the token is reused for its lifetime', J(hits.map((h) => h.url)));
  hits = [];
  r = await C.lookup('hp', { clientId: HP_KEY, secret: 'another-secret-0002' }, 'CZC5123ABD');
  check(!r.ok && r.code === 'VENDOR_AUTH_FAILED' && !r.transient && hits.length === 1, 'another credential never reuses a cached token: refused at the token', J(r));
  hits = []; mode = { hpRevoked: ['hp-token-1'] };
  r = await C.lookup('hp', hp, 'CZC5123ABE');
  check(r.ok && hits.filter((h) => h.url.includes('/oauth/')).length === 1, 'a remembered token the vendor refuses is replaced once, and the lookup goes on', J(hits.map((h) => `${h.method} ${h.url}`)));
  hits = []; mode = { hpResult: 'none' }; C.clearTokenCache();
  r = await C.lookup('hp', hp, 'CZC0000000');
  check(!r.ok && r.code === 'NOT_FOUND' && !r.transient, 'no offers: NOT_FOUND', J(r));
  mode = { hpStatus: 'never' }; hits = [];
  r = await C.lookup('hp', hp, 'CZC5123ABF');
  check(!r.ok && r.code === 'VENDOR_PENDING' && r.transient && hits.filter((h) => /\/jobs\/[0-9a-f-]+$/.test(h.url)).length === C.HP_MAX_POLLS, `a job that never finishes: VENDOR_PENDING after ${C.HP_MAX_POLLS} polls, asked again within a day`, J(r));
  mode = { hpStatus: 'failed' };
  r = await C.lookup('hp', hp, 'CZC5123ABF');
  check(!r.ok && r.code === 'VENDOR_JOB_FAILED' && r.transient, 'a failed job: VENDOR_JOB_FAILED', J(r));
  mode = { hpJob: 429 };
  r = await C.lookup('hp', hp, 'CZC5123ABF');
  check(!r.ok && r.code === 'VENDOR_RATE_LIMITED' && r.transient, 'HP 429: rate limited, transient', J(r));
  mode = { hpJob: 500 };
  r = await C.lookup('hp', hp, 'CZC5123ABF');
  check(!r.ok && r.code === 'VENDOR_HTTP_5XX' && r.transient, 'HP 5xx: transient', J(r));
  mode = { hpResult: 'garbage' };
  r = await C.lookup('hp', hp, 'CZC5123ABF');
  check(!r.ok && r.code === 'RESPONSE_INVALID', 'unreadable results: RESPONSE_INVALID', J(r));
  mode = { hpBadJobId: true }; hits = [];
  r = await C.lookup('hp', hp, 'CZC5123ABF');
  check(!r.ok && r.code === 'RESPONSE_INVALID' && !hits.some((h) => h.url.includes('etc')), 'a job id outside its charset is never put in a URL', J(r));
  mode = { hpToken: 429 }; C.clearTokenCache();
  r = await C.lookup('hp', hp, 'CZC5123ABF');
  check(!r.ok && r.code === 'VENDOR_RATE_LIMITED', 'token endpoint 429: rate limited', J(r));
  r = await C.lookup('hp', { clientId: null, secret: HP_SECRET }, 'CZC5123ABF');
  check(!r.ok && r.code === 'VENDOR_NOT_CONFIGURED', 'no API key: not configured, nothing sent', J(r));

  section('Apple: the private key, the client assertion, the token, the coverage');
  check(C.normaliseApplePrivateKey(APPLE_PEM)?.startsWith('-----BEGIN PRIVATE KEY-----'), 'a PKCS#8 P-256 key is accepted');
  check(C.normaliseApplePrivateKey(APPLE_SEC1)?.startsWith('-----BEGIN PRIVATE KEY-----'), 'a SEC1 ("EC PRIVATE KEY") P-256 key is accepted and stored as PKCS#8');
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const p384 = generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  check(C.normaliseApplePrivateKey(rsa) === null && C.normaliseApplePrivateKey(p384) === null, 'an RSA or P-384 key is refused');
  check(C.normaliseApplePrivateKey('not a key at all') === null && C.normaliseApplePrivateKey(APPLE_PUB.export({ type: 'spki', format: 'pem' }).toString()) === null, 'garbage or a public key is refused');
  const apple = { clientId: APPLE_CLIENT, keyId: APPLE_KID, secret: C.normaliseApplePrivateKey(APPLE_PEM) };
  hits = []; mode = {}; C.clearTokenCache();
  r = await C.lookup('apple', apple, 'C02XK0ABJGH5');
  check(r.ok && r.found.coverage === 'AppleCare+ for Business' && r.found.startsAt.toISOString().startsWith('2025-02-02') && Math.round((r.found.endsAt - Date.now()) / DAY) >= 299,
    'the latest end among plans that are not cancelled; an open-ended plan has no end and does not count', J(r));
  check(mode.lastAssertion?.head.kid === APPLE_KID && mode.lastAssertion.claims.exp - mode.lastAssertion.claims.iat === 300, 'the assertion: ES256, the key id, five minutes, verified with the public key');
  const cov = hits.find((h) => h.url.startsWith('/apple/'));
  check(cov?.url === '/apple/v1/orgDevices/C02XK0ABJGH5/appleCareCoverage' && cov.method === 'GET' && cov.body === '', 'the coverage request carries the serial only, in the path', cov?.url);
  hits = [];
  r = await C.lookup('apple', apple, 'NOTINORG01');
  check(!r.ok && r.code === 'NOT_FOUND' && !hits.some((h) => h.url.includes('oauth2')), 'not in the organisation: NOT_FOUND; the token was reused', J(r));
  mode = { apple: 429 };
  r = await C.lookup('apple', apple, 'C02XK0ABJGH5');
  check(!r.ok && r.code === 'VENDOR_RATE_LIMITED', 'Apple 429: rate limited', J(r));
  mode = { applePub: generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey }; C.clearTokenCache();
  r = await C.lookup('apple', apple, 'C02XK0ABJGH5');
  check(!r.ok && r.code === 'VENDOR_AUTH_FAILED' && !r.transient, 'an assertion Apple cannot verify (wrong key): VENDOR_AUTH_FAILED', J(r));
  mode = {};
  r = await C.lookup('apple', { ...apple, keyId: null }, 'C02XK0ABJGH5');
  check(!r.ok && r.code === 'VENDOR_NOT_CONFIGURED', 'no key id: not configured', J(r));
  r = await C.lookup('apple', { ...apple, secret: 'not-a-key' }, 'C02XK0ABJGH5');
  check(!r.ok && r.code === 'VENDOR_NOT_CONFIGURED', 'an unusable stored key: not configured, nothing sent', J(r));

  section('Nothing about the computer but the serial, and no secret in a URL');
  const all = hits.map((h) => h.url).join(' ');
  check(!all.includes(HP_SECRET) && !all.includes('PRIVATE'), 'no secret or key in any URL');
  void createPublicKey;
}

main().catch((e) => { fail++; console.error(e); }).finally(() => {
  stub.close();
  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
  if (fail) process.exit(1);
  console.log('ALL PASSED');
});
