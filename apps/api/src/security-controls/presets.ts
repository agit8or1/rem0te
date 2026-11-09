import { createHash } from 'node:crypto';
/**
 * Technician access presets (v0.23) and the platform/business access policy.
 *
 * One file is the source of truth for:
 *   - what each built-in tier grants and denies (BUILT_IN_PRESETS),
 *   - which controls exist and how each may be set (CONTROLS),
 *   - which settings are mandatory (LOCKED) and which modes this deployment
 *     cannot enforce at all (UNAVAILABLE),
 *   - and what counts as WIDENING trust, which needs independent review.
 *
 * Capabilities are derived from a preset's policy, never typed in by hand,
 * and the derivation can only ever produce the read-side capabilities below.
 * In particular a preset can never yield `computers:connect`, `computers:edit`,
 * `computers:add`, `computers:remove`, `support:quick_connect` or
 * `users:manage`: remote launch for a preset-backed grant is decided by the
 * launch policy (access-policy.service.ts), with every restriction it needs
 * enforced or the launch refused.
 */
import { z } from 'zod';
import { CAP, type Capability } from '../rbac/capabilities';

export const TIERS = ['L1', 'L2', 'L3'] as const;
export type Tier = (typeof TIERS)[number];

/** Ordered weakest → strongest. A preset value above the platform's is clamped down. */
const RANK = { off: 0, request: 1, allowed: 2 } as const;
type Mode = keyof typeof RANK;
const ModeZ = z.enum(['off', 'request', 'allowed']);

export const Thresholds = z.object({
  /** Distinct computers that may enter privileged work in one window. */
  devices: z.number().int().min(0).max(10000),
  businesses: z.number().int().min(0).max(1000),
  launches: z.number().int().min(0).max(10000),
  writes: z.number().int().min(0).max(10000),
}).strict();
export type Thresholds = z.infer<typeof Thresholds>;

export const PresetPolicy = z.object({
  inventoryView: z.enum(['off', 'allowed']),
  supportRequests: z.enum(['off', 'allowed']),
  eventLogs: z.enum(['off', 'allowed']),
  diagnostics: z.enum(['off', 'basic', 'advanced']),
  /** Diagnostics and view-only only on WORKSTATION-class computers. */
  standardWorkstationsOnly: z.boolean(),
  remoteViewOnly: ModeZ,
  remoteControl: ModeZ,
  elevation: ModeZ,
  unattended: ModeZ,
  clipboard: ModeZ,
  fileTransfer: ModeZ,
  credentialReveal: z.literal('off'),
  enrollment: z.literal('off'),
  scripts: z.literal('off'),
  patches: z.enum(['off', 'request']),
  fixRequests: z.enum(['off', 'low_risk', 'higher_risk']),
  fixApproval: z.literal('off'),
  fleetExecution: z.literal('off'),
  maxSessionMinutes: z.number().int().min(5).max(480),
}).strict();
export type PresetPolicy = z.infer<typeof PresetPolicy>;

const L1: PresetPolicy = {
  inventoryView: 'allowed', supportRequests: 'allowed', eventLogs: 'off', diagnostics: 'off',
  standardWorkstationsOnly: true,
  // Attended view-only is an option an admin may enable for L1 — off by default.
  remoteViewOnly: 'off', remoteControl: 'off', elevation: 'off', unattended: 'off',
  clipboard: 'off', fileTransfer: 'off', credentialReveal: 'off', enrollment: 'off', scripts: 'off',
  patches: 'off', fixRequests: 'off', fixApproval: 'off', fleetExecution: 'off', maxSessionMinutes: 30,
};
const L2: PresetPolicy = {
  ...L1, eventLogs: 'allowed', diagnostics: 'basic', remoteViewOnly: 'allowed',
  remoteControl: 'request', fixRequests: 'low_risk', maxSessionMinutes: 60,
};
const L3: PresetPolicy = {
  ...L2, diagnostics: 'advanced', standardWorkstationsOnly: false,
  elevation: 'request', patches: 'request', fixRequests: 'higher_risk', maxSessionMinutes: 120,
};

export const BUILT_IN_PRESETS: { key: string; tier: Tier; name: string; description: string; policy: PresetPolicy }[] = [
  { key: 'l1-help-desk', tier: 'L1', name: 'L1 — Help Desk', policy: L1,
    description: 'Inventory and liveness for assigned computers; works assigned support requests. No remote launch, event logs, credentials, control, elevation, enrollment, scripts, patches or fix approval.' },
  { key: 'l2-technician', tier: 'L2', name: 'L2 — Technician', policy: L2,
    description: 'L1 plus bounded read-only diagnostics on assigned standard workstations, attended view-only, and requests for low-risk fixes. Interactive control only through a temporary, independently approved grant with fresh authentication.' },
  { key: 'l3-senior', tier: 'L3', name: 'L3 — Senior Technician', policy: L3,
    description: 'L2 plus advanced diagnostics and eligibility to request time-limited control, elevation, higher-risk fixes and staged patch work. The tier grants no approval, execution, enrollment, administration or cross-business access.' },
];

/** What a preset grants as business capabilities. Read-side only, by construction. */
export function presetCapabilities(p: PresetPolicy): Capability[] {
  const caps: Capability[] = [];
  if (p.inventoryView === 'allowed') caps.push(CAP.COMPUTERS_VIEW);
  if (p.supportRequests === 'allowed') caps.push(CAP.SUPPORT_REQUESTS);
  if (p.eventLogs === 'allowed') caps.push(CAP.COMPUTERS_EVENT_LOGS);
  return caps;
}

/** Capabilities no preset can ever produce. Checked by the unit test and the invariant script. */
export const NEVER_FROM_PRESET: Capability[] = [
  CAP.COMPUTERS_CONNECT, CAP.COMPUTERS_EDIT, CAP.COMPUTERS_ADD, CAP.COMPUTERS_REMOVE,
  CAP.QUICK_CONNECT, CAP.USERS_MANAGE,
];

// ── Platform / business access policy ────────────────────────────────────────

export const PROTECTED_CLASSES_MINIMUM = ['DOMAIN_CONTROLLER', 'HYPERVISOR', 'BACKUP_SERVER', 'RMM_HOST'] as const;

export const AccessControls = z.object({
  /** Customer consent at the endpoint for interactive sessions. */
  attendedConsent: z.enum(['required', 'not_required']),
  unattendedAccess: z.enum(['off', 'request']),
  clipboard: z.enum(['off', 'request']),
  fileTransfer: z.enum(['off', 'request']),
  trustedWorkstations: z.enum(['required_for_protected', 'required_for_all']),
  protectedClasses: z.array(z.enum(['SERVER', ...PROTECTED_CLASSES_MINIMUM])).max(6),
  maxSessionMinutes: z.number().int().min(5).max(480),
  windowMinutes: z.number().int().min(5).max(1440),
  thresholds: z.object({
    L1: Thresholds, L2: Thresholds, L3: Thresholds,
    /** Assignments without a preset (made before 0.23). */
    custom: Thresholds,
    /** Business Owners and Business Users acting in their own business. */
    member: Thresholds,
    platformAdmin: Thresholds,
    integration: Thresholds,
  }).strict(),
  maintenanceExceptions: z.enum(['off', 'request']),
  /** Independent contacts for abuse alerts. Webhook URLs are secrets: stored, never echoed or logged. */
  alertDestinations: z.array(z.object({ kind: z.literal('webhook'), url: z.string().url().max(512), label: z.string().max(64) }).strict()).max(5),
}).strict();
export type AccessControls = z.infer<typeof AccessControls>;

export const DEFAULT_CONTROLS: AccessControls = {
  attendedConsent: 'required',
  unattendedAccess: 'off',
  clipboard: 'off',
  fileTransfer: 'off',
  trustedWorkstations: 'required_for_protected',
  protectedClasses: [...PROTECTED_CLASSES_MINIMUM],
  maxSessionMinutes: 60,
  windowMinutes: 60,
  thresholds: {
    // L1 launches nothing by default; 5 is headroom for an admin who enables
    // attended view-only, not an allowance. L1 has no writes at all.
    L1: { devices: 10, businesses: 3, launches: 5, writes: 0 },
    L2: { devices: 15, businesses: 3, launches: 10, writes: 20 },
    L3: { devices: 25, businesses: 5, launches: 20, writes: 40 },
    custom: { devices: 25, businesses: 5, launches: 25, writes: 50 },
    member: { devices: 40, businesses: 1, launches: 40, writes: 80 },
    platformAdmin: { devices: 60, businesses: 20, launches: 60, writes: 120 },
    integration: { devices: 100, businesses: 50, launches: 0, writes: 0 },
  },
  maintenanceExceptions: 'request',
  alertDestinations: [],
};

/** Business override: only fields that can be tightened; validated against the platform values. */
export const BusinessControls = AccessControls.pick({
  attendedConsent: true, unattendedAccess: true, clipboard: true, fileTransfer: true,
  protectedClasses: true, maxSessionMinutes: true,
}).partial().strict();
export type BusinessControls = z.infer<typeof BusinessControls>;

const ORDER = {
  attendedConsent: ['required', 'not_required'],        // later = looser
  unattendedAccess: ['off', 'request'],
  clipboard: ['off', 'request'],
  fileTransfer: ['off', 'request'],
  trustedWorkstations: ['required_for_all', 'required_for_protected'],
  maintenanceExceptions: ['off', 'request'],
} as const;

/** Combine platform and business: the business may only make things stricter. */
export function effectiveControls(platform: AccessControls, business: BusinessControls | null): AccessControls {
  if (!business) return platform;
  const out: AccessControls = structuredClone(platform);
  for (const k of ['attendedConsent', 'unattendedAccess', 'clipboard', 'fileTransfer'] as const) {
    const b = business[k];
    if (b !== undefined && (ORDER[k] as readonly string[]).indexOf(b) < (ORDER[k] as readonly string[]).indexOf(platform[k])) (out as Record<string, unknown>)[k] = b;
  }
  if (business.protectedClasses) out.protectedClasses = [...new Set([...platform.protectedClasses, ...business.protectedClasses])];
  if (business.maxSessionMinutes !== undefined) out.maxSessionMinutes = Math.min(platform.maxSessionMinutes, business.maxSessionMinutes);
  return out;
}

/**
 * The list of ways `after` widens trust compared with `before`. Empty = a
 * tightening or neutral change, applied at once. Non-empty = needs fresh
 * authentication AND an independent reviewer.
 */
export function wideningOf(before: AccessControls, after: AccessControls): string[] {
  const w: string[] = [];
  for (const k of Object.keys(ORDER) as (keyof typeof ORDER)[]) {
    const o = ORDER[k] as readonly string[];
    if (o.indexOf(after[k] as string) > o.indexOf(before[k] as string)) w.push(`${k}: ${before[k]} → ${after[k]}`);
  }
  const removed = before.protectedClasses.filter((c) => !after.protectedClasses.includes(c));
  if (removed.length) w.push(`protectedClasses removed: ${removed.join(', ')}`);
  if (after.maxSessionMinutes > before.maxSessionMinutes) w.push(`maxSessionMinutes: ${before.maxSessionMinutes} → ${after.maxSessionMinutes}`);
  if (after.windowMinutes < before.windowMinutes) w.push(`windowMinutes: ${before.windowMinutes} → ${after.windowMinutes} (shorter window = more work per day)`);
  for (const t of Object.keys(after.thresholds) as (keyof AccessControls['thresholds'])[]) {
    for (const f of ['devices', 'businesses', 'launches', 'writes'] as const) {
      if (after.thresholds[t][f] > before.thresholds[t][f]) w.push(`thresholds.${t}.${f}: ${before.thresholds[t][f]} → ${after.thresholds[t][f]}`);
    }
  }
  // Any change to who is told about abuse is trust: an attacker's first move
  // is to point the alert somewhere they read, or nowhere.
  const sig = (d: AccessControls['alertDestinations']) => d.map((x) => x.url).sort().join('\n');
  if (sig(before.alertDestinations) !== sig(after.alertDestinations)) w.push('alertDestinations changed');
  return w;
}

/** Preset changes that widen what the tier may do. */
export function presetWidening(before: PresetPolicy, after: PresetPolicy): string[] {
  const w: string[] = [];
  const score: Record<string, Record<string, number>> = {
    inventoryView: { off: 0, allowed: 1 }, supportRequests: { off: 0, allowed: 1 }, eventLogs: { off: 0, allowed: 1 },
    diagnostics: { off: 0, basic: 1, advanced: 2 }, patches: { off: 0, request: 1 },
    fixRequests: { off: 0, low_risk: 1, higher_risk: 2 },
  };
  const a = after as unknown as Record<string, string>, b = before as unknown as Record<string, string>;
  for (const [k, m] of Object.entries(score)) {
    if (m[a[k]] > m[b[k]]) w.push(`${k}: ${b[k]} → ${a[k]}`);
  }
  for (const k of ['remoteViewOnly', 'remoteControl', 'elevation', 'unattended', 'clipboard', 'fileTransfer'] as const) {
    if (RANK[after[k] as Mode] > RANK[before[k] as Mode]) w.push(`${k}: ${before[k]} → ${after[k]}`);
  }
  if (before.standardWorkstationsOnly && !after.standardWorkstationsOnly) w.push('standardWorkstationsOnly: true → false');
  if (after.maxSessionMinutes > before.maxSessionMinutes) w.push(`maxSessionMinutes: ${before.maxSessionMinutes} → ${after.maxSessionMinutes}`);
  return w;
}

/**
 * How each preset control is presented and whether it can be changed. The
 * Settings UI renders exactly this; the server refuses anything else.
 *   locked       mandatory, cannot be changed
 *   unavailable  this deployment cannot enforce it, so it cannot be turned on
 */
export const CONTROL_STATUS: Record<keyof PresetPolicy, { label: string; locked?: string; unavailable?: string }> = {
  inventoryView: { label: 'Inventory and liveness' },
  supportRequests: { label: 'Work assigned support requests' },
  eventLogs: { label: 'Read event logs (bounded)' },
  diagnostics: { label: 'Diagnostics' },
  standardWorkstationsOnly: { label: 'Standard workstations only' },
  remoteViewOnly: { label: 'Attended view-only', unavailable: 'RustDesk view-only is a toggle on the technician\'s own client; an endpoint can only enforce it machine-wide. No agent reports an enforceable view-only mode yet, so a view-only launch is refused rather than opened with control.' },
  remoteControl: { label: 'Interactive control (temporary grant)' },
  elevation: { label: 'Elevation', unavailable: 'There is no privileged helper on the endpoint to elevate through.' },
  unattended: { label: 'Unattended access' },
  clipboard: { label: 'Clipboard', unavailable: 'Clipboard is controlled on the technician\'s RustDesk client; the endpoint does not enforce it per session.' },
  fileTransfer: { label: 'File transfer', unavailable: 'File transfer is controlled on the technician\'s RustDesk client; the endpoint does not enforce it per session.' },
  credentialReveal: { label: 'Credential reveal', locked: 'Never granted by a preset.' },
  enrollment: { label: 'Enrollment', locked: 'A tier never grants enrollment.' },
  scripts: { label: 'Scripts', locked: 'No preset runs scripts; there is no signed script catalog.' },
  patches: { label: 'Staged patch work', unavailable: 'Patch installation is not implemented; requests are recorded only.' },
  // Since 0.26 a request can become a signed plan: the catalog has one action
  // (start the Print Spooler). Requesting is all a tier grants — approval is
  // the approval signer's roster, and fixApproval stays locked off.
  fixRequests: { label: 'Request catalog actions (approved by the roster, never by the tier)' },
  fixApproval: { label: 'Approve fixes', locked: 'A tier never approves. Independent review is a separate designation.' },
  fleetExecution: { label: 'Fleet execution', locked: 'Off for all tiers.' },
  maxSessionMinutes: { label: 'Maximum session length (minutes)' },
};

// ── Secret handling for alert destinations ───────────────────────────────────


/** Stable, non-reversible handle for a destination URL. */
export function destinationRef(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 12);
}

/**
 * The policy as it may be shown, audited or recorded: each webhook becomes
 * its label, its origin and a ref. The path and query of a webhook URL are
 * usually the credential, so they never leave the policy row.
 */
export function redactControls(c: AccessControls) {
  return {
    ...c,
    alertDestinations: c.alertDestinations.map((d) => {
      let origin = '(invalid)';
      try { origin = new URL(d.url).origin; } catch { /* keep placeholder */ }
      return { kind: d.kind, label: d.label, origin, ref: destinationRef(d.url) };
    }),
  };
}

/**
 * Accept a policy edited from its redacted form: a destination given as
 * `{ref}` (no url) is the existing one with that ref. An unknown ref is an
 * error rather than a silently dropped contact.
 */
export function restoreDestinations(raw: unknown, current: AccessControls): unknown {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { alertDestinations?: unknown }).alertDestinations)) return raw;
  const byRef = new Map(current.alertDestinations.map((d) => [destinationRef(d.url), d]));
  const dests = (raw as { alertDestinations: unknown[] }).alertDestinations.map((d) => {
    const o = d as { ref?: string; url?: string; label?: string; kind?: string };
    if (o && typeof o === 'object' && !o.url && o.ref) {
      const hit = byRef.get(o.ref);
      if (!hit) throw new Error(`unknown alert destination ref ${o.ref}`);
      return { kind: 'webhook', url: hit.url, label: o.label ?? hit.label };
    }
    return { kind: o?.kind, url: o?.url, label: o?.label };
  });
  return { ...(raw as object), alertDestinations: dests };
}
