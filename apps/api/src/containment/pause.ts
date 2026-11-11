/**
 * Containment pauses (v0.28): the one question every write path asks.
 * Plain Prisma, no Nest — the integration worker asks it too, and loads no
 * portal module.
 */
import type { ContainmentPause, PrismaClient } from '@prisma/client';

/**
 * `notifications` (0.34) stops every email this server sends: alert emails,
 * scheduled reports, confirmation and test messages. It is its own kind, not
 * part of `integration`, because the two answer different incidents — a
 * business suspending ClientSt0r jobs still wants to hear about a disk
 * filling, and stopping mail (say, a report schedule leaking a fleet list)
 * should not stop ticket analysis. Alert webhooks are not covered: they go
 * to destinations the MSP or business configured as its own systems, and
 * monitoring keeps telling people during a pause by design (0.29).
 */
export const KINDS = ['actions', 'remote', 'updates', 'integration', 'notifications'] as const;
export type Kind = (typeof KINDS)[number];

export const KIND_LABEL: Record<Kind, string> = {
  actions: 'approved actions and patch rings', remote: 'remote connections', updates: 'agent and RustDesk updates', integration: 'ClientSt0r jobs',
  notifications: 'outbound emails',
};

type Db = Pick<PrismaClient, 'containmentPause'>;

/** The pause that blocks `kind` for this business (or everywhere), if any. Global first. */
export async function activePause(db: Db, kind: Kind, customerId: string | null | undefined): Promise<ContainmentPause | null> {
  const rows = await db.containmentPause.findMany({
    where: { clearedAt: null, kinds: { has: kind }, OR: [{ scope: 'GLOBAL' }, ...(customerId ? [{ scope: 'BUSINESS' as const, customerId }] : [])] },
    orderBy: [{ scope: 'asc' }, { createdAt: 'asc' }], take: 1,
  });
  return rows[0] ?? null;
}

export function pauseMessage(p: ContainmentPause, kind: Kind): string {
  const who = p.scope === 'GLOBAL' ? 'A global write pause' : p.setBy === 'customer' ? 'This business has suspended' : 'This business is suspended:';
  return p.scope === 'GLOBAL'
    ? `${who} is in effect: ${KIND_LABEL[kind]} are stopped. Reason: ${p.reason}`
    : p.setBy === 'customer'
      ? `${who} ${KIND_LABEL[kind]}. Only the business can lift it. Reason: ${p.reason}`
      : `${who} ${KIND_LABEL[kind]} are stopped. Reason: ${p.reason}`;
}
