/**
 * What the Patches tab says about one computer, and what a linked ticket is
 * told — built from evidence, with its source and age, and never more certain
 * than that evidence (0.30).
 *
 * Two sources exist:
 *   - `signed_agent_scan` — the signed agent's patch-scan (`rem0te-patch-posture/1`):
 *     offered updates with identities, install history, restart sources and
 *     competing update managers. The only source a deployment is built from.
 *   - `standard_agent_scan` — every agent's inventory UPDATE_SCAN (every 12 h):
 *     titles, KBs and a restart flag. Read-only. It does not read update
 *     policy, so who manages patching is UNKNOWN from it, never "nobody".
 *
 * Pure (no Nest, no Prisma) so the cases can be unit-tested against fixtures.
 */
import { MANAGER_LABEL, type Posture, type UpdateState } from './posture';

/** Three missed 12-hour scans. Older evidence is shown, flagged stale. */
export const STALE_AFTER_MS = 36 * 3600_000;

export type Freshness = 'fresh' | 'stale' | 'none';
export type EvidenceSource = 'signed_agent_scan' | 'standard_agent_scan' | 'none';
export type ManagedBy = 'rem0te_or_windows_update' | 'external' | 'unknown';

export const MANAGER_EXPLANATION: Record<keyof typeof MANAGER_LABEL, string> = {
  wsus: 'This computer takes its updates from a WSUS server (Group Policy WUServer with UseWUServer=1). Approvals belong on that WSUS server; rem0te shows what the computer reports and will not deploy here.',
  mdm_policy: 'An Intune (MDM) Windows Update policy — an update ring, deferral or pause — decides when updates install. Change it in Intune; rem0te shows what the computer reports and will not deploy here.',
  wufb_policy: 'A Windows Update for Business Group Policy (deferral, pause or target release) decides when updates install. rem0te shows what the computer reports and will not deploy here.',
  configmgr: 'Configuration Manager (the CCM client) deploys updates to this computer. Use its software-update deployments; rem0te shows what the computer reports and will not deploy here.',
};
export const UNKNOWN_MANAGER_EXPLANATION =
  'The standard agent lists pending updates but does not read update policy, so whether WSUS, Intune or Configuration Manager manages this computer is unknown. The signed agent reports it.';

export interface BasicScan {
  checkedAt: Date | null;
  rebootRequired: boolean | null;
  updates: { title: string; kb: string | null; severity: string | null }[];
}

export interface InstallOutcome {
  updateId: string; revision: number; kb: string | null; title: string;
  state: UpdateState; detail: string | null; resultAt: Date | null;
}

export interface SummaryInput {
  now: Date;
  posture: Posture | null;
  postureScannedAt: Date | null;
  basic: BasicScan | null;
  lastBootAt: Date | null;
  isOnline: boolean;
  lastSeenAt: Date | null;
  /** Signed channel and the update action advertised. */
  signedCapable: boolean;
  /** Most recent first: this computer's results from approved update plans. */
  outcomes: InstallOutcome[];
}

const ageHours = (now: Date, d: Date | null) => (d ? Math.max(0, Math.round((now.getTime() - d.getTime()) / 360_000) / 10) : null);
const KB_RANK = (s: string | null | undefined) => (/critical/i.test(s ?? '') ? 0 : /important|security/i.test(s ?? '') ? 1 : 2);

export function buildPatchSummary(i: SummaryInput) {
  const p = i.posture;
  const source: EvidenceSource = p ? 'signed_agent_scan' : i.basic?.checkedAt ? 'standard_agent_scan' : 'none';
  const at = p ? (i.postureScannedAt ?? new Date(p.scannedAt)) : i.basic?.checkedAt ?? null;
  const freshness: Freshness = !at ? 'none' : i.now.getTime() - at.getTime() > STALE_AFTER_MS ? 'stale' : 'fresh';
  // A scan that came back with an error still counts as evidence of the
  // computer, not of its updates: the last SUCCESSFUL scan is reported apart.
  const lastSuccessfulScanAt = p ? (p.error ? null : at) : i.basic?.checkedAt ?? null;

  const managers = p ? p.managers.map((m) => ({ id: m, label: MANAGER_LABEL[m], explanation: MANAGER_EXPLANATION[m] })) : [];
  const managedBy: ManagedBy = !p ? 'unknown' : managers.length ? 'external' : 'rem0te_or_windows_update';

  const rebootRequired = p ? p.reboot.pending : i.basic?.rebootRequired ?? null;
  const pending = p
    ? p.updates.map((u) => ({ kb: u.kb ?? null, title: u.title, severity: u.severity ?? null }))
    : (i.basic?.updates ?? []).map((u) => ({ kb: u.kb, title: u.title, severity: u.severity }));
  const relevantKbs = [...new Set([...pending].sort((a, b) => KB_RANK(a.severity) - KB_RANK(b.severity)).map((u) => u.kb).filter((k): k is string => !!k))].slice(0, 20);

  const lastInstallAt = i.outcomes.map((o) => o.resultAt).filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  const confirmations = i.outcomes.slice(0, 20).map((o) => ({
    kb: o.kb, title: o.title, state: o.state, detail: o.detail,
    // Only `effective` is a later scan's confirmation; see updateState().
    confirmedByLaterScan: o.state === 'effective',
    resultAt: o.resultAt,
  }));

  const deploy = !i.signedCapable
    ? { possible: false, reason: 'Deploying updates needs the signed agent (update channel "signed", 0.27 or later). This computer reports read-only.' }
    : managers.length ? { possible: false, reason: `Managed by ${managers.map((m) => m.label).join(', ')}: rem0te will not deploy here.` }
      : !p ? { possible: false, reason: 'No signed scan yet: run Scan now.' }
        : freshness === 'stale' ? { possible: false, reason: 'The last scan is stale: a plan is built from a fresh scan.' }
          : { possible: true, reason: null };

  const warnings: string[] = [];
  if (source === 'none') warnings.push('No update scan has been received from this computer.');
  if (freshness === 'stale') warnings.push(`The last scan is ${ageHours(i.now, at)} hours old${i.isOnline ? '' : ', and the computer is offline'}: what it shows may no longer be true.`);
  if (!i.isOnline && freshness !== 'stale') warnings.push('The computer is offline: nothing newer will arrive until it reconnects.');
  if (p?.error) warnings.push(`The last signed scan failed: ${p.error}`);
  if (managedBy === 'unknown' && source !== 'none') warnings.push(UNKNOWN_MANAGER_EXPLANATION);
  if (rebootRequired && i.lastBootAt && lastInstallAt && i.lastBootAt > lastInstallAt) warnings.push('The computer restarted after the last install, yet still reports a restart pending.');

  return {
    evidence: { source, at, ageHours: ageHours(i.now, at), freshness, lastSuccessfulScanAt },
    lastBootAt: i.lastBootAt,
    restartedSinceLastInstall: lastInstallAt && i.lastBootAt ? i.lastBootAt > lastInstallAt : null,
    online: { isOnline: i.isOnline, lastSeenAt: i.lastSeenAt },
    managedBy: { state: managedBy, managers, explanation: managedBy === 'unknown' ? UNKNOWN_MANAGER_EXPLANATION : managers.map((m) => m.explanation).join(' ') || null },
    rebootRequired,
    pendingCount: pending.length,
    relevantKbs,
    confirmations,
    deploy,
    warnings,
  };
}
export type PatchSummary = ReturnType<typeof buildPatchSummary>;

/**
 * The redacted form a linked ticket receives (contract revision 2,
 * `alert.patch_summary`): KB numbers, states, ages and labels — no update
 * titles, error text, computer names, users, addresses or registry values.
 */
export function redactedPatchSummary(s: PatchSummary) {
  const kbs = (pred: (c: PatchSummary['confirmations'][number]) => boolean) => [...new Set(s.confirmations.filter(pred).map((c) => c.kb).filter((k): k is string => !!k))].slice(0, 20);
  return {
    evidence_source: s.evidence.source,
    evidence_at: s.evidence.at ? s.evidence.at.toISOString() : null,
    evidence_age_hours: s.evidence.ageHours,
    freshness: s.evidence.freshness,
    last_boot_at: s.lastBootAt ? s.lastBootAt.toISOString() : null,
    managed_by: s.managedBy.state,
    managers: s.managedBy.managers.map((m) => m.label),
    reboot_required: s.rebootRequired,
    pending_count: s.pendingCount,
    pending_kbs: s.relevantKbs,
    confirmed_kbs: kbs((c) => c.confirmedByLaterScan),
    failed_kbs: kbs((c) => c.state === 'failed'),
    awaiting_confirmation_kbs: kbs((c) => c.state === 'installed' || c.state === 'restart_required'),
    deploy_available: s.deploy.possible,
  };
}
