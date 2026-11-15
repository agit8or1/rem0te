/**
 * Which agent a computer runs, sticky to signed (0.51) — the one rule the
 * heartbeat, the tray's identify, the Agent card and the Devices list share
 * (check-security-invariants §64).
 *
 * Why it is sticky. `updateChannel` used to be whatever the last
 * authenticated heartbeat said, and the signed install script's own
 * check-ins say nothing: `Register` (step 6) and the `Test-Registered` loop
 * (every 5 s for up to 90 s) send the device secret with no `updateChannel`,
 * and Test-Registered no `agentVersion` either. Each was recorded as a
 * standard agent — DS-HOME1 got a `standard_pre015` auto-update attempt
 * 36 seconds after every signed one — and while the computer read `legacy`
 * it was handed standard installs, the old migration again, and its signed
 * tray host was refused (`TRAY_KEY_REQUIRED`, DEWEY-WKS2022).
 *
 * The rule:
 *   - A computer runs the signed agent while an authenticated signed
 *     heartbeat was seen within SIGNED_STICKY_MS (`Endpoint.signedSeenAt`),
 *     or — before any is on record — while it reports `signed`.
 *   - On such a computer a heartbeat that does not say `signed` is a
 *     *legacy report*. It keeps liveness (and the RustDesk registration
 *     answer the installer waits for), and nothing else: it writes no agent
 *     field and is handed no install, reinstall, migration, auto-update,
 *     RustDesk update, rotation, command or action.
 *   - A legacy report that carries live state (a logged-on user or an uptime:
 *     what heartbeat.ps1 sends and the installers' check-ins never do) is a
 *     real standard heartbeat still running beside the signed one. It is
 *     recorded (`legacySeenAt`, audited once a day as
 *     AGENT_DUAL_REPORT) for the Agent card's warning, and answered with
 *     `retireStandard: true`.
 *   - The signed agent is gone, not sticky, once no signed heartbeat has
 *     come for SIGNED_STICKY_MS: a computer that really went back to the
 *     standard agent is treated as one again after that.
 */

/** How long one signed heartbeat keeps a computer signed. */
export const SIGNED_STICKY_MS = 7 * 24 * 3600_000;
/** How recent a legacy heartbeat must be for the Agent card to warn. */
export const DUAL_WARNING_MS = 24 * 3600_000;
/** At most one AGENT_DUAL_REPORT audit entry per computer per this long. */
export const DUAL_AUDIT_EVERY_MS = 24 * 3600_000;

export interface AgentIdentityFacts {
  updateChannel: string | null;
  signedSeenAt: Date | null;
}

/** Does this computer run the signed agent, by the sticky rule? */
export function runsSignedAgent(f: AgentIdentityFacts, now: Date = new Date()): boolean {
  if (f.signedSeenAt) return now.getTime() - f.signedSeenAt.getTime() < SIGNED_STICKY_MS;
  return f.updateChannel === 'signed';
}

export type HeartbeatKind =
  /** A heartbeat on the signed channel. */
  | 'signed'
  /** Not signed, on a computer that is not signed: an ordinary standard heartbeat. */
  | 'standard'
  /** Not signed, on a signed computer, carrying live state: a leftover standard heartbeat. */
  | 'legacy_on_signed'
  /** Not signed, on a signed computer, no live state: an installer's own check-in. */
  | 'installer_on_signed';

export interface HeartbeatShape {
  updateChannel?: string;
  loggedOnUser?: string;
  uptimeSeconds?: number;
}

/** What one authenticated heartbeat is, given the computer as it was before it. */
export function heartbeatKind(dto: HeartbeatShape, ep: AgentIdentityFacts, now: Date = new Date()): HeartbeatKind {
  if (dto.updateChannel === 'signed') return 'signed';
  if (!runsSignedAgent(ep, now)) return 'standard';
  return carriesLiveState(dto) ? 'legacy_on_signed' : 'installer_on_signed';
}

/**
 * heartbeat.ps1 (both variants) sends who is logged on and the uptime on
 * every beat; the installers' Register and Test-Registered check-ins, and the
 * Rem0teEnrollment retry, never do.
 */
export function carriesLiveState(dto: HeartbeatShape): boolean {
  return dto.loggedOnUser !== undefined || dto.uptimeSeconds !== undefined;
}

/**
 * An installer's own check-in: no live state (Register, Test-Registered, the
 * Rem0teEnrollment retry). It reads nothing in its answer but the RustDesk
 * registration, so it must not start an automatic update either: on DS-HOME1
 * each Test-Registered ping (no agent version before 0.51) was classed as a
 * 0.13–0.14 agent (`standard_pre015`) and started an attempt.
 */
export function isInstallerCheckIn(dto: HeartbeatShape & { agentVersion?: string }): boolean {
  return !carriesLiveState(dto) && dto.updateChannel !== 'signed';
}

/** Whether a heartbeat of this kind may write agent fields or be handed any update or work. */
export function heartbeatMayAct(kind: HeartbeatKind): boolean {
  return kind === 'signed' || kind === 'standard';
}

/** The Agent card's warning, or null. */
export function dualAgentWarning(
  f: AgentIdentityFacts & { legacySeenAt: Date | null; legacySeenVersion: string | null },
  now: Date = new Date(),
): { signedSeenAt: string; legacySeenAt: string; legacyVersion: string | null; text: string; fix: string; command: string } | null {
  if (!f.signedSeenAt || !f.legacySeenAt || !runsSignedAgent(f, now)) return null;
  if (now.getTime() - f.legacySeenAt.getTime() > DUAL_WARNING_MS) return null;
  const v = f.legacySeenVersion ? ` (version ${f.legacySeenVersion})` : '';
  const replaced = f.legacySeenAt.getTime() > f.signedSeenAt.getTime() + 10 * 60_000;
  return {
    signedSeenAt: f.signedSeenAt.toISOString(),
    legacySeenAt: f.legacySeenAt.toISOString(),
    legacyVersion: f.legacySeenVersion,
    text: `Two agents are reporting from this computer: the signed agent, and an old standard heartbeat${v}. Rem0te ignores the standard one: it changes nothing on this computer's record and is handed nothing to install.`,
    fix: replaced
      ? 'The standard heartbeat has taken the signed one\'s place on the computer. A standard heartbeat from 0.51 or later hands over to the signed agent by itself; an older one cannot be told to. Run this in an elevated PowerShell on the computer: the signed agent reinstalls its own heartbeat and removes the standard leftovers.'
      : 'The signed agent removes the standard leftovers each time it installs or updates (Update agent above) and each time its tray host starts. To do it now, run this in an elevated PowerShell on the computer:',
    command: STANDARD_RETIRE_COMMAND,
  };
}

/** What the card tells a person to run on the computer: the signed agent's own update, which rewrites the heartbeat and removes the standard leftovers. */
export const STANDARD_RETIRE_COMMAND = "& \"$env:ProgramFiles\\Rem0te\\rem0te-agent.exe\" update";
