#!/usr/bin/env node
// Tests for 0.81's backups (roadmap 4.1 and 4.2), run against dist:
//
//   cd apps/api && npx nest build && node scripts/unit-backups.mjs
//
// Pure functions only:
//   - the feed: strict, closed lists, no business, no restoreTest, simulated
//     required, a pass that validated nothing refused, sizes bounded;
//   - deriveRestoreTests: a job is verified only by a passed, non-simulated
//     drill of its own recovery point, never by succeeding;
//   - assetState: completion, integrity and a verified restore kept apart;
//     stale, failing, running; RPO/RTO measured against the asset's or the
//     business's target; the page state (requires setup until connected);
//   - the four monitor kinds' parameters and verdicts, opt-in (never in
//     RECOMMENDED), their dedup keys;
//   - the push token: shape, hash only, constant-time match;
//   - the backup-agent templates (4.2): service names, alertIfMissing off.
// The behavioural proof against a running API is scripts/e2e-backups.mjs.

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const dist = join(here, '..', 'dist');
const M = require(join(dist, 'backups', 'model.js'));
const S = require(join(dist, 'backups', 'state.js'));
const P = require(join(dist, 'backups', 'push-token.js'));
const PR = require(join(dist, 'backups', 'providers.js'));
const E = require(join(dist, 'monitoring', 'engine.js'));
const T = require(join(dist, 'monitoring', 'backup-agent-templates.js'));
const C = require(join(dist, 'security-controls', 'confirm-catalog.js'));
const CAPS = require(join(dist, 'rbac', 'capabilities.js'));

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => { if (ok) passed++; else failures.push(`${name}${detail ? ` — ${detail}` : ''}`); };
const J = (x) => JSON.stringify(x);
const NOW = new Date(Date.UTC(2026, 10, 21, 12, 0, 0));
const h = (n) => new Date(NOW.getTime() - n * 3_600_000);
const iso = (d) => d.toISOString();
const rule = (key, kind, params = {}) => ({ id: `r-${key}`, scopeKey: 'global', key, kind, enabled: true, severity: 'WARNING', name: key, params });

// ── The feed ────────────────────────────────────────────────────────────────
const job = (o = {}) => ({ externalId: 'j1', startedAt: iso(h(3)), finishedAt: iso(h(2)), completion: 'succeeded', integrity: 'passed', ...o });
const drill = (o = {}) => ({ externalId: 'd1', target: 'isolated_vm', scope: 'full_image', result: 'passed', simulated: false, validation: 'boot', startedAt: iso(h(1.5)), finishedAt: iso(h(1)), elapsedSeconds: 900, ...o });
const asset = (o = {}) => ({ externalId: 'a1', name: 'FS-01 C: volume', type: 'server', jobs: [job()], recoveryPoints: [{ externalId: 'p1', pointAt: iso(h(2)), location: 'offsite', jobExternalId: 'j1' }], drills: [drill({ recoveryPointExternalId: 'p1' })], ...o });
const feed = (assets = [asset()]) => ({ v: 1, assets });
{
  check('feed: a well-formed feed parses', M.parseFeed(feed()).ok, J(M.parseFeed(feed())));
  check('feed: v must be 1', !M.parseFeed({ ...feed(), v: 2 }).ok);
  check('feed: a business, tenant or connection field is refused (strict)', ['businessId', 'customerId', 'tenantId', 'connectionId'].every((k) => !M.parseFeed({ ...feed(), [k]: 'x' }).ok));
  check('feed: a job cannot say restoreTest or verified (no such field)', !M.parseFeed(feed([asset({ jobs: [job({ restoreTest: 'verified' })] })])).ok && !M.parseFeed(feed([asset({ jobs: [job({ verified: true })] })])).ok);
  check('feed: a drill must say whether it was simulated', !M.parseFeed(feed([asset({ drills: [(() => { const d = drill(); delete d.simulated; return d; })()] })])).ok);
  check('feed: a drill that validated nothing did not pass', !M.parseFeed(feed([asset({ drills: [drill({ validation: 'none' })] })])).ok && M.parseFeed(feed([asset({ drills: [drill({ validation: 'none', result: 'failed' })] })])).ok);
  check('feed: a running job has no finishedAt', !M.parseFeed(feed([asset({ jobs: [job({ completion: 'running' })] })])).ok);
  check('feed: closed lists (completion, integrity, location, target, scope, result, validation, type)', [
    asset({ jobs: [job({ completion: 'ok' })] }), asset({ jobs: [job({ integrity: 'verified' })] }), asset({ type: 'laptop' }),
    asset({ recoveryPoints: [{ externalId: 'p', pointAt: iso(h(1)), location: 'tape' }] }), asset({ drills: [drill({ target: 'production' })] }),
    asset({ drills: [drill({ scope: 'everything' })] }), asset({ drills: [drill({ result: 'verified' })] }), asset({ drills: [drill({ validation: 'trust_me' })] }),
  ].every((a) => !M.parseFeed(feed([a])).ok));
  check('feed: ids and names are inert', !M.parseFeed(feed([asset({ externalId: 'a b' })])).ok && !M.parseFeed(feed([asset({ name: '<script>' })])).ok && !M.parseFeed(feed([asset({ name: 'x'.repeat(201) })])).ok);
  check('feed: duplicates are refused', !M.parseFeed(feed([asset(), asset()])).ok && !M.parseFeed(feed([asset({ jobs: [job(), job()] })])).ok);
  check('feed: bounded — 500 assets, 50 jobs, 50 points, 20 drills', J(M.FEED_LIMITS) === J({ assets: 500, jobs: 50, points: 50, drills: 20, bytes: 1048576 })
    && !M.parseFeed(feed([asset({ jobs: Array.from({ length: 51 }, (_, i) => job({ externalId: `j${i}` })) })])).ok);
  check('feed: a date far in the future is refused', !M.parseFeed(feed([asset({ jobs: [job({ startedAt: '2099-01-01T00:00:00Z', finishedAt: null, completion: 'unknown' })] })])).ok);
  check('feed: a computer hint is a Rem0te id or a hostname only', !M.parseFeed(feed([asset({ computer: { ip: '10.0.0.1' } })])).ok && M.parseFeed(feed([asset({ computer: { hostname: 'fs-01.acme.example' } })])).ok);
  check('closed lists match 0097', J(M.CONNECTION_KINDS) === J(['standin', 'st0r', 'comet']) && J(M.TRANSPORT_OF) === J({ standin: 'pull', st0r: 'push', comet: 'pull' })
    && J(M.RESTORE_TESTS) === J(['not_tested', 'verified', 'failed']));
}

// ── Restore tests come from drills, never from completion ───────────────────
{
  const pts = [{ id: 'p1', jobId: 'j1' }, { id: 'p2', jobId: 'j2' }];
  const d = (o) => ({ id: 'd', recoveryPointId: 'p1', result: 'passed', simulated: false, finishedAt: h(1), startedAt: h(2), ...o });
  let r = M.deriveRestoreTests(['j1', 'j2'], pts, []);
  check('restore: a successful job with no drill is not_tested', r.get('j1').restoreTest === 'not_tested' && r.get('j1').drillId === null);
  r = M.deriveRestoreTests(['j1', 'j2'], pts, [d({ id: 'dA' })]);
  check('restore: a passed, non-simulated drill of the job\'s own point verifies that job only', r.get('j1').restoreTest === 'verified' && r.get('j1').drillId === 'dA' && r.get('j2').restoreTest === 'not_tested');
  r = M.deriveRestoreTests(['j1'], pts, [d({ id: 'dS', simulated: true })]);
  check('restore: a simulated pass never verifies', r.get('j1').restoreTest === 'not_tested');
  r = M.deriveRestoreTests(['j1'], pts, [d({ id: 'dOld', finishedAt: h(10) }), d({ id: 'dNew', result: 'failed', finishedAt: h(1) })]);
  check('restore: the newest real drill decides (a later failure is failed)', r.get('j1').restoreTest === 'failed' && r.get('j1').drillId === 'dNew');
  r = M.deriveRestoreTests(['j1'], pts, [d({ id: 'dR', result: 'running', finishedAt: null })]);
  check('restore: a running or unknown drill decides nothing', r.get('j1').restoreTest === 'not_tested');
  r = M.deriveRestoreTests(['j1'], pts, [d({ id: 'dX', recoveryPointId: null })]);
  check('restore: a drill naming no recovery point verifies no job', r.get('j1').restoreTest === 'not_tested');
}

// ── Asset state ─────────────────────────────────────────────────────────────
const J1 = (o = {}) => ({ id: 'j1', startedAt: h(3), finishedAt: h(2), completion: 'succeeded', integrity: 'passed', restoreTest: 'not_tested', errorCode: null, ...o });
const D1 = (o = {}) => ({ id: 'd1', startedAt: h(1.5), finishedAt: h(1), result: 'passed', simulated: false, validation: 'boot', target: 'isolated_vm', scope: 'full_image', elapsedSeconds: 1500, recoveryPointId: 'p1', recoveryPointAt: h(2), failureCode: null, ...o });
const facts = (o = {}) => ({ firstSeenAt: h(24 * 30), jobs: [J1()], points: [{ id: 'p1', pointAt: h(2), location: 'offsite', jobId: 'j1' }], drills: [], objective: null, businessObjective: null, ...o });
{
  let s = S.assetState(facts(), NOW);
  check('state: a successful job without a drill is backed up but NOT verified', s.backup === 'ok' && s.drill === 'never_tested' && s.verified === null && s.lastJob.completion === 'succeeded' && s.lastJob.integrity === 'passed' && s.lastJob.restoreTest === 'not_tested' && !/verified/.test(s.summary.replace('not verified', '')), J(s));
  s = S.assetState(facts({ drills: [D1({ simulated: true })] }), NOW);
  check('state: only simulated drills are "simulated_only", never verified', s.drill === 'simulated_only' && s.verified === null && /not verified/.test(s.summary));
  s = S.assetState(facts({ drills: [D1()] }), NOW);
  check('state: a passed real drill is a verified restore, with its recovery point, scope, target and elapsed time', s.drill === 'verified' && s.verified.drillId === 'd1' && s.verified.scope === 'full_image' && s.verified.elapsedSeconds === 1500 && s.verified.recoveryPointAt.getTime() === h(2).getTime());
  s = S.assetState(facts({ drills: [D1(), D1({ id: 'd2', result: 'failed', finishedAt: h(0.5), failureCode: 'BOOT_TIMEOUT' })] }), NOW);
  check('state: a newer failed drill makes the drill state failed and names it; the older verified restore is still shown', s.drill === 'failed' && s.lastFailedDrill.failureCode === 'BOOT_TIMEOUT' && s.verified.drillId === 'd1');
  s = S.assetState(facts({ jobs: [J1({ finishedAt: h(40), startedAt: h(41) })], points: [] }), NOW);
  check('state: no success for longer than 26 h (no target) is stale', s.backup === 'stale' && s.staleAfterHours === 26);
  s = S.assetState(facts({ jobs: [J1({ finishedAt: h(40), startedAt: h(41) })], points: [], businessObjective: { rpoMinutes: 72 * 60, rtoMinutes: null } }), NOW);
  check('state: the RPO target sets the stale window', s.backup === 'ok' && s.staleAfterHours === 72);
  s = S.assetState(facts({ jobs: [J1(), J1({ id: 'j2', startedAt: h(1), finishedAt: h(0.5), completion: 'failed', errorCode: 'VSS_FAILED' })] }), NOW);
  check('state: the newest finished job failed: failing', s.backup === 'failing' && s.lastJob.errorCode === 'VSS_FAILED');
  s = S.assetState(facts({ jobs: [J1(), J1({ id: 'j3', startedAt: h(0.2), finishedAt: null, completion: 'running' })] }), NOW);
  check('state: a running job inside the window is running', s.backup === 'running');
  s = S.assetState(facts({ jobs: [], points: [], firstSeenAt: h(2) }), NOW);
  check('state: a new asset with no job yet is "never", not stale', s.backup === 'never');
  s = S.assetState(facts({ objective: { rpoMinutes: 60, rtoMinutes: 20 }, businessObjective: { rpoMinutes: 1440, rtoMinutes: 240 }, drills: [D1()] }), NOW);
  check('state: the asset\'s targets beat the business\'s; RPO measured from the newest point; RTO from the verified drill', s.rpo.targetMinutes === 60 && s.rpo.from === 'asset' && s.rpo.measuredMinutes === 120 && s.rpo.exceeded === true
    && s.rto.targetMinutes === 20 && s.rto.measuredMinutes === 25 && s.rto.exceeded === true, J([s.rpo, s.rto]));
  s = S.assetState(facts({ businessObjective: { rpoMinutes: 1440, rtoMinutes: 240 } }), NOW);
  check('state: without a verified restore, RTO is not measured (never guessed from a job)', s.rto.measuredMinutes === null && s.rto.exceeded === null && s.rpo.exceeded === false && s.rpo.from === 'business');
  check('page: requires setup until a provider is connected; awaiting data until it reports',
    S.pageState([]) === 'requires_setup' && S.pageState([{ enabled: true, revokedAt: h(1), lastSyncAt: h(2) }]) === 'requires_setup'
      && S.pageState([{ enabled: true, revokedAt: null, lastSyncAt: null }]) === 'awaiting_data' && S.pageState([{ enabled: true, revokedAt: null, lastSyncAt: h(1) }]) === 'connected');
}

// ── Monitor kinds ───────────────────────────────────────────────────────────
{
  const kinds = ['BACKUP_STALE', 'BACKUP_FAILED', 'DRILL_FAILED', 'RPO_EXCEEDED'];
  check('kinds: the four backup kinds are monitor kinds, after the earlier thirteen, in order', J(E.MONITOR_KINDS.slice(13)) === J(kinds) && E.MONITOR_KINDS.length === 17);
  check('kinds: BACKUP_KINDS is exactly them', J([...E.BACKUP_KINDS].sort()) === J([...kinds].sort()));
  check('kinds: opt-in — none is in RECOMMENDED', !E.RECOMMENDED.some((r) => kinds.includes(r.kind)));
  check('params: defaults (26 h, 1, 30 days, no fallback) and bounds', J(E.parseParams('BACKUP_STALE', {}).params) === J({ hours: 26 }) && J(E.parseParams('BACKUP_FAILED', {}).params) === J({ consecutive: 1 })
    && J(E.parseParams('DRILL_FAILED', {}).params) === J({ days: 30 }) && J(E.parseParams('RPO_EXCEEDED', {}).params) === J({})
    && !E.parseParams('BACKUP_STALE', { hours: 0 }).ok && !E.parseParams('BACKUP_FAILED', { consecutive: 11 }).ok && !E.parseParams('RPO_EXCEEDED', { fallbackHours: 9000 }).ok && !E.parseParams('DRILL_FAILED', { days: 30, x: 1 }).ok);
  check('keys: one alert per asset, under the computer\'s prefix', E.assetKeyOf('bk', 'ep1', 'asset1234') === 'bk:ep1:asset1234' && E.assetKeyOf('bk', 'ep1', 'asset1234').startsWith(E.drivePrefixOf('bk', 'ep1')) && E.ASSET_ID.test('ckxyz12345') && !E.ASSET_ID.test('a:b'));

  const ev = (kind, params, f) => E.evaluateBackup(rule('bk', kind, params), 'PC · FS', f, NOW);
  // BACKUP_STALE
  check('stale: a success 2 h ago is ok', ev('BACKUP_STALE', { hours: 26 }, facts()).verdict === 'ok');
  let v = ev('BACKUP_STALE', { hours: 26 }, facts({ jobs: [J1({ finishedAt: h(50), startedAt: h(51) })] }));
  check('stale: no success for 50 h raises, and says a success is not a verified restore', v.verdict === 'breach' && /no successful backup for 2 d/.test(v.title) && /not a verified restore/.test(v.detail.note), J(v));
  v = ev('BACKUP_STALE', { hours: 26 }, facts({ jobs: [J1({ completion: 'failed' })], firstSeenAt: h(100) }));
  check('stale: never a success, asset seen 100 h ago: raises "no successful backup recorded"', v.verdict === 'breach' && /recorded/.test(v.title));
  v = ev('BACKUP_STALE', { hours: 26 }, facts({ jobs: [], firstSeenAt: h(3) }));
  check('stale: a new asset inside the window is skipped (nothing raised, nothing cleared)', v.verdict === 'skip');
  v = ev('BACKUP_STALE', { hours: 26 }, facts({ jobs: [J1({ completion: 'partial' })], firstSeenAt: h(100) }));
  check('stale: a partial job is not a success', v.verdict === 'breach');
  // BACKUP_FAILED
  const F = (id, hrs, completion) => J1({ id, startedAt: h(hrs + 1), finishedAt: h(hrs), completion });
  check('failed: the newest finished failed (consecutive 1) raises', ev('BACKUP_FAILED', { consecutive: 1 }, facts({ jobs: [F('a', 30, 'succeeded'), F('b', 2, 'failed')] })).verdict === 'breach');
  check('failed: two needed, one failed: hold (an open alert stays, none raised)', ev('BACKUP_FAILED', { consecutive: 2 }, facts({ jobs: [F('a', 30, 'succeeded'), F('b', 2, 'failed')] })).verdict === 'hold');
  check('failed: two in a row: raises', ev('BACKUP_FAILED', { consecutive: 2 }, facts({ jobs: [F('a', 30, 'failed'), F('b', 2, 'failed')] })).verdict === 'breach');
  check('failed: the newest finished succeeded: ok (clears)', ev('BACKUP_FAILED', { consecutive: 1 }, facts({ jobs: [F('a', 30, 'failed'), F('b', 2, 'succeeded')] })).verdict === 'ok');
  check('failed: a running job is not a finished one', ev('BACKUP_FAILED', { consecutive: 1 }, facts({ jobs: [F('a', 30, 'failed'), J1({ id: 'r', startedAt: h(0.1), finishedAt: null, completion: 'running' })] })).verdict === 'breach');
  check('failed: no finished job: skip', ev('BACKUP_FAILED', {}, facts({ jobs: [] })).verdict === 'skip');
  // DRILL_FAILED
  check('drill: none: ok', ev('DRILL_FAILED', { days: 30 }, facts()).verdict === 'ok');
  v = ev('DRILL_FAILED', { days: 30 }, facts({ drills: [D1({ result: 'failed', failureCode: 'HASH_MISMATCH' })] }));
  check('drill: a failed real drill in the window raises, naming scope and code', v.verdict === 'breach' && /restore drill failed \(full image\)/.test(v.title) && v.detail.failureCode === 'HASH_MISMATCH');
  check('drill: a failed SIMULATED drill never counts', ev('DRILL_FAILED', { days: 30 }, facts({ drills: [D1({ result: 'failed', simulated: true })] })).verdict === 'ok');
  check('drill: a failure older than the window: ok', ev('DRILL_FAILED', { days: 7 }, facts({ drills: [D1({ result: 'failed', finishedAt: h(24 * 10), startedAt: h(24 * 10 + 1) })] })).verdict === 'ok');
  check('drill: a later pass clears it', ev('DRILL_FAILED', { days: 30 }, facts({ drills: [D1({ id: 'x', result: 'failed', finishedAt: h(5) }), D1({ id: 'y', finishedAt: h(1) })] })).verdict === 'ok');
  // RPO_EXCEEDED
  check('rpo: no target anywhere: skip (an RPO nobody set cannot be exceeded)', ev('RPO_EXCEEDED', {}, facts()).verdict === 'skip');
  v = ev('RPO_EXCEEDED', {}, facts({ objective: { rpoMinutes: 60, rtoMinutes: null } }));
  check('rpo: the newest point is 2 h old against 60 min: raises, measured 120', v.verdict === 'breach' && v.detail.measuredMinutes === 120 && v.detail.targetMinutes === 60 && v.detail.targetFrom === 'asset', J(v));
  check('rpo: the business target applies when the asset has none', ev('RPO_EXCEEDED', {}, facts({ businessObjective: { rpoMinutes: 180, rtoMinutes: null } })).verdict === 'ok');
  check('rpo: the monitor\'s fallback applies only where neither is set', ev('RPO_EXCEEDED', { fallbackHours: 1 }, facts()).verdict === 'breach' && ev('RPO_EXCEEDED', { fallbackHours: 1 }, facts({ businessObjective: { rpoMinutes: 600, rtoMinutes: null } })).verdict === 'ok');
  check('rpo: no point, falls back to the last successful job', ev('RPO_EXCEEDED', {}, facts({ points: [], objective: { rpoMinutes: 180, rtoMinutes: null } })).verdict === 'ok');
  check('invalid params skip', ev('BACKUP_STALE', { hours: 'x' }, facts()).verdict === 'skip');
}

// ── Push token ──────────────────────────────────────────────────────────────
{
  const t = P.newPushToken('bkc0123456789abcdef');
  check('token: rbk_<connection>_<64 hex>; only its hash and last four are kept', /^rbk_bkc0123456789abcdef_[0-9a-f]{64}$/.test(t.token) && /^[0-9a-f]{64}$/.test(t.hash) && t.last4 === t.token.slice(-4) && !t.token.includes(t.hash));
  const a = P.parsePushAuth(`Bearer ${t.token}`);
  check('token: parses from a Bearer header', a && a.connectionId === 'bkc0123456789abcdef' && P.secretMatches(a.secret, t.hash));
  check('token: a wrong secret, a missing hash or a malformed header never match', !P.secretMatches('0'.repeat(64), t.hash) && !P.secretMatches(a.secret, null) && P.parsePushAuth(t.token) === null && P.parsePushAuth(`Bearer ${t.token}x`) === null && P.parsePushAuth(`Basic ${t.token}`) === null && P.parsePushAuth(undefined) === null);
  check('token: two tokens differ', P.newPushToken('bkcabcdefgh').hash !== P.newPushToken('bkcabcdefgh').hash);
}

// ── Providers, permission, confirm key ──────────────────────────────────────
{
  check('providers: St0r pushes, Comet is planned and pulls, the stand-in is test-only', PR.PROVIDERS.st0r.transport === 'push' && PR.PROVIDERS.comet.state === 'planned' && PR.PROVIDERS.standin.state === 'test_only');
  check('providers: Comet says it has no verified-restore fact; both say standby is readiness only', PR.PROVIDERS.comet.limitations.some((l) => /no test-restore/.test(l)) && PR.PROVIDERS.st0r.limitations.some((l) => /readiness only/.test(l)) && PR.PROVIDERS.comet.limitations.some((l) => /readiness only/.test(l)));
  check('capability: backups:view is a business capability, not a default for Business Users', CAPS.CAP.BACKUPS_VIEW === 'backups:view' && CAPS.ALL_BUSINESS_CAPABILITIES.includes('backups:view') && !CAPS.DEFAULT_BUSINESS_USER_CAPABILITIES.includes('backups:view'));
  const k = C.CONFIRM_CATALOG.find((x) => x.key === 'backup.connection');
  check('confirm: backup.connection is a catalog key under Integrations, default off', !!k && k.group === 'Integrations' && k.default === 'off');
}

// ── Templates (4.2) ─────────────────────────────────────────────────────────
{
  const all = T.BACKUP_AGENT_TEMPLATES.flatMap((t) => t.rules);
  check('templates: UrBackup and Comet, each citing its source', J(T.BACKUP_AGENT_TEMPLATES.map((t) => t.id)) === J(['urbackup-client', 'comet-backup']) && T.BACKUP_AGENT_TEMPLATES.every((t) => /^https:\/\/(github\.com\/uroni|docs\.cometbackup\.com)\//.test(t.source)));
  check('templates: the verified service names, SERVICE_STOPPED only', J(all.map((r) => [r.kind, r.params.service])) === J([['SERVICE_STOPPED', 'UrBackupClientBackend'], ['SERVICE_STOPPED', 'backup.delegate']]));
  check('templates: a computer without the agent raises nothing (alertIfMissing false)', all.every((r) => r.params.alertIfMissing === false));
  check('templates: every rule passes the monitor\'s own parameter check and key charset', all.every((r) => E.parseParams(r.kind, r.params).ok && E.RULE_KEY.test(r.key)));
  check('templates: none is in RECOMMENDED', !E.RECOMMENDED.some((r) => all.some((x) => x.key === r.key)));
}

console.log(`unit-backups: ${passed} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1); }
