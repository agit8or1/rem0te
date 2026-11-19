import { HEARTBEAT_STALE_MS } from '../common/connectivity';
import { isWindowsPlatform, osName } from '../common/platform';

/**
 * Managed Secure Access readiness (0.69, build step 2 of
 * docs/managed-secure-access.md): one pure function deciding each computer's
 * MSA state from facts already stored. It imports two constants-and-regex
 * modules and nothing that reads a database, a file or the network.
 *
 * READINESS ONLY. Managed Secure Access is not built: nothing here, or
 * anywhere in 0.69, changes a setting, a password or a session on any
 * computer. `managed`, `managed_verified` and `enforcement_failure` are in
 * the type so the console and the API speak the design's whole vocabulary,
 * and NOTHING can produce them yet: `decideReadiness` returns only
 * PRODUCIBLE_STATES, and unit-msa-readiness.mjs and check-security-invariants
 * (§80) assert it. A saved or assumed state is never shown as verified:
 * `verified` is the literal `false` on every answer.
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
 */

export const MSA_STATES = [
  'unsupported',
  'upgrade_available',
  'compatible',
  'unknown',
  // Later build steps (grants, enforcement, readback). Not producible in 0.69.
  'managed',
  'managed_verified',
  'enforcement_failure',
] as const;
export type MsaState = (typeof MSA_STATES)[number];

/** The only states decideReadiness can return in this release. */
export const PRODUCIBLE_STATES = ['unsupported', 'upgrade_available', 'compatible', 'unknown'] as const satisfies readonly MsaState[];
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

export interface ReadinessFacts {
  platform: string | null;
  /** runsSignedAgent(...) — computed by the caller from stored facts. */
  signedAgent: boolean;
  agentVersion: string | null;
  isOnline: boolean;
  lastSeenAt: Date | string | null;
  preflight: PreflightFacts | null;
}

export interface Readiness {
  state: ProducibleState;
  label: string;
  /** Plain sentences, the deciding one first. */
  reasons: string[];
  /** Always false: readiness is a report, never verified enforcement. */
  verified: false;
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
    state, label: STATE_LABEL[state], reasons, verified: false, checkedAt, rustdeskVersion: rd, labTested,
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
