#!/usr/bin/env node
/**
 * End-to-end proof of Rem0te's own Apple MDM server (0.84 Harbor,
 * docs/own-mdm.md M2, invariant §93), against the real built API and a
 * scratch database only. NOTHING HERE IS A REAL DEVICE OR A REAL APPLE CALL:
 *
 *   - the device is mdmb (github.com/jessepeterson/mdmb, built from a pinned
 *     commit into a scratch directory: MDMB_BIN), a simulator that speaks
 *     the MDM protocol but is not iOS;
 *   - the device CA is step-ca (STEP_CA_BIN, a pinned release), set up by
 *     deploy/mdm-ca/rem0te-mdm-ca-setup.sh in a temporary directory with
 *     its TEST ONLY SCEP provisioner, because mdmb cannot do ACME or
 *     Apple's attestation. The ACME provisioner is probed on loopback: it
 *     offers device-attest-01 and nothing else; no attestation is made;
 *   - APNs is a loopback HTTP/2 stub with its own test CA; the push
 *     certificate is a TEST ONLY stand-in (lib/test-pki.mjs).
 *
 * What it proves:
 *   - step 6: the device CA and the profile signer, checked and refused;
 *   - enrollment links: Platform Admin, fresh authentication on `ask`
 *     (mdm.enroll), shown once, claimed once (a second download is 404),
 *     revoked without asking;
 *   - the signed profile verifies under the device CA, names ServerURL,
 *     CheckInURL with the link, the topic, SignMessage, AccessRights without
 *     erase, and carries no PKCS#12 identity;
 *   - Mdm-Signature before any parse: missing, malformed, tampered, foreign
 *     CA, wrong device certificate, unknown device: 401 with no body;
 *   - Authenticate needs a claimed, unexpired link, once; iOS/iPadOS 16+;
 *   - mdmb enrolls (SCEP → Authenticate → TokenUpdate), the five inventory
 *     commands are queued, the sweep pushes {"mdm": PushMagic} with the push
 *     certificate as the TLS client certificate, mdmb fetches and answers
 *     them, results are recorded, and the sync creates the business's
 *     `apple` connector and its MobileDevice;
 *   - a 410 from APNs stops pushing that device; CheckOut is final;
 *   - no secret in any response, audit row or the API's output.
 *
 *   cd apps/api && npx nest build
 *   MDMB_BIN=… STEP_CA_BIN=… DATABASE_URL=postgresql://…/<scratch|test> node scripts/e2e-mdm-apple.mjs
 *
 * Ports 4061 (API), 4062 (APNs stub), 4063 (the CA's TLS), 4064 (its test
 * SCEP over HTTP). Never 3001.
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign as edSign, X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import http2 from 'node:http2';
import https from 'node:https';
import tls from 'node:tls';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { confirmEverythingAsks } from './lib/confirm-asks.mjs';
import { pushCertFor, testChain, testTopic } from './lib/test-pki.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const repo = path.resolve(here, '..', '..', '..');
const DB = process.env.DATABASE_URL ?? '';
const dbName = DB.split('/').pop()?.split('?')[0] ?? '';
if (!/scratch|test/.test(dbName)) { console.error(`Refusing to run against database "${dbName}": name must contain "scratch" or "test".`); process.exit(2); }
const PORT = 4061, APNS_PORT = 4062, CA_PORT = 4063, SCEP_PORT = 4064;
for (const p of [PORT, APNS_PORT, CA_PORT, SCEP_PORT]) if ([3000, 3001, 3201, 3202, 443, 4000, 4001].includes(p)) process.exit(2);
const MDMB = process.env.MDMB_BIN, STEPCA = process.env.STEP_CA_BIN;
if (!MDMB || !fs.existsSync(MDMB) || !STEPCA || !fs.existsSync(STEPCA)) { console.error('MDMB_BIN and STEP_CA_BIN must name the built mdmb and the pinned step-ca binary.'); process.exit(2); }

const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex').toUpperCase();
const PW = 'mdm-apple-e2e-password-123';
const CHALLENGE = `e2e-scep-${randomBytes(8).toString('hex')}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rem0te-mdm-apple-'));

let pass = 0, fail = 0;
const failures = [];
const check = (c, n, d = '') => { if (c) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); } else { fail++; failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); } };
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;
const sh = (cmd, args, o = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...o });

const JWT = randomBytes(32).toString('hex'), LTS = randomBytes(32).toString('hex'), ENC = randomBytes(32).toString('hex');
const OFF = {
  INTEGRATION_PEERS_FILE: '', REPORT_SCHEDULE_SWEEP: 'off', AUDIT_SEALER: 'off', STALE_SWEEP: 'off', MONITOR_SWEEP: 'off',
  CLIENT_UPDATE_SWEEP: 'off', PATCH_POLICY_SWEEP: 'off', METRIC_SWEEP: 'off', RETENTION_SWEEP: 'off', CHAT_RETENTION_SWEEP: 'off', TRAY_SWEEP: 'off',
  SCRIPT_OUTPUT_SWEEP: 'off', AUTO_MIGRATION_SWEEP: 'off', WINGET_INDEX_SWEEP: 'off', SNAPSHOT_SWEEP: 'off', AGENT_AUTO_UPDATE: 'off',
  WARRANTY_SWEEP: 'off', AUTOMATION_SWEEP: 'off', RESTART_WINDOW_SWEEP: 'off', SSO_SESSION_SWEEP: 'off', TERMINAL_SWEEP: 'off',
  BACKUP_SYNC_SWEEP: 'off',
};
const procs = [];
function startApi(extra = {}) {
  const p = spawn(process.execPath, [path.join(dist, 'main.js')], {
    env: {
      ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATABASE_URL: DB, JWT_SECRET: JWT, LAUNCHER_TOKEN_SECRET: LTS, ENCRYPTION_KEY: ENC,
      TRUSTED_PROXIES: 'loopback', HBBS_PRESENCE_HOST: '127.0.0.2', VERSION_FILE: path.join(repo, 'version.json'),
      FRONTEND_URL: `http://127.0.0.1:${PORT}`, PUBLIC_API_URL: `http://127.0.0.1:${PORT}`, GEOIP_DB_PATH: path.join(here, 'no-geoip.mmdb'),
      ...OFF,
      MDM_SWEEP: 'on', MDM_SWEEP_SECONDS: '2', MDM_SYNC_MINUTES: '0.02',
      MDM_TEST_SCEP_URL: `http://127.0.0.1:${SCEP_PORT}/scep/rem0te-mdm-test`, MDM_TEST_SCEP_CHALLENGE: CHALLENGE,
      APNS_TEST_BASE_URL: `https://127.0.0.1:${APNS_PORT}`, APNS_TEST_CA_FILE: path.join(tmp, 'apns-ca.crt'),
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.log = ''; p.stdout.on('data', (d) => { p.log += d; }); p.stderr.on('data', (d) => { p.log += d; });
  procs.push(p);
  return p;
}
async function waitUp(p) {
  for (let i = 0; i < 120; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/api/v1/health`); if (r.status < 500) return; } catch { /* */ } await sleep(300); }
  throw new Error(`api did not come up:\n${p.log.slice(-3000)}`);
}
async function stop(p) { if (p && p.exitCode === null && p.signalCode === null) await new Promise((r) => { p.once('exit', r); p.kill('SIGTERM'); }); }

const API = `http://127.0.0.1:${PORT}/api/v1`;
async function req(method, p, { s, body } = {}) {
  await sleep(20);
  const h = { 'content-type': 'application/json', 'x-forwarded-for': ip() };
  if (s) h.cookie = s.cookie + (s.stepUp ? `; step_up=${s.stepUp}` : '');
  const r = await fetch(`${API}${p}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j, data: j?.data, text };
}
/** A device request: raw bytes, an optional Mdm-Signature, no session. */
async function dev(p, body, sig, contentType = 'application/x-apple-aspen-mdm-checkin') {
  await sleep(20);
  const h = { 'x-forwarded-for': ip() };
  if (contentType) h['content-type'] = contentType;
  if (sig !== undefined) h['mdm-signature'] = sig;
  const r = await fetch(`${API}${p}`, { method: 'PUT', headers: h, body });
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, body: buf, text: buf.toString('utf8') };
}
async function login(email) {
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip() }, body: JSON.stringify({ email, password: PW }) });
  const mm = (r.headers.get('set-cookie') ?? '').match(/access_token=([^;]+)/);
  if (r.status !== 200 || !mm) throw new Error(`login ${email}: ${r.status} ${await r.text()}`);
  return { cookie: `access_token=${mm[1]}` };
}
async function stepUp(s) {
  const r = await fetch(`${API}/auth/step-up`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip(), cookie: s.cookie }, body: JSON.stringify({ password: PW }) });
  const mm = (r.headers.get('set-cookie') ?? '').match(/step_up=([^;]+)/);
  if (r.status !== 200 || !mm) throw new Error(`step-up: ${r.status}`);
  return { ...s, stepUp: mm[1] };
}
const code = (r) => r.body?.code ?? r.body?.message?.code ?? r.body?.error?.code;
const msg = (r) => `HTTP ${r.status} ${typeof r.body === 'string' ? r.body.slice(0, 300) : Buffer.isBuffer(r.body) ? r.text.slice(0, 300) : JSON.stringify(r.body).slice(0, 600)}`;
const SECRET_RE = /PRIVATE KEY|[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]{40,}/;

// ── Test PKI on disk (all under the temporary directory) ────────────────

const caDir = path.join(tmp, 'ca');
const caEtc = path.join(caDir, 'etc', 'rem0te-mdm-ca');
const plistXml = (d) => `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>${
  Object.entries(d).map(([k, v]) => `<key>${k}</key>${typeof v === 'number' ? `<integer>${v}</integer>` : Buffer.isBuffer(v) ? `<data>${v.toString('base64')}</data>` : `<string>${String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</string>`}`).join('')}</dict></plist>`;
/** A client certificate from a CA's intermediate (openssl), for hand-made device messages. */
function deviceIdentity(tag, { caCert, caKey }) {
  const key = path.join(tmp, `${tag}.key`), csr = path.join(tmp, `${tag}.csr`), crt = path.join(tmp, `${tag}.crt`), ext = path.join(tmp, `${tag}.ext`);
  fs.writeFileSync(ext, 'basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=clientAuth\n');
  sh('openssl', ['genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:2048', '-out', key]);
  sh('openssl', ['req', '-new', '-key', key, '-subj', `/CN=TEST device ${tag}`, '-out', csr]);
  sh('openssl', ['x509', '-req', '-in', csr, '-CA', caCert, '-CAkey', caKey, '-CAcreateserial', '-days', '30', '-extfile', ext, '-out', crt]);
  return { key, crt, sha256: createHash('sha256').update(new X509Certificate(fs.readFileSync(crt)).raw).digest('hex') };
}
/** A detached CMS over `body`, base64: what a device puts in Mdm-Signature. */
function mdmSign(body, id) {
  const inF = path.join(tmp, `msg-${randomBytes(4).toString('hex')}`);
  fs.writeFileSync(inF, body);
  const der = execFileSync('openssl', ['cms', '-sign', '-binary', '-in', inF, '-signer', id.crt, '-inkey', id.key, '-outform', 'DER', '-md', 'sha256']);
  return der.toString('base64');
}
function selfSignedCa(tag) {
  const key = path.join(tmp, `${tag}-ca.key`), crt = path.join(tmp, `${tag}-ca.crt`);
  sh('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-subj', `/CN=TEST ${tag} CA`, '-days', '30', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign', '-out', crt]);
  return { caCert: crt, caKey: key };
}

// ── The APNs stub ───────────────────────────────────────────────────────

const pushes = [];
let stubPushCertSha = null;
function startApnsStub() {
  const ca = selfSignedCa('apns-stub');
  const key = path.join(tmp, 'apns-srv.key'), csr = path.join(tmp, 'apns-srv.csr'), crt = path.join(tmp, 'apns-srv.crt'), ext = path.join(tmp, 'apns-srv.ext');
  fs.writeFileSync(ext, 'basicConstraints=CA:FALSE\nsubjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n');
  sh('openssl', ['genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:2048', '-out', key]);
  sh('openssl', ['req', '-new', '-key', key, '-subj', '/CN=127.0.0.1', '-out', csr]);
  sh('openssl', ['x509', '-req', '-in', csr, '-CA', ca.caCert, '-CAkey', ca.caKey, '-CAcreateserial', '-days', '30', '-extfile', ext, '-out', crt]);
  fs.copyFileSync(ca.caCert, path.join(tmp, 'apns-ca.crt'));
  const srv = http2.createSecureServer({ key: fs.readFileSync(key), cert: fs.readFileSync(crt), requestCert: true, rejectUnauthorized: false, allowHTTP1: false });
  srv.on('stream', (stream, headers) => {
    const peer = stream.session.socket.getPeerCertificate(false);
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => {
      const p = {
        method: headers[':method'], path: headers[':path'], topic: headers['apns-topic'], type: headers['apns-push-type'], priority: headers['apns-priority'],
        body: Buffer.concat(chunks).toString('utf8'), clientCertSha256: peer?.raw ? createHash('sha256').update(peer.raw).digest('hex') : null,
      };
      pushes.push(p);
      const token = String(headers[':path']).split('/').pop();
      if (token === Buffer.from('deadToken').toString('hex')) { stream.respond({ ':status': 410, 'content-type': 'application/json' }); stream.end(JSON.stringify({ reason: 'Unregistered' })); return; }
      if (p.clientCertSha256 !== stubPushCertSha) { stream.respond({ ':status': 403, 'content-type': 'application/json' }); stream.end(JSON.stringify({ reason: 'BadCertificate' })); return; }
      stream.respond({ ':status': 200, 'apns-id': '11111111-2222-3333-4444-555555555555' });
      stream.end();
    });
  });
  return new Promise((r) => srv.listen(APNS_PORT, '127.0.0.1', () => r(srv)));
}

/** GET over https trusting one CA file (the device CA's step-ca). */
function caRequest(method, url, { body, ca, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = https.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, ca, headers, checkServerIdentity: (_h, cert) => tls.checkServerIdentity('127.0.0.1', cert) }, (res) => {
      const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(c).toString('utf8') }));
    });
    r.on('error', reject);
    if (body) r.end(body); else r.end();
  });
}
const b64u = (b) => Buffer.from(b).toString('base64url');

const resetRow = () => prisma.$executeRawUnsafe(`UPDATE "MdmPlatformSetup" SET "appleChecklist" = '{}', "androidChecklist" = '{}', "signingRoute" = NULL,
  "pushKeyEnc" = NULL, "pushCsrPem" = NULL, "pushKeySpkiSha256" = NULL, "pushKeyCreatedAt" = NULL,
  "vendorKeyEnc" = NULL, "vendorCertPem" = NULL, "vendorChainPem" = NULL, "vendorNotAfter" = NULL, "vendorSetAt" = NULL,
  "pushCertEnc" = NULL, "pushCertSerial" = NULL, "pushCertSha256" = NULL, "pushCertIssuer" = NULL, "pushCertNotBefore" = NULL, "pushCertNotAfter" = NULL,
  "pushCertInstalledAt" = NULL, "pushCertRenewedAt" = NULL, "apnsTopic" = NULL, "appleAccount" = NULL, "pushRemindedDays" = NULL,
  "deviceCaRootPem" = NULL, "deviceCaChainPem" = NULL, "deviceCaRootSha256" = NULL, "deviceCaNotAfter" = NULL, "deviceCaSetAt" = NULL,
  "profileSignKeyEnc" = NULL, "profileSignCertPem" = NULL, "profileSignChainPem" = NULL, "profileSignSha256" = NULL, "profileSignNotAfter" = NULL, "profileSignSetAt" = NULL,
  "updatedAt" = now() WHERE id = 'platform'`);
let api, apns, ca;
const created = { businesses: [], users: [] };

async function all() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first (prisma db seed)');
  if (await prisma.platformSettings.findFirst({ where: { publicUrl: { not: null } } }).catch(() => null)) throw new Error('this scratch database has a public URL setting; the suite needs the loopback one from PUBLIC_API_URL');
  await confirmEverythingAsks(prisma);
  await resetRow();
  const started = new Date();
  const roleOwner = await prisma.role.findFirst({ where: { type: 'BUSINESS_OWNER' } });

  section('The device CA: rem0te-mdm-ca-setup.sh in a temporary directory (TEST ONLY SCEP)');
  const setupOut = sh('bash', [path.join(repo, 'deploy/mdm-ca/rem0te-mdm-ca-setup.sh'), '--prefix', caDir, '--no-user', '--no-systemd', '--port', String(CA_PORT),
    '--dns-name', '127.0.0.1', '--step-ca-bin', STEPCA, '--test-scep-port', String(SCEP_PORT), '--test-scep-challenge', CHALLENGE]);
  check(/rem0te-mdm-ca is set up/.test(setupOut) && fs.existsSync(path.join(caEtc, 'public', 'root_ca.crt')), 'the setup script makes the root, intermediate and profile signer, and ca.json', setupOut.slice(-400));
  const caJson = JSON.parse(fs.readFileSync(path.join(caEtc, 'ca.json'), 'utf8'));
  const acmeProv = caJson.authority.provisioners.find((p) => p.type === 'ACME');
  check(caJson.address === `127.0.0.1:${CA_PORT}` && acmeProv?.name === 'rem0te-mdm' && JSON.stringify(acmeProv.challenges) === '["device-attest-01"]' && JSON.stringify(acmeProv.attestationFormats) === '["apple"]',
    'ca.json: loopback only; one ACME provisioner, device-attest-01 with Apple attestation only', JSON.stringify(caJson.authority.provisioners));
  const again = sh('bash', [path.join(repo, 'deploy/mdm-ca/rem0te-mdm-ca-setup.sh'), '--prefix', caDir, '--no-user', '--no-systemd', '--port', String(CA_PORT), '--dns-name', '127.0.0.1', '--step-ca-bin', STEPCA, '--test-scep-port', String(SCEP_PORT), '--test-scep-challenge', CHALLENGE]);
  check(/set up/.test(again) && fs.readFileSync(path.join(caEtc, 'root_ca.crt'), 'utf8') === fs.readFileSync(path.join(caEtc, 'public', 'root_ca.crt'), 'utf8'), 'running it again regenerates no key');
  let refused = '';
  try { sh('bash', [path.join(repo, 'deploy/mdm-ca/rem0te-mdm-ca-setup.sh'), '--no-user', '--no-systemd', '--dns-name', 'x.example.test', '--test-scep-port', '4999', '--test-scep-challenge', CHALLENGE]); } catch (e) { refused = String(e.stderr); }
  check(/test suite only/.test(refused), 'the SCEP provisioner is refused without --prefix (never on a real server)', refused.slice(0, 200));
  ca = spawn(path.join(caDir, 'usr/local/lib/rem0te-mdm-ca/step-ca'), [path.join(caEtc, 'ca.json')], { stdio: ['ignore', 'pipe', 'pipe'] });
  ca.log = ''; ca.stdout.on('data', (d) => { ca.log += d; }); ca.stderr.on('data', (d) => { ca.log += d; });
  procs.push(ca);
  const rootPem = fs.readFileSync(path.join(caEtc, 'public', 'root_ca.crt'), 'utf8');
  const midPem = fs.readFileSync(path.join(caEtc, 'public', 'intermediate_ca.crt'), 'utf8');
  for (let i = 0; i < 50 && !/Serving HTTP on/.test(ca.log); i++) await sleep(200);
  const dir = await caRequest('GET', `https://127.0.0.1:${CA_PORT}/acme/rem0te-mdm/directory`, { ca: rootPem, headers: { host: 'rmm.example.test' } });
  const dj = JSON.parse(dir.text || '{}');
  check(dir.status === 200 && dj.newOrder === 'https://rmm.example.test/acme/rem0te-mdm/new-order', 'the ACME directory names the public host and /acme/rem0te-mdm/ (the path Caddy\'s one route proxies)', dir.text.slice(0, 300));

  section('ACME on loopback: an order\'s only challenge is device-attest-01 (no attestation is made)');
  {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' });
    const nonce = async () => (await caRequest('HEAD', `https://127.0.0.1:${CA_PORT}/acme/rem0te-mdm/new-nonce`, { ca: rootPem })).headers['replay-nonce'];
    const jws = async (url, payload, kid) => {
      const prot = { alg: 'ES256', nonce: await nonce(), url, ...(kid ? { kid } : { jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } }) };
      const input = `${b64u(JSON.stringify(prot))}.${payload === '' ? '' : b64u(JSON.stringify(payload))}`;
      const sig = edSign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' });
      return JSON.stringify({ protected: input.split('.')[0], payload: input.split('.')[1], signature: b64u(sig) });
    };
    const base = `https://127.0.0.1:${CA_PORT}/acme/rem0te-mdm`;
    const post = async (url, payload, kid) => caRequest('POST', url, { ca: rootPem, body: await jws(url, payload, kid), headers: { 'content-type': 'application/jose+json' } });
    const acct = await post(`${base}/new-account`, { termsOfServiceAgreed: true });
    const kid = acct.headers.location;
    const order = await post(`${base}/new-order`, { identifiers: [{ type: 'permanent-identifier', value: 'TESTSERIAL0001' }] }, kid);
    const oj = JSON.parse(order.text || '{}');
    const authz = oj.authorizations?.[0] ? await post(oj.authorizations[0], '', kid) : { text: '{}' };
    const types = (JSON.parse(authz.text || '{}').challenges ?? []).map((c) => c.type);
    check(acct.status === 201 && order.status === 201 && JSON.stringify(types) === '["device-attest-01"]', 'an ACME order for a permanent-identifier offers device-attest-01 only', JSON.stringify({ acct: acct.status, order: order.status, types, o: order.text.slice(0, 200) }));
    const dnsOrder = await post(`${base}/new-order`, { identifiers: [{ type: 'dns', value: 'evil.example.test' }] }, kid);
    const dj2 = JSON.parse(dnsOrder.text || '{}');
    const dnsAuthz = dj2.authorizations?.[0] ? JSON.parse((await post(dj2.authorizations[0], '', kid)).text || '{}') : {};
    const dnsTypes = (dnsAuthz.challenges ?? []).map((c) => c.type);
    check(!dnsTypes.some((t) => t === 'http-01' || t === 'dns-01' || t === 'tls-alpn-01'), 'a DNS-name order gets no http-01, dns-01 or tls-alpn-01 challenge', JSON.stringify({ s: dnsOrder.status, dnsTypes }));
  }

  section('Fixtures (synthetic): a Platform Admin, a Business Owner, a business; the APNs stub');
  const A = await prisma.customer.create({ data: { tenantId: tenant.id, name: `Harbor ${sfx}` } });
  created.businesses.push(A.id);
  const hash = await argon2.hash(PW, { type: argon2.argon2id });
  const mkUser = async (tag, extra = {}) => { const u = await prisma.user.create({ data: { email: `hb-${tag}-${sfx.toLowerCase()}@test.invalid`, passwordHash: hash, firstName: 'HB', lastName: tag, status: 'ACTIVE', ...extra } }); created.users.push(u.id); return u; };
  const admin = await mkUser('admin', { isPlatformAdmin: true });
  const owner = await mkUser('owner');
  await prisma.membership.create({ data: { userId: owner.id, tenantId: tenant.id, customerId: A.id, roleId: roleOwner.id } });
  apns = await startApnsStub();
  api = startApi();
  await waitUp(api);
  const S = { admin: await login(admin.email), owner: await login(owner.email) };
  const F = await stepUp(S.admin);

  section('Steps 1–5 (stand-ins): the push key, the vendor certificate, the push certificate');
  const now = new Date();
  let r = await req('POST', '/mdm/setup/apple/push-key', { s: F, body: {} });
  const csrPem = (await req('GET', '/mdm/setup/apple/push-csr', { s: F })).data?.csr;
  if (!csrPem) throw new Error(`no push CSR: ${msg(r)}`);
  const ch = testChain(now);
  await req('PUT', '/mdm/setup/apple/vendor', { s: F, body: { certificate: ch.vendor.pem, privateKey: ch.vendor.keyPem, chain: ch.chainPem } });
  const topic = testTopic();
  const pc = pushCertFor({ csrPem, topic, now });
  stubPushCertSha = createHash('sha256').update(pc.cert.raw).digest('hex');
  r = await req('PUT', '/mdm/setup/apple/push-certificate', { s: F, body: { certificate: pc.pem, appleAccount: 'mdm-push@example.test' } });
  check(r.status === 200 && r.data.apple.topic === topic, 'a stand-in push certificate is installed', msg(r));

  section('Step 6: the device CA and the profile signer');
  r = await req('POST', '/mdm/apple/links', { s: F, body: { businessId: A.id } });
  check(r.status === 409 && code(r) === 'NO_DEVICE_CA', 'no enrollment link before the device CA is uploaded', msg(r));
  r = await req('PUT', '/mdm/setup/apple/device-ca', { s: S.admin, body: { root: rootPem, intermediates: midPem } });
  check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED', 'uploading the device CA asks for a fresh confirmation (mdm.setup)', msg(r));
  r = await req('PUT', '/mdm/setup/apple/device-ca', { s: F, body: { root: midPem } });
  check(r.status === 400 && code(r) === 'CA_NOT_ROOT', 'an intermediate offered as the root is refused', msg(r));
  r = await req('PUT', '/mdm/setup/apple/device-ca', { s: F, body: { root: rootPem, intermediates: ch.mid.pem } });
  check(r.status === 400 && code(r) === 'CA_CHAIN_BROKEN', 'an intermediate from another CA is refused', msg(r));
  r = await req('PUT', '/mdm/setup/apple/device-ca', { s: F, body: { root: rootPem, intermediates: midPem } });
  check(r.status === 200 && r.data.apple.deviceCa.present && r.data.apple.deviceCa.intermediates === 1 && !SECRET_RE.test(r.text), 'the device CA\'s root and intermediate are accepted; nothing secret returned', msg(r));
  const signerCrt = fs.readFileSync(path.join(caEtc, 'public', 'profile_signer.crt'), 'utf8');
  const signerKey = fs.readFileSync(path.join(caEtc, 'handoff', 'profile-signer.key'), 'utf8');
  r = await req('PUT', '/mdm/setup/apple/profile-signer', { s: F, body: { certificate: midPem, privateKey: signerKey } });
  check(r.status === 400 && (code(r) === 'SIGNER_KEY_MISMATCH' || code(r) === 'SIGNER_IS_CA'), 'a CA certificate (or a key that is not its own) is refused as the signer', msg(r));
  r = await req('PUT', '/mdm/setup/apple/profile-signer', { s: F, body: { certificate: signerCrt, privateKey: signerKey, chain: midPem } });
  check(r.status === 200 && r.data.apple.profileSigner.present && !SECRET_RE.test(r.text) && !r.text.includes(signerKey.slice(30, 70)), 'the profile signer is accepted and sealed; its key is never returned', msg(r));
  const setupRow = await prisma.mdmPlatformSetup.findUnique({ where: { id: 'platform' } });
  check(/^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/.test(setupRow.profileSignKeyEnc ?? '') && !/PRIVATE/.test(setupRow.profileSignKeyEnc), 'the stored key is a sealed value, not PEM');
  r = await req('GET', '/mdm/setup', { s: F });
  const caps = Object.fromEntries((r.data?.capabilities ?? []).map((c) => [c.key, c]));
  check(caps['apple.device_ca']?.state === 'available' && caps['apple.profile_signer']?.state === 'available' && caps['apple.enrollment']?.state === 'requires_setup' && /Ready/.test(caps['apple.enrollment']?.detail ?? caps['apple.enrollment']?.reason ?? JSON.stringify(caps['apple.enrollment'])),
    'step 6 complete: enrollment is ready but not yet proven', JSON.stringify(caps['apple.enrollment']));

  section('Enrollment links: Platform Admin, fresh confirmation (mdm.enroll), shown once');
  r = await req('POST', '/mdm/apple/links', { s: await stepUp(S.owner), body: { businessId: A.id } });
  check(r.status === 403, 'a Business Owner cannot create a link', msg(r));
  r = await req('GET', '/mdm/apple/devices', { s: S.owner });
  check(r.status === 403, 'a Business Owner cannot list the Apple devices here', msg(r));
  r = await req('POST', '/mdm/apple/links', { s: S.admin, body: { businessId: A.id } });
  check(r.status === 403 && code(r) === 'STEP_UP_REQUIRED' && r.body?.action === 'mdm.enroll', 'creating a link without a fresh confirmation: 403 naming mdm.enroll', msg(r));
  r = await req('POST', '/mdm/apple/links', { s: F, body: { businessId: A.id, expiresInMinutes: 5 } });
  check(r.status === 400, 'a link shorter than 15 minutes is refused', msg(r));
  const mkLink = async () => { const x = await req('POST', '/mdm/apple/links', { s: F, body: { businessId: A.id } }); if (x.status !== 200) throw new Error(msg(x)); return x.data; };
  const L1 = await mkLink();
  const token1 = L1.url.split('/').pop();
  check(L1.shownOnce && L1.url.startsWith(`http://127.0.0.1:${PORT}/api/v1/mdm/apple/enroll/`) && /^[A-Za-z0-9_-]{43}$/.test(token1), 'a link is returned once, with a 256-bit token', JSON.stringify(L1));
  const linkRow = await prisma.appleEnrollmentLink.findUnique({ where: { id: L1.id } });
  check(linkRow.tokenSha256 === createHash('sha256').update(token1).digest('hex') && !JSON.stringify(linkRow).includes(token1), 'only the token\'s SHA-256 is stored');
  r = await req('GET', '/mdm/apple/links', { s: F });
  check(r.status === 200 && !r.text.includes(token1) && r.data.some((l) => l.id === L1.id && l.state === 'open'), 'the list never shows the token', msg(r));

  section('The signed profile: claimed once, verifies under the device CA');
  let res = await fetch(L1.url, { headers: { 'x-forwarded-for': ip() } });
  const prof = Buffer.from(await res.arrayBuffer());
  check(res.status === 200 && res.headers.get('content-type') === 'application/x-apple-aspen-config' && res.headers.get('cache-control') === 'no-store', 'GET the link: 200, application/x-apple-aspen-config, no-store', `${res.status} ${res.headers.get('content-type')}`);
  res = await fetch(L1.url, { headers: { 'x-forwarded-for': ip() } });
  const second = await res.text();
  check(res.status === 404 && second === '', 'a second download of the same link: 404 with no body', `${res.status} ${second.slice(0, 80)}`);
  res = await fetch(`${API}/mdm/apple/enroll/${'A'.repeat(43)}`, { headers: { 'x-forwarded-for': ip() } });
  check(res.status === 404, 'an unknown token: the same 404');
  fs.writeFileSync(path.join(tmp, 'p1.mobileconfig'), prof);
  let verified;
  try { verified = sh('openssl', ['cms', '-verify', '-inform', 'DER', '-in', path.join(tmp, 'p1.mobileconfig'), '-CAfile', path.join(caEtc, 'public', 'root_ca.crt'), '-purpose', 'any', '-out', path.join(tmp, 'p1.plist')]); verified = 'ok'; } catch (e) { verified = String(e.stderr); }
  const p1 = fs.existsSync(path.join(tmp, 'p1.plist')) ? fs.readFileSync(path.join(tmp, 'p1.plist'), 'utf8') : '';
  check(verified === 'ok' && /<key>SignMessage<\/key>\s*<true\/>/.test(p1), 'openssl verifies the profile\'s signature under the device CA\'s root', verified.slice(0, 300));
  const ar = Number(p1.match(/<key>AccessRights<\/key>\s*<integer>(\d+)<\/integer>/)?.[1]);
  check(p1.includes(`<string>http://127.0.0.1:${PORT}/api/v1/mdm/apple/server</string>`) && p1.includes(`checkin?enroll=${L1.id}</string>`) && p1.includes(`<string>${topic}</string>`)
    && ar === 1309 && (ar & 8) === 8 && (ar & 2) === 0, 'it names ServerURL, CheckInURL with the link id, the push topic, and AccessRights 1309 (erase granted, decision 25; no profile install)', `AccessRights ${ar}`);
  check(!p1.includes('com.apple.security.pkcs12') && p1.includes('com.apple.security.scep') && p1.includes('TEST ONLY') && !/PRIVATE KEY|<key>Password<\/key>/.test(p1),
    'no PKCS#12 identity and no key: the device makes its own (here the TEST ONLY SCEP payload, under NODE_ENV=test only)');
  const linkAfter = await prisma.appleEnrollmentLink.findUnique({ where: { id: L1.id } });
  check(linkAfter.state === 'claimed' && linkAfter.claimedAt, 'the link is claimed');

  section('Mdm-Signature before any parse: every refusal is 401 with no body');
  const devA = deviceIdentity('devA', { caCert: path.join(caEtc, 'intermediate_ca.crt'), caKey: path.join(caEtc, 'intermediate_ca_key') });
  const foreign = deviceIdentity('foreign', selfSignedCa('foreign'));
  const udidA = `0000${randomBytes(10).toString('hex').toUpperCase()}`;
  const authA = Buffer.from(plistXml({ MessageType: 'Authenticate', UDID: udidA, Topic: topic, ProductName: 'iPad13,1', OSVersion: '17.4', BuildVersion: '21E219', SerialNumber: `TESTA${sfx}`, DeviceName: 'Test iPad <A>' }));
  const okSig = mdmSign(authA, devA);
  const refusals = [
    ['no signature', await dev(`/mdm/apple/checkin?enroll=${L1.id}`, authA, undefined)],
    ['an empty signature', await dev(`/mdm/apple/checkin?enroll=${L1.id}`, authA, '')],
    ['not base64', await dev(`/mdm/apple/checkin?enroll=${L1.id}`, authA, '!!!notbase64!!!')],
    ['garbage DER', await dev(`/mdm/apple/checkin?enroll=${L1.id}`, authA, randomBytes(300).toString('base64'))],
    ['a tampered body', await dev(`/mdm/apple/checkin?enroll=${L1.id}`, Buffer.from(authA.toString().replace('iPad13,1', 'iPad13,2')), okSig)],
    ['a signature from another CA', await dev(`/mdm/apple/checkin?enroll=${L1.id}`, authA, mdmSign(authA, foreign))],
    ['no link', await dev('/mdm/apple/checkin', authA, okSig)],
    ['a link id that does not exist', await dev(`/mdm/apple/checkin?enroll=ael${'0'.repeat(22)}`, authA, okSig)],
    ['the server endpoint, unsigned', await dev('/mdm/apple/server', Buffer.from(plistXml({ UDID: udidA, Status: 'Idle' })), undefined, null)],
  ];
  for (const [n, x] of refusals) check(x.status === 401 && x.body.length === 0, `${n}: 401, no body`, `${x.status} ${x.text.slice(0, 80)}`);
  const garbled = await dev(`/mdm/apple/checkin?enroll=${L1.id}`, Buffer.from('<plist>&bogus;</plist>'), mdmSign(Buffer.from('<plist>&bogus;</plist>'), devA));
  check(garbled.status === 400 && garbled.body.length === 0, 'a correctly signed body that is not a plist: 400, nothing stored', `${garbled.status}`);
  const big = Buffer.alloc(70 * 1024, 0x20);
  const tooBig = await dev(`/mdm/apple/checkin?enroll=${L1.id}`, big, okSig);
  check(tooBig.status === 413, 'a check-in over 64 KB: 413', `${tooBig.status}`);
  check((await prisma.appleDevice.count({ where: { customerId: A.id } })) === 0, 'none of that stored a device');

  section('Authenticate: iOS/iPadOS 16+ only, a claimed link, once');
  const mac = Buffer.from(plistXml({ MessageType: 'Authenticate', UDID: udidA, Topic: topic, ProductName: 'Mac16,10', OSVersion: '15.1' }));
  r = await dev(`/mdm/apple/checkin?enroll=${L1.id}`, mac, mdmSign(mac, devA));
  check(r.status === 403 && r.body.length === 0, 'a Mac: 403, no body', `${r.status}`);
  const old = Buffer.from(plistXml({ MessageType: 'Authenticate', UDID: udidA, Topic: topic, ProductName: 'iPhone12,1', OSVersion: '15.7' }));
  r = await dev(`/mdm/apple/checkin?enroll=${L1.id}`, old, mdmSign(old, devA));
  check(r.status === 403, 'iOS 15: 403', `${r.status}`);
  const wrongTopic = Buffer.from(plistXml({ MessageType: 'Authenticate', UDID: udidA, Topic: 'com.apple.mgmt.External.00000000-0000-0000-0000-000000000000', ProductName: 'iPad13,1', OSVersion: '17.4' }));
  r = await dev(`/mdm/apple/checkin?enroll=${L1.id}`, wrongTopic, mdmSign(wrongTopic, devA));
  check(r.status === 401, 'another push topic: 401', `${r.status}`);
  const L0 = await mkLink();
  r = await dev(`/mdm/apple/checkin?enroll=${L0.id}`, authA, okSig);
  check(r.status === 401, 'a link that was never downloaded (open, not claimed): 401', `${r.status}`);
  r = await dev(`/mdm/apple/checkin?enroll=${L1.id}`, authA, okSig);
  check(r.status === 200, 'a signed Authenticate naming the claimed link: 200', msg(r));
  r = await dev(`/mdm/apple/checkin?enroll=${L1.id}`, authA, okSig);
  check(r.status === 401, 'the same Authenticate replayed: 401 (the link is used)', `${r.status}`);
  let dA = await prisma.appleDevice.findFirst({ where: { udid: udidA } });
  check(dA?.state === 'authenticated' && dA.certSha256 === devA.sha256 && dA.platform === 'ipados' && dA.serialNumber === `TESTA${sfx}` && dA.deviceName === 'Test iPad <A>' && dA.customerId === A.id,
    'the device is bound to its link\'s business, its UDID and its certificate; the serial is kept (corporate)', JSON.stringify(dA));
  check((await prisma.appleEnrollmentLink.findUnique({ where: { id: L1.id } })).state === 'used', 'the link is used');

  section('TokenUpdate: only the enrolled certificate; no UnlockToken kept');
  const devA2 = deviceIdentity('devA2', { caCert: path.join(caEtc, 'intermediate_ca.crt'), caKey: path.join(caEtc, 'intermediate_ca_key') });
  const tuA = Buffer.from(plistXml({ MessageType: 'TokenUpdate', UDID: udidA, Topic: topic, Token: Buffer.from('deadToken'), PushMagic: 'magic-A-1', UnlockToken: Buffer.from('secret-unlock-token') }));
  r = await dev('/mdm/apple/checkin', tuA, mdmSign(tuA, devA2));
  check(r.status === 401, 'a TokenUpdate signed by another (valid) device certificate: 401', `${r.status}`);
  r = await dev('/mdm/apple/checkin', tuA, mdmSign(tuA, devA));
  check(r.status === 200, 'the enrolled certificate\'s TokenUpdate: 200', msg(r));
  dA = await prisma.appleDevice.findFirst({ where: { udid: udidA } });
  check(dA.state === 'enrolled' && dA.pushToken === Buffer.from('deadToken').toString('hex') && dA.pushMagic === 'magic-A-1' && !JSON.stringify(dA, (k, v) => (typeof v === 'bigint' ? String(v) : v)).includes(Buffer.from('secret-unlock-token').toString('base64')),
    'enrolled; the push token and magic are kept; the UnlockToken is not', JSON.stringify({ s: dA.state }));
  const cmdsA = await prisma.appleCommand.findMany({ where: { appleDeviceId: dA.id }, orderBy: { requestType: 'asc' } });
  check(cmdsA.length === 5 && cmdsA.every((c) => c.state === 'queued') && JSON.stringify(cmdsA.map((c) => c.requestType).sort()) === JSON.stringify(['CertificateList', 'DeviceInformation', 'InstalledApplicationList', 'ProfileList', 'SecurityInfo']),
    'the five inventory commands are queued, and nothing else', cmdsA.map((c) => c.requestType).join());

  section('mdmb (a simulator, not iOS): SCEP from the test CA, then Authenticate and TokenUpdate');
  const mdb = path.join(tmp, 'mdmb.db');
  const created1 = sh(MDMB, ['-db', mdb, 'devices-create', '-n', '1', '-product-name', 'iPhone15,2', '-os-version', '17.5']);
  const udidB = created1.trim().split('\n').pop().trim();
  const L2 = await mkLink();
  res = await fetch(L2.url, { headers: { 'x-forwarded-for': ip() } });
  fs.writeFileSync(path.join(tmp, 'p2.mobileconfig'), Buffer.from(await res.arrayBuffer()));
  sh('openssl', ['cms', '-verify', '-inform', 'DER', '-in', path.join(tmp, 'p2.mobileconfig'), '-CAfile', path.join(caEtc, 'public', 'root_ca.crt'), '-purpose', 'any', '-out', path.join(tmp, 'p2.plist')]);
  let installOut;
  try { installOut = sh(MDMB, ['-db', mdb, '-uuids', udidB, 'devices-profiles-install', '-f', path.join(tmp, 'p2.plist')]) + ''; } catch (e) { installOut = `${e.stdout}${e.stderr}`; }
  let dB = await prisma.appleDevice.findFirst({ where: { udid: udidB } });
  check(dB?.state === 'enrolled' && dB.platform === 'ios' && dB.pushMagic === 'fakePushMagic' && dB.customerId === A.id, 'mdmb enrolled through the signed profile: its certificate from step-ca\'s SCEP, Authenticate and TokenUpdate signed', `${installOut.slice(-600)} ${JSON.stringify(dB && { s: dB.state, p: dB.platform })}`);

  section('The sweep pushes {"mdm": PushMagic}, presenting the push certificate');
  for (let i = 0; i < 40 && pushes.filter((p) => p.path === `/3/device/${dB?.pushToken}`).length === 0; i++) await sleep(500);
  const pB = pushes.find((p) => p.path === `/3/device/${dB?.pushToken}`);
  check(pB && pB.method === 'POST' && pB.body === JSON.stringify({ mdm: 'fakePushMagic' }) && pB.topic === topic && pB.type === 'mdm' && pB.priority === '10',
    'APNs got exactly {"mdm":"fakePushMagic"} on /3/device/<token>, apns-topic the push topic, apns-push-type mdm', JSON.stringify(pB));
  check(pB?.clientCertSha256 === stubPushCertSha, 'the TLS client certificate presented is the installed push certificate', `${pB?.clientCertSha256} vs ${stubPushCertSha}`);
  for (let i = 0; i < 20; i++) { dB = await prisma.appleDevice.findFirst({ where: { udid: udidB } }); if (dB.lastPushOkAt) break; await sleep(300); }
  check(dB.lastPushResult === 'ok' && dB.lastPushOkAt, 'the push is recorded as answered');
  for (let i = 0; i < 20; i++) { dA = await prisma.appleDevice.findFirst({ where: { udid: udidA } }); if (dA.lastPushResult) break; await sleep(300); }
  check(dA.lastPushResult === 'unregistered' && dA.pushTokenInvalidAt, 'APNs\' 410 Unregistered stops pushing that device', JSON.stringify({ r: dA.lastPushResult }));
  const countA = pushes.filter((p) => p.path === `/3/device/${dA.pushToken}`).length;
  await sleep(5000);
  check(pushes.filter((p) => p.path === `/3/device/${dA.pushToken}`).length === countA, 'and it is not pushed again until a new TokenUpdate');

  section('mdmb connects: the queue is fetched, answered and recorded');
  let connectOut;
  try { connectOut = sh(MDMB, ['-db', mdb, '-uuids', udidB, 'devices-connect']) + ''; } catch (e) { connectOut = `${e.stdout}${e.stderr}`; }
  const cmdsB = await prisma.appleCommand.findMany({ where: { appleDeviceId: dB.id } });
  const byType = Object.fromEntries(cmdsB.map((c) => [c.requestType, c]));
  check(byType.DeviceInformation?.state === 'acknowledged' && byType.DeviceInformation.sentAt && byType.DeviceInformation.respondedAt, 'DeviceInformation: sent, then acknowledged', `${connectOut.slice(-400)} ${JSON.stringify(byType.DeviceInformation)}`);
  const others = ['SecurityInfo', 'InstalledApplicationList', 'CertificateList'];
  check(byType.ProfileList?.state === 'acknowledged', 'ProfileList (which mdmb implements): acknowledged', JSON.stringify(byType.ProfileList));
  check(others.every((t) => byType[t]?.state === 'error' && /^apple:/.test(byType[t].errorCode ?? '')), 'the three mdmb does not implement come back as errors with Apple\'s domain and code, never its text', JSON.stringify(others.map((t) => [t, byType[t]?.state, byType[t]?.errorCode])));
  dB = await prisma.appleDevice.findFirst({ where: { udid: udidB } });
  check(dB.lastInventoryAt && dB.deviceName && dB.profileCount >= 1 && dB.lastSeenAt >= dB.lastPushOkAt, 'the device\'s name came from DeviceInformation; it connected after the push', JSON.stringify({ n: dB.deviceName }));
  check(['sha1', 'sha256', 'sha384', 'sha512'].includes(dB.signatureDigest), `the digest of its Mdm-Signature is recorded (decision 28): ${dB.signatureDigest}`, String(dB.signatureDigest));
  {
    const r = await req('GET', '/mdm/apple/devices', { s: S.admin });
    const row = (r.data ?? []).find((x) => x.id === dB.id);
    check(r.status === 200 && row?.signatureDigest === dB.signatureDigest, 'the admin device list shows the signature digest', JSON.stringify(row && { d: row.signatureDigest }));
  }
  const audits1 = await prisma.activityLog.findMany({ where: { createdAt: { gte: started }, action: { in: ['MDM_APPLE_COMMAND_RESULT'] } } });
  check(audits1.length >= 5 && audits1.every((a) => !/Description|LocalizedDescription|Unknown request type/i.test(JSON.stringify(a.metadata))), 'every result is audited with ids, the type and the code only', String(audits1.length));
  r = await req('GET', '/mdm/setup', { s: F });
  const caps2 = Object.fromEntries((r.data?.capabilities ?? []).map((c) => [c.key, c]));
  check(caps2['apple.enrollment']?.state === 'available' && r.data.apple.pushCertificate.proven === true, 'Settings: enrollment available and the push certificate proven (by the stub: a test)', JSON.stringify({ e: caps2['apple.enrollment'], p: r.data.apple.pushCertificate }));

  section('The sync: the business\'s `apple` connector and its mobile devices');
  let conn, mob;
  for (let i = 0; i < 40; i++) {
    conn = await prisma.mdmConnector.findFirst({ where: { customerId: A.id, provider: 'apple' } });
    mob = conn ? await prisma.mobileDevice.findMany({ where: { connectorId: conn.id } }) : [];
    if (mob.length >= 2 && conn.lastSyncResult) break;
    await sleep(500);
  }
  check(conn?.enabled && conn.lastSyncResult === 'ok', 'one enabled `apple` connector was created for the business, and read', JSON.stringify(conn));
  const mobB = mob.find((m) => m.providerDeviceId === dB.id);
  check(mobB && mobB.provider === 'apple' && mobB.platform === 'ios' && mobB.ownership === 'corporate' && mobB.enrollmentState === 'enrolled' && mobB.manufacturer === 'Apple', 'MobileDevice (written by the sync only): iOS, corporate, enrolled', JSON.stringify(mobB));
  let mcmds = [];
  for (let i = 0; i < 40; i++) {
    mcmds = conn ? await prisma.mdmCommand.findMany({ where: { connectorId: conn.id, mobileDeviceId: mobB?.id } }) : [];
    if (mcmds.filter((c) => c.state === 'completed').length === 2 && mcmds.filter((c) => c.state === 'failed').length === 3) break;
    await sleep(500);
  }
  check(mcmds.length === 5 && mcmds.every((c) => c.kind === 'sync' && c.providerAcceptedAt) && mcmds.filter((c) => c.state === 'completed').length === 2 && mcmds.filter((c) => c.state === 'failed').length === 3,
    'its five commands appear as `sync`, accepted when fetched: two completed, three failed', JSON.stringify(mcmds.map((c) => c.state)));
  r = await req('GET', `/mobile-devices?businessId=${A.id}`, { s: S.owner });
  check(r.status === 200 || r.status === 403, 'the mobile-devices list answers as before (mobile:view)', msg(r));
  r = await req('GET', '/mdm/apple/devices', { s: F });
  check(r.status === 200 && r.data.length >= 2 && !/pushToken|pushMagic|fakePushMagic/.test(r.text), 'the Platform Admin device list never shows a push token or magic', msg(r).slice(0, 200));

  section('CheckOut (signed by mdmb\'s own identity) is final');
  const coB = Buffer.from(plistXml({ MessageType: 'CheckOut', UDID: udidB, Topic: topic }));
  fs.writeFileSync(path.join(tmp, 'co.plist'), coB);
  const coSig = sh(MDMB, ['-db', mdb, '-uuids', udidB, 'devices-mdm-signature', '-f', path.join(tmp, 'co.plist')]).trim();
  r = await dev('/mdm/apple/checkin', coB, coSig);
  check(r.status === 200, 'CheckOut signed with mdmb\'s certificate: 200', msg(r));
  dB = await prisma.appleDevice.findFirst({ where: { id: dB.id } });
  check(dB.state === 'checked_out' && dB.checkoutReason === 'checkout' && dB.pushToken === null && dB.pushMagic === null, 'checked out; the push token is dropped');
  const idle = Buffer.from(plistXml({ UDID: udidB, Status: 'Idle' }));
  r = await dev('/mdm/apple/server', idle, sh(MDMB, ['-db', mdb, '-uuids', udidB, 'devices-mdm-signature', '-f', (fs.writeFileSync(path.join(tmp, 'idle.plist'), idle), path.join(tmp, 'idle.plist'))]).trim(), null);
  check(r.status === 401, 'afterwards the device is refused (401)', `${r.status}`);
  let raised = '';
  try { await prisma.appleDevice.update({ where: { id: dB.id }, data: { state: 'enrolled' } }); } catch (e) { raised = String(e.message); }
  check(/checked-out Apple device does not come back/.test(raised), '0101\'s trigger: a checked-out device never comes back', raised.slice(0, 120));
  for (let i = 0; i < 30; i++) { const m = await prisma.mobileDevice.findFirst({ where: { connectorId: conn.id, providerDeviceId: dB.id } }); if (m?.enrollmentState === 'unenrolled') { mob = m; break; } await sleep(500); }
  check(mob?.enrollmentState === 'unenrolled', 'the sync shows it unenrolled', JSON.stringify(mob?.enrollmentState));

  section('Revoking a link never asks; an expired claim is refused');
  const L3 = await mkLink();
  r = await req('DELETE', `/mdm/apple/links/${L3.id}`, { s: S.admin });
  check(r.status === 200, 'revoked without a fresh confirmation', msg(r));
  res = await fetch(L3.url, { headers: { 'x-forwarded-for': ip() } });
  check(res.status === 404, 'a revoked link\'s download: 404');
  const L4 = await mkLink();
  await fetch(L4.url, { headers: { 'x-forwarded-for': ip() } });
  await prisma.$executeRawUnsafe(`UPDATE "AppleEnrollmentLink" SET "claimedAt" = now() - interval '2 hours', "createdAt" = now() - interval '3 hours', "expiresAt" = now() - interval '2 hours' WHERE id = $1`, L4.id).catch(async () => {
    await prisma.$executeRawUnsafe(`UPDATE "AppleEnrollmentLink" SET "claimedAt" = now() - interval '2 hours' WHERE id = $1`, L4.id);
  });
  const udidC = `0000${randomBytes(10).toString('hex').toUpperCase()}`;
  const devC = deviceIdentity('devC', { caCert: path.join(caEtc, 'intermediate_ca.crt'), caKey: path.join(caEtc, 'intermediate_ca_key') });
  const authC = Buffer.from(plistXml({ MessageType: 'Authenticate', UDID: udidC, Topic: topic, ProductName: 'iPhone15,2', OSVersion: '17.5' }));
  r = await dev(`/mdm/apple/checkin?enroll=${L4.id}`, authC, mdmSign(authC, devC));
  check(r.status === 401, 'an Authenticate more than an hour after the download: 401', `${r.status}`);

  section('Nothing secret in any audit row or in the API\'s output');
  const audits = await prisma.activityLog.findMany({ where: { createdAt: { gte: started }, action: { in: ['MDM_APPLE_LINK_CREATED', 'MDM_APPLE_LINK_CLAIMED', 'MDM_APPLE_LINK_REVOKED', 'MDM_APPLE_DEVICE_AUTHENTICATED', 'MDM_APPLE_DEVICE_ENROLLED', 'MDM_APPLE_DEVICE_CHECKED_OUT', 'MDM_APPLE_COMMAND_RESULT', 'MDM_APPLE_PUSHED', 'MDM_SETUP_CREDENTIAL_SET'] } } });
  const acts = new Set(audits.map((a) => a.action));
  check(['MDM_APPLE_LINK_CREATED', 'MDM_APPLE_LINK_CLAIMED', 'MDM_APPLE_LINK_REVOKED', 'MDM_APPLE_DEVICE_AUTHENTICATED', 'MDM_APPLE_DEVICE_ENROLLED', 'MDM_APPLE_DEVICE_CHECKED_OUT', 'MDM_APPLE_COMMAND_RESULT', 'MDM_APPLE_PUSHED'].every((a) => acts.has(a)), 'every Apple event is audited', [...acts].join(','));
  const at = JSON.stringify(audits.map((a) => a.metadata));
  check(!SECRET_RE.test(at) && !at.includes(token1) && !at.includes('fakePushMagic') && !at.includes(Buffer.from('fakeToken').toString('hex')), 'no key, link token, push token or magic in any audit row');
  check(!/PRIVATE KEY|fakePushMagic|BEGIN CERTIFICATE/.test(api.log), 'nor in the API\'s output');
  check(!/api\.push\.apple\.com|gateway\.push\.apple/.test(api.log), 'the API logged no call to Apple');
}

try {
  await all();
} catch (e) {
  fail++; failures.push(String(e?.stack ?? e)); console.error(e);
} finally {
  for (const p of procs) await stop(p);
  if (apns) apns.close();
  await resetRow().catch(() => {});
  await prisma.membership.deleteMany({ where: { userId: { in: created.users } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: created.users } } }).catch(() => {});
  await prisma.customer.deleteMany({ where: { id: { in: created.businesses } } }).catch(() => {});
  await prisma.$disconnect();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
