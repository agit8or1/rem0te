/**
 * Loading a computer's patch summary (0.30). Plain Prisma, so both the
 * Patches tab (PatchingService) and alert events (monitoring) can use it
 * without one module depending on the other.
 */
import type { PrismaClient } from '@prisma/client';
import { UPDATE_INSTALL } from '../actions/catalog';
import { Posture, updateState } from './posture';
import { buildPatchSummary, type InstallOutcome, type PatchSummary } from './summary';

export type { PatchSummary } from './summary';
type DeploymentUpdate = { updateId: string; revision: number; kb: string | null; title: string };

export async function patchSummaryFor(prisma: PrismaClient, endpointId: string, now = new Date()): Promise<PatchSummary> {
  const [inv, ep] = await Promise.all([
    prisma.endpointInventory.findUnique({ where: { endpointId }, select: { patchPosture: true, patchScannedAt: true, pendingUpdates: true, rebootRequired: true, updatesCheckedAt: true, lastBootAt: true } }),
    prisma.endpoint.findUnique({ where: { id: endpointId }, select: { updateChannel: true, agentActions: true, isOnline: true, lastSeenAt: true } }),
  ]);
  const parsed = Posture.safeParse(inv?.patchPosture);
  const posture = parsed.success ? parsed.data : null;
  // This computer's results from the most recent approved update plans.
  const targets = await prisma.actionTarget.findMany({
    where: { endpointId, job: { deploymentId: { not: null } } }, orderBy: { createdAt: 'desc' }, take: 5,
    include: { job: { select: { status: true, deploymentId: true } } },
  });
  const outcomes: InstallOutcome[] = [];
  for (const t of targets) {
    const d = await prisma.patchDeployment.findUnique({ where: { id: t.job.deploymentId! }, select: { updates: true } });
    const tv = { status: t.status, statusReason: t.statusReason, jobStatus: t.job.status, result: t.result as never, resultAt: t.resultAt, reconciledNote: t.reconcileNote };
    for (const u of (d?.updates ?? []) as unknown as DeploymentUpdate[]) {
      if (outcomes.some((o) => o.updateId === u.updateId && o.revision === u.revision)) continue; // the newest plan's answer wins
      const st = updateState(u, tv, posture);
      if (st.state === 'not_planned' || st.state === 'canceled') continue;
      outcomes.push({ updateId: u.updateId, revision: u.revision, kb: u.kb, title: u.title, state: st.state, detail: st.detail, resultAt: t.resultAt });
    }
  }
  return buildPatchSummary({
    now, posture, postureScannedAt: inv?.patchScannedAt ?? null,
    basic: inv ? { checkedAt: inv.updatesCheckedAt, rebootRequired: inv.rebootRequired, updates: Array.isArray(inv.pendingUpdates) ? (inv.pendingUpdates as { title: string; kb: string | null; severity: string | null }[]) : [] } : null,
    lastBootAt: inv?.lastBootAt ?? null, isOnline: !!ep?.isOnline, lastSeenAt: ep?.lastSeenAt ?? null,
    signedCapable: ep?.updateChannel === 'signed' && !!ep.agentActions?.includes(`${UPDATE_INSTALL.id}@${UPDATE_INSTALL.version}`),
    outcomes,
  });
}
