#!/usr/bin/env node
// Tests for 0.82 Wharf (Settings → Backups and the St0r push contract), run
// against dist:
//
//   cd apps/api && npx nest build && node scripts/unit-backup-setup.mjs
//
// Pure functions and the documents only:
//   - docs/st0r-push-contract.md: every `<!-- example: valid -->` body is
//     accepted and every `<!-- example: invalid -->` body refused by the
//     API's own parseFeed; every response example is JSON; every field of the
//     schema is named in the field tables; the limits and the version match;
//   - docs/st0r-push-contract.schema.json is exactly what gen-st0r-schema.mjs
//     makes from the zod schema (no drift);
//   - drills must name their recovery point (contract version 1);
//   - idempotency: mergeJob and drillRegresses never move a fact backwards;
//   - rotation: a new token for the same connection, the old secret no longer
//     matches, and only a live push connection may rotate;
//   - the push address and the four capability states;
//   - errorLine keeps a refusal within 0099's CHECK.
// The behavioural proof against a running API is scripts/e2e-backup-setup.mjs.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { buildSchema, SCHEMA_FILE } from './gen-st0r-schema.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const dist = join(here, '..', 'dist');
const M = require(join(dist, 'backups', 'model.js'));
const P = require(join(dist, 'backups', 'push-token.js'));
const SU = require(join(dist, 'backups', 'setup.js'));
const { z } = require('zod');

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => { if (ok) passed++; else failures.push(`${name}${detail ? ` — ${detail}` : ''}`); };
const J = (x) => JSON.stringify(x);

// ── The contract document's examples, against the API's own schema ──────────
const DOC = readFileSync(join(here, '..', '..', '..', 'docs', 'st0r-push-contract.md'), 'utf8');
{
  const blocks = [...DOC.matchAll(/<!-- example: (valid|invalid|response) -->\s*\n```json\n([\s\S]*?)\n```/g)].map((m) => ({ kind: m[1], text: m[2] }));
  const n = (k) => blocks.filter((b) => b.kind === k).length;
  check('contract: has valid, invalid and response examples', n('valid') >= 5 && n('invalid') >= 8 && n('response') >= 3, J({ valid: n('valid'), invalid: n('invalid'), response: n('response') }));
  for (const [i, b] of blocks.entries()) {
    let body;
    try { body = JSON.parse(b.text); } catch (e) { check(`contract example ${i + 1} (${b.kind}) is JSON`, false, e.message); continue; }
    if (b.kind === 'response') { check(`contract example ${i + 1}: a response with success`, typeof body.success === 'boolean' && typeof body.data === 'object'); continue; }
    const r = M.parseFeed(body);
    check(`contract example ${i + 1} is ${b.kind === 'valid' ? 'accepted' : 'refused'} by parseFeed`, r.ok === (b.kind === 'valid'), r.ok ? 'accepted' : r.error);
  }
  // Every unmarked ```json block is an error shape or a response, never an unchecked body.
  const unmarked = [...DOC.matchAll(/(^|\n)(?!<!-- example)[^\n]*\n```json\n([\s\S]*?)\n```/g)].map((m) => m[3]).filter((t) => /"v"\s*:/.test(t));
  check('contract: every body example is marked and so checked', unmarked.length === 0, unmarked[0]?.slice(0, 80));
  // The dry-run issue shown in the document is what the API really says.
  const shown = /"path": "assets\.0\.drills\.0\.recoveryPointExternalId", "message": "([^"]+)"/.exec(DOC)?.[1];
  const drill = { externalId: 'd1', target: 'isolated_vm', scope: 'full_image', result: 'passed', simulated: false, validation: 'boot', startedAt: '2026-11-20T03:00:00Z', finishedAt: '2026-11-20T03:10:00Z' };
  const real = M.parseFeed({ v: 1, assets: [{ externalId: 'a1', name: 'FS01', type: 'server', drills: [drill] }] });
  check('contract: the dry-run issue it shows is the API\'s own wording', !real.ok && real.issues.some((x) => x.path === 'assets.0.drills.0.recoveryPointExternalId' && x.message === shown), J({ shown, real: !real.ok && real.issues }));
}

// ── The document names every field, and the numbers match ──────────────────
{
  const schema = z.toJSONSchema(M.Feed, { io: 'input' });
  const fields = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.properties) for (const [k, v] of Object.entries(node.properties)) { fields.add(k); walk(v); }
    if (node.items) walk(node.items);
    if (node.anyOf) node.anyOf.forEach(walk);
  };
  walk(schema);
  const missing = [...fields].filter((f) => !new RegExp(`\\| \`(computer\\.)?${f}\` \\|`).test(DOC));
  check(`contract: each of the ${fields.size} schema fields has a row in a field table`, fields.size >= 30 && missing.length === 0, missing.join(', '));
  const enums = [M.ASSET_TYPES, M.JOB_COMPLETIONS, M.JOB_INTEGRITIES, M.POINT_LOCATIONS, M.DRILL_TARGETS, M.DRILL_SCOPES, M.DRILL_RESULTS, M.DRILL_VALIDATIONS];
  const lost = enums.flat().filter((v) => !DOC.includes(`\`${v}\``));
  check('contract: every value of every closed list is in the document', lost.length === 0, lost.join(', '));
  const L = M.FEED_LIMITS;
  check('contract: limits match FEED_LIMITS and the rate limit',
    L.bytes === 1024 * 1024 && /\*\*1 MB\*\* of JSON/.test(DOC) && new RegExp(`Assets per push \\| \\*\\*${L.assets}\\*\\*`).test(DOC) && new RegExp(`Jobs per asset \\| \\*\\*${L.jobs}\\*\\*`).test(DOC)
      && new RegExp(`Recovery points per asset \\| \\*\\*${L.points}\\*\\*`).test(DOC) && new RegExp(`Drills per asset \\| \\*\\*${L.drills}\\*\\*`).test(DOC)
      && new RegExp(`\\*\\*${SU.PUSH_PER_MINUTE} a minute\\*\\*`).test(DOC), J(L));
  check('contract: version 1 is the API\'s CONTRACT_VERSION', M.CONTRACT_VERSION === 1 && /\*\*Contract version 1\*\* \(`"v": 1`\)/.test(DOC) && /### Version 1: Rem0te 0\.82\.0/.test(DOC));
  check('contract: a message to the St0r developers', /## Message to the St0r developers/.test(DOC));
}

// ── The JSON Schema file is generated from zod, unedited ───────────────────
{
  const committed = readFileSync(SCHEMA_FILE, 'utf8');
  check('schema: docs/st0r-push-contract.schema.json is exactly what gen-st0r-schema.mjs makes from the zod schema', committed === buildSchema(), 'run node apps/api/scripts/gen-st0r-schema.mjs');
  const s = JSON.parse(committed);
  const drill = s.properties.assets.items.properties.drills.items;
  check('schema: strict objects; a drill requires its recovery point and simulated', s.additionalProperties === false && drill.additionalProperties === false
    && drill.required.includes('recoveryPointExternalId') && drill.required.includes('simulated'), J(drill.required));
  check('schema: no business, restoreTest or verified field anywhere', !/"(businessId|customerId|tenantId|restoreTest|verified)"\s*:/.test(committed));
}

// ── Drills name their recovery point (contract version 1) ─────────────────
{
  const d = { externalId: 'd1', recoveryPointExternalId: 'p1', target: 'sandbox', scope: 'file', result: 'failed', simulated: false, validation: 'sha256', startedAt: '2026-11-20T03:00:00Z', finishedAt: '2026-11-20T03:01:00Z' };
  const feed = (drill) => ({ v: 1, assets: [{ externalId: 'a', name: 'A', type: 'files', drills: [drill] }] });
  check('drill: with its recovery point, accepted', M.parseFeed(feed(d)).ok);
  check('drill: without one, refused', !M.parseFeed(feed({ ...d, recoveryPointExternalId: undefined })).ok);
  check('drill: null is not a recovery point', !M.parseFeed(feed({ ...d, recoveryPointExternalId: null })).ok);
  const r = M.parseFeed({ v: 1, assets: Array.from({ length: 30 }, (_, i) => ({ externalId: `a${i}`, name: 'A', type: 'nope' })) });
  check('issues: at most MAX_ISSUES, each with a path', !r.ok && r.issues.length === M.MAX_ISSUES && r.issues.every((x) => /^assets\.\d+\.type$/.test(x.path)) && r.error.split('; ').length === 5, J(r.issues?.length));
}

// ── Idempotency: a fact never moves backwards ──────────────────────────────
{
  const at = (h) => new Date(Date.UTC(2026, 10, 20, h));
  const done = { completion: 'succeeded', finishedAt: at(2), integrity: 'passed', integrityCheckedAt: at(3) };
  const running = { completion: 'running', finishedAt: null, integrity: 'not_checked', integrityCheckedAt: null };
  let m = M.mergeJob(null, running);
  check('mergeJob: a new job is taken as reported', J(m.facts) === J(running) && m.regressed.length === 0);
  m = M.mergeJob(running, done);
  check('mergeJob: running → finished moves forward', J(m.facts) === J(done) && m.regressed.length === 0);
  m = M.mergeJob(done, running);
  check('mergeJob: finished → running (a late, older report) is held back, completion and integrity', m.facts.completion === 'succeeded' && +m.facts.finishedAt === +at(2) && m.facts.integrity === 'passed' && J(m.regressed) === J(['completion', 'integrity']), J(m));
  m = M.mergeJob(done, { ...done, completion: 'unknown', finishedAt: null });
  check('mergeJob: finished → unknown is held back too', m.facts.completion === 'succeeded' && m.regressed.includes('completion'));
  m = M.mergeJob(done, { ...done, completion: 'failed', finishedAt: at(4) });
  check('mergeJob: a finished job may be corrected to another finished completion', m.facts.completion === 'failed' && +m.facts.finishedAt === +at(4) && m.regressed.length === 0);
  m = M.mergeJob({ ...done, integrity: 'not_checked', integrityCheckedAt: null }, done);
  check('mergeJob: integrity not_checked → passed moves forward', m.facts.integrity === 'passed' && m.regressed.length === 0);
  m = M.mergeJob(done, { ...done, integrity: 'failed', integrityCheckedAt: at(5) });
  check('mergeJob: integrity passed → failed (a newer check) is taken', m.facts.integrity === 'failed' && m.regressed.length === 0);
  m = M.mergeJob(done, done);
  check('mergeJob: the identical report again changes nothing', J(m.facts) === J(done) && m.regressed.length === 0);
  check('drillRegresses: passed/failed/partial → running or unknown is skipped', ['passed', 'failed', 'partial'].every((s) => ['running', 'unknown'].every((t) => M.drillRegresses({ result: s, finishedAt: at(1) }, { result: t, finishedAt: null }))));
  check('drillRegresses: running → finished, finished → finished and a new drill are taken',
    !M.drillRegresses({ result: 'running', finishedAt: null }, { result: 'passed', finishedAt: at(1) }) && !M.drillRegresses({ result: 'failed', finishedAt: at(1) }, { result: 'passed', finishedAt: at(2) }) && !M.drillRegresses(null, { result: 'running', finishedAt: null }));
}

// ── Rotation ────────────────────────────────────────────────────────────────
{
  const id = 'bkc0123456789abcdef012345';
  const a = P.newPushToken(id), b = P.newPushToken(id);
  const secret = (t) => P.parsePushAuth(`Bearer ${t}`)?.secret;
  check('rotate: a new token names the same connection', P.parsePushAuth(`Bearer ${b.token}`)?.connectionId === id && b.token !== a.token && b.hash !== a.hash);
  check('rotate: after it, the old secret no longer matches — no overlap', P.secretMatches(secret(b.token), b.hash) && !P.secretMatches(secret(a.token), b.hash));
  check('rotate: the last four change with it', b.last4 === b.token.slice(-4) && /^[0-9a-f]{4}$/.test(b.last4));
  const live = { transport: 'push', revokedAt: null, enabled: true, pushTokenHash: a.hash };
  check('rotate: a live push connection may rotate', SU.rotationRefusal(live) === null);
  check('rotate: not a revoked, pull or disabled one',
    SU.rotationRefusal({ ...live, revokedAt: new Date() }) === 'BACKUP_CONNECTION_REVOKED' && SU.rotationRefusal({ ...live, transport: 'pull' }) === 'BACKUP_NOT_A_PUSH_CONNECTION'
      && SU.rotationRefusal({ ...live, enabled: false }) === 'BACKUP_CONNECTION_DISABLED' && SU.rotationRefusal({ ...live, pushTokenHash: null }) === 'BACKUP_CONNECTION_DISABLED');
}

// ── The push address and the four states ──────────────────────────────────
{
  const e = SU.pushEndpoint('https://rmm.example.com/');
  check('address: from the public address, with the dry-run form', e.url === 'https://rmm.example.com/api/v1/backups/push' && e.dryRunUrl === `${e.url}?dryRun=1` && e.https === true, J(e));
  check('address: an http or default address carries a warning', SU.pushInstructions('http://10.0.0.5', 'setting').warning?.includes('HTTPS') && SU.pushInstructions('http://localhost:3001', 'default').warning?.includes('development default')
    && SU.pushInstructions('https://rmm.example.com', 'environment').warning === null);
  const ins = SU.pushInstructions('https://rmm.example.com', 'setting');
  check('address: headers and limits for St0r', J(ins.headers.map((h) => h.name)) === J(['Authorization', 'Content-Type']) && ins.limits.assets === M.FEED_LIMITS.assets && ins.limits.bytes === M.FEED_LIMITS.bytes && ins.contractVersion === 1);
  const STATES = ['available', 'requires_setup', 'unsupported', 'planned'];
  const base = { st0r: null, dryRunSeen: false, assets: 0, linkedAssets: 0, backupMonitors: 0, addressOk: true };
  const by = (f) => Object.fromEntries(SU.capabilityStates(f).map((c) => [c.key, c]));
  let c = by(base);
  check('capabilities: four states only, Comet and drills planned, failover unsupported',
    SU.capabilityStates(base).every((x) => STATES.includes(x.state)) && c.comet.state === 'planned' && c['drill.start'].state === 'planned' && c.failover.state === 'unsupported');
  check('capabilities: with nothing set up, the push requires setup and says to create a connection', c['st0r.push'].state === 'requires_setup' && /Create a St0r connection/.test(c['st0r.push'].note) && c['st0r.dryrun'].state === 'requires_setup');
  c = by({ ...base, st0r: { lastSyncAt: null, lastResult: null }, addressOk: false });
  check('capabilities: a connection with no https address says so first', c['st0r.push'].state === 'requires_setup' && /https public address/.test(c['st0r.push'].note) && c['st0r.dryrun'].state === 'available');
  c = by({ ...base, st0r: { lastSyncAt: new Date(), lastResult: 'OK' }, assets: 4, linkedAssets: 3, backupMonitors: 2 });
  check('capabilities: once St0r reports, push, facts, links and alerts are available', ['st0r.push', 'facts.separate', 'link.computers', 'alerts'].every((k) => c[k].state === 'available') && /3 of 4 linked/.test(c['link.computers'].note));
}

// ── A refusal kept on the connection fits 0099's CHECK ─────────────────────
{
  const line = M.errorLine(`assets.0.name: bad\u0000\n${'x'.repeat(400)}`);
  check('errorLine: printable ASCII, at most 300', line.length === 300 && /^[\x20-\x7e]+$/.test(line));
  check('errorLine: never empty', M.errorLine('\n\t') === '??' || M.errorLine('') === 'refused');
}

console.log(`unit-backup-setup: ${passed} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1); }
