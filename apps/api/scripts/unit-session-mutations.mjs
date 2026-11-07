#!/usr/bin/env node
/**
 * Behavioural regression tests for support-session mutation (0.19.12).
 *
 * Runs the COMPILED services (dist/) — the real SessionsService,
 * QuickConnectService and AccessControlService — against an in-memory Prisma
 * double. No database, no network, so CI runs it after `pnpm build`.
 *
 * The double implements the subset of Prisma the services use, with the
 * semantics the fixes rely on:
 *   - `where` filters with equality, `{ in: [...] }`, `{ not: ... }`
 *   - updateMany returns the count of rows it matched, and only writes those
 *   - $transaction(fn) rolls every write back if fn throws
 *   - every call yields to the event loop first, so Promise.all of two
 *     requests interleaves their reads before their writes, as two HTTP
 *     requests would
 *
 * v0.20: the transitions themselves are session-state.ts, applied through
 * SessionEventsService.record(); the browser may report only "connected"
 * and "failed". The guarantees from 0.19.12 are unchanged.
 *
 * Covers the 2026-11 review findings:
 *   1. support:history_view let a user complete/cancel/inject events into
 *      another technician's session
 *   2. client_opened reopened a completed session
 * and that rejected mutations leave no rows behind.
 *
 *   cd apps/api && npx nest build && node scripts/unit-session-mutations.mjs
 */
/* global setImmediate, structuredClone */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const { SessionsService } = require(path.join(dist, 'sessions/sessions.service.js'));
const { QuickConnectService } = require(path.join(dist, 'quick-connect/quick-connect.service.js'));
const { AccessControlService } = require(path.join(dist, 'rbac/access-control.service.js'));
const { SessionEventsService } = require(path.join(dist, 'sessions/session-events.service.js'));
const state = require(path.join(dist, 'sessions/session-state.js'));
const { Prisma } = require('@prisma/client');

// ── In-memory Prisma double ──────────────────────────────────────────────────

const tick = () => new Promise((r) => setImmediate(r));

function matches(row, where = {}) {
  for (const [k, cond] of Object.entries(where)) {
    const v = row[k];
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('in' in cond && !cond.in.includes(v)) return false;
      if ('not' in cond && v === cond.not) return false;
      if ('lt' in cond && !(v < cond.lt)) return false;
      continue;
    }
    if (cond instanceof Date || v instanceof Date) {
      if (!(cond instanceof Date && v instanceof Date && cond.getTime() === v.getTime())) return false;
      continue;
    }
    if (v !== cond) return false;
  }
  return true;
}

function pick(row, select) {
  if (!select) return { ...row };
  const out = {};
  for (const k of Object.keys(select)) if (select[k]) out[k] = row[k];
  return out;
}

let idSeq = 0;
function model(db, name) {
  return {
    async findFirst({ where, select } = {}) {
      await tick();
      const r = db[name].find((x) => matches(x, where));
      return r ? pick(r, select) : null;
    },
    async findUnique({ where, select }) {
      await tick();
      const r = db[name].find((x) => x.id === where.id);
      return r ? pick(r, select) : null;
    },
    async findUniqueOrThrow(args) {
      const r = await this.findUnique(args);
      if (!r) throw new Error('not found');
      return r;
    },
    async create({ data }) {
      await tick();
      // @@unique([supportSessionId, dedupeKey]) — NULLs never collide, as in Postgres.
      if (name === 'supportSessionEvent' && data.dedupeKey != null &&
          db[name].some((x) => x.supportSessionId === data.supportSessionId && x.dedupeKey === data.dedupeKey)) {
        throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });
      }
      const row = { id: `${name}_${++idSeq}`, timestamp: new Date(), createdAt: new Date(), ...data };
      db[name].push(row);
      return { ...row };
    },
    async update({ where, data }) {
      await tick();
      const r = db[name].find((x) => x.id === where.id);
      if (!r) throw new Error('not found');
      Object.assign(r, data);
      return { ...r };
    },
    async updateMany({ where, data }) {
      await tick();
      const rows = db[name].filter((x) => matches(x, where));
      for (const r of rows) Object.assign(r, data);
      return { count: rows.length };
    },
  };
}

function makePrisma(seed) {
  const db = { supportSession: [], supportSessionEvent: [], activityLog: [] };
  for (const s of seed) db.supportSession.push({ ...s });
  const p = {
    db,
    supportSession: model(db, 'supportSession'),
    supportSessionEvent: model(db, 'supportSessionEvent'),
    activityLog: model(db, 'activityLog'),
    // Transactions are serialised, as the row lock their conditional
    // update takes serialises them in Postgres; a rollback therefore only
    // ever undoes its own writes.
    _lock: Promise.resolve(),
    async $transaction(fn) {
      const prev = p._lock;
      let release;
      p._lock = new Promise((r) => { release = r; });
      await prev;
      const snapshot = structuredClone(db);
      try {
        return await fn(p);
      } catch (e) {
        for (const k of Object.keys(db)) db[k] = snapshot[k];
        throw e;
      } finally {
        release();
      }
    },
  };
  return p;
}

const audit = { logs: [], async log(e) { this.logs.push(e); } };

// ── Actors ───────────────────────────────────────────────────────────────────

const actor = (userId, businessId, extra = {}) => ({
  userId, email: `${userId}@example.com`, tenantId: 't1', businessId,
  isPlatformAdmin: false, roleType: 'BUSINESS_USER', capabilities: [], ip: '127.0.0.1', ...extra,
});
const ALICE = actor('alice', 'bizA', { capabilities: ['computers:connect'] });
// The reviewer's case: connect + history_view, not the session's technician.
const MALLORY = actor('mallory', 'bizA', { capabilities: ['computers:connect', 'support:history_view', 'support:sessions_view'] });
const OWNER_A = actor('ownerA', 'bizA', { roleType: 'BUSINESS_OWNER' });
const OWNER_B = actor('ownerB', 'bizB', { roleType: 'BUSINESS_OWNER' });
const BOB_B = actor('bob', 'bizB', { capabilities: ['computers:connect', 'support:history_view'] });
const ADMIN = actor('admin', null, { isPlatformAdmin: true, roleType: null });
// An MSP technician acting in business A through an assignment that includes
// history view: an assignment never makes anyone a supervisor.
const TECH_A = actor('tech', 'bizA', {
  roleType: null, capabilities: ['computers:view', 'computers:connect', 'support:history_view', 'support:sessions_view'],
  technician: { businessId: 'bizA', endpointIds: null, sources: [] }, assignedBusinessIds: ['bizA'],
});
const TECH_B = actor('tech', 'bizB', {
  roleType: null, capabilities: ['computers:connect', 'support:history_view'],
  technician: { businessId: 'bizB', endpointIds: null, sources: [] }, assignedBusinessIds: ['bizB'],
});

const session = (id, status, extra = {}) => ({
  id, tenantId: 't1', customerId: 'bizA', technicianId: 'alice', endpointId: 'ep1', isAdHoc: false,
  adHocRustdeskId: null, status, startedAt: null, completedAt: null, duration: null,
  notes: null, disposition: null, manualWorkMinutes: null,
  createdAt: new Date(Date.now() - 600_000), updatedAt: new Date(0),
  launchRequestedAt: new Date(Date.now() - 600_000), launcherAckAt: null, clientOpenedAt: null,
  connectionConfirmedAt: null, endedAt: null, endReason: null, endInferred: false,
  statusSource: null, statusChangedAt: new Date(Date.now() - 600_000), lastSignalAt: null, timingQuality: 'UNKNOWN',
  ...extra,
});

function setup(seed) {
  const prisma = makePrisma(seed);
  audit.logs = [];
  const acl = new AccessControlService(prisma);
  const events = new SessionEventsService(prisma, audit);
  return {
    prisma, events,
    svc: new SessionsService(prisma, audit, acl, events),
    qc: new QuickConnectService(prisma, audit, acl, {}, events, {}),
  };
}

async function rejects(promise, status) {
  try {
    await promise;
  } catch (e) {
    const got = e.getStatus?.() ?? e.status;
    assert.equal(got, status, `expected HTTP ${status}, got ${got}: ${e.message}`);
    return;
  }
  assert.fail(`expected HTTP ${status}, but the call succeeded`);
}

/** Assert that nothing in the database changed. */
function unchanged(prisma, before) {
  assert.deepEqual(structuredClone(prisma.db), before, 'database changed after a rejected mutation');
}

// ── Tests ────────────────────────────────────────────────────────────────────

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const t0 = Date.now() - 120_000;
const actions = (prisma, action) => audit.logs.filter((l) => l.action === action).length;

test('history viewer CAN read another technician\'s session (visibility unchanged)', async () => {
  const { svc } = setup([session('s1', 'CLIENT_OPENED')]);
  const s = await svc.findOne(MALLORY, 's1');
  assert.equal(s.id, 's1');
});

for (const [who, a] of [['history viewer', MALLORY], ['assigned MSP technician with history view', TECH_A]]) {
  for (const [label, call] of [
    ['complete', (svc) => svc.complete(a, 's1', { notes: 'x', disposition: 'resolved' })],
    ['cancel', (svc) => svc.cancel(a, 's1')],
    ['report connected', (svc) => svc.addEvent(a, 's1', { event: 'connected' })],
    ['report failed', (svc) => svc.addEvent(a, 's1', { event: 'failed' })],
  ]) {
    test(`${who} cannot ${label} another technician's session — 403, no writes`, async () => {
      const { prisma, svc } = setup([session('s1', 'LAUNCH_REQUESTED')]);
      const before = structuredClone(prisma.db);
      await rejects(call(svc), 403);
      unchanged(prisma, before);
      assert.equal(audit.logs.length, 0);
    });
  }
}

test('user without history_view cannot even see another technician\'s session — 404, no writes', async () => {
  const { prisma, svc } = setup([session('s1', 'LAUNCH_REQUESTED')]);
  const noHist = actor('carol', 'bizA', { capabilities: ['computers:connect'] });
  const before = structuredClone(prisma.db);
  await rejects(svc.complete(noHist, 's1', {}), 404);
  await rejects(svc.addEvent(noHist, 's1', { event: 'connected' }), 404);
  unchanged(prisma, before);
});

test('owning technician can report connected and then complete', async () => {
  const { prisma, svc } = setup([session('s1', 'LAUNCH_REQUESTED')]);
  const r = await svc.addEvent(ALICE, 's1', { event: 'connected' });
  assert.equal(r.applied, true);
  assert.equal(prisma.db.supportSession[0].status, 'SESSION_STARTED');
  assert.equal(prisma.db.supportSession[0].statusSource, 'technician');
  const done = await svc.complete(ALICE, 's1', { disposition: 'resolved', manualWorkMinutes: 15 });
  assert.equal(done.status, 'SESSION_COMPLETED');
  assert.equal(done.manualWorkMinutes, 15);
  assert.equal(prisma.db.supportSessionEvent.length, 2);
});

test('a technician\'s completion is a report, not a measurement: no duration is invented', async () => {
  const { prisma, svc } = setup([session('s1', 'CLIENT_OPENED', { clientOpenedAt: new Date(t0) })]);
  await svc.complete(ALICE, 's1', {});
  const s = prisma.db.supportSession[0];
  assert.equal(s.status, 'SESSION_COMPLETED');
  assert.notEqual(s.timingQuality, 'MEASURED');
  assert.equal(s.duration, null);
});

test('Business Owner of the session\'s business can complete a technician\'s session', async () => {
  const { prisma, svc } = setup([session('s1', 'CLIENT_OPENED')]);
  await svc.complete(OWNER_A, 's1', {});
  assert.equal(prisma.db.supportSession[0].status, 'SESSION_COMPLETED');
});

test('Platform Admin can cancel any session', async () => {
  const { prisma, svc } = setup([session('s1', 'LAUNCH_REQUESTED')]);
  await svc.cancel(ADMIN, 's1');
  assert.equal(prisma.db.supportSession[0].status, 'CANCELED');
});

test('assigned technician can complete their OWN session in the assigned business', async () => {
  const { prisma, svc } = setup([session('s1', 'CLIENT_OPENED', { technicianId: 'tech' })]);
  await svc.complete(TECH_A, 's1', {});
  assert.equal(prisma.db.supportSession[0].status, 'SESSION_COMPLETED');
});

test('cross-business: other business Owner, history viewer and technician get 404, no writes', async () => {
  const { prisma, svc } = setup([session('s1', 'LAUNCH_REQUESTED')]);
  const before = structuredClone(prisma.db);
  for (const a of [OWNER_B, BOB_B, TECH_B]) {
    await rejects(svc.findOne(a, 's1'), 404);
    await rejects(svc.complete(a, 's1', {}), 404);
    await rejects(svc.cancel(a, 's1'), 404);
    await rejects(svc.addEvent(a, 's1', { event: 'connected' }), 404);
  }
  unchanged(prisma, before);
});

for (const terminal of ['SESSION_COMPLETED', 'CANCELED', 'FAILED', 'STATUS_UNKNOWN']) {
  test(`${terminal} session rejects connected, failed, complete and cancel — 409, no writes`, async () => {
    const { prisma, svc } = setup([session('s1', terminal, {
      clientOpenedAt: new Date(t0), completedAt: new Date(t0 + 60_000), endedAt: new Date(t0 + 60_000),
    })]);
    const before = structuredClone(prisma.db);
    for (const a of [ALICE, OWNER_A, ADMIN]) {
      await rejects(svc.addEvent(a, 's1', { event: 'connected' }), 409);
      await rejects(svc.addEvent(a, 's1', { event: 'failed' }), 409);
      await rejects(svc.complete(a, 's1', { notes: 'late' }), 409);
      await rejects(svc.cancel(a, 's1'), 409);
    }
    unchanged(prisma, before);
  });
}

test('machine signals cannot reopen a closed session either (but are kept on the timeline)', async () => {
  const { prisma, events } = setup([session('s1', 'SESSION_COMPLETED', { completedAt: new Date(t0) })]);
  for (const [type, source] of [['client_opened', 'connect_script'], ['connection_confirmed', 'endpoint_agent'], ['launcher_acknowledged', 'server']]) {
    const r = await events.record('s1', { type, source, receivedAt: new Date() }, { dedupeKey: `x:${type}` });
    assert.equal(r.applied, false);
  }
  assert.equal(prisma.db.supportSession[0].status, 'SESSION_COMPLETED');
  assert.ok(prisma.db.supportSessionEvent.every((e) => e.applied === false));
});

test('browser cannot claim client_opened / client_closed (it cannot observe them) — 400, no writes', async () => {
  const { prisma, svc } = setup([session('s1', 'LAUNCH_REQUESTED')]);
  const before = structuredClone(prisma.db);
  await rejects(svc.addEvent(ALICE, 's1', { event: 'client_opened' }), 400);
  await rejects(svc.addEvent(ALICE, 's1', { event: 'client_closed' }), 400);
  unchanged(prisma, before);
});

test('duplicate "connected" is refused and changes nothing', async () => {
  const { prisma, svc } = setup([session('s1', 'LAUNCH_REQUESTED')]);
  await svc.addEvent(ALICE, 's1', { event: 'connected' });
  const before = structuredClone(prisma.db);
  await rejects(svc.addEvent(ALICE, 's1', { event: 'connected' }), 409);
  unchanged(prisma, before);
});

test('concurrent complete + cancel: exactly one wins, the other is 409', async () => {
  const { prisma, svc } = setup([session('s1', 'CLIENT_OPENED')]);
  const results = await Promise.allSettled([svc.complete(ALICE, 's1', { notes: 'mine' }), svc.cancel(OWNER_A, 's1')]);
  const ok = results.filter((r) => r.status === 'fulfilled');
  const bad = results.filter((r) => r.status === 'rejected');
  assert.equal(ok.length, 1, 'exactly one close must succeed');
  assert.equal(bad[0].reason.getStatus(), 409, bad[0].reason.message);
  assert.equal(actions(prisma, 'SESSION_COMPLETED') + actions(prisma, 'SESSION_CANCELED'), 1, 'only the winner is audited');
  const s = prisma.db.supportSession[0];
  assert.equal(s.status, ok[0].value.status);
  if (s.status === 'CANCELED') assert.equal(s.notes, null, 'the losing complete wrote its notes');
});

test('concurrent duplicate "connected": one applies, one 409, one event row', async () => {
  const { prisma, svc } = setup([session('s1', 'LAUNCH_REQUESTED')]);
  const results = await Promise.allSettled([
    svc.addEvent(ALICE, 's1', { event: 'connected' }),
    svc.addEvent(ALICE, 's1', { event: 'connected' }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(prisma.db.supportSessionEvent.length, 1);
});

test('a session completed first cannot be reopened by a later "connected"', async () => {
  const { prisma, svc } = setup([session('s1', 'LAUNCH_REQUESTED')]);
  await svc.complete(ALICE, 's1', {});
  await rejects(svc.addEvent(ALICE, 's1', { event: 'connected' }), 409);
  assert.equal(prisma.db.supportSession[0].status, 'SESSION_COMPLETED');
  assert.equal(prisma.db.supportSession[0].connectionConfirmedAt, null);
});

test('malformed event names are refused before any lookup', async () => {
  const { prisma, svc } = setup([session('s1', 'LAUNCH_REQUESTED')]);
  const before = structuredClone(prisma.db);
  for (const ev of ['', 'Connected', '<script>', 'a'.repeat(80), 'x y']) {
    await rejects(svc.addEvent(ALICE, 's1', { event: ev }), 400);
  }
  unchanged(prisma, before);
});

test('Quick Connect end: a second end is refused and does not overwrite the outcome', async () => {
  const { prisma, qc } = setup([session('q1', 'CLIENT_OPENED', { isAdHoc: true, endpointId: null, adHocRustdeskId: '123456789' })]);
  await qc.end(ALICE, 'q1', 'completed');
  const before = structuredClone(prisma.db);
  await rejects(qc.end(ALICE, 'q1', 'failed'), 409);
  unchanged(prisma, before);
  assert.equal(prisma.db.supportSession[0].status, 'SESSION_COMPLETED');
});

test('Quick Connect end: history viewer cannot end another technician\'s session', async () => {
  const { prisma, qc } = setup([session('q1', 'CLIENT_OPENED', { isAdHoc: true, endpointId: null, adHocRustdeskId: '123456789' })]);
  const before = structuredClone(prisma.db);
  await rejects(qc.end(MALLORY, 'q1', 'cancelled'), 403);
  unchanged(prisma, before);
});

test('state machine: no event moves a terminal session, from any source', () => {
  const types = Object.keys(state.ALLOWED_SOURCES);
  for (const status of state.TERMINAL) {
    for (const type of types) {
      for (const source of state.ALLOWED_SOURCES[type]) {
        const snap = session('x', status);
        const r = state.applySessionEvent(snap, { type, source, receivedAt: new Date() });
        assert.equal(r.applied, false, `${status} + ${type}/${source}`);
        assert.equal(r.patch.status, undefined, `${status} + ${type}/${source} changed status`);
      }
    }
  }
});

// ── Runner ───────────────────────────────────────────────────────────────────

let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`  ok   ${t.name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${t.name}\n       ${e.message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
