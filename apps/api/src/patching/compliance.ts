/**
 * Patch compliance, one definition (0.32).
 *
 * The dashboard's tile and the Patch compliance report count the same thing
 * from the same stored evidence, so the rule lives here and both call it:
 * a device is *up to date* when its latest Windows Update scan is fresh
 * (under STALE_AFTER_MS) and lists no pending updates. Compliance is counted
 * only over devices with a fresh scan; devices with a stale scan or none at
 * all are coverage gaps, counted apart and never as compliant.
 *
 * Pure (no Nest, no Prisma beyond types).
 */
import { Posture } from './posture';
import { buildPatchSummary, STALE_AFTER_MS, type Freshness, type EvidenceSource } from './summary';

export const PATCH_COMPLIANCE_DEFINITION =
  `A device is up to date when its latest Windows Update scan is under ${STALE_AFTER_MS / 3_600_000} hours old and lists no pending updates. Compliance counts only devices with such a scan; coverage is how many devices have one.`;

/** The inventory columns the evidence comes from — the ones the Patches tab reads. */
export const PATCH_INVENTORY_SELECT = {
  patchPosture: true, patchScannedAt: true, pendingUpdates: true, rebootRequired: true, updatesCheckedAt: true, lastBootAt: true,
} as const;

export interface PatchInventory {
  patchPosture: unknown; patchScannedAt: Date | null; pendingUpdates: unknown; rebootRequired: boolean | null; updatesCheckedAt: Date | null; lastBootAt: Date | null;
}

export type ComplianceState = 'up_to_date' | 'needs_updates' | 'stale_scan' | 'no_scan';

export interface DeviceCompliance {
  state: ComplianceState;
  source: EvidenceSource;
  freshness: Freshness;
  scanAt: Date | null;
  pendingCount: number;
  rebootRequired: boolean | null;
}

/** One device's patch evidence, classified. The same call the dashboard makes. */
export function deviceCompliance(inv: PatchInventory | null | undefined, e: { isOnline: boolean; lastSeenAt: Date | null }, now: Date): DeviceCompliance {
  const parsed = Posture.safeParse(inv?.patchPosture);
  const s = buildPatchSummary({
    now, posture: parsed.success ? parsed.data : null, postureScannedAt: inv?.patchScannedAt ?? null,
    basic: inv ? { checkedAt: inv.updatesCheckedAt, rebootRequired: inv.rebootRequired, updates: Array.isArray(inv.pendingUpdates) ? (inv.pendingUpdates as { title: string; kb: string | null; severity: string | null }[]) : [] } : null,
    lastBootAt: inv?.lastBootAt ?? null, isOnline: e.isOnline, lastSeenAt: e.lastSeenAt, signedCapable: false, outcomes: [],
  });
  const f = s.evidence.freshness;
  return {
    state: f === 'none' ? 'no_scan' : f === 'stale' ? 'stale_scan' : s.pendingCount === 0 ? 'up_to_date' : 'needs_updates',
    source: s.evidence.source, freshness: f, scanAt: s.evidence.at, pendingCount: s.pendingCount, rebootRequired: s.rebootRequired,
  };
}

/** Totals over a set of classified devices, with the two percentages the dashboard shows. */
export function tally(list: DeviceCompliance[]) {
  const t = { total: list.length, fresh: 0, upToDate: 0, needsUpdates: 0, stale: 0, noScan: 0 };
  for (const d of list) {
    if (d.state === 'no_scan') t.noScan++;
    else if (d.state === 'stale_scan') t.stale++;
    else { t.fresh++; if (d.state === 'up_to_date') t.upToDate++; else t.needsUpdates++; }
  }
  return {
    ...t,
    compliancePercent: t.fresh ? Math.round((t.upToDate / t.fresh) * 100) : null,
    coveragePercent: t.total ? Math.round((t.fresh / t.total) * 100) : null,
  };
}
