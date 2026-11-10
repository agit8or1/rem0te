/**
 * Monitoring demo data for documentation screenshots (0.29). Runs ONLY against
 * the throwaway reboot_remote_docs database, after _docs-demo-data.ts and
 * _docs-demo-refresh.ts. Idempotent: it clears its own monitoring rows first.
 *
 * Run the docs API with MONITOR_SWEEP=off while capturing, or the sweep will
 * (correctly) re-evaluate these fictional alerts against fictional heartbeats.
 *
 * Nothing here can reach anything: notification destinations are on
 * example.com (RFC 2606) and no peer is configured.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
if (!process.env.DATABASE_URL?.includes('reboot_remote_docs')) {
  throw new Error('Refusing to run: DATABASE_URL is not the docs database');
}

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const ago = (ms: number) => new Date(Date.now() - ms);

const RECOMMENDED = [
  { key: 'offline', kind: 'OFFLINE', name: 'Computer offline', severity: 'WARNING', params: { minutes: 15 } },
  { key: 'disk-free', kind: 'DISK_FREE', name: 'System disk nearly full', severity: 'WARNING', params: { minFreePercent: 10 } },
  { key: 'cpu-high', kind: 'CPU_HIGH', name: 'Processor pinned', severity: 'INFO', params: { percent: 95, samples: 5 } },
  { key: 'memory-high', kind: 'MEMORY_HIGH', name: 'Memory exhausted', severity: 'WARNING', params: { percent: 95, samples: 5 } },
  { key: 'reboot-pending', kind: 'REBOOT_PENDING', name: 'Restart pending for 3 days', severity: 'INFO', params: { hours: 72 } },
  { key: 'disk-errors', kind: 'EVENT_MATCH', name: 'Disk errors in the System log', severity: 'CRITICAL', params: { log: 'System', ids: [7, 11, 51, 153], levels: [], threshold: 1, clearAfterMinutes: 1440 } },
] as const;

const SOFTWARE = [
  ['Microsoft 365 Apps for business - en-us', '16.0.17928.20156', 'Microsoft Corporation'],
  ['Google Chrome', '131.0.6778.86', 'Google LLC'],
  ['7-Zip 24.08 (x64)', '24.08', 'Igor Pavlov'],
  ['Adobe Acrobat Reader (64-bit)', '24.004.20220', 'Adobe'],
  ['Zebra Setup Utilities', '1.1.9.1325', 'Zebra Technologies'],
  ['Microsoft Edge', '131.0.2903.70', 'Microsoft Corporation'],
  ['Microsoft Visual C++ 2015-2022 Redistributable (x64)', '14.40.33810.0', 'Microsoft Corporation'],
  ['Notepad++ (64-bit x64)', '8.7.1', 'Notepad++ Team'],
  ['RustDesk', '1.4.1', 'RustDesk'],
  ['Windows PC Health Check', '3.6.2204.08001', 'Microsoft Corporation'],
];

async function main() {
  const admin = await prisma.user.findFirst({ where: { isPlatformAdmin: true }, orderBy: { createdAt: 'asc' } });
  const harbor = await prisma.customer.findFirst({ where: { name: 'Harbor Logistics' } });
  const northwind = await prisma.customer.findFirst({ where: { name: 'Northwind Dental' } });
  const cascade = await prisma.customer.findFirst({ where: { name: 'Cascade Accounting' } });
  if (!admin || !harbor || !northwind || !cascade) throw new Error('run _docs-demo-data.ts first');
  const ep = async (name: string) => {
    const e = await prisma.endpoint.findFirst({ where: { name } });
    if (!e) throw new Error(`demo computer ${name} missing`);
    return e;
  };

  // Clean slate for everything this script owns.
  await prisma.monitorAlert.deleteMany({});
  await prisma.monitorRule.deleteMany({});
  await prisma.monitorSuppression.deleteMany({});
  await prisma.monitorNotifyPolicy.deleteMany({});
  await prisma.endpointChange.deleteMany({});
  await prisma.site.deleteMany({ where: { customerId: harbor.id, name: 'Tacoma warehouse' } });

  // ── Monitors: the recommended set globally, plus overrides ─────────────
  for (const r of RECOMMENDED) {
    await prisma.monitorRule.create({ data: { scopeKey: 'global', key: r.key, kind: r.kind, name: r.name, severity: r.severity, params: r.params, createdById: admin.id } });
  }
  await prisma.monitorRule.create({ data: { scopeKey: `b:${harbor.id}`, customerId: harbor.id, key: 'offline', kind: 'OFFLINE', name: 'Computer offline (30 min for the depots)', severity: 'WARNING', params: { minutes: 30 }, createdById: admin.id } });
  await prisma.monitorRule.create({ data: { scopeKey: `b:${harbor.id}`, customerId: harbor.id, key: 'spooler', kind: 'SERVICE_STOPPED', name: 'Label printing: Print Spooler stopped', severity: 'CRITICAL', params: { service: 'Spooler', alertIfMissing: false, ignoreDisabled: true }, createdById: admin.id } });
  await prisma.monitorRule.create({ data: { scopeKey: `b:${harbor.id}`, customerId: harbor.id, key: 'cpu-high', kind: 'CPU_HIGH', name: 'Processor pinned', severity: 'INFO', enabled: false, params: { percent: 95, samples: 5 }, createdById: admin.id } });

  // ── A site with most of its computers offline → one site outage ───────
  const site = await prisma.site.create({ data: { tenantId: harbor.tenantId, customerId: harbor.id, name: 'Tacoma warehouse', city: 'Tacoma', state: 'WA', country: 'US' } });
  const siteNames = ['HARB-WAREHOUSE-1', 'HARB-WAREHOUSE-2', 'HARB-YARD-KIOSK', 'HARB-GATEHOUSE'];
  for (const n of siteNames) await prisma.endpoint.update({ where: { id: (await ep(n)).id }, data: { siteId: site.id } });
  const outage = await prisma.monitorAlert.create({
    data: {
      tenantId: harbor.tenantId, customerId: harbor.id, siteId: site.id, ruleKey: 'site-outage', kind: 'SITE_OUTAGE', dedupKey: `site-outage:${site.id}`,
      severity: 'CRITICAL', title: 'Tacoma warehouse: 3 of 4 computers offline', detail: { offline: 3, total: 4 },
      firstSeenAt: ago(42 * MIN), lastSeenAt: ago(MIN), notifyFrom: ago(42 * MIN), escalationLevel: 1, lastNotifiedAt: ago(42 * MIN),
      events: { create: [
        { type: 'raised', detail: { grouped: 3 }, createdAt: ago(42 * MIN) },
        { type: 'notified', detail: { level: 0, results: [{ label: 'On-call Teams', ok: true, status: 'HTTP 200' }] }, createdAt: ago(42 * MIN) },
      ] },
    },
  });
  for (const [i, n] of ['HARB-WAREHOUSE-1', 'HARB-WAREHOUSE-2', 'HARB-YARD-KIOSK'].entries()) {
    const e = await ep(n);
    await prisma.monitorAlert.create({
      data: {
        tenantId: e.tenantId, customerId: harbor.id, siteId: site.id, endpointId: e.id, ruleKey: 'offline', kind: 'OFFLINE', dedupKey: `offline:${e.id}`,
        severity: 'WARNING', title: `${n} has been offline for 30 minutes`, detail: { minutes: 30 }, parentId: outage.id,
        firstSeenAt: ago((45 - i) * MIN), lastSeenAt: ago(MIN), notifyFrom: ago((45 - i) * MIN),
        events: { create: [{ type: 'raised', detail: { rule: 'offline', inheritedFrom: `b:${harbor.id}` }, createdAt: ago((45 - i) * MIN) }, { type: 'grouped', detail: { outageAlertId: outage.id }, createdAt: ago(42 * MIN) }] },
      },
    });
  }

  // ── Single-computer alerts in each state ───────────────────────────────
  const dispatch = await ep('HARB-DISPATCH-01');
  await prisma.monitorAlert.create({
    data: {
      tenantId: dispatch.tenantId, customerId: harbor.id, endpointId: dispatch.id, ruleKey: 'spooler', kind: 'SERVICE_STOPPED', dedupKey: `spooler:${dispatch.id}`,
      severity: 'CRITICAL', title: 'HARB-DISPATCH-01: service Spooler is Stopped', detail: { service: 'Spooler', status: 'Stopped', startType: 'Automatic' },
      firstSeenAt: ago(2 * HOUR), lastSeenAt: ago(2 * MIN), occurrences: 4, notifyFrom: ago(2 * HOUR), escalationLevel: 2, lastNotifiedAt: ago(90 * MIN),
      ticketPeerId: 'clientst0r', ticketId: 'T-20418', ticketUrl: 'https://tickets.example.com/t/20418', ticketLinkedAt: ago(110 * MIN),
      events: { create: [
        { type: 'raised', detail: { rule: 'spooler', inheritedFrom: `b:${harbor.id}` }, createdAt: ago(2 * HOUR) },
        { type: 'notified', detail: { level: 0, results: [{ label: 'On-call Teams', ok: true, status: 'HTTP 200' }] }, createdAt: ago(2 * HOUR) },
        { type: 'ticket_event', detail: { event: 'alert.raised', organizations: 1 }, createdAt: ago(2 * HOUR) },
        { type: 'ticket_linked', detail: { ticketId: 'T-20418' }, createdAt: ago(110 * MIN) },
        { type: 'escalated', detail: { level: 1, results: [{ label: 'Service desk lead', ok: true, status: 'HTTP 200' }] }, createdAt: ago(90 * MIN) },
      ] },
    },
  });
  const xray = await ep('NWD-XRAY-WS');
  await prisma.monitorAlert.create({
    data: {
      tenantId: xray.tenantId, customerId: northwind.id, endpointId: xray.id, ruleKey: 'disk-free', kind: 'DISK_FREE', dedupKey: `disk-free:${xray.id}`,
      severity: 'WARNING', state: 'ACKNOWLEDGED', title: 'NWD-XRAY-WS: C: has 6% free (28.4 GB)', detail: { freePercent: 6, freeGb: 28.4 },
      firstSeenAt: ago(5 * HOUR), lastSeenAt: ago(10 * MIN), occurrences: 12, notifyFrom: ago(5 * HOUR), escalationLevel: 1, lastNotifiedAt: ago(5 * HOUR),
      acknowledgedAt: ago(4 * HOUR), acknowledgedById: admin.id,
      events: { create: [
        { type: 'raised', detail: { rule: 'disk-free', inheritedFrom: 'global' }, createdAt: ago(5 * HOUR) },
        { type: 'notified', detail: { level: 0, results: [{ label: 'On-call Teams', ok: true, status: 'HTTP 200' }] }, createdAt: ago(5 * HOUR) },
        { type: 'acknowledged', actorId: admin.id, detail: { note: 'Imaging archive moving to the NAS on Friday' }, createdAt: ago(4 * HOUR) },
      ] },
    },
  });
  const payroll = await ep('CASC-PAYROLL-01');
  await prisma.monitorAlert.create({
    data: {
      tenantId: payroll.tenantId, customerId: cascade.id, endpointId: payroll.id, ruleKey: 'disk-errors', kind: 'EVENT_MATCH', dedupKey: `disk-errors:${payroll.id}`,
      severity: 'CRITICAL', title: 'CASC-PAYROLL-01: 3 matching events in System (disk errors)', detail: { count: 3, sample: { eventId: 153, provider: 'disk', message: 'The IO operation at logical block address 0x1a2b3c for Disk 0 was retried.' } },
      firstSeenAt: ago(25 * MIN), lastSeenAt: ago(5 * MIN), occurrences: 2, notifyFrom: ago(25 * MIN), suppressed: true,
      events: { create: [{ type: 'raised', detail: { rule: 'disk-errors', inheritedFrom: 'global' }, createdAt: ago(25 * MIN) }, { type: 'suppressed', detail: { until: new Date(Date.now() + 2 * HOUR).toISOString() }, createdAt: ago(25 * MIN) }] },
    },
  });
  const sup = await prisma.monitorSuppression.create({ data: { scopeKey: `b:${cascade.id}`, customerId: cascade.id, ruleKeys: [], reason: 'Payroll server disk replacement (vendor on site)', startsAt: ago(HOUR), endsAt: new Date(Date.now() + 2 * HOUR), createdById: admin.id } });
  await prisma.monitorAlert.updateMany({ where: { endpointId: payroll.id }, data: { suppressionId: sup.id, notifyFrom: sup.endsAt, nextCheckAt: sup.endsAt } });
  await prisma.monitorSuppression.create({ data: { scopeKey: 'global', ruleKeys: ['offline'], reason: 'ISP maintenance window (Saturday night)', startsAt: new Date(Date.now() + 3 * DAY), endsAt: new Date(Date.now() + 3 * DAY + 4 * HOUR), createdById: admin.id } });
  const recep = await ep('NWD-RECEPTION-01');
  await prisma.monitorAlert.create({
    data: {
      tenantId: recep.tenantId, customerId: northwind.id, endpointId: recep.id, ruleKey: 'reboot-pending', kind: 'REBOOT_PENDING', dedupKey: `reboot-pending:${recep.id}`,
      severity: 'INFO', state: 'RESOLVED', title: 'NWD-RECEPTION-01: restart pending for 3 days', detail: { hours: 74 },
      firstSeenAt: ago(2 * DAY), lastSeenAt: ago(DAY), notifyFrom: ago(2 * DAY), resolvedAt: ago(DAY), resolveNote: 'Restarted after hours',
      events: { create: [{ type: 'raised', createdAt: ago(2 * DAY) }, { type: 'resolved', detail: { note: 'Restarted after hours' }, createdAt: ago(DAY) }] },
    },
  });

  // ── Notification policy ────────────────────────────────────────────────
  await prisma.monitorNotifyPolicy.create({
    data: {
      scopeKey: 'global', updatedById: admin.id,
      levels: [
        { afterMinutes: 0, minSeverity: 'WARNING', destinations: [{ label: 'On-call Teams', url: 'https://hooks.example.com/teams/on-call' }] },
        { afterMinutes: 30, minSeverity: 'CRITICAL', destinations: [{ label: 'Service desk lead', url: 'https://hooks.example.com/pager/lead' }] },
      ],
      ticketing: { enabled: true, minSeverity: 'CRITICAL' },
    },
  });

  // ── Change history, software and a monitor report on one computer ─────
  const changes = [
    ['software', 'added', '7-Zip 24.08 (x64)', null, '24.08', 3 * HOUR],
    ['software', 'changed', 'Google Chrome', '130.0.6723.117', '131.0.6778.86', DAY],
    ['hardware', 'changed', 'memory', '16 GB', '32 GB', 4 * DAY],
    ['software', 'removed', 'Java 8 Update 381', '8.0.3810.9', null, 6 * DAY],
    ['os', 'changed', 'operating system', 'Windows 11 Pro 23H2 (22631.4317)', 'Windows 11 Pro 23H2 (22631.4460)', 9 * DAY],
    ['network', 'added', 'adapter Intel(R) Wi-Fi 6E AX211', null, 'Intel(R) Wi-Fi 6E AX211', 12 * DAY],
  ] as const;
  for (const [category, change, subject, before, after, t] of changes) {
    await prisma.endpointChange.create({ data: { endpointId: dispatch.id, customerId: harbor.id, category, change, subject, before, after, detectedAt: ago(t) } });
  }
  const software = SOFTWARE.map(([name, version, publisher], i) => ({ name, version, publisher, installedOn: ago((i * 37 + 3) * DAY).toISOString() }));
  await prisma.endpointInventory.updateMany({
    where: { endpointId: dispatch.id },
    data: { software, softwareCount: software.length, monitorReport: { services: [{ name: 'Spooler', status: 'Stopped', startType: 'Automatic' }], events: [{ key: 'disk-errors', checkedAt: ago(2 * MIN).toISOString(), count: 0, newestAt: null, sample: null }] }, monitorReportedAt: ago(2 * MIN) },
  });

  // ── Two API keys for Settings → API keys. Hashes of random values that are
  // never printed, so neither key can authenticate anything.
  await prisma.apiKey.deleteMany({ where: { customerId: harbor.id } });
  const { createHash, randomBytes } = await import('crypto');
  for (const [name, scopes, used, revoked] of [
    ['PSA sync', ['companies:read', 'computers:read'], 12 * MIN, null],
    ['Old asset export', ['computers:read', 'audit:read'], 40 * DAY, 30 * DAY],
  ] as const) {
    await prisma.apiKey.create({
      data: {
        tenantId: harbor.tenantId, customerId: harbor.id, createdById: admin.id, name, scopes: [...scopes],
        keyHash: createHash('sha256').update(randomBytes(32)).digest('hex'), keyPrefix: `rk_${randomBytes(4).toString('hex')}`,
        lastUsedAt: ago(used), expiresAt: revoked ? null : new Date(Date.now() + 80 * DAY), revokedAt: revoked ? ago(revoked) : null, createdAt: ago(60 * DAY),
      },
    });
  }

  console.log('Monitoring demo data created:', {
    rules: await prisma.monitorRule.count(), alerts: await prisma.monitorAlert.count(), windows: await prisma.monitorSuppression.count(), changes: await prisma.endpointChange.count(),
  });
}

main().finally(() => prisma.$disconnect());
