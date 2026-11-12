import { z } from 'zod';
import { UPDATE_ID_RE } from '../actions/catalog';
import { DeviceSigned } from '../actions/device-result';

/**
 * Windows Update posture as the signed agent's `patch-scan` reports it
 * (v0.27; tools/windows-installer/internal/patch). Device-reported, so
 * untrusted: every field is bounded here, and nothing in it can widen what an
 * approved plan installs — the agent decides from Windows Update's own
 * answer at install time. The portal uses it to show posture, to offer
 * updates for a deployment, and to confirm afterwards whether an update took
 * effect.
 */

const Guid = z.string().regex(UPDATE_ID_RE);
// eslint-disable-next-line no-control-regex -- stripping control characters from device-reported text is the point
const Text = (n: number) => z.string().max(n * 4).transform((s) => s.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, n));

export const CLASSIFICATIONS: Record<string, string> = {
  '0fa1201d-4330-4fa8-8ae9-b877473b6441': 'Security Updates',
  'e6cf1350-c01b-414d-a61f-263d14d133b4': 'Critical Updates',
  '28bc880e-0592-4cbf-8f95-c79b17911d5f': 'Update Rollups',
  'cd5ffd1e-e932-4e3a-bf74-18bf0b1bbd83': 'Updates',
};
/** Never installed by a plan in this release; shown so nobody wonders where they went. */
export const EXCLUDED_CLASSIFICATIONS: Record<string, string> = {
  'ebfc1fc5-71a4-4f7b-9aca-3b9a503104a0': 'Drivers',
  '3689bdc8-b205-4af4-8d4a-a63924c5e9d5': 'Upgrades',
  'b54e7d24-7add-428f-8b75-90a396fa584f': 'Feature Packs',
  '68c5b0a3-d1a6-4553-ae49-01d3a7827828': 'Service Packs',
  'b4832bd8-e735-4761-8daf-37f882276dab': 'Tools',
  'e0789628-ce08-4437-be74-2495b842f43b': 'Definition Updates',
};

export const PostureUpdate = z.object({
  updateId: Guid, revision: z.number().int().min(1).max(1_000_000),
  kb: z.string().regex(/^KB[0-9]{4,10}$/).optional(),
  title: Text(300), classification: z.union([Guid, z.literal('')]), className: Text(64).optional(), severity: Text(32).optional(),
  downloaded: z.boolean(), rebootBehavior: z.number().int().min(0).max(2), userInput: z.boolean(), eulaAccepted: z.boolean(), browseOnly: z.boolean(),
  sizeBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict();
export type PostureUpdate = z.infer<typeof PostureUpdate>;

export const HistoryEntry = z.object({
  updateId: Guid, revision: z.number().int(), kb: z.string().regex(/^KB[0-9]{4,10}$/).optional(), title: Text(300),
  result: z.enum(['in_progress', 'succeeded', 'succeeded_with_errors', 'failed', 'aborted', 'unknown']),
  hresult: z.string().regex(/^0x[0-9A-Fa-f]{1,8}$/).optional(), operation: z.enum(['install', 'uninstall', 'other']), date: z.string().max(40),
}).strict();

export const MANAGERS = ['wsus', 'wufb_policy', 'mdm_policy', 'configmgr'] as const;
export const MANAGER_LABEL: Record<(typeof MANAGERS)[number], string> = {
  wsus: 'WSUS', wufb_policy: 'Windows Update for Business policy', mdm_policy: 'MDM (Intune) update policy', configmgr: 'Configuration Manager',
};

export const Posture = z.object({
  schema: z.literal('rem0te-patch-posture/1'),
  scannedAt: z.string().datetime(),
  updates: z.array(PostureUpdate).max(100),
  history: z.array(HistoryEntry).max(50),
  reboot: z.object({ pending: z.boolean(), sources: z.array(z.enum(['component_servicing', 'windows_update', 'pending_file_rename', 'update_agent'])).max(4) }).strict(),
  managers: z.array(z.enum(MANAGERS)).max(4),
  autoUpdate: z.enum(['enabled', 'disabled', 'notify', 'unknown']),
  error: Text(200).optional(),
  /**
   * v0.34: the computer's own signature over this scan's gate facts, kept as
   * received and relayed to the approval signer. Never verified as trust here
   * (the portal cannot tell its own forgery from the computer's); a malformed
   * one is dropped rather than refusing the posture.
   */
  signed: DeviceSigned.optional().catch(undefined),
}).strict();
export type Posture = z.infer<typeof Posture>;

export const idKey = (u: { updateId: string; revision: number }) => `${u.updateId}@${u.revision}`;

/** The portal's copy of the agent's Eligible(); the agent's is the one that decides. */
export function eligibility(u: PostureUpdate): { ok: boolean; reason: string | null } {
  if (!CLASSIFICATIONS[u.classification]) return { ok: false, reason: EXCLUDED_CLASSIFICATIONS[u.classification] ? `${EXCLUDED_CLASSIFICATIONS[u.classification]} are not installed by a plan` : 'unclassified updates are not installed by a plan' };
  if (u.browseOnly) return { ok: false, reason: 'optional update' };
  if (u.userInput) return { ok: false, reason: 'needs someone at the computer' };
  if (!u.eulaAccepted) return { ok: false, reason: 'needs a licence accepted' };
  return { ok: true, reason: null };
}

/**
 * Where one update stands on one computer. "effective" is claimed only from
 * a scan taken after the install result, which no longer offers the update,
 * shows no restart pending, and has Windows Update's own history recording
 * the install (or the computer said it was already installed).
 */
export type UpdateState =
  | 'not_planned' | 'awaiting_approval' | 'scheduled' | 'delivered' | 'installed' | 'restart_required' | 'effective'
  | 'superseded' | 'not_applicable' | 'excluded' | 'failed' | 'refused' | 'not_executed' | 'unknown' | 'canceled';

export interface TargetView {
  status: string; statusReason: string | null; jobStatus: string;
  result: { outcome?: string; reason?: string; updates?: { updateId: string; revision: number; state: string; reason?: string; hresult?: string }[] } | null;
  resultAt: Date | null;
  reconciledNote?: string | null;
}

/**
 * The part of a posture that `updateState` reads. A full Posture is one; so
 * is the reduced scan a portal relays to the approval signer as evidence
 * (0.32, actions/patch-policy.ts), which is why both use this one rule.
 */
export interface PostureLike {
  scannedAt: string;
  error?: string;
  updates: { updateId: string; revision: number }[];
  history: { updateId: string; revision: number; operation: string; result: string }[];
  reboot: { pending: boolean };
}

export function updateState(u: { updateId: string; revision: number }, t: TargetView | null, posture: PostureLike | null): { state: UpdateState; detail: string | null } {
  if (!t) return { state: 'not_planned', detail: null };
  if (t.status === 'CANCELED') return { state: 'canceled', detail: t.statusReason };
  if (t.jobStatus === 'AWAITING_APPROVAL') return { state: 'awaiting_approval', detail: null };
  if (t.status === 'PENDING') return { state: 'scheduled', detail: null };
  if (!t.result) return t.status === 'UNKNOWN' ? { state: 'unknown', detail: t.reconciledNote ?? t.statusReason } : { state: 'delivered', detail: null };
  const o = t.result.updates?.find((x) => x.updateId === u.updateId && x.revision === u.revision);
  if (!o) {
    if (t.result.outcome === 'refused') return { state: 'refused', detail: t.result.reason ?? null };
    if (t.result.outcome === 'not_executed') return { state: 'not_executed', detail: t.result.reason ?? null };
    return { state: 'unknown', detail: t.result.reason ?? t.reconciledNote ?? null };
  }
  switch (o.state) {
    case 'installed': case 'restart_required': case 'already_installed': {
      const after = posture && t.resultAt && Date.parse(posture.scannedAt) > t.resultAt.getTime();
      if (after && !posture!.error) {
        const stillOffered = posture!.updates.some((x) => idKey(x) === idKey(u));
        const recorded = o.state === 'already_installed' || posture!.history.some((h) => idKey(h) === idKey(u) && h.operation === 'install' && h.result === 'succeeded');
        if (!stillOffered && recorded && !posture!.reboot.pending) return { state: 'effective', detail: null };
        if (stillOffered) return { state: 'failed', detail: 'a later scan offers it again: it did not stay installed' };
      }
      if (o.state === 'restart_required') return { state: 'restart_required', detail: 'installed; takes effect after a restart' };
      if (after && posture!.reboot.pending) return { state: 'installed', detail: 'a restart is pending on this computer; confirmed by a scan after it' };
      return { state: 'installed', detail: o.state === 'already_installed' ? 'already installed' : 'waiting for a later scan to confirm' };
    }
    case 'superseded': return { state: 'superseded', detail: o.reason ?? null };
    case 'not_offered': return { state: 'not_applicable', detail: o.reason ?? null };
    case 'excluded': return { state: 'excluded', detail: o.reason ?? null };
    case 'failed': return { state: 'failed', detail: [o.reason, o.hresult].filter(Boolean).join(' ') || null };
    default: return { state: 'unknown', detail: o.reason ?? t.reconciledNote ?? null };
  }
}
