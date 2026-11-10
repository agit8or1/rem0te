import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '../integration/crypto';

/**
 * The approved-action catalog (v0.26) and the canonical plan an approver
 * signs. Shared, as code, by the portal and the approval signer; mirrored in
 * the Windows agent (tools/windows-installer/internal/action/catalog.go),
 * which is the copy that decides what actually runs.
 *
 * Two actions. Starting one Windows service on one workstation (0.26), and
 * installing named Windows updates on a ring of computers (0.27). Nothing here
 * can carry a command line, a script, a path or a URL — parameters are closed
 * enums or update identities — so an AI suggestion, a ticket or a compromised
 * portal cannot turn a catalog entry into arbitrary execution.
 */

export const PLAN_SCHEMA = 'rem0te-action-plan/1';
export const ENVELOPE_SCHEMA = 'rem0te-action-envelope/1';
/** Domain separation for the approval signature (also in the agent). */
export const PLAN_SIGNING_PREFIX = 'rem0te-action-plan-v1\n';

export type Risk = 'low' | 'high';

export interface CatalogAction {
  id: string;
  version: number;
  title: string;
  description: string;
  params: z.ZodType<Record<string, unknown>>;
  /** Shown on the approval page above the approve button, verbatim. */
  warnings: string[];
  /** What the agent checks afterwards. Nothing else is claimed. */
  verification: string;
  /** What this action can never tell you. */
  doesNotProve: string[];
  /** Risk from the plan alone: target class and count. */
  risk(targets: { deviceClass: string }[]): Risk;
  /** How many computers one signed plan may name. */
  maxTargets: number;
  /** How long after delivery a missing result becomes UNKNOWN. */
  resultDeadlineMinutes: number;
  /** Requestable one computer at a time from its Actions tab (false: only through its own workflow). */
  direct: boolean;
}

export const SERVICE_START: CatalogAction = {
  id: 'windows.service.start',
  version: 1,
  title: 'Start the Windows Print Spooler',
  description: 'Starts the Print Spooler service (Spooler) once. If it is already running, nothing is changed.',
  params: z.object({ service: z.literal('Spooler') }).strict(),
  warnings: [
    'Documents already waiting in the print queue may print immediately when the spooler starts. They cannot be recalled once sent to the printer.',
    'This starts the service once. It does not change its startup type, so it may be stopped again after a restart.',
  ],
  verification: 'The agent confirms the service is running 10 seconds after starting it and again 30 seconds after.',
  doesNotProve: ['that any document printed', 'that the printer works', 'why the spooler had stopped'],
  // Anything but a single standard workstation is high impact: two approvers.
  risk: (targets) => (targets.length !== 1 || targets.some((t) => t.deviceClass !== 'WORKSTATION') ? 'high' : 'low'),
  maxTargets: 1,
  resultDeadlineMinutes: 30,
  direct: true,
};

export const UPDATE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Most updates one plan names; the agent enforces the same (patch.MaxPerPlan). */
export const MAX_UPDATES_PER_PLAN = 20;
/** Most computers in one ring plan; the agent enforces the same (action.MaxRingTargets). */
export const MAX_RING_TARGETS = 25;

export const UpdateIdentity = z.object({ updateId: z.string().regex(UPDATE_ID_RE), revision: z.number().int().min(1).max(1_000_000) }).strict();

export const UPDATE_INSTALL: CatalogAction = {
  id: 'windows.update.install',
  version: 1,
  title: 'Install Windows updates',
  description: 'Downloads and installs the named Windows updates from Windows Update on each named computer, then reports each update\'s result. It never restarts a computer.',
  params: z.object({
    updates: z.array(UpdateIdentity).min(1).max(MAX_UPDATES_PER_PLAN)
      .refine((u) => new Set(u.map((x) => `${x.updateId}@${x.revision}`)).size === u.length, 'duplicate update'),
    reboot: z.literal('never'),
  }).strict(),
  warnings: [
    'Installing updates changes the computer. An update can break a driver or an application, and some cannot be uninstalled.',
    'Many updates need a restart before they take effect. This plan never restarts a computer: until someone restarts it, it keeps running the old code and reports "restart required".',
    'Updates download from Microsoft. People using the computer may notice it slow down while they install.',
    'Each computer installs only the named updates that Windows Update offers it and that are security, critical, rollup or ordinary updates. Drivers, feature upgrades and optional updates are never installed, and no licence is accepted on anyone\'s behalf.',
  ],
  verification: 'Each computer reports what Windows Update said for every named update, and whether a restart is pending. A later scan, after any restart, shows whether the update took effect.',
  doesNotProve: ['that the update fixed any problem', 'that applications still work afterwards', 'that the computer has been restarted'],
  // Software installation is high impact on any computer, at any count.
  risk: () => 'high',
  maxTargets: MAX_RING_TARGETS,
  resultDeadlineMinutes: 6 * 60,
  direct: false,
};

export const CATALOG: CatalogAction[] = [SERVICE_START, UPDATE_INSTALL];
export const catalogEntry = (id: string, version: number) => CATALOG.find((a) => a.id === id && a.version === version) ?? null;

/** Approvals required by risk. The agent enforces the same minimums. */
export const APPROVALS_REQUIRED: Record<Risk, number> = { low: 1, high: 2 };
/** The most any action allows; each action sets its own (maxTargets). */
export const MAX_TARGETS = MAX_RING_TARGETS;
/** Longest window a requester may ask for. */
export const MAX_WINDOW_HOURS = 24;

const Id = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const Hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const Iso = z.string().datetime();

export const Target = z.object({
  endpointId: Id,
  businessId: Id,
  businessName: z.string().max(120),
  hostname: z.string().max(64),
  deviceClass: z.string().max(32),
  rustdeskId: z.string().regex(/^[0-9]{6,15}$/),
  /** sha256(device secret) — the agent recomputes it from its own state. */
  deviceSecretSha256: Hex64,
}).strict();

export const Approver = z.object({
  userId: Id,
  name: z.string().max(120),
  role: z.enum(['approver', 'customer']),
  credentialSha256: Hex64,
  at: Iso,
}).strict();

/** What the approver sees and signs. Every field is bound by the signature. */
export const Plan = z.object({
  schema: z.literal(PLAN_SCHEMA),
  jobId: z.string().regex(/^[a-f0-9]{32}$/),
  action: z.object({ id: z.string(), version: z.number().int().positive() }).strict(),
  /** The signed agent build that may execute it (TUF target windows/rem0te-agent.exe). */
  artifact: z.object({ target: z.literal('windows/rem0te-agent.exe'), sha256: Hex64 }).strict(),
  params: z.record(z.string(), z.unknown()),
  targets: z.array(Target).min(1).max(MAX_TARGETS),
  requestedBy: z.object({ userId: Id, name: z.string().max(120), via: z.enum(['portal', 'clientst0r']) }).strict(),
  /** Where the suggestion came from; an AI suggestion still needs every approval. */
  origin: z.object({ kind: z.enum(['technician', 'ai_suggestion']), ticketRef: z.string().max(200).nullable() }).strict(),
  reason: z.string().min(3).max(500),
  policy: z.object({
    risk: z.enum(['low', 'high']),
    approvalsRequired: z.number().int().min(1).max(5),
    customerSignoff: z.boolean(),
  }).strict(),
  window: z.object({ notBefore: Iso, notAfter: Iso }).strict(),
  /**
   * What the approver is shown about the parameters (v0.27): an update's KB
   * and title, as the computers reported them. Signed with everything else,
   * but never consulted by the agent, which decides from Windows Update's own
   * answer — so a misleading title can mislabel an update, never widen what
   * is installed.
   */
  display: z.object({
    updates: z.array(z.object({
      updateId: z.string().regex(UPDATE_ID_RE), revision: z.number().int(), kb: z.string().max(16).nullable(),
      title: z.string().max(300), className: z.string().max(64).nullable(), severity: z.string().max(32).nullable(),
    }).strict()).max(MAX_UPDATES_PER_PLAN),
    deployment: z.object({ id: Id, name: z.string().max(120), ring: z.number().int().min(0).max(9), rings: z.number().int().min(1).max(10) }).strict().nullable(),
  }).strict().optional(),
  createdAt: Iso,
  /** Filled in by the signer when the quorum is met. */
  approvers: z.array(Approver).max(6),
  signedAt: Iso.nullable(),
}).strict();
export type Plan = z.infer<typeof Plan>;

export const Envelope = z.object({
  schema: z.literal(ENVELOPE_SCHEMA),
  kid: z.string().regex(/^[A-Za-z0-9_-]{4,64}$/),
  /** base64 of the exact canonical plan bytes that were signed. */
  plan: z.string().max(65536),
  /** base64 Ed25519 signature over PLAN_SIGNING_PREFIX + plan bytes. */
  sig: z.string().max(200),
}).strict();
export type Envelope = z.infer<typeof Envelope>;

/** Validate the action-specific parts of a plan against the catalog. */
export function validatePlanAction(p: Plan): { ok: true; action: CatalogAction } | { ok: false; reason: string } {
  const a = catalogEntry(p.action.id, p.action.version);
  if (!a) return { ok: false, reason: 'unknown_action' };
  if (!a.params.safeParse(p.params).success) return { ok: false, reason: 'params_not_allowed' };
  if (p.targets.length > a.maxTargets) return { ok: false, reason: 'too_many_targets' };
  const eps = new Set(p.targets.map((t) => t.endpointId)), rids = new Set(p.targets.map((t) => t.rustdeskId));
  if (eps.size !== p.targets.length || rids.size !== p.targets.length) return { ok: false, reason: 'duplicate_target' };
  const risk = a.risk(p.targets);
  if (p.policy.risk !== risk) return { ok: false, reason: 'risk_mismatch' };
  if (p.policy.approvalsRequired < APPROVALS_REQUIRED[risk]) return { ok: false, reason: 'too_few_approvals_required' };
  const nb = Date.parse(p.window.notBefore), na = Date.parse(p.window.notAfter);
  if (!(na > nb) || na - nb > MAX_WINDOW_HOURS * 3600_000) return { ok: false, reason: 'bad_window' };
  return { ok: true, action: a };
}

/**
 * Suggestions that can never become a plan, whatever the catalog grows into.
 * Used to label ClientSt0r proposals that name something outside the catalog.
 */
export const BLOCKED_CATEGORIES = ['arbitrary_command', 'credential_extraction', 'backup_removal', 'defense_disable', 'admin_grant', 'disk_wipe'] as const;

/** The digest an approver is shown and assents to: the plan before anyone approved it. */
export function planDigest(p: Plan): string {
  return createHash('sha256').update(canonicalJson({ ...p, approvers: [], signedAt: null })).digest('hex');
}
