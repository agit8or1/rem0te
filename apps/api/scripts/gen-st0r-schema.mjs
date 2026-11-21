#!/usr/bin/env node
// docs/st0r-push-contract.schema.json, generated from the API's own zod
// schema (apps/api/src/backups/model.ts Feed) so the published schema can
// never say something the API does not enforce (0.82 Wharf).
//
//   cd apps/api && npx nest build
//   node scripts/gen-st0r-schema.mjs            # write the file
//   node scripts/gen-st0r-schema.mjs --check    # exit 1 if the file differs (CI, via unit-backup-setup.mjs)
//
// The structure (types, enums, patterns, limits, required fields, no extra
// properties) is zod's z.toJSONSchema output for the request body, unedited.
// Only annotations are added: an $id, a title, and a description per field
// from DESCRIBE below. Rules JSON Schema cannot state (a running job has no
// finishedAt, a pass must have validated something, ids unique within their
// list, dates no later than tomorrow) are in the root description and in
// docs/st0r-push-contract.md, and the API enforces them.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { z } = require('zod');
const M = require(join(here, '..', 'dist', 'backups', 'model.js'));
export const SCHEMA_FILE = join(here, '..', '..', '..', 'docs', 'st0r-push-contract.schema.json');

const A = 'properties.assets.items.properties';
const DESCRIBE = {
  '': 'Rem0te St0r push contract, version 1: the body of POST /api/v1/backups/push. Also enforced and not expressible here: a job with completion "running" has no finishedAt; a drill with result "passed" has a validation other than "none"; a drill whose result is passed, failed or partial has finishedAt; externalId is unique among the assets, and within each asset\'s jobs, recoveryPoints and drills; every date is RFC 3339 with an offset, no earlier than 2000-01-01 and no later than 24 hours after Rem0te\'s clock. The body carries no business: the token decides it. See docs/st0r-push-contract.md.',
  'properties.v': 'The contract version. Always 1 for this contract.',
  'properties.assets': 'The assets this push reports on. A push is a delta: an asset left out is kept as it was. At most 500 per push; send more pushes for more.',
  [`${A}.externalId`]: 'St0r\'s own stable id for the asset. The same id in a later push updates the same asset.',
  [`${A}.name`]: 'What people see. Letters (including Latin accents), digits, space and . , : ; ( ) / & + \' # _ @ - only.',
  [`${A}.type`]: 'What is protected.',
  [`${A}.computer`]: 'Which Rem0te computer this asset is, if St0r knows. Linked only to a computer of the token\'s business; anything else leaves it unlinked.',
  [`${A}.computer.properties.rem0teId`]: 'The computer\'s Rem0te id. Tried first.',
  [`${A}.computer.properties.hostname`]: 'The computer\'s hostname. Links only when exactly one active computer of the business has it (case-insensitive).',
  [`${A}.jobs`]: 'Recent backup jobs of this asset, at most 50.',
  [`${A}.jobs.items.properties.externalId`]: 'St0r\'s id for the job. Re-sending the same id updates the job; a finished job is never put back to running.',
  [`${A}.jobs.items.properties.startedAt`]: 'When the job started.',
  [`${A}.jobs.items.properties.finishedAt`]: 'When it finished. Absent or null while running.',
  [`${A}.jobs.items.properties.completion`]: 'Did the job finish, and how. Completion only: says nothing about integrity or restore.',
  [`${A}.jobs.items.properties.integrity`]: 'Did St0r verify the stored data. Separate from completion. Default not_checked; never put back to not_checked once passed or failed.',
  [`${A}.jobs.items.properties.integrityCheckedAt`]: 'When the integrity check ran.',
  [`${A}.jobs.items.properties.bytes`]: 'Bytes transferred or stored, if known.',
  [`${A}.jobs.items.properties.errorCode`]: 'A short machine code for a failure (not a message).',
  [`${A}.recoveryPoints`]: 'Restorable points of this asset, at most 50.',
  [`${A}.recoveryPoints.items.properties.externalId`]: 'St0r\'s id for the point. A drill names it.',
  [`${A}.recoveryPoints.items.properties.pointAt`]: 'The moment the point restores to.',
  [`${A}.recoveryPoints.items.properties.location`]: 'Where the point is kept.',
  [`${A}.recoveryPoints.items.properties.jobExternalId`]: 'The job that made the point. Needed for a drill of this point to verify that job.',
  [`${A}.drills`]: 'Restore drills of this asset, at most 20.',
  [`${A}.drills.items.properties.externalId`]: 'St0r\'s id for the drill.',
  [`${A}.drills.items.properties.recoveryPointExternalId`]: 'Required: the recovery point this drill restored. A drill that does not name one is refused; one naming a point Rem0te does not hold verifies nothing.',
  [`${A}.drills.items.properties.recoveryPointAt`]: 'The restored point\'s time, if the point itself is not sent. Ignored when the named point is stored.',
  [`${A}.drills.items.properties.target`]: 'Where it was restored to. Always isolated from production.',
  [`${A}.drills.items.properties.scope`]: 'What was restored.',
  [`${A}.drills.items.properties.result`]: 'The drill\'s outcome. A finished result is never put back to running or unknown.',
  [`${A}.drills.items.properties.simulated`]: 'Required. true for a simulated drill: shown, never counted as a verified restore.',
  [`${A}.drills.items.properties.validation`]: 'How the restore was checked. "none" cannot pass.',
  [`${A}.drills.items.properties.startedAt`]: 'When the drill started.',
  [`${A}.drills.items.properties.finishedAt`]: 'When it finished. Required once the result is passed, failed or partial.',
  [`${A}.drills.items.properties.elapsedSeconds`]: 'How long the restore took. The only source of Rem0te\'s measured RTO.',
  [`${A}.drills.items.properties.failureCode`]: 'A short machine code for a failure (not a message).',
};

function get(obj, path) {
  if (!path) return obj;
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

export function buildSchema() {
  const core = z.toJSONSchema(M.Feed, { io: 'input', unrepresentable: 'throw' });
  for (const [path, text] of Object.entries(DESCRIBE)) {
    const node = get(core, path);
    if (!node || typeof node !== 'object') throw new Error(`gen-st0r-schema: no node at "${path}" — the zod schema changed; update DESCRIBE`);
    node.description = text;
  }
  const out = {
    $schema: core.$schema,
    $id: 'https://github.com/agit8or1/rem0te/blob/main/docs/st0r-push-contract.schema.json',
    title: 'Rem0te St0r push, contract version 1',
    ...Object.fromEntries(Object.entries(core).filter(([k]) => k !== '$schema')),
  };
  return `${JSON.stringify(out, null, 2)}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const text = buildSchema();
  if (process.argv.includes('--check')) {
    let cur = '';
    try { cur = readFileSync(SCHEMA_FILE, 'utf8'); } catch { /* missing */ }
    if (cur !== text) { console.error('✗ docs/st0r-push-contract.schema.json differs from the API\'s zod schema: run node apps/api/scripts/gen-st0r-schema.mjs'); process.exit(1); }
    console.log('✓ docs/st0r-push-contract.schema.json matches the API\'s zod schema');
  } else {
    writeFileSync(SCHEMA_FILE, text);
    console.log(`wrote ${SCHEMA_FILE}`);
  }
}
