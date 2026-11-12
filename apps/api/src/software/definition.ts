import { z } from 'zod';
import {
  Detection, MAX_RING_TARGETS, PACKAGE_ID_MAX, PACKAGE_ID_RE, SHA256_RE, SOFTWARE_VERSION_RE, SoftwareParams,
} from '../actions/catalog';

/**
 * Software deployment (0.34): the pure rules, with no Nest, Prisma or
 * network. The portal's service, the compliance report and unit-software.mjs
 * all call these, so the numbers a report shows and the rule a ring gate
 * applies are one implementation.
 *
 * Version comparison and detection evaluation repeat the agent's
 * (tools/windows-installer/internal/action/software.go): the agent decides
 * what happened on a computer, these only read what it, or the inventory,
 * reported.
 */

export type DetectionState = 'installed' | 'outdated' | 'absent';
export type ComplianceState = 'compliant' | 'outdated' | 'missing' | 'unknown';
export const COMPLIANCE_STATES: ComplianceState[] = ['compliant', 'outdated', 'missing', 'unknown'];
/** Evidence older than this is not trusted to say what is installed now. */
export const EVIDENCE_STALE_DAYS = 14;
export const MAX_SOFTWARE_RINGS = 5;

// ── Versions ─────────────────────────────────────────────────────────────────

const NUM = /^[0-9]+$/;
function cmpNum(a: string, b: string): number {
  const x = a.replace(/^0+(?=.)/, ''), y = b.replace(/^0+(?=.)/, '');
  if (x.length !== y.length) return x.length < y.length ? -1 : 1;
  return x < y ? -1 : x > y ? 1 : 0;
}
/**
 * Segment-wise comparison: split on . - + _, a missing segment is "0", two
 * numeric segments compare as numbers (of any length), anything else as
 * case-insensitive ASCII. -1, 0 or 1.
 */
export function compareVersions(a: string, b: string): number {
  const sa = a.split(/[.\-+_]/), sb = b.split(/[.\-+_]/);
  const n = Math.max(sa.length, sb.length);
  for (let i = 0; i < n; i++) {
    // A missing or empty segment is "0", as on the agent: "1..2" is 1.0.2.
    const x = sa[i] || '0', y = sb[i] || '0';
    let c: number;
    if (NUM.test(x) && NUM.test(y)) c = cmpNum(x, y);
    else { const lx = x.toLowerCase(), ly = y.toLowerCase(); c = lx < ly ? -1 : lx > ly ? 1 : 0; }
    if (c !== 0) return c;
  }
  return 0;
}

export function meets(found: string, rule: Pick<Detection, 'compare' | 'version'>): boolean {
  const c = compareVersions(found, rule.version);
  return rule.compare === 'eq' ? c === 0 : c >= 0;
}

// ── Detection, from what the portal stores ──────────────────────────────────

export interface InventoryProgram { name: string; version: string | null }

/**
 * Evaluate a display_name rule over the inventory's software list (the same
 * uninstall-key entries the agent reads). The other two kinds need the
 * computer itself (a registry key name, a file's version resource), which the
 * inventory does not carry: null, never a guess.
 */
export function detectFromInventory(rule: Detection, programs: InventoryProgram[] | null): DetectionState | null {
  if (rule.kind !== 'display_name' || !programs) return null;
  const want = rule.name.toLowerCase();
  const hits = programs.filter((p) => typeof p?.name === 'string' && (rule.match === 'exact' ? p.name.toLowerCase() === want : p.name.toLowerCase().startsWith(want)));
  if (!hits.length) return 'absent';
  const best = hits.map((h) => h.version ?? '').sort((a, b) => compareVersions(b, a))[0];
  return meets(best, rule) ? 'installed' : 'outdated';
}

/** What a software job's result says about the computer, and from when. */
export function detectFromResult(result: unknown): { state: DetectionState; version: string | null } | null {
  if (!result || typeof result !== 'object') return null;
  const o = (result as { observed?: Record<string, unknown> }).observed;
  if (!o) return null;
  const pick = (k: string) => (o[k] === 'installed' || o[k] === 'outdated' || o[k] === 'absent' ? o[k] as DetectionState : null);
  for (const [s, v] of [['detectedAfter', 'versionAfter'], ['detectedNow', 'versionNow'], ['detectedBefore', 'versionBefore']] as const) {
    const st = pick(s);
    if (st) return { state: st, version: typeof o[v] === 'string' ? o[v] as string : null };
  }
  return null;
}

export const sameDetection = (a: unknown, b: unknown) => {
  const x = Detection.safeParse(a), y = Detection.safeParse(b);
  return x.success && y.success && JSON.stringify(Object.entries(x.data).sort()) === JSON.stringify(Object.entries(y.data).sort());
};

export interface Evidence { state: DetectionState; at: Date; source: 'inventory' | 'agent'; version: string | null }

/** The inventory's software list, as stored (EndpointInventory.software). */
export function programsOf(sw: unknown): InventoryProgram[] | null {
  return Array.isArray(sw) ? (sw as { name?: unknown; version?: unknown }[]).filter((p) => p && typeof p.name === 'string').map((p) => ({ name: p.name as string, version: typeof p.version === 'string' ? p.version : null })) : null;
}

/**
 * Everything that says whether one entry is on one computer: the inventory
 * (display_name rules only) and each software job's own detection — which
 * counts only for the same package and the same rule.
 */
export function evidenceFor(
  e: { packageId: string; detection: unknown }, inventoryAt: Date | null, programs: InventoryProgram[] | null,
  targets: { resultAt: Date | null; result: unknown; job: { params: unknown } }[],
): (Evidence | null)[] {
  const rule = Detection.safeParse(e.detection);
  if (!rule.success) return [];
  const inv = inventoryAt ? detectFromInventory(rule.data, programs) : null;
  const fromInv: Evidence | null = inv && inventoryAt ? { state: inv, at: inventoryAt, source: 'inventory', version: null } : null;
  const agent = targets.filter((t) => t.resultAt && (t.job.params as { packageId?: string } | null)?.packageId === e.packageId && sameDetection((t.job.params as { detection?: unknown }).detection, rule.data))
    .map((t) => { const d = detectFromResult(t.result); return d ? { state: d.state, at: t.resultAt!, source: 'agent' as const, version: d.version } : null; });
  return [fromInv, ...agent];
}

/**
 * One computer against one catalog entry: the newest evidence decides, and
 * evidence older than EVIDENCE_STALE_DAYS (or none at all) is "unknown".
 */
export function complianceOf(evidence: (Evidence | null)[], now: Date): { state: ComplianceState; evidence: Evidence | null; stale: boolean } {
  const e = evidence.filter((x): x is Evidence => !!x).sort((a, b) => b.at.getTime() - a.at.getTime())[0] ?? null;
  if (!e) return { state: 'unknown', evidence: null, stale: false };
  if (now.getTime() - e.at.getTime() > EVIDENCE_STALE_DAYS * 86_400_000) return { state: 'unknown', evidence: e, stale: true };
  return { state: e.state === 'installed' ? 'compliant' : e.state === 'outdated' ? 'outdated' : 'missing', evidence: e, stale: false };
}

export function tallyCompliance(states: ComplianceState[]) {
  const out: Record<ComplianceState, number> & { total: number } = { total: states.length, compliant: 0, outdated: 0, missing: 0, unknown: 0 };
  for (const s of states) out[s]++;
  return out;
}

// ── The winget-pkgs manifest ────────────────────────────────────────────────

export const WINGET_PKGS_RAW = 'https://raw.githubusercontent.com/microsoft/winget-pkgs/master/manifests';
export const MANIFEST_MAX_BYTES = 256 * 1024;

/** manifests/<first letter>/<Publisher>/<Package…>/<version>/<id>.installer.yaml, as winget-pkgs lays them out. */
export function manifestPath(packageId: string, version: string): string {
  if (!PACKAGE_ID_RE.test(packageId) || packageId.length > PACKAGE_ID_MAX || !SOFTWARE_VERSION_RE.test(version)) throw new Error('bad package id or version');
  return `${packageId[0].toLowerCase()}/${packageId.split('.').join('/')}/${version}/${packageId}.installer.yaml`;
}

export interface ManifestInstaller { architecture: string | null; scope: string | null; installerType: string | null; installerUrl: string | null; installerSha256: string | null; locale: string | null }
export interface InstallerManifest { packageIdentifier: string | null; packageVersion: string | null; manifestType: string | null; installers: ManifestInstaller[] }

const unq = (v: string) => {
  const t = v.replace(/\s+#.*$/, '').trim();
  return (t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")) ? t.slice(1, -1) : t;
};

/**
 * Read the few fields an installer manifest needs: the root identity and,
 * per installer, architecture, scope, type, URL and SHA-256 (root-level
 * defaults apply to every installer). A deliberately small line reader for
 * the winget-pkgs layout, not a YAML parser: anything it does not recognise
 * is ignored, and a manifest it cannot read yields no installers, which the
 * caller refuses.
 */
export function parseInstallerManifest(text: string): InstallerManifest {
  const out: InstallerManifest = { packageIdentifier: null, packageVersion: null, manifestType: null, installers: [] };
  const root: Record<string, string> = {};
  let inInstallers = false, cur: Record<string, string> | null = null, keyIndent = -1;
  const items: Record<string, string>[] = [];
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(raw)) continue;
    let m = raw.match(/^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/);
    if (m) { inInstallers = m[1] === 'Installers'; cur = null; keyIndent = -1; if (!inInstallers) root[m[1]] = unq(m[2]); continue; }
    if (!inInstallers) continue;
    m = raw.match(/^(\s*)-\s+([A-Za-z][A-Za-z0-9]*):\s*(.*)$/);
    if (m && (keyIndent < 0 || m[1].length + 2 === keyIndent)) { cur = { [m[2]]: unq(m[3]) }; items.push(cur); keyIndent = m[1].length + 2; continue; }
    m = raw.match(/^(\s+)([A-Za-z][A-Za-z0-9]*):\s*(.*)$/);
    if (m && cur && m[1].length === keyIndent) cur[m[2]] = unq(m[3]);
  }
  out.packageIdentifier = root.PackageIdentifier ?? null;
  out.packageVersion = root.PackageVersion ?? null;
  out.manifestType = root.ManifestType ?? null;
  for (const it of items) {
    const get = (k: string) => (it[k] ?? root[k] ?? null) || null;
    const sha = get('InstallerSha256');
    out.installers.push({
      architecture: get('Architecture')?.toLowerCase() ?? null, scope: get('Scope')?.toLowerCase() ?? null, installerType: get('InstallerType')?.toLowerCase() ?? null,
      installerUrl: get('InstallerUrl'), installerSha256: sha && /^[0-9A-Fa-f]{64}$/.test(sha) ? sha.toLowerCase() : null, locale: get('InstallerLocale'),
    });
  }
  return out;
}

/**
 * The installers a machine-scope install on this architecture could get: the
 * architecture's own (or neutral), scope machine or unstated. The hash is
 * pinned only when they all carry the same one, or when the caller names one
 * of them.
 */
export function selectInstaller(m: InstallerManifest, architecture: string, sha?: string): { ok: true; installer: ManifestInstaller } | { ok: false; code: string; message: string; candidates: ManifestInstaller[] } {
  const fit = m.installers.filter((i) => (i.architecture === architecture || i.architecture === 'neutral') && (i.scope === null || i.scope === 'machine') && i.installerSha256);
  if (!fit.length) return { ok: false, code: 'NO_MACHINE_INSTALLER', message: `The manifest has no machine-scope installer for ${architecture}.`, candidates: m.installers };
  if (sha) {
    const hit = fit.find((i) => i.installerSha256 === sha.toLowerCase());
    return hit ? { ok: true, installer: hit } : { ok: false, code: 'HASH_NOT_IN_MANIFEST', message: 'That SHA-256 is not one of the manifest\'s machine-scope installers for this architecture.', candidates: fit };
  }
  const distinct = new Set(fit.map((i) => i.installerSha256));
  if (distinct.size > 1) return { ok: false, code: 'AMBIGUOUS_INSTALLER', message: `The manifest has ${distinct.size} different machine-scope installers for ${architecture}. Choose one by its SHA-256.`, candidates: fit };
  return { ok: true, installer: fit[0] };
}

// ── Requests ────────────────────────────────────────────────────────────────

const Id = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
// eslint-disable-next-line no-control-regex -- refusing control characters in catalog text is the point
const Text = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\u0000-\u001f\u007f<>]*$/, 'no control characters or angle brackets');

const HashFromManifest = z.object({
  source: z.literal('winget_pkgs'),
  architecture: z.enum(['x64', 'x86', 'arm64', 'neutral']).default('x64'),
  installerSha256: z.string().regex(SHA256_RE).optional(),
}).strict();
const HashPasted = z.object({ source: z.literal('admin_pasted'), installerSha256: z.string().regex(SHA256_RE) }).strict();

export const EntryFields = z.object({
  name: Text(120),
  publisher: Text(120).optional(),
  version: z.string().regex(SOFTWARE_VERSION_RE),
  hash: z.discriminatedUnion('source', [HashFromManifest, HashPasted]),
  detection: Detection,
  notes: Text(500).optional(),
}).strict();
export const CreateEntryDto = EntryFields.extend({
  scope: z.enum(['global', 'business']),
  businessId: Id.optional(),
  packageId: z.string().max(PACKAGE_ID_MAX).regex(PACKAGE_ID_RE, 'a winget package id such as 7zip.7zip'),
}).strict();
/** Changing an entry: everything but its package, scope and business. The revision seen is required. */
export const UpdateEntryDto = EntryFields.extend({ expectedRevision: z.number().int().min(1) }).strict();
export const ArchiveEntryDto = z.object({ reason: Text(300), expectedRevision: z.number().int().min(1) }).strict();
export const ManifestPreviewDto = z.object({
  packageId: z.string().max(PACKAGE_ID_MAX).regex(PACKAGE_ID_RE, 'a winget package id such as 7zip.7zip'),
  version: z.string().regex(SOFTWARE_VERSION_RE),
}).strict();

export const CreateDeploymentDto = z.object({
  entryId: Id,
  operation: z.enum(['install', 'uninstall']),
  name: Text(120).optional(),
  rings: z.array(z.array(Id).min(1).max(MAX_RING_TARGETS)).min(1).max(MAX_SOFTWARE_RINGS),
  soakHours: z.number().int().min(0).max(168).default(24),
  failureThreshold: z.number().int().min(0).max(MAX_RING_TARGETS).default(0),
  windowHours: z.number().int().min(1).max(24).default(8),
}).strict();
export const RequestRingDto = z.object({
  reason: z.string().trim().min(3).max(400),
  startsInMinutes: z.number().int().min(0).max(24 * 60).default(0),
  exclude: z.array(z.object({ endpointId: Id, why: z.string().trim().min(3).max(200) }).strict()).max(MAX_RING_TARGETS).default([]),
}).strict();
export const SingleDto = z.object({
  reason: z.string().trim().min(3).max(400),
  windowHours: z.number().int().min(1).max(24).default(8),
  startsInMinutes: z.number().int().min(0).max(24 * 60).default(0),
}).strict();
export const ReasonDto = z.object({ reason: z.string().trim().min(3).max(300) }).strict();

/** The exact params a plan signs for an entry. Throws if the entry could not be signed (it always can, given the CHECKs). */
export function paramsOf(e: { packageId: string; version: string; installerSha256: string; detection: unknown }): SoftwareParams {
  return SoftwareParams.parse({ packageId: e.packageId, version: e.version, installerSha256: e.installerSha256, scope: 'machine', detection: e.detection });
}

// ── The ring gate ───────────────────────────────────────────────────────────

export interface SwGateTarget {
  endpointId: string; status: string; reconciled: boolean; resultAt: Date | null;
  result: { outcome?: string; reason?: string; observed?: Record<string, string> } | null;
  /** A later inventory's verdict for a display_name rule (after a restart), if any. */
  laterInventory?: DetectionState | null;
}
export interface SwGate { ok: boolean; reason: string; detail: string; until?: string }

/** Did this computer end up the way the operation wanted? */
export function effective(t: SwGateTarget, operation: 'install' | 'uninstall'): boolean {
  if (t.status !== 'SUCCEEDED' || !t.result) return false;
  if (t.result.observed?.effective === 'true') return true;
  // Installed but waiting for a restart: a later inventory may confirm it.
  const want: DetectionState = operation === 'install' ? 'installed' : 'absent';
  return t.result.outcome === 'restart_required' && t.laterInventory === want;
}

/**
 * May the ring after `ring` be requested? The patching gate's reasons, with
 * the canary judged by the agent's own after-detection: "it ran" is not
 * enough, and a canary that already had it proves nothing.
 */
export function evaluateSoftwareGate(g: { ring: number; jobStatus: string | null; targets: SwGateTarget[]; operation: 'install' | 'uninstall'; failureThreshold: number; soakHours: number }, now: Date): SwGate {
  const ring = g.ring;
  if (!g.jobStatus) return { ok: false, reason: 'not_requested', detail: `Ring ${ring} has not been requested.` };
  if (['AWAITING_APPROVAL', 'APPROVED', 'DISPATCHED'].includes(g.jobStatus)) return { ok: false, reason: 'in_progress', detail: `Ring ${ring} is ${g.jobStatus.toLowerCase().replace(/_/g, ' ')}.` };
  if (['REJECTED', 'CANCELED', 'EXPIRED'].includes(g.jobStatus)) return { ok: false, reason: 'ring_not_run', detail: `Ring ${ring}'s plan was ${g.jobStatus.toLowerCase()}; request it again.` };
  if (g.targets.some((t) => t.status === 'UNKNOWN' && !t.reconciled)) return { ok: false, reason: 'unreconciled', detail: `A computer in ring ${ring} has an uncertain outcome. Reconcile it first.` };
  if (g.targets.some((t) => t.status === 'PENDING' || t.status === 'DISPATCHED')) return { ok: false, reason: 'in_progress', detail: `A computer in ring ${ring} has not answered yet.` };
  const computers = g.targets.filter((t) => t.status !== 'CANCELED');
  if (!computers.length) return { ok: false, reason: 'ring_not_run', detail: `No computer in ring ${ring} was reached.` };
  const failed = computers.filter((t) => t.status !== 'SUCCEEDED' || (t.result?.outcome !== 'no_change' && !effective(t, g.operation) && t.result?.outcome !== 'restart_required'));
  if (failed.length > g.failureThreshold) return { ok: false, reason: 'too_many_failures', detail: `${failed.length} computer(s) in ring ${ring} failed; the threshold is ${g.failureThreshold}.` };
  if (ring === 0) {
    const c = computers[0];
    if (c.result?.outcome === 'no_change') return { ok: false, reason: 'canary_proved_nothing', detail: `The canary ${g.operation === 'install' ? 'already had it' : 'did not have it'}, so it proves nothing. Choose another canary.` };
    if (!effective(c, g.operation)) return { ok: false, reason: 'canary_not_effective', detail: c.result?.outcome === 'restart_required' ? 'The canary needs a restart before its detection rule confirms the change; restart it and let its inventory report.' : 'The canary\'s detection rule did not confirm the change.' };
  }
  const last = computers.map((t) => t.resultAt?.getTime() ?? 0).reduce((a, b) => Math.max(a, b), 0);
  const until = last + g.soakHours * 3_600_000;
  if (now.getTime() < until) return { ok: false, reason: 'soaking', detail: `Soaking until ${new Date(until).toISOString()}.`, until: new Date(until).toISOString() };
  return { ok: true, reason: 'passed', detail: `Ring ${ring} passed.` };
}

/** Which ring may be requested next, and why. The patching rule: a failed ring is retried, never promoted past. */
export function nextRing(status: string, pausedReason: string | null, jobs: Map<number, { status: string }>, gates: SwGate[], n: number): { ring: number | null; canRequest: boolean; why: string } {
  if (status !== 'ACTIVE') return { ring: null, canRequest: false, why: `The deployment is ${status.toLowerCase()}${pausedReason ? `: ${pausedReason}` : ''}.` };
  for (let i = 0; i < n; i++) {
    const j = jobs.get(i);
    if (!j || ['REJECTED', 'CANCELED', 'EXPIRED'].includes(j.status)) {
      if (i === 0) return { ring: 0, canRequest: true, why: j ? 'The canary\'s plan did not run; request it again.' : 'Start with the canary.' };
      const g = gates[i - 1];
      return { ring: i, canRequest: g.ok, why: g.ok ? `Ring ${i - 1} passed.` : g.detail };
    }
    const g = gates[i];
    if (g.ok) continue;
    if (g.reason === 'too_many_failures') return { ring: i, canRequest: true, why: `${g.detail} Request ring ${i} again to retry, leaving out computers if you need to.` };
    if (g.reason === 'soaking' && i === n - 1) break;
    return { ring: i + 1 < n ? i + 1 : null, canRequest: false, why: g.detail };
  }
  return { ring: null, canRequest: false, why: 'Every ring has run.' };
}
