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
if (drift || bad) { console.error(`${drift} schema(s) drifted, ${bad} fixture(s) failed${drift ? ' — run node scripts/gen-integration-contracts.mjs' : ''}`); process.exit(1); }
console.log(`ticket-rmm-v1: ${Object.keys(CONTRACT_SCHEMAS).length} schemas ${check ? 'match' : 'written'}, fixtures valid`);
