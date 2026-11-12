#!/usr/bin/env node
/**
 * Group-scoped policy cost, measured (0.35) — the figures in
 * docs/group-policies.md.
 *
 * It boots the API's Nest application context from dist/ (no HTTP server,
 * every sweep switched off so nothing runs on its own) against DATABASE_URL,
 * which must name a scratch/test database, and:
 *
 *   1. creates one synthetic business with BENCH_ENDPOINTS computers
 *      (default 5000) across 10 sites, with inventory, RustDesk versions and
 *      tags, and BENCH_GROUPS rule groups (default 50) whose rules use every
 *      kind of condition a rule may carry that a policy may use (tags,
 *      online, platform, site, OS, RustDesk version, pending patches, restart
 *      pending, agent type, last seen);
 *   2. gives every group an OFFLINE monitor and every group but one a
 *      client-update policy (all off), each with its own priority;
 *   3. measures, BENCH_ROUNDS times each, median and worst:
 *        - one membership snapshot of all the groups over the business — what
 *          each sweep tick builds once;
 *        - one monitor sweep (MonitoringService.sweep), against the same
 *          sweep with the group monitors removed (the baseline);
 *        - the per-computer path the heartbeat takes (rulesFor) and the
 *          client-update hold (membership for one computer).
 *
 * Every fixture it made is removed at the end (audit rows excepted: sealed).
 *
 *        - the heartbeat's monitor block when the group monitors are of a
 *          kind the heartbeat does not ask about (none evaluated) and when
 *          they are all service monitors (all evaluated: the worst case).
 *
 * Run:  DATABASE_URL=…/rem0te_<x>_test ENCRYPTION_KEY=… node scripts/bench-group-policy.mjs
 */
import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const require = createRequire(import.meta.url);
const DB = process.env.DATABASE_URL ?? '';
const dbName = DB.split('/').pop()?.split('?')[0] ?? '';
if (!/scratch|test/.test(dbName)) { console.error(`Refusing to run against database "${dbName}": name must contain "scratch" or "test".`); process.exit(2); }
const N = Math.min(20_000, Number(process.env.BENCH_ENDPOINTS ?? 5000));
const G = Math.min(50, Number(process.env.BENCH_GROUPS ?? 50));
const ROUNDS = Math.min(20, Number(process.env.BENCH_ROUNDS ?? 5));
Object.assign(process.env, {
  NODE_ENV: 'test', MONITOR_SWEEP: 'off', CLIENT_UPDATE_SWEEP: 'off', PATCH_POLICY_SWEEP: 'off', METRIC_SWEEP: 'off', RETENTION_SWEEP: 'off',
  REPORT_SCHEDULE_SWEEP: 'off', CHAT_RETENTION_SWEEP: 'off', SCRIPT_OUTPUT_SWEEP: 'off', AUDIT_SEALER: 'off', HBBS_PRESENCE_HOST: '127.0.0.2',
  JWT_SECRET: process.env.JWT_SECRET ?? randomBytes(32).toString('hex'), LAUNCHER_TOKEN_SECRET: process.env.LAUNCHER_TOKEN_SECRET ?? randomBytes(32).toString('hex'),
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? randomBytes(32).toString('hex'),
  VERSION_FILE: path.resolve(here, '..', '..', '..', 'version.json'),
});
const prisma = new PrismaClient();
const sfx = randomBytes(3).toString('hex');
const TAG = `GPB${sfx}`;
const { parseRule } = require(path.join(dist, 'device-views', 'group-rule.js'));

const stats = (xs) => { const s = [...xs].sort((a, b) => a - b); return { median: s[Math.floor(s.length / 2)], worst: s[s.length - 1] }; };
const fmt = (o) => `median ${o.median.toFixed(0)} ms, worst ${o.worst.toFixed(0)} ms`;
async function time(fn, rounds = ROUNDS) { const out = []; for (let i = 0; i < rounds; i++) { const t = performance.now(); await fn(); out.push(performance.now() - t); } return stats(out); }

let bizId = null;
async function main() {
  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) throw new Error('seed the scratch database first');
  const biz = await prisma.customer.create({ data: { tenantId: tenant.id, name: `${TAG} Bench` } });
  bizId = biz.id;
  const sites = [];
  for (let i = 0; i < 10; i++) sites.push(await prisma.site.create({ data: { tenantId: tenant.id, customerId: biz.id, name: `${TAG} site ${i}` } }));
  console.log(`fixtures: ${N} computers, ${sites.length} sites, ${G} rule groups…`);
  const now = Date.now();
  const rows = Array.from({ length: N }, (_, i) => ({
    id: `${TAG.toLowerCase()}ep${String(i).padStart(6, '0')}`, tenantId: tenant.id, customerId: biz.id, siteId: sites[i % 10].id,
    name: `${TAG}-${i}`, hostname: `${TAG}-${i}`.toLowerCase(), platform: ['Windows', 'Windows', 'Windows', 'Linux', 'macOS'][i % 5],
    osVersion: i % 3 ? 'Windows 11 Pro' : 'Windows 10 Pro', status: 'ACTIVE', isOnline: i % 4 !== 0, isManaged: true, accessMode: 'COMPANY_WIDE',
    lastSeenAt: new Date(now - (i % 4 === 0 ? (i % 7) * 86_400_000 : 30_000)), agentVersion: i % 2 ? '0.34.0' : null, updateChannel: i % 6 === 0 ? 'signed' : null,
  }));
  for (let i = 0; i < N; i += 1000) await prisma.endpoint.createMany({ data: rows.slice(i, i + 1000) });
  for (let i = 0; i < N; i += 1000) {
    await prisma.endpointInventory.createMany({ data: rows.slice(i, i + 1000).map((r, k) => ({ endpointId: r.id, updatesCheckedAt: new Date(now - 3600_000), pendingUpdateCount: (i + k) % 3, rebootRequired: (i + k) % 9 === 0 })) });
    await prisma.rustdeskNode.createMany({ data: rows.slice(i, i + 1000).map((r, k) => ({ tenantId: tenant.id, endpointId: r.id, rustdeskId: String(700000000 + i + k), version: ['1.3.9', '1.4.0', '1.4.5'][(i + k) % 3] })) });
    await prisma.endpointTag.createMany({ data: rows.slice(i, i + 1000).map((r, k) => ({ endpointId: r.id, tag: `t${(i + k) % 25}` })) });
  }
  const shapes = (i) => [
    { tag: `t${i % 25}` }, { online: 'online', tag: `t${i % 25}` }, { platform: 'windows', siteId: sites[i % 10].id }, { rustdeskMin: '1.4.0', platform: 'windows' },
    { patches: 'pending' }, { notSeenDays: '3' }, { os: 'Windows 11' }, { restartPending: true, online: 'online' }, { agent: 'signed' }, { seenWithinDays: '1', platform: 'linux' },
  ][i % 10];
  const groups = [];
  for (let i = 0; i < G; i++) {
    const rule = parseRule(shapes(i));
    groups.push(await prisma.endpointGroup.create({ data: { tenantId: tenant.id, customerId: biz.id, name: `${TAG} g${i}`, kind: 'RULE', rule } }));
  }
  await prisma.monitorRule.create({ data: { scopeKey: `b:${biz.id}`, customerId: biz.id, key: 'offline', kind: 'OFFLINE', name: 'offline', params: { minutes: 15 }, createdById: 'bench' } });

  const { NestFactory } = require(path.join(here, '..', 'node_modules', '@nestjs', 'core'));
  const { AppModule } = require(path.join(dist, 'app.module.js'));
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const { GroupMembershipService } = require(path.join(dist, 'group-policy', 'membership.service.js'));
  const { MonitoringService } = require(path.join(dist, 'monitoring', 'monitoring.service.js'));
  const { ClientUpdatesService } = require(path.join(dist, 'client-updates', 'client-updates.service.js'));
  const members = app.get(GroupMembershipService), mon = app.get(MonitoringService), cus = app.get(ClientUpdatesService);

  console.log('baseline: monitor sweep with one business monitor and no group monitors');
  await mon.sweep();
  const base = await time(() => mon.sweep());
  console.log(`  monitor sweep, no group monitors: ${fmt(base)}`);

  for (let i = 0; i < G; i++) {
    await prisma.monitorRule.create({ data: { scopeKey: `g:${groups[i].id}`, customerId: biz.id, groupId: groups[i].id, priority: i + 1, key: `g-offline-${i % 5}`, kind: 'OFFLINE', name: `g${i}`, params: { minutes: 15 }, createdById: 'bench' } });
    if (i < G - 1) await prisma.clientUpdatePolicy.create({ data: { tenantId: tenant.id, customerId: biz.id, groupId: groups[i].id, priority: i + 1, enabled: false, timeZone: 'UTC', windows: [{ days: [0], start: '01:00', end: '02:00' }] } });
  }
  const snap = await members.snapshot(groups.map((g) => g.id));
  const sizes = groups.map((g) => snap.count(g.id));
  console.log(`groups: ${G}, members per group min ${Math.min(...sizes)} / max ${Math.max(...sizes)}, computers in at least one: ${rows.filter((r) => snap.groupsOf(r.id).size).length}`);

  const tSnap = await time(() => members.snapshot(groups.map((g) => g.id)));
  console.log(`  membership snapshot, ${G} rule groups over ${N} computers (once per sweep tick): ${fmt(tSnap)}`);
  await mon.sweep();
  const tSweep = await time(() => mon.sweep());
  console.log(`  monitor sweep, ${G} group monitors: ${fmt(tSweep)}  (baseline ${fmt(base)})`);
  const pols = await prisma.clientUpdatePolicy.findMany({ where: { customerId: biz.id } });
  const tCu = await time(() => cus.membershipFor(pols));
  console.log(`  client-update sweep membership, ${pols.length} group policies (once per business per tick): ${fmt(tCu)}`);
  const sample = rows.filter((_, i) => i % 100 === 0);
  const perComputer = async (fn) => { const xs = []; for (const r of sample) { const t = performance.now(); await fn(r); xs.push(performance.now() - t); } return stats(xs); };
  console.log(`  device page (rulesFor, every kind, all ${G} groups evaluated), ${sample.length} computers: ${fmt(await perComputer((r) => mon.rulesFor({ id: r.id, customerId: biz.id, siteId: r.siteId })))}`);
  console.log(`  heartbeat monitor block, ${G} OFFLINE group monitors (no group can change it, none evaluated): ${fmt(await perComputer((r) => mon.heartbeatConfig(r.id)))}`);
  await prisma.monitorRule.updateMany({ where: { customerId: biz.id, groupId: { not: null } }, data: { kind: 'SERVICE_STOPPED', params: { service: 'Spooler' } } });
  console.log(`  heartbeat monitor block, ${G} SERVICE group monitors (worst case: all evaluated): ${fmt(await perComputer((r) => mon.heartbeatConfig(r.id)))}`);
  const hold = [];
  for (const r of sample) { const t = performance.now(); await cus.membershipFor(pols, [r.id]); hold.push(performance.now() - t); }
  console.log(`  client-update hold membership (one computer, ${pols.length} group policies): ${fmt(stats(hold))}`);
  await app.close();
}

async function cleanup() {
  if (!bizId) return prisma.$disconnect();
  const eps = (await prisma.endpoint.findMany({ where: { customerId: bizId }, select: { id: true } })).map((e) => e.id);
  await prisma.clientUpdatePolicy.deleteMany({ where: { customerId: bizId } });
  await prisma.monitorRule.deleteMany({ where: { customerId: bizId } });
  await prisma.monitorAlertEvent.deleteMany({ where: { alert: { customerId: bizId } } });
  await prisma.monitorAlert.deleteMany({ where: { customerId: bizId } });
  for (let i = 0; i < eps.length; i += 1000) {
    const ids = eps.slice(i, i + 1000);
    await prisma.endpointMonitorState.deleteMany({ where: { endpointId: { in: ids } } });
    await prisma.endpointTag.deleteMany({ where: { endpointId: { in: ids } } });
    await prisma.endpointInventory.deleteMany({ where: { endpointId: { in: ids } } });
    await prisma.rustdeskNode.deleteMany({ where: { endpointId: { in: ids } } });
    await prisma.endpoint.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.endpointGroup.deleteMany({ where: { customerId: bizId } });
  await prisma.site.deleteMany({ where: { customerId: bizId } });
  await prisma.customer.delete({ where: { id: bizId } });
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(cleanup);
