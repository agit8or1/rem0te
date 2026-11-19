import { runsSignedAgent } from './agent-identity';

/**
 * What the console says about a computer's agent version (0.70.1). Display
 * only: nothing here decides an update.
 *
 * Why it exists. The signed agent's binary is built reproducibly and does not
 * embed a version, so a release that changes nothing on the agent publishes
 * the same bytes under a new label: `windows/rem0te-agent.exe` was
 * byte-identical from 0.63.0 through 0.68.3, and only the targets metadata's
 * `custom.version` moved. `Endpoint.agentVersion` is the label the computer
 * recorded at its last once-a-day update check. Automatic update compares the
 * reported `agentSha256` with the published target (schedule.ts `isBehind`),
 * so it rightly dispatched nothing — but the console showed the recorded
 * labels, and a fleet that was entirely current read as 0.64.0, 0.67.0,
 * 0.67.0 and 0.68.0.
 *
 * The rule, which is the same comparison `isBehind` makes for the signed
 * channel:
 *   - a signed agent whose build hash is the published target's is current,
 *     and shows the published release's version (the recorded label stays
 *     available as `recorded`);
 *   - a signed agent on another build is not current, and shows what it
 *     recorded;
 *   - with no published target, no reported build, or any other agent
 *     (standard Windows, Linux, macOS), nothing changes: the recorded label,
 *     current unknown.
 *
 * Pure: no imports but the identity rule, so it can be unit tested from dist.
 */

/** The published signed agent: the target's sha256 and its `custom.version`, when that is a dotted number. */
export interface ServedAgentBuild { sha256: string; version: string | null }

export interface AgentVersionFacts {
  updateChannel: string | null;
  agentVersion: string | null;
  agentSha256: string | null;
  /** When known, the sticky signed rule (§64) decides "signed"; otherwise the channel does. */
  signedSeenAt?: Date | null;
}

export type AgentVersionReason =
  /** Signed, and the build hash is the published target's. */
  | 'same_build'
  /** Signed, on another build: an update is due. */
  | 'different_build'
  /** Signed, but no signed agent is published to compare against. */
  | 'no_published_build'
  /** Signed, but the agent has not reported its build hash. */
  | 'no_build_reported'
  /** Not the signed agent: the recorded label is the version. */
  | 'not_signed';

export interface AgentVersionView {
  /** What to show as the agent's version. */
  label: string | null;
  /** `Endpoint.agentVersion`, unchanged. */
  recorded: string | null;
  /** true / false for a signed agent compared with the published build; null when it cannot be told. */
  current: boolean | null;
  reason: AgentVersionReason;
  /** One sentence for a tooltip or a card, or null when there is nothing to add. */
  detail: string | null;
}

/** A dotted number of one to four parts, as the release tool records it. Split rather than one regex (detect-unsafe-regex). */
const isDotted = (v: string): boolean => {
  const parts = v.split('.');
  return parts.length <= 4 && parts.every((p) => /^[0-9]{1,6}$/.test(p));
};
const SHA_RE = /^[0-9a-f]{64}$/;

/** The `custom.version` a release recorded for the agent target, if it is a dotted number. */
export function servedVersionOf(custom: unknown): string | null {
  const v = custom && typeof custom === 'object' ? (custom as Record<string, unknown>).version : null;
  return typeof v === 'string' && isDotted(v) ? v : null;
}

export function agentVersionView(f: AgentVersionFacts, served: ServedAgentBuild | null, now: Date = new Date()): AgentVersionView {
  const recorded = f.agentVersion ?? null;
  const base = { label: recorded, recorded, current: null, detail: null } as const;
  const signed = runsSignedAgent({ updateChannel: f.updateChannel, signedSeenAt: f.signedSeenAt ?? null }, now);
  if (!signed) return { ...base, reason: 'not_signed' };
  if (!served || !SHA_RE.test(served.sha256)) return { ...base, reason: 'no_published_build' };
  if (!f.agentSha256) return { ...base, reason: 'no_build_reported' };
  const v = served.version && isDotted(served.version) ? served.version : null;
  if (f.agentSha256.toLowerCase() === served.sha256) {
    const label = v ?? recorded;
    const detail = v && recorded && recorded !== v
      ? `Runs the published agent (${v}). It last recorded ${recorded} at its daily update check; the agent binary has not changed since, so it is the same agent.`
      : `Runs the published agent${v ? ` (${v})` : ''}.`;
    return { label, recorded, current: true, reason: 'same_build', detail };
  }
  return {
    label: recorded, recorded, current: false, reason: 'different_build',
    detail: `Not the published agent${v ? ` (${v})` : ''}: an update is due.`,
  };
}
