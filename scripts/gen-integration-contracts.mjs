#!/usr/bin/env node
/**
 * Generate docs/contracts/ticket-rmm-v1/schemas/*.schema.json from the runtime
 * zod schemas (apps/api/src/integration/contract.ts, compiled to dist), and
 * validate every fixture in docs/contracts/ticket-rmm-v1/fixtures against the
 * schema its file name names (<schema>.<case>.json).
 *
 *   node scripts/gen-integration-contracts.mjs           # write
 *   node scripts/gen-integration-contracts.mjs --check   # fail on drift (CI)
 *
 * Needs `nest build` first. The zod schemas are the source of truth; the JSON
 * Schemas are what ClientSt0r validates against, so the two must not drift.
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'apps/api/package.json'));
const { z } = require('zod');
const { CONTRACT_SCHEMAS } = require(path.join(root, 'apps/api/dist/integration/contract.js'));
const dir = path.join(root, 'docs/contracts/ticket-rmm-v1');
const check = process.argv.includes('--check');

let drift = 0, bad = 0;
for (const [name, schema] of Object.entries(CONTRACT_SCHEMAS)) {
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
  json.$id = `urn:rem0te:contract:ticket-rmm-v1:${name}`;
  json.title = `ticket-rmm-v1 ${name}`;
  const text = JSON.stringify(json, null, 2) + '\n';
  const file = path.join(dir, 'schemas', `${name}.schema.json`);
  if (check) {
    if (!existsSync(file) || readFileSync(file, 'utf8') !== text) { console.error(`drift: ${path.relative(root, file)}`); drift++; }
  } else writeFileSync(file, text);
}

for (const f of readdirSync(path.join(dir, 'fixtures')).filter((x) => x.endsWith('.json')).sort()) {
  const name = f.split('.')[0];
  const schema = CONTRACT_SCHEMAS[name];
  if (!schema) { console.error(`fixture ${f}: no schema named ${name}`); bad++; continue; }
  const data = JSON.parse(readFileSync(path.join(dir, 'fixtures', f), 'utf8'));
  const expectInvalid = f.includes('.invalid-');
  const r = schema.safeParse(data);
  if (r.success === expectInvalid) {
    console.error(`fixture ${f}: expected ${expectInvalid ? 'INVALID' : 'valid'}${r.success ? '' : ` — ${r.error.issues.map((i) => i.path.join('.') + ': ' + i.message).join('; ')}`}`);
    bad++;
  }
}
// ── Signed examples (0.30) ──────────────────────────────────────────────────
// examples/*.json are real exchanges recorded by apps/api/scripts/e2e-ticket-workflow.mjs
// --write-examples, signed with the TEST-ONLY keys in examples/keys/. Every
// signature must verify with the published public keys, every delegation
// token must be bound to its request body, and every body must match its schema.
const exDir = path.join(dir, 'examples');
let examplesChecked = 0;
if (existsSync(path.join(exDir, 'index.json'))) {
  const C = require(path.join(root, 'apps/api/dist/integration/crypto.js'));
  const { createPublicKey } = await import('node:crypto');
  const index = JSON.parse(readFileSync(path.join(exDir, 'index.json'), 'utf8'));
  const key = (n) => createPublicKey(readFileSync(path.join(exDir, 'keys', `${n}.pub.pem`), 'utf8'));
  const self = key('rem0te-self'), peerReq = key('clientst0r-request'), peerDel = key('clientst0r-delegation');
  const fail = (e, m) => { console.error(`example ${e.name}: ${m}`); bad++; };
  const bodyText = (b) => (b == null ? '' : JSON.stringify(b));
  for (const entry of index.examples) {
    const e = JSON.parse(readFileSync(path.join(exDir, entry.file), 'utf8'));
    examplesChecked++;
    const h = e.request.headers ?? {};
    const toPeer = e.direction === 'rem0te_to_clientst0r';
    if (h['rem0te-signature']) {
      const ok = C.verifyEd25519(toPeer ? self : peerReq, C.requestSigningString({
        audience: toPeer ? index.peer.peer_audience : index.peer.audience, method: e.request.method, pathWithQuery: e.request.path,
        timestamp: h['rem0te-timestamp'], nonce: h['rem0te-nonce'], bodySha256: C.sha256Hex(Buffer.from(bodyText(e.request.body))),
      }), h['rem0te-signature']);
      if (!ok) fail(e, 'request signature does not verify');
    } else if (!h['X-Integration-Signature']) fail(e, 'request carries no signature');
    if (h['rem0te-delegation']) {
      const t = C.parseJws(h['rem0te-delegation']);
      if (!C.verifyEd25519(peerDel, t.signingInput, t.signature)) fail(e, 'delegation token signature does not verify');
      const schema = e.request_schema && CONTRACT_SCHEMAS[e.request_schema];
      if (t.payload.req_sha256) {
        const parsed = schema ? schema.safeParse(e.request.body) : null;
        if (t.payload.req_sha256 !== C.sha256Hex(C.canonicalJson(parsed?.success ? parsed.data : e.request.body))) fail(e, 'delegation token is not bound to this body');
      }
    }
    const rsig = e.response.headers?.['rem0te-response-signature'];
    if (rsig && !C.verifyEd25519(peerReq, C.responseSigningString(h['rem0te-nonce'], C.sha256Hex(Buffer.from(bodyText(e.response.body)))), rsig)) fail(e, 'response signature does not verify');
    const b = e.request.body;
    if (b?.event && !C.verifyEd25519(self, C.eventSigningString(b.event), b.signature.sig)) fail(e, 'job event signature does not verify');
    if (b?.alert_event && !C.verifyEd25519(self, C.alertEventSigningString(b.alert_event), b.signature.sig)) fail(e, 'alert event signature does not verify');
    for (const [which, name, body] of [['request', e.request_schema, e.request.body], ['response', e.response_schema, e.response.body]]) {
      if (!name) continue;
      const r = CONTRACT_SCHEMAS[name]?.safeParse(body);
      if (!r) fail(e, `${which}: no schema named ${name}`);
      else if (!r.success) fail(e, `${which} does not match ${name}: ${r.error.issues.map((i) => i.path.join('.') + ': ' + i.message).join('; ')}`);
    }
  }
}

if (drift || bad) { console.error(`${drift} schema(s) drifted, ${bad} fixture(s) failed${drift ? ' — run node scripts/gen-integration-contracts.mjs' : ''}`); process.exit(1); }
console.log(`ticket-rmm-v1: ${Object.keys(CONTRACT_SCHEMAS).length} schemas ${check ? 'match' : 'written'}, fixtures valid, ${examplesChecked} signed examples verified`);
