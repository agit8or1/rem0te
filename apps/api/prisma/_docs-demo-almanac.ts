/**
 * Demo data for the pages added in 0.51–0.53, for documentation screenshots
 * and the walkthrough video. Runs ONLY against the throwaway
 * reboot_remote_docs database, after _docs-demo-roster.ts and before
 * _docs-demo-refresh.ts. Idempotent: it clears what it owns first (every
 * ActionJob and PatchDeployment of Harbor Logistics, and its own update scan
 * command), so it can be re-run before every capture.
 *
 *   DATABASE_URL=…/reboot_remote_docs npx tsx prisma/_docs-demo-almanac.ts
 *   DATABASE_URL=…/reboot_remote_docs npx tsx prisma/_docs-demo-almanac.ts finish
 *
 * What it writes, and why:
 *   - (0.52) tasks in every state the Tasks panel, Automation → Tasks and the
 *     top bar show, all requested by Morgan Reyes (the account the captures
 *     sign in as), so the in-progress count is theirs:
 *       HARB-DISPATCH-01  update install, answered 21 minutes ago: 3 installed,
 *                         1 failed (0x800f0922), restart required — the
 *                         Patches tab's Latest install card and its banner;
 *                         a Firefox install that succeeded yesterday;
 *       HARB-DISPATCH-02  update install scheduled for the next opening of
 *                         its patch policy window (Tuesday 22:00 Pacific);
 *       HARB-GATEHOUSE    update install handed out 6 minutes ago (running);
 *       HARB-DEPOT-BOI    a Print Spooler restart queued for the next
 *                         check-in, and an update install that failed two
 *                         days ago (0x80070070, disk full);
 *       HARB-DEPOT-SPO    log collection handed out 24 minutes ago with no
 *                         answer: overdue;
 *       HARB-WAREHOUSE-1  an update scan queued on a computer that has not
 *                         checked in for days.
 *   - (0.52) a hand-made deployment for the depots whose canary has not been
 *     requested, so its page offers Start now or Schedule for the next ring.
 *   - (0.52) the Tacoma warehouse site's time zone, America/Los_Angeles, so the
 *     schedule picker names the computer's site zone first.
 *   - `finish` writes the gatehouse install's answer (2 installed, no restart)
 *     as the agent would report it. The walkthrough runs it while the Tasks
 *     page is open, so the console's "your task finished" toast appears.
 *
 * Every plan is written as the docs stack's direct-mode signer would have
 * admitted it (APPROVED at once, no approvers) and its digest is computed
 * with the portal's own planDigest. Envelopes are left empty: there is no
 * agent on the other end, and the docs API's sweeps are off. Results are
 * shaped as the signed agent reports them (src/actions/catalog.ts, the
 * update install's result). Nothing here can reach anything.
 */
import { PrismaClient, Prisma } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { CATALOG, DIRECT, PLAN_SCHEMA, planDigest, type Plan } from '../src/actions/catalog';
import { nextOccurrence, type PolicyWindow } from '../src/actions/patch-policy';

const prisma = new PrismaClient();
if (!process.env.DATABASE_URL?.includes('reboot_remote_docs')) {
  throw new Error('Refusing to run: DATABASE_URL is not the docs database');
}

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms);
const TECH = 'morgan.reyes@rem0te.example.com';
const TZ = 'America/Los_Angeles';
const GATEHOUSE_JOB = 'docs-gatehouse-install';

// The same illustrative updates the roster seed's Windows Update scan offers.
const guid = (seed: string) => { const h = createHash('sha256').update(`docs-update:${seed}`).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`; };
const U = {
  cu: { updateId: guid('KB5070773'), revision: 200, kb: 'KB5070773', title: '2026-11 Cumulative Update for Windows 11 Version 24H2 for x64-based Systems (KB5070773)', className: 'Security Updates', severity: 'Critical' },
  net: { updateId: guid('KB5070112'), revision: 200, kb: 'KB5070112', title: '2026-11 Cumulative Update for .NET Framework 3.5 and 4.8.1 for Windows 11 (KB5070112)', className: 'Security Updates', severity: 'Important' },
  def: { updateId: guid('KB2267602'), revision: 200, kb: 'KB2267602', title: 'Security Intelligence Update for Microsoft Defender Antivirus (KB2267602)', className: 'Definition Updates', severity: null },
  msrt: { updateId: guid('KB5070390'), revision: 200, kb: 'KB5070390', title: 'Windows Malicious Software Removal Tool x64 - v5.143 (KB5070390)', className: 'Updates', severity: null },
};
type Upd = (typeof U)[keyof typeof U];
/** One update's line of the agent's result (AgentResult in src/actions/actions.service.ts). */
const ok = (u: Upd, state = 'installed', hresult = '0x00000000') => ({ updateId: u.updateId, revision: u.revision, kb: u.kb, state, hresult });

async function finish() {
  const t = await prisma.actionTarget.findFirst({ where: { job: { reason: { contains: GATEHOUSE_JOB } } }, include: { job: true } });
  if (!t) throw new Error('the gatehouse install is missing: run this module without "finish" first');
  const at = new Date();
  const result = {
    outcome: 'succeeded',
    updates: [ok(U.def), ok(U.msrt)],
    reboot: { pending: false, sources: [] },
  };
  await prisma.actionTarget.update({ where: { id: t.id }, data: { status: 'SUCCEEDED', outcome: 'succeeded', result: result as Prisma.InputJsonValue, resultAt: at } });
  await prisma.actionJob.update({ where: { id: t.jobId }, data: { status: 'SUCCEEDED', outcome: 'succeeded', result: result as Prisma.InputJsonValue, resultAt: at } });
  console.log('gatehouse install answered at', at.toISOString());
}

async function main() {
  const harbor = await prisma.customer.findFirst({ where: { name: 'Harbor Logistics' } });
  const tech = await prisma.user.findFirst({ where: { email: TECH } });
  if (!harbor || !tech) throw new Error('run _docs-demo-data.ts and _docs-demo-roster.ts first');
  const company = await prisma.patchPolicySeries.findFirst({ where: { customerId: harbor.id, scope: 'business' } });
  if (!company) throw new Error('run _docs-demo-roster.ts first (the company-wide policy)');

  // ── Clear what this module owns ─────────────────────────────────────────
  await prisma.actionJob.deleteMany({ where: { customerId: harbor.id } });
  await prisma.patchDeployment.deleteMany({ where: { customerId: harbor.id } });
  await prisma.endpointCommand.deleteMany({ where: { customerId: harbor.id, type: 'UPDATE_SCAN' } });
  await prisma.endpoint.updateMany({ where: { customerId: harbor.id }, data: { patchScanRequestedAt: null } });

  // ── The schedule picker names the site's zone first ─────────────────────
  await prisma.site.updateMany({ where: { customerId: harbor.id }, data: { timezone: TZ } });

  const eps = await prisma.endpoint.findMany({
    where: { customerId: harbor.id },
    select: { id: true, name: true, hostname: true, deviceClass: true, tenantId: true, rustdeskNode: { select: { rustdeskId: true, agentSecretHash: true } } },
  });
  const ep = (n: string) => { const e = eps.find((x) => x.name === n); if (!e) throw new Error(`demo computer ${n} missing`); return e; };
  const host = (e: (typeof eps)[number]) => (e.hostname ?? e.name).slice(0, 64);

  // The gatehouse and the depots run the same signed agent as the dispatch
  // desks (the dispatch seed gave only those two their catalog).
  const actions = CATALOG.map((a) => `${a.id}@${a.version}`);
  await prisma.endpoint.updateMany({ where: { name: { in: ['HARB-GATEHOUSE', 'HARB-DEPOT-BOI', 'HARB-DEPOT-SPO'] } }, data: { agentActions: actions } });

  const agent = await prisma.endpoint.findFirst({ where: { name: 'HARB-DISPATCH-01' }, select: { agentSha256: true } });
  const artifactSha = agent?.agentSha256 && /^[0-9a-f]{64}$/.test(agent.agentSha256) ? agent.agentSha256 : createHash('sha256').update('docs-agent').digest('hex');

  /** One plan as the direct-mode signer admitted it, and its one target. */
  const job = async (o: {
    on: string; action: string; params: Record<string, unknown>; reason: string; created: Date; notBefore?: Date; windowHours: number;
    display?: Record<string, unknown>; deployment?: { id: string; ring: number };
    target: Partial<Prisma.ActionTargetUncheckedCreateWithoutJobInput>; status: Prisma.ActionJobCreateInput['status'];
  }) => {
    const a = CATALOG.find((x) => x.id === o.action);
    if (!a) throw new Error(`no catalog action ${o.action}`);
    const e = ep(o.on);
    const notBefore = o.notBefore ?? o.created;
    const notAfter = new Date(notBefore.getTime() + o.windowHours * HOUR);
    const plan: Plan = {
      schema: PLAN_SCHEMA, jobId: randomBytes(16).toString('hex'), action: { id: a.id, version: a.version },
      artifact: { target: 'windows/rem0te-agent.exe', sha256: artifactSha }, params: o.params,
      targets: [{ endpointId: e.id, businessId: harbor.id, businessName: harbor.name, hostname: host(e), deviceClass: e.deviceClass, rustdeskId: e.rustdeskNode?.rustdeskId ?? '', deviceSecretSha256: e.rustdeskNode?.agentSecretHash ?? '' }],
      requestedBy: { userId: tech.id, name: 'Morgan Reyes', via: 'portal' }, origin: { kind: 'technician', ticketRef: null }, reason: o.reason,
      policy: { risk: 'high', approvalsRequired: 0, customerSignoff: false, approval: DIRECT },
      window: { notBefore: notBefore.toISOString(), notAfter: notAfter.toISOString() },
      ...(o.display ? { display: o.display } : {}),
      createdAt: o.created.toISOString(), approvers: [], signedAt: o.created.toISOString(),
    } as unknown as Plan;
    const t = o.target;
    await prisma.actionJob.create({
      data: {
        id: plan.jobId, tenantId: harbor.tenantId, customerId: harbor.id, endpointId: e.id, actionId: a.id, actionVersion: a.version,
        params: o.params as Prisma.InputJsonValue, reason: o.reason, origin: 'technician', via: 'portal', requestedById: tech.id,
        status: o.status, risk: 'high', approvalsRequired: 0, customerSignoff: false, notBefore, notAfter,
        plan: plan as unknown as Prisma.InputJsonValue, digest: planDigest(plan), approvalUrl: `https://approve.example.com/a/${plan.jobId}`,
        approvers: [] as unknown as Prisma.InputJsonValue, createdAt: o.created,
        dispatchedAt: t.dispatchedAt ?? null, deliveries: t.deliveries ?? 0, lastDeliveredAt: t.lastDeliveredAt ?? null,
        outcome: t.outcome ?? null, result: (t.result ?? undefined) as Prisma.InputJsonValue | undefined, resultAt: t.resultAt ?? null,
        deploymentId: o.deployment?.id ?? null, ring: o.deployment?.ring ?? null,
        targets: { create: [{ endpointId: e.id, createdAt: o.created, ...t }] },
      },
    });
  };

  /** A one-computer install from the Patches tab: its MANUAL deployment, then the ring-0 plan. */
  const install = async (o: { on: string; updates: Upd[]; created: Date; notBefore?: Date; windowHours: number; reason: string; target: Partial<Prisma.ActionTargetUncheckedCreateWithoutJobInput>; status: Prisma.ActionJobCreateInput['status'] }) => {
    const e = ep(o.on);
    const name = `Install on ${host(e)}`.slice(0, 120);
    const d = await prisma.patchDeployment.create({
      data: { tenantId: harbor.tenantId, customerId: harbor.id, name, updates: o.updates as unknown as Prisma.InputJsonValue, rings: [{ endpointIds: [e.id] }] as unknown as Prisma.InputJsonValue, soakHours: 0, failureThreshold: 0, windowHours: o.windowHours, reboot: 'never', origin: 'MANUAL', createdById: tech.id, createdAt: o.created },
    });
    await job({
      on: o.on, action: 'windows.update.install', params: { updates: o.updates.map((u) => ({ updateId: u.updateId, revision: u.revision })), reboot: 'never' },
      reason: `${name} — canary: ${o.reason}`.slice(0, 500), created: o.created, notBefore: o.notBefore, windowHours: o.windowHours,
      display: { updates: o.updates, deployment: { id: d.id, name, ring: 0, rings: 1 } }, deployment: { id: d.id, ring: 0 }, target: o.target, status: o.status,
    });
  };

  // HARB-DISPATCH-01: answered, restart required. The roster's scan (38 minutes ago) predates it.
  await install({
    on: 'HARB-DISPATCH-01', updates: [U.cu, U.net, U.def, U.msrt], created: ago(34 * MIN), windowHours: 8, status: 'SUCCEEDED',
    reason: 'Installed from the computer’s Patches tab',
    target: {
      status: 'SUCCEEDED', dispatchedAt: ago(32 * MIN), deliveries: 4, lastDeliveredAt: ago(23 * MIN), outcome: 'restart_required', resultAt: ago(21 * MIN),
      result: {
        outcome: 'restart_required',
        updates: [ok(U.cu, 'restart_required'), ok(U.net, 'failed', '0x800f0922'), ok(U.def), ok(U.msrt)],
        reboot: { pending: true, sources: ['windows_update', 'component_servicing'] },
      },
    },
  });

  // HARB-DISPATCH-02: scheduled for the next opening of the company-wide policy's window.
  const companyWindow = (company.settings as { window: PolicyWindow }).window;
  const opening = nextOccurrence(new Date(NOW + 2 * HOUR), companyWindow);
  if (!opening) throw new Error('the company-wide window never opens');
  await install({
    on: 'HARB-DISPATCH-02', updates: [U.net, U.def, U.msrt], created: ago(12 * MIN), notBefore: opening.start,
    windowHours: Math.max(1, Math.round((opening.end.getTime() - opening.start.getTime()) / HOUR)), status: 'APPROVED',
    reason: 'Scheduled for the policy window: the dispatch desk is busy until 22:00', target: { status: 'PENDING' },
  });

  // HARB-GATEHOUSE: handed out, running. `finish` answers it.
  await install({
    on: 'HARB-GATEHOUSE', updates: [U.def, U.msrt], created: ago(8 * MIN), windowHours: 4, status: 'DISPATCHED',
    reason: `Defender and MSRT before the night shift (${GATEHOUSE_JOB})`,
    target: { status: 'DISPATCHED', dispatchedAt: ago(6 * MIN), deliveries: 2, lastDeliveredAt: ago(3 * MIN) },
  });

  // HARB-DEPOT-BOI: failed two days ago, and a restart queued now.
  await install({
    on: 'HARB-DEPOT-BOI', updates: [U.cu], created: ago(2 * DAY + 40 * MIN), windowHours: 8, status: 'FAILED',
    reason: 'November cumulative update ahead of the depot policy',
    target: {
      status: 'FAILED', dispatchedAt: ago(2 * DAY + 37 * MIN), deliveries: 3, lastDeliveredAt: ago(2 * DAY + 28 * MIN), outcome: 'failed', resultAt: ago(2 * DAY + 25 * MIN),
      result: { outcome: 'failed', updates: [ok(U.cu, 'failed', '0x80070070')], reboot: { pending: false, sources: [] } },
    },
  });
  await job({
    on: 'HARB-DEPOT-BOI', action: 'windows.service.restart', params: { service: 'Spooler' }, reason: 'Label printer queue stuck at the Boise depot',
    created: ago(1 * MIN), windowHours: 2, status: 'APPROVED', target: { status: 'PENDING' },
  });

  // HARB-DEPOT-SPO: log collection handed out, no answer: overdue.
  await job({
    on: 'HARB-DEPOT-SPO', action: 'windows.logs.collect', params: {}, reason: 'Scanner app crashed twice this morning',
    created: ago(26 * MIN), windowHours: 2, status: 'DISPATCHED', target: { status: 'DISPATCHED', dispatchedAt: ago(24 * MIN), deliveries: 3, lastDeliveredAt: ago(12 * MIN) },
  });

  // HARB-DISPATCH-01: a catalog install that succeeded yesterday.
  const ff = await prisma.softwareCatalogEntry.findFirst({ where: { packageId: 'Mozilla.Firefox' } });
  if (ff) {
    await job({
      on: 'HARB-DISPATCH-01', action: 'windows.software.install',
      params: { packageId: ff.packageId, version: ff.version, installerSha256: ff.installerSha256, scope: 'machine', detection: ff.detection },
      reason: 'Dispatch needs Firefox for the carrier portal', created: ago(26 * HOUR), windowHours: 4, status: 'SUCCEEDED',
      display: { software: { name: ff.name, version: ff.version, publisher: ff.publisher } },
      target: { status: 'SUCCEEDED', dispatchedAt: ago(26 * HOUR - 2 * MIN), deliveries: 1, lastDeliveredAt: ago(26 * HOUR - 2 * MIN), outcome: 'succeeded', resultAt: ago(26 * HOUR - 6 * MIN), result: { outcome: 'succeeded', observed: { installed: ff.version } } },
    });
  }

  // HARB-WAREHOUSE-1: an update scan queued on a computer that has gone quiet.
  const wh1 = ep('HARB-WAREHOUSE-1');
  await prisma.endpointCommand.create({ data: { endpointId: wh1.id, tenantId: harbor.tenantId, customerId: harbor.id, type: 'UPDATE_SCAN', requestedById: tech.id, createdAt: ago(15 * MIN), expiresAt: new Date(NOW + DAY) } });

  // A hand-made deployment for the depots whose canary has not been requested yet.
  await prisma.patchDeployment.create({
    data: {
      tenantId: harbor.tenantId, customerId: harbor.id, name: 'Defender and MSRT — depots', updates: [U.def, U.msrt] as unknown as Prisma.InputJsonValue,
      rings: [{ endpointIds: [ep('HARB-DEPOT-SPO').id] }, { endpointIds: [ep('HARB-DEPOT-BOI').id] }] as unknown as Prisma.InputJsonValue,
      soakHours: 12, failureThreshold: 0, windowHours: 4, reboot: 'never', origin: 'DEPLOYMENT', createdById: tech.id, createdAt: ago(5 * MIN),
    },
  });

  console.log('Almanac demo data created:', {
    jobs: await prisma.actionJob.count({ where: { customerId: harbor.id } }),
    deployments: await prisma.patchDeployment.count({ where: { customerId: harbor.id } }),
    scheduledFor: opening.start.toISOString(),
  });
}

(process.argv[2] === 'finish' ? finish() : main())
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
