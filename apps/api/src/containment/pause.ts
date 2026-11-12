/**
 * Containment pauses (v0.28): the one question every write path asks.
 * Plain Prisma, no Nest — the integration worker asks it too, and loads no
 * portal module.
 */
import type { ContainmentPause, PrismaClient } from '@prisma/client';

export const KINDS = ['actions', 'remote', 'updates', 'integration'] as const;
export type Kind = (typeof KINDS)[number];

export const KIND_LABEL: Record<Kind, string> = {
  actions: 'approved actions and patch rings', remote: 'remote connections and chat', updates: 'agent and RustDesk updates', integration: 'ClientSt0r jobs',
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
