#!/usr/bin/env node
/**
 * Unit proof of 0.79's rollback and repeatability per catalog action (§89),
 * from the compiled API (no database, no network):
 *
 *   - every one of the twelve catalog actions declares a rollback (one of the
 *     closed kinds; `via` only for an inverse, and naming a catalog action)
 *     and whether it is safe to repeat, each with its text;
 *   - the portal's catalog agrees, action by action and in order, with the
 *     fixture the agent's Go test reads
 *     (tools/windows-installer/internal/action/testdata/rollback-repeat.json);
 *   - GET /actions/catalog serves both, and the job view carries them;
 *   - the table in docs/approved-actions.md says the same;
 *   - the per-computer tally (actions/target-tally.ts) and the console's
 *     words for it (apps/web/lib/action-notes.ts) and for a tool's note
 *     (apps/web/lib/device-tools.ts).
 *
 *   cd apps/api && npx nest build && node scripts/unit-action-rollback.mjs
 */
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const API = path.join(here, '..');
const ROOT = path.join(API, '..', '..');
const dist = path.join(API, 'dist');
const cat = require(path.join(dist, 'actions/catalog.js'));
const { targetTally, TALLY_KEYS } = require(path.join(dist, 'actions/target-tally.js'));

let passed = 0; const failures = [];
const check = (name, ok, detail = '') => { if (ok) passed++; else failures.push(`${name}${detail ? ` — ${detail}` : ''}`); };
const j = (x) => JSON.stringify(x);

const fixture = JSON.parse(readFileSync(path.join(ROOT, 'tools/windows-installer/internal/action/testdata/rollback-repeat.json'), 'utf8'));
const ids = cat.CATALOG.map((a) => a.id);

// ── The closed kinds ───────────────────────────────────────────────────────
check('ROLLBACK_KINDS is exactly none, inverse, read_only', j(cat.ROLLBACK_KINDS) === j(['none', 'inverse', 'read_only']), j(cat.ROLLBACK_KINDS));
check('ROLLBACK_KINDS is the fixture\'s (and so the agent\'s) list, in order', j(cat.ROLLBACK_KINDS) === j(fixture.rollbackKinds));

// ── Every action declares both ─────────────────────────────────────────────
check('the catalog is the twelve actions', cat.CATALOG.length === 12, `${cat.CATALOG.length}`);
for (const a of cat.CATALOG) {
  const r = a.rollback, p = a.repeat;
  check(`${a.id}: declares a rollback of a known kind`, !!r && cat.ROLLBACK_KINDS.includes(r.kind), j(r));
  check(`${a.id}: an inverse names a catalog action, nothing else names one`,
    r?.kind === 'inverse' ? typeof r.via === 'string' && ids.includes(r.via) : r?.via === undefined, j(r));
  check(`${a.id}: says how it is undone, in a sentence or two`, typeof r?.how === 'string' && r.how.length >= 20 && r.how.length <= 300 && /\.$/.test(r.how), r?.how);
  check(`${a.id}: declares whether it is safe to repeat`, typeof p?.safe === 'boolean', j(p));
  check(`${a.id}: says why, in a sentence or two`, typeof p?.why === 'string' && p.why.length >= 20 && p.why.length <= 300 && /\.$/.test(p.why), p?.why);
  check(`${a.id}: read-only is always safe to repeat`, r?.kind !== 'read_only' || p?.safe === true);
  check(`${a.id}: carries no other key`, j(Object.keys(r ?? {}).sort()) === j(r?.kind === 'inverse' ? ['how', 'kind', 'via'] : ['how', 'kind']) && j(Object.keys(p ?? {}).sort()) === j(['safe', 'why']));
}
check('exactly two actions are not safe to repeat: the restart and the script run',
  j(cat.CATALOG.filter((a) => !a.repeat.safe).map((a) => a.id)) === j(['windows.reboot.schedule', 'windows.script.run']));

// ── The agent's copy, through the shared fixture ───────────────────────────
check('the fixture lists the catalog, in order', j(fixture.actions.map((x) => `${x.id}@${x.version}`)) === j(cat.CATALOG.map((a) => `${a.id}@${a.version}`)));
for (const want of fixture.actions) {
  const a = cat.catalogEntry(want.id, want.version);
  check(`${want.id}: the portal agrees with the agent's fixture`,
    !!a && a.rollback.kind === want.rollback && (a.rollback.via ?? '') === want.via && a.repeat.safe === want.repeatable,
    `portal ${j({ kind: a?.rollback.kind, via: a?.rollback.via, safe: a?.repeat.safe })}, fixture ${j(want)}`);
}

// ── Served by the API ──────────────────────────────────────────────────────
{
  const { ActionsService } = require(path.join(dist, 'actions/actions.service.js'));
  const svc = Object.create(ActionsService.prototype);
  svc.signer = { configured: () => true };
  const served = svc.catalog().actions;
  check('GET /actions/catalog serves every action\'s rollback and repeat, as the catalog has them',
    served.length === 12 && served.every((s) => j(s.rollback) === j(cat.catalogEntry(s.id, s.version).rollback) && j(s.repeat) === j(cat.catalogEntry(s.id, s.version).repeat)));
  const src = readFileSync(path.join(API, 'src/actions/actions.service.ts'), 'utf8');
  check('the job view carries the action\'s rollback and repeat', /action: \{ id: j\.actionId, [^\n]*rollback: a\?\.rollback \?\? null, repeat: a\?\.repeat \?\? null \}/.test(src));
  check('a plan seen from one computer carries the tally of all its computers', /ringSize: v\.targets\.length, ringTally: targetTally\(v\.targets\)/.test(src));
}

// ── The docs table says the same ───────────────────────────────────────────
{
  const doc = readFileSync(path.join(ROOT, 'docs/approved-actions.md'), 'utf8');
  const sec = doc.slice(doc.indexOf('## Rollback and repeating an action (0.79)'));
  const rows = [...sec.slice(0, sec.indexOf('\n\n', sec.indexOf('| Action |'))).matchAll(/^\| `([a-z.]+)` \| (none|inverse|read-only)(?:, `([a-z.]+)`)? \| [^|]+ \| (Yes|\*\*No\*\*) \| [^|]+ \|$/gm)]
    .map((m) => ({ id: m[1], kind: m[2].replace('-', '_'), via: m[3] ?? '', safe: m[4] === 'Yes' }));
  check('docs/approved-actions.md has a row per action, in catalog order', j(rows.map((r) => r.id)) === j(ids), j(rows.map((r) => r.id)));
  for (const r of rows) {
    const a = cat.catalogEntry(r.id, 1);
    check(`docs: ${r.id} agrees with the catalog`, a.rollback.kind === r.kind && (a.rollback.via ?? '') === r.via && a.repeat.safe === r.safe, j(r));
  }
}

// ── The per-computer tally ─────────────────────────────────────────────────
{
  const T = (...st) => targetTally(st.map((status) => ({ status })));
  check('tally keys', j(TALLY_KEYS) === j(['succeeded', 'failed', 'refused', 'not_executed', 'uncertain', 'waiting', 'canceled']));
  const a = T('SUCCEEDED', 'SUCCEEDED', 'FAILED', 'DISPATCHED', 'PENDING');
  check('a plan with a success and a failure is partial', a.partial && a.succeeded === 2 && a.failed === 1 && a.waiting === 2 && a.total === 5, j(a));
  check('all succeeded is not partial', !T('SUCCEEDED', 'SUCCEEDED').partial);
  check('all failed is not partial (nothing succeeded)', !T('FAILED', 'REFUSED_BY_ENDPOINT').partial);
  check('waiting alone does not make it partial', !T('SUCCEEDED', 'PENDING').partial);
  check('a refusal, a not-executed and an uncertain one each make it partial',
    T('SUCCEEDED', 'REFUSED_BY_ENDPOINT').partial && T('SUCCEEDED', 'NOT_EXECUTED').partial && T('SUCCEEDED', 'UNKNOWN').partial);
  check('a canceled computer does not make it partial', !T('SUCCEEDED', 'CANCELED').partial);
  const u = T('SUCCEEDED', 'SOMETHING_NEW');
  check('an unknown status counts as uncertain, never as success', u.uncertain === 1 && u.succeeded === 1 && u.partial, j(u));
  check('the tally has counts only', j(Object.keys(a).sort()) === j([...TALLY_KEYS, 'partial', 'total'].sort()));
}

// ── The console's words (pure web modules, transpiled) ─────────────────────
{
  const wreq = createRequire(path.join(ROOT, 'apps/web/package.json'));
  const ts = wreq('typescript');
  const load = (f) => {
    const out = ts.transpileModule(readFileSync(path.join(ROOT, 'apps/web/lib', f), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;
    if (/\brequire\s*\(/.test(out)) throw new Error(`apps/web/lib/${f} imports a module: it must stay pure`);
    const m = { exports: {} }; new Function('module', 'exports', out)(m, m.exports); return m.exports;
  };
  const N = load('action-notes.ts');
  const t = targetTally(['SUCCEEDED', 'SUCCEEDED', 'FAILED', 'PENDING'].map((status) => ({ status })));
  check('tallyText names every non-zero count', N.tallyText(t) === 'Of 4 devices: 2 succeeded, 1 failed, 1 still waiting.', N.tallyText(t));
  check('tallyProblems counts failed, refused, not executed and uncertain', N.tallyProblems(targetTally(['FAILED', 'REFUSED_BY_ENDPOINT', 'NOT_EXECUTED', 'UNKNOWN', 'SUCCEEDED', 'PENDING'].map((status) => ({ status })))) === 4);
  const D = load('device-tools.ts');
  check('the console labels every rollback kind', j(Object.keys(D.ROLLBACK_LABEL).sort()) === j([...cat.ROLLBACK_KINDS].sort()));
  const notes = Object.fromEntries(cat.CATALOG.map((a) => [a.id, { rollback: a.rollback, repeat: a.repeat }]));
  const titles = Object.fromEntries(cat.CATALOG.map((a) => [a.id, a.title]));
  check('a restart\'s note names the cancel and says not safe to repeat',
    D.noteLine(notes['windows.reboot.schedule'], titles) === `Can be undone: ${cat.REBOOT_CANCEL.title} · Not safe to repeat`, D.noteLine(notes['windows.reboot.schedule'], titles));
  check('logs collection reads as read-only and safe', D.noteLine(notes['windows.logs.collect']) === 'Read-only · Safe to repeat');
  const facts = {
    diagAllowed: null, diagNeedsNewer: null, agentKind: 'signed', readOnlyOs: null, agentVersion: '0.79.0', agentActions: cat.CATALOG.map((a) => `${a.id}@${a.version}`),
    status: 'ACTIVE', pooled: false, agentBound: true, connectivity: 'online', connectivityText: 'Online', signer: { configured: true, approval: 'signed' }, paused: [],
    perms: { view: true, eventLogs: true, terminal: true, filesUpload: true, filesDownload: true, requestLow: true, requestHigh: true }, actionRisk: {}, restartPending: false,
  };
  const withNotes = D.deviceTools('ep', { ...facts, actionNotes: notes });
  const actionTools = withNotes.filter((t) => t.need.kind === 'action');
  check('every action tool in the Tools panel carries its action\'s note', actionTools.length > 0 && actionTools.every((t) => j(t.note) === j(notes[t.need.action])));
  check('no other tool carries a note', withNotes.filter((t) => t.need.kind !== 'action').every((t) => t.note === null));
  check('before the catalog is read, no tool claims a note', D.deviceTools('ep', facts).every((t) => t.note === null));
}

console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  FAIL ${f}`); process.exit(1); }
