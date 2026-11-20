import { HEARTBEAT_STALE_MS } from '../common/connectivity';
import { isWindowsPlatform, osName } from '../common/platform';

/**
 * Managed Secure Access readiness (0.69, build step 2 of
 * docs/managed-secure-access.md): one pure function deciding each computer's
 * MSA state from facts already stored. It imports two constants-and-regex
 * modules and nothing that reads a database, a file or the network.
 *
 * Readiness, and since 0.72 the managed states. Nothing here changes a
 * computer. `managed` (Managed (pending)), `managed_verified` and
 * `enforcement_failure` are produced ONLY from the caller's `managed` fact —
 * the MsaManagedComputer row a Platform Admin's cutover wrote, as the agent's
 * reports moved it — and only while the computer is reporting now (rules 1–3
 * first: an Unknown computer is never shown as managed). Managed and verified
 * also needs the agent's own readback of every managed setting within
 * REPORT_MAX_AGE_MS; a saved state alone is never shown as verified, and
 * `verified` is true on that answer alone (unit-msa-readiness.mjs, §80).
 *
 * The rules, in order (the first that applies decides):
 *   1. Platform unknown → unknown. Linux or macOS → unsupported.
 *   2. Not the signed agent (common/agent-identity.ts runsSignedAgent) →
 *      unsupported: the standard agent has no preflight and never will.
 *   3. Not reporting now (no heartbeat within HEARTBEAT_STALE_MS, or offline)
 *      → unknown: an old report is not today's computer.
 *   4. Signed agent older than MIN_REPORTING_AGENT (or no version) →
 *      upgrade_available: it cannot report. Agents update themselves under
 *      the automatic update policy.
 *   5. No report, or a report older than REPORT_MAX_AGE_MS → unknown.
 *   6. RustDesk not where its installer puts it, or no service running that
 *      exe → upgrade_available (Update RustDesk installs it there).
 *   7. Sciter build → unsupported (it ignores access-mode). Build or version
 *      unreadable → unknown.
 *   8. RustDesk older than LAB_TESTED_MIN → upgrade_available, worded "not
 *      lab-tested", never "broken". Newer than LAB_TESTED_MAX → unknown until
 *      the lab covers it.
 *   9. Service not running, or any `--option` read unanswered → unknown.
 *  10. Otherwise → compatible. Still Legacy: compatible changes nothing.
 *
 * With a `managed` fact (0.72), after rule 3: rollback_pending → managed
 * (rolling back), enforcement_failure → enforcement_failure, pending →
 * managed, verified → managed_verified when the agent read every setting
 * back within REPORT_MAX_AGE_MS, else unknown.
 */

export const MSA_STATES = [
  'unsupported',
  'upgrade_available',
  'compatible',
  'unknown',
  // 0.72: only from a managed fact (the MsaManagedComputer row) — never from a preflight.
  'managed',
  'managed_verified',
  'enforcement_failure',
] as const;
export type MsaState = (typeof MSA_STATES)[number];

/** What a preflight alone can produce: never a managed state. */
export const READINESS_STATES = ['unsupported', 'upgrade_available', 'compatible', 'unknown'] as const satisfies readonly MsaState[];
/** The managed states (0.72): only from a managed fact. */
export const MANAGED_READINESS_STATES = ['managed', 'managed_verified', 'enforcement_failure'] as const satisfies readonly MsaState[];
/** Every state decideReadiness can return. */
export const PRODUCIBLE_STATES = [...READINESS_STATES, ...MANAGED_READINESS_STATES] as const;
export type ProducibleState = (typeof PRODUCIBLE_STATES)[number];

export const STATE_LABEL: Record<MsaState, string> = {
  unsupported: 'Unsupported',
  upgrade_available: 'Upgrade available',
  compatible: 'Compatible',
  unknown: 'Unknown',
  managed: 'Managed (pending)',
  managed_verified: 'Managed and verified',
  enforcement_failure: 'Enforcement failure',
};

/** The first signed agent that runs the preflight. */
export const MIN_REPORTING_AGENT = '0.69.0';
/** The first signed agent that enforces a grant (0.72): cutover needs it. */
export const MIN_ENFORCING_AGENT = '0.72.0';
/** RustDesk releases the Windows lab ran as SYSTEM (0.68.3, docs/lab-testing.md). */
export const LAB_TESTED_RUSTDESK = ['1.4.1', '1.4.6', '1.4.7', '1.4.9', '1.5.3'] as const;
export const LAB_TESTED_MIN = '1.4.1';
export const LAB_TESTED_MAX = '1.5.3';
/** A report older than this says nothing about the computer today. */
export const REPORT_MAX_AGE_MS = 7 * 24 * 3600_000;
/** How many `--option` reads the agent makes (msa/preflight.ts PREFLIGHT_KEYS). */
export const PREFLIGHT_KEY_COUNT = 11;

export const READINESS_NOTE =
  'Readiness only — Managed Secure Access is not available yet; nothing has changed on this computer.';
export const READINESS_FLEET_NOTE =
  'Readiness only — Managed Secure Access is not available yet; nothing has changed on any computer.';
/** 0.72: the fleet note while MSA_GRANTS is on (a test server). */
export const READINESS_FLEET_MANAGED_NOTE =
  'Managed Secure Access is switched on for testing: a Platform Admin can move one computer at a time. It has run only in the Windows lab.';
/** 0.72: the note for a computer a Platform Admin moved into Managed Secure Access. */
export const MANAGED_NOTE =
  'Managed Secure Access (build step 4) has run only in the Windows lab: never on a Windows 10 or 11 desktop or on the fleet.';

export interface PreflightFacts {
  checkedAt: Date | string;
  installed: boolean;
  expectedPath: boolean;
  version: string | null;
  build: string;
  service: string;
  cli: string;
  keysOk: number;
}

/** The MsaManagedComputer row (0.72), as the caller read it. No row is Legacy. */
export interface ManagedFacts {
  state: 'pending' | 'verified' | 'enforcement_failure' | 'rollback_pending';
  requestedAt: Date | string;
  verifiedAt: Date | string | null;
  readbackOkAt: Date | string | null;
  failReason: string | null;
  failedKeys: string[];
}

export interface ReadinessFacts {
  platform: string | null;
  /** runsSignedAgent(...) — computed by the caller from stored facts. */
  signedAgent: boolean;
  agentVersion: string | null;
  isOnline: boolean;
  lastSeenAt: Date | string | null;
  preflight: PreflightFacts | null;
  /** 0.72: the managed row, or null / absent for Legacy. */
  managed?: ManagedFacts | null;
}

export interface Readiness {
  state: ProducibleState;
  label: string;
  /** Plain sentences, the deciding one first. */
  reasons: string[];
  /** True only for managed_verified: a Platform Admin's confirmation AND the agent's recent readback. */
  verified: boolean;
  checkedAt: string | null;
  rustdeskVersion: string | null;
  /** True for an exact lab-tested release, false otherwise, null when unknown. */
  labTested: boolean | null;
}

/** "1.4.7+65" → [1, 4, 7]; null when it is not a version. */
export function versionParts(v: string | null | undefined): [number, number, number] | null {
  // eslint-disable-next-line security/detect-unsafe-regex -- anchored, bounded repetitions, one optional group starting with a literal [.+] the digit classes exclude
  const m = typeof v === 'string' ? /^v?([0-9]{1,4})\.([0-9]{1,4})\.([0-9]{1,4})(?:[.+][0-9]{1,6})?$/.exec(v.trim()) : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** <0, 0, >0 like a comparator; null if either is not a version. */
export function compareVersion(a: string | null | undefined, b: string): number | null {
  const pa = versionParts(a);
  const pb = versionParts(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

/** The release part only: "1.4.7+65" → "1.4.7". */
export function releaseOf(v: string | null | undefined): string | null {
  const p = versionParts(v);
  return p ? p.join('.') : null;
}

function iso(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  const t = new Date(d);
  return Number.isFinite(t.getTime()) ? t.toISOString() : null;
}

function ageText(ms: number): string {
  const h = Math.floor(ms / 3600_000);
  if (h < 1) return 'less than an hour ago';
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.floor(h / 24);
  return `${d} days ago`;
}

export function decideReadiness(f: ReadinessFacts, now: number = Date.now()): Readiness {
  const pf = f.preflight;
  const checkedAt = iso(pf?.checkedAt ?? null);
  const rd = pf?.version ?? null;
  const out = (state: ProducibleState, reasons: string[], labTested: boolean | null = null): Readiness => ({
    state, label: STATE_LABEL[state], reasons, verified: state === 'managed_verified', checkedAt, rustdeskVersion: rd, labTested,
  });

  // 1. Platform.
  if (!f.platform) return out('unknown', ['The computer has not reported its operating system.']);
  if (!isWindowsPlatform(f.platform)) {
    const os = osName(f.platform) ?? 'This operating system';
    return out('unsupported', [`${os} is not supported: Managed Secure Access needs the signed Windows agent to apply and read back RustDesk's settings.`]);
  }

  // 2. The signed agent.
  if (!f.signedAgent) {
    return out('unsupported', ['It runs the standard agent, which cannot check or apply RustDesk settings. Upgrade to the full (signed) agent to be checked.']);
  }

  // 3. Reporting now.
  const seen = f.lastSeenAt ? new Date(f.lastSeenAt).getTime() : NaN;
  if (!f.isOnline || !Number.isFinite(seen) || now - seen > HEARTBEAT_STALE_MS) {
    return out('unknown', [Number.isFinite(seen)
      ? `The agent is not reporting (last heartbeat ${ageText(now - seen)}), so nothing current is known.`
      : 'The agent has never reported.']);
  }

  // 0.72: a computer a Platform Admin moved into Managed Secure Access.
  const m = f.managed;
  if (m) {
    const keys = m.failedKeys.length ? ` (${m.failedKeys.join(', ')})` : '';
    if (m.state === 'rollback_pending') {
      return out('managed', ['Rolling back to Legacy: the agent restores the RustDesk settings it saved before it first applied a grant, then the portal hands it a new permanent password.']);
    }
    if (m.state === 'enforcement_failure') {
      return out('enforcement_failure', [
        `The agent could not enforce Managed Secure Access: ${m.failReason ?? 'a setting did not read back'}${keys}. Nothing weaker was substituted.`,
        m.verifiedAt ? 'Connect stays refused until a test grant applies and reads back again, or the computer is rolled back.' : 'Legacy Connect still works (the computer was never verified).',
      ]);
    }
    if (m.state === 'pending') {
      return out('managed', [
        'Moved to Managed (pending) by a Platform Admin. Legacy Connect still works until a managed test session succeeds and a Platform Admin confirms it.',
        m.readbackOkAt ? `The agent last read every managed setting back ${ageText(now - new Date(m.readbackOkAt).getTime())}.` : 'No test grant has been applied yet.',
      ]);
    }
    const rb = m.readbackOkAt ? new Date(m.readbackOkAt).getTime() : NaN;
    if (!Number.isFinite(rb) || now - rb > REPORT_MAX_AGE_MS) {
      return out('unknown', ['Verified as managed, but the agent has not read the managed settings back within 7 days, so it is not shown as enforced.']);
    }
    return out('managed_verified', [
      `The agent read every managed setting back ${ageText(now - rb)}, a managed test session connected, and a Platform Admin confirmed it.`,
      'Its RustDesk password is one nobody is told; the legacy password no longer connects.',
    ]);
  }

  // 4. An agent that can report.
  const agentCmp = compareVersion(f.agentVersion, MIN_REPORTING_AGENT);
  if (agentCmp === null || agentCmp < 0) {
    return out('upgrade_available', [
      `The signed agent${f.agentVersion ? ` (${f.agentVersion})` : ''} is too old to check RustDesk: agents from ${MIN_REPORTING_AGENT} do.`,
      'Signed agents update themselves under the automatic update policy (Settings → Client updates), or with Update agent on this page.',
    ]);
  }

  // 5. A report, and a recent one.
  if (!pf || !checkedAt) {
    return out('unknown', ['No readiness report yet. The agent checks RustDesk within about 30 minutes of starting, then every 6 hours or when RustDesk changes.']);
  }
  const age = now - new Date(checkedAt).getTime();
  if (age > REPORT_MAX_AGE_MS) {
    return out('unknown', [`The last readiness report is from ${ageText(age)}: older than 7 days, so it is not used.`]);
  }

  // 6. Installed where the installer puts it, run by the service.
  if (!pf.installed) {
    return out('upgrade_available', ['RustDesk is not installed where its installer puts it (Program Files\\RustDesk). Update RustDesk installs it there.']);
  }
  if (!pf.expectedPath || pf.service === 'missing') {
    return out('upgrade_available', [pf.service === 'missing'
      ? 'RustDesk has no Windows service. Update RustDesk installs it as a service.'
      : 'The RustDesk service does not run the copy in Program Files\\RustDesk. RustDesk 1.4.7 and later accept settings only from the installed copy; Update RustDesk reinstalls it.']);
  }

  // 7. Build and version.
  if (pf.build === 'sciter') {
    return out('unsupported', ['This is a Sciter build of RustDesk, which ignores view-only (access-mode). Only the standard (Flutter) Windows build can be managed.']);
  }
  if (pf.build !== 'flutter') return out('unknown', ['The RustDesk build could not be identified (neither a Flutter nor a Sciter build was recognised).']);
  const rel = releaseOf(rd);
  if (!rel) return out('unknown', ['The RustDesk version could not be read from rustdesk.exe.']);
  if ((compareVersion(rel, LAB_TESTED_MIN) ?? -1) < 0) {
    return out('upgrade_available', [
      `RustDesk ${rel} is older than the oldest lab-tested release (${LAB_TESTED_MIN}). It is not lab-tested — not known to be broken. Update RustDesk to a lab-tested release.`,
    ], false);
  }
  if ((compareVersion(rel, LAB_TESTED_MAX) ?? 1) > 0) {
    return out('unknown', [`RustDesk ${rel} is newer than the newest lab-tested release (${LAB_TESTED_MAX}). It will be judged once the Windows lab has run it.`], false);
  }
  const exact = (LAB_TESTED_RUSTDESK as readonly string[]).includes(rel);

  // 9. The preflight itself.
  if (pf.service !== 'running') {
    return out('unknown', [`The RustDesk service is ${pf.service === 'stopped' ? 'stopped' : 'not running normally'}, so whether the running server would take a change cannot be judged.`], exact);
  }
  if (pf.cli !== 'ok' || pf.keysOk !== PREFLIGHT_KEY_COUNT) {
    return out('unknown', [`RustDesk's command line answered ${pf.keysOk} of ${PREFLIGHT_KEY_COUNT} read-only checks${pf.cli === 'not_run' ? ' (they were not run)' : ''}. The agent tries again within 6 hours.`], exact);
  }

  // 10. Compatible — and still Legacy.
  return out('compatible', [
    `RustDesk ${rel} (Flutter build) runs as a service from Program Files\\RustDesk, and answered all ${PREFLIGHT_KEY_COUNT} read-only checks as SYSTEM.`,
    exact
      ? `RustDesk ${rel} is a lab-tested release.`
      : `RustDesk ${rel} is within the lab-tested range (${LAB_TESTED_MIN}–${LAB_TESTED_MAX}), though this exact release was not itself run in the lab.`,
    'Nothing has been changed: the computer stays in Legacy mode.',
  ], exact);
}
