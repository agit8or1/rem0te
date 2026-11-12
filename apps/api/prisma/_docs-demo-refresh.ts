/**
 * Re-anchor the demo data's clocks to "now".
 *
 * Online/offline in the UI is derived from how recently a device checked in,
 * so a dataset seeded twenty minutes before a capture drifts: machines seeded
 * as online start reporting Offline, and the dashboard's counts stop matching
 * the inventory list. Run this immediately before a capture run.
 *
 * Only timestamps move. No rows are created, deleted or re-scoped.
 *
 *   DATABASE_URL=…/reboot_remote_docs npx tsx prisma/_docs-demo-refresh.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
if (!process.env.DATABASE_URL?.includes('reboot_remote_docs')) {
  throw new Error('Refusing to run: DATABASE_URL is not the docs database');
}

const MIN = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms);

/**
 * The machines the seed intends to be disconnected. The API sweeps `isOnline`
 * to false from staleness, so by the time a capture runs some of the intended
 * online set has already flipped — reading the current flag back would bake
 * that drift in. Drive the split from names instead.
 */
const OFFLINE = new Set([
  'NWD-XRAY-WS', 'CASC-RECEPTION', 'CASC-TAX-SEASON', 'HARB-WAREHOUSE-2',
  // 0.29: with HARB-WAREHOUSE-2 these make the Tacoma warehouse site outage
  // that _docs-demo-monitoring.ts records (3 of its 4 computers offline).
  'HARB-WAREHOUSE-1', 'HARB-YARD-KIOSK',
  'HARB-OPS-MB', 'CRV-LAB-PC', 'PSL-PARTNER-MB', 'ACF-ESTIMATING',
]);

/**
 * 0.36: one computer is reachable through RustDesk with its agent silent —
 * the amber state 0.35 introduced (common/connectivity.ts). Its agent last
 * checked in SILENT_FOR ago; hbbs still reports its RustDesk peer, so it
 * stays `isOnline` with a fresh RustDesk node. It sits alone in Eugene, so the
 * map draws that marker amber. Keep in step with _docs-demo-workbench.ts,
 * which stops its metric history when the agent went quiet. The docs API must
 * run with STALE_SWEEP=off: with no hbbs on that stack, the sweep would take
 * it offline within a minute.
 */
const AGENT_SILENT = new Set(['NWD-BILLING-RMT']);
const SILENT_FOR = 3 * 24 * 60 * MIN + 2 * 60 * MIN;

async function main() {
  const all = await prisma.endpoint.findMany({ select: { id: true, name: true } });
  for (const e of all) {
    await prisma.endpoint.update({
      where: { id: e.id }, data: { isOnline: !OFFLINE.has(e.name) },
    });
  }

  // Online machines: a scatter of very recent check-ins.
  const online = await prisma.endpoint.findMany({ where: { isOnline: true, name: { notIn: [...AGENT_SILENT] } }, select: { id: true } });
  for (let i = 0; i < online.length; i++) {
    const seen = ago((1 + (i % 9)) * MIN);
    await prisma.endpoint.update({ where: { id: online[i].id }, data: { lastSeenAt: seen } });
    await prisma.rustdeskNode.updateMany({ where: { endpointId: online[i].id }, data: { lastSeenAt: seen } });
  }

  // Agent silent: reachable (isOnline, RustDesk node fresh), heartbeat days old.
  const silent = await prisma.endpoint.findMany({ where: { name: { in: [...AGENT_SILENT] } }, select: { id: true } });
  for (const e of silent) {
    await prisma.endpoint.update({ where: { id: e.id }, data: { isOnline: true, lastSeenAt: ago(SILENT_FOR) } });
    await prisma.rustdeskNode.updateMany({ where: { endpointId: e.id }, data: { lastSeenAt: ago(2 * MIN) } });
  }

  // Offline machines keep a believable spread of staleness.
  const offline = await prisma.endpoint.findMany({ where: { isOnline: false }, select: { id: true } });
  const staleMins = [180, 360, 720, 1440, 2880, 5760, 10080, 43200];
  for (let i = 0; i < offline.length; i++) {
    const seen = ago(staleMins[i % staleMins.length] * MIN);
    await prisma.endpoint.update({ where: { id: offline[i].id }, data: { lastSeenAt: seen } });
    await prisma.rustdeskNode.updateMany({ where: { endpointId: offline[i].id }, data: { lastSeenAt: seen } });
  }

  // The Resources card's sample carries its own timestamp and is read as
  // "minutes old". Leaving it behind while every other clock moves would make
  // a gauge on a freshly-captured screenshot claim to be hours stale.
  // A silent agent's samples stop when it went quiet.
  const silentIds = new Set(silent.map((e) => e.id));
  const inv = await prisma.endpointInventory.findMany({ select: { id: true, endpointId: true } });
  for (let i = 0; i < inv.length; i++) {
    const quiet = silentIds.has(inv[i].endpointId);
    await prisma.endpointInventory.update({
      where: { id: inv[i].id },
      data: quiet
        ? { liveSampledAt: ago(SILENT_FOR), collectedAt: ago(SILENT_FOR + 20 * MIN) }
        : { liveSampledAt: ago((1 + (i % 3)) * MIN), collectedAt: ago((4 + (i % 7) * 3) * MIN) },
    });
  }

  // Sessions still in flight should look like they started minutes ago.
  const live = await prisma.supportSession.findMany({
    where: { status: { in: ['SESSION_STARTED', 'LAUNCH_REQUESTED', 'CLIENT_OPENED'] } },
    select: { id: true },
  });
  for (let i = 0; i < live.length; i++) {
    await prisma.supportSession.update({
      where: { id: live[i].id }, data: { startedAt: ago((4 + i * 9) * MIN) },
    });
  }

  console.log(`refreshed: ${online.length} online, ${silent.length} agent silent, ${offline.length} offline, ${live.length} live sessions, ${inv.length} inventory samples`);
}

main().finally(() => prisma.$disconnect());
