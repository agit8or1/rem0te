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
  'HARB-OPS-MB', 'CRV-LAB-PC', 'PSL-PARTNER-MB', 'ACF-ESTIMATING',
]);

async function main() {
  const all = await prisma.endpoint.findMany({ select: { id: true, name: true } });
  for (const e of all) {
    await prisma.endpoint.update({
      where: { id: e.id }, data: { isOnline: !OFFLINE.has(e.name) },
    });
  }

  // Online machines: a scatter of very recent check-ins.
  const online = await prisma.endpoint.findMany({ where: { isOnline: true }, select: { id: true } });
  for (let i = 0; i < online.length; i++) {
    const seen = ago((1 + (i % 9)) * MIN);
    await prisma.endpoint.update({ where: { id: online[i].id }, data: { lastSeenAt: seen } });
    await prisma.rustdeskNode.updateMany({ where: { endpointId: online[i].id }, data: { lastSeenAt: seen } });
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
  const inv = await prisma.endpointInventory.findMany({ select: { id: true } });
  for (let i = 0; i < inv.length; i++) {
    await prisma.endpointInventory.update({
      where: { id: inv[i].id },
      data: { liveSampledAt: ago((1 + (i % 3)) * MIN), collectedAt: ago((4 + (i % 7) * 3) * MIN) },
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

  console.log(`refreshed: ${online.length} online, ${offline.length} offline, ${live.length} live sessions, ${inv.length} inventory samples`);
}

main().finally(() => prisma.$disconnect());
