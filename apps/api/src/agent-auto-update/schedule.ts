import { z } from 'zod';
import { compareVersions } from '../common/agent-contract';
import { isWindowsPlatform, readOnlyAgentOs } from '../common/platform';

/**
 * Automatic agent self-update (0.36): the pure decisions, so the heartbeat,
 * the Agent card and the settings page cannot each grow their own idea of
 * them, and scripts/unit-agent-auto-update.mjs tests them without a database.
 *
 * What "outdated" means, per agent:
 *   - standard Windows agent: its reported agentVersion is older than the
 *     platform version this server bakes into a fresh installer
 *     (version.json). An agent that reports no version at all but holds a
 *     device secret is a 0.13–0.14 install (device secrets arrived in 0.13.0,
 *     version reporting in 0.15.0): outdated by definition.
 *   - signed agent: its reported build SHA-256 is not the build the signed
 *     repository publishes. No published build means "cannot tell".
 *   - Linux and macOS agents are read-only by design (security invariants
 *     §24, §32): they act on nothing the server sends, so they are never
 *     updated from here — the card gives the command to run on the computer.
 *
 * How it is asked: the heartbeat response carries the flag that agent
 * already acts on — `reinstallAgent` (0.15.0 and later; a signed agent runs
 * `rem0te-agent.exe update`), or `updateRustdesk` for a 0.13–0.14 agent,
 * whose heartbeat re-runs the installer on that flag alone. Both pass
 * through every agent's own 30-minute floor between installer runs.
 *
 * Bounded three ways, so a release never turns into a download loop:
 *   - an attempt hands the flag out for ATTEMPT_WINDOW_MS (20 min), shorter
 *     than the agent's own 30-minute floor, so one attempt is at most one
 *     installer run;
 *   - attempts at one target are spaced by `backoffMs` and capped at the
 *     platform's maxAttempts (default 3); after the last one the computer is
 *     shown failing and is not asked again until the target changes or
 *     someone clicks Update agent;
 *   - attempts started across the whole fleet are capped per hour (the
 *     service counts AgentAutoUpdateAttempt rows under an advisory lock, so
 *     the cap holds across API processes).
 */

export type AgentMode = 'ANY_TIME' | 'WINDOW' | 'OFF';
export const AGENT_MODES: readonly AgentMode[] = ['ANY_TIME', 'WINDOW', 'OFF'];
export const DEFAULT_MODE: AgentMode = 'ANY_TIME';

const MIN = 60_000;
const H = 60 * MIN;
/** How long one attempt keeps handing out the flag. Under the agent's 30-minute floor: one attempt, at most one run. */
export const ATTEMPT_WINDOW_MS = 20 * MIN;
/** After an attempt's window, how long the install has to report the new version before it counts as not having worked. */
export const VERIFY_GRACE_MS = 60 * MIN;
/** Minimum spacing between two attempts at the same target, from the earlier one's dispatch. Index = attempts made. */
export const BACKOFF_MS = [0, 2 * H, 8 * H, 24 * H] as const;
export function backoffMs(attemptsMade: number): number {
  return BACKOFF_MS[Math.min(Math.max(attemptsMade, 0), BACKOFF_MS.length - 1)];
}

export const PER_HOUR_MIN = 1;
export const PER_HOUR_MAX = 2000;
export const ATTEMPTS_MIN = 1;
export const ATTEMPTS_MAX = 10;

export interface AgentAutoSettings {
  enabled: boolean;
  perHour: number;
  maxAttempts: number;
  /** AGENT_AUTO_UPDATE=off in this API process. */
  processOn: boolean;
}

export function settingsFrom(
  row: { agentAutoUpdateEnabled?: boolean | null; agentAutoUpdatePerHour?: number | null; agentAutoUpdateMaxAttempts?: number | null } | null,
  env: Record<string, string | undefined> = process.env,
): AgentAutoSettings {
  const clamp = (v: number | null | undefined, lo: number, hi: number, d: number) => (Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi ? (v as number) : d);
  return {
    enabled: row?.agentAutoUpdateEnabled ?? true,
    perHour: clamp(row?.agentAutoUpdatePerHour, PER_HOUR_MIN, PER_HOUR_MAX, 120),
    maxAttempts: clamp(row?.agentAutoUpdateMaxAttempts, ATTEMPTS_MIN, ATTEMPTS_MAX, 3),
    processOn: env.AGENT_AUTO_UPDATE !== 'off',
  };
}

export const SettingsUpdate = z.object({
  enabled: z.boolean().optional(),
  perHour: z.number().int().min(PER_HOUR_MIN).max(PER_HOUR_MAX).optional(),
  maxAttempts: z.number().int().min(ATTEMPTS_MIN).max(ATTEMPTS_MAX).optional(),
}).strict();
export type SettingsUpdate = z.infer<typeof SettingsUpdate>;

/** Validate a settings change; throws an Error whose message is fit for a 400. */
export function parseSettingsUpdate(raw: unknown): SettingsUpdate {
  const p = SettingsUpdate.safeParse(raw ?? {});
  if (!p.success) throw new Error(p.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  if (!Object.keys(p.data).length) throw new Error('Nothing to change: give enabled, perHour or maxAttempts.');
  return p.data;
}

// ── Which agent, and is it behind ───────────────────────────────────────────

/** standard_pre015: 0.13–0.14, asked through `updateRustdesk` (it predates `reinstallAgent`). */
export type AgentChannel = 'standard' | 'standard_pre015' | 'signed';

export interface AgentFacts {
  platform: string | null;
  updateChannel: string | null;
  agentVersion: string | null;
  agentSha256: string | null;
  hasSecret: boolean;
}

/** Which update path this computer's agent has, or why it has none here. */
export function agentChannel(f: AgentFacts): { channel: AgentChannel } | { none: 'read_only_agent' | 'not_windows' | 'no_device_secret' } {
  if (readOnlyAgentOs(f.platform)) return { none: 'read_only_agent' };
  if (!isWindowsPlatform(f.platform) && f.updateChannel !== 'signed') return { none: 'not_windows' };
  // Without a device secret nothing the computer says is believed and nothing
  // is handed to it: only a claim (an enrolment token) can bind one.
  if (!f.hasSecret) return { none: 'no_device_secret' };
  if (f.updateChannel === 'signed') return { channel: 'signed' };
  return { channel: f.agentVersion ? 'standard' : 'standard_pre015' };
}

export interface Served {
  /** The platform version a fresh standard installer reports ('unknown' when version.json cannot be read). */
  version: string;
  /** The signed agent build the signed repository publishes, or null. */
  signedSha256: string | null;
}

/** 2–4 dot-separated numeric parts of at most six digits (no regex: the linter refuses nested quantifiers). */
function isPlatformVersion(v: string): boolean {
  const parts = v.split('.');
  return parts.length >= 2 && parts.length <= 4 && parts.every((p) => /^[0-9]{1,6}$/.test(p));
}

/** What this channel updates TO, or null when the server cannot say. */
export function targetFor(channel: AgentChannel, served: Served): string | null {
  if (channel === 'signed') return served.signedSha256 && /^[0-9a-f]{64}$/.test(served.signedSha256) ? served.signedSha256 : null;
  return isPlatformVersion(served.version) ? served.version : null;
}

/** Is the agent behind `target`? Null: cannot tell. */
export function isBehind(channel: AgentChannel, f: Pick<AgentFacts, 'agentVersion' | 'agentSha256'>, target: string | null): boolean | null {
  if (!target) return null;
  if (channel === 'signed') return f.agentSha256 ? f.agentSha256 !== target : null;
  if (channel === 'standard_pre015') return true;
  if (!f.agentVersion || !/^[0-9]/.test(f.agentVersion)) return null;
  return compareVersions(f.agentVersion, target) < 0;
}

/** The heartbeat flag that this channel acts on. */
export function flagFor(channel: AgentChannel): 'reinstallAgent' | 'updateRustdesk' {
  return channel === 'standard_pre015' ? 'updateRustdesk' : 'reinstallAgent';
}

// ── Which mode governs ──────────────────────────────────────────────────────

export interface ModePolicy {
  id: string;
  scope: 'business' | 'site' | 'group';
  agentMode: AgentMode | null;
  skipLoggedOnUser: boolean;
}

/**
 * The agent mode for a computer, from its client-update policies in
 * precedence order (most specific first, as group-policy/precedence.ts ranks
 * them): the first one that sets a mode decides; one that leaves it unset
 * passes to the next. None set: the platform default, any time.
 */
export function resolveMode<P extends ModePolicy>(ranked: P[]): { mode: AgentMode; policy: P | null } {
  const p = ranked.find((x) => x.agentMode !== null && x.agentMode !== undefined) ?? null;
  return { mode: p ? (p.agentMode as AgentMode) : DEFAULT_MODE, policy: p };
}

// ── The decision ────────────────────────────────────────────────────────────

export type AutoState = 'up_to_date' | 'queued' | 'updating' | 'failing' | 'opted_out' | 'manual' | 'unknown';

export type Reason =
  // manual
  | 'read_only_agent' | 'not_windows' | 'no_device_secret' | 'signed_only'
  // unknown
  | 'archived' | 'no_target' | 'version_unparsed' | 'no_signed_build_reported'
  // opted out
  | 'platform_off' | 'process_off' | 'policy_off'
  // queued (held)
  | 'paused' | 'rollout' | 'pending_request' | 'portal_migration' | 'outside_window' | 'session_open' | 'user_logged_on' | 'user_unknown'
  | 'backoff' | 'pacing' | 'next_heartbeat'
  // updating / failing / current
  | 'attempt_open' | 'verifying' | 'attempts_exhausted' | 'current';

export interface DecideInput {
  now: Date;
  settings: AgentAutoSettings;
  archived: boolean;
  facts: AgentFacts;
  served: Served;
  /** UpdateTrustService.gateForHeartbeat for this channel. */
  gate: 'pass' | 'withhold' | 'migrate';
  mode: AgentMode;
  /** WINDOW mode: is the governing policy's window open now. */
  windowOpen: boolean;
  /** The governing policy skips computers with someone logged on (WINDOW mode only). */
  skipLoggedOnUser: boolean;
  /** An "updates" containment pause covers this computer. */
  paused: boolean;
  /** A staged rollout owns this computer's updates. */
  rollout: boolean;
  /** Something else is about to re-run the installer here: a queued RustDesk update, Reinstall/Update agent, a signed-agent migration. */
  pendingRequest: boolean;
  sessionOpen: boolean;
  /** '' nobody, a name, or undefined when the agent does not say. */
  loggedOnUser: string | null | undefined;
  /** The node's state, already reset by the caller when the target changed. */
  attempts: number;
  lastAt: Date | null;
}

export interface Decision {
  state: AutoState;
  reason: Reason;
  /** 'resend': hand the flag out again inside the current attempt; 'new': start an attempt (if the pace allows). */
  dispatch: 'resend' | 'new' | null;
  channel: AgentChannel | null;
  target: string | null;
  /** When something changes by itself: the next attempt, the end of the verification grace. */
  nextAt: Date | null;
}

/** The node state that counts for `target`: a different target starts from zero. */
export function attemptsFor(node: { agentAutoTarget: string | null; agentAutoAttempts: number; agentAutoLastAt: Date | null }, target: string | null) {
  return node.agentAutoTarget && node.agentAutoTarget === target
    ? { attempts: node.agentAutoAttempts, lastAt: node.agentAutoLastAt }
    : { attempts: 0, lastAt: null };
}

export function decide(i: DecideInput): Decision {
  const ch = agentChannel(i.facts);
  const out = (state: AutoState, reason: Reason, extra: Partial<Decision> = {}): Decision => ({
    state, reason, dispatch: null, channel: 'channel' in ch ? ch.channel : null, target: null, nextAt: null, ...extra,
  });
  if (i.archived) return out('unknown', 'archived');
  if ('none' in ch) return out('manual', ch.none);
  const channel = ch.channel;
  const target = targetFor(channel, i.served);
  const behind = isBehind(channel, i.facts, target);
  if (behind === null) {
    return out('unknown', !target ? 'no_target' : channel === 'signed' ? 'no_signed_build_reported' : 'version_unparsed');
  }
  if (!behind) return out('up_to_date', 'current', { target });
  const t = { target };
  if (!i.settings.enabled) return out('opted_out', 'platform_off', t);
  if (!i.settings.processOn) return out('opted_out', 'process_off', t);
  if (i.mode === 'OFF') return out('opted_out', 'policy_off', t);
  // A standard agent in Signed only is handed nothing to run; with portal
  // migration on, every heartbeat already hands it the migration instead.
  if (channel !== 'signed' && i.gate === 'withhold') return out('manual', 'signed_only', t);
  if (channel !== 'signed' && i.gate === 'migrate') return out('queued', 'portal_migration', t);

  const now = i.now.getTime();
  const last = i.lastAt?.getTime() ?? null;
  const inAttempt = last !== null && now - last < ATTEMPT_WINDOW_MS;
  const verifyEnd = last !== null ? last + ATTEMPT_WINDOW_MS + VERIFY_GRACE_MS : null;

  if (i.attempts >= i.settings.maxAttempts && !inAttempt) {
    if (verifyEnd !== null && now < verifyEnd) return out('updating', 'verifying', { ...t, nextAt: new Date(verifyEnd) });
    return out('failing', 'attempts_exhausted', t);
  }
  // Holds: nothing goes out while any of these is true, a resend included.
  if (i.paused) return out('queued', 'paused', t);
  if (i.rollout) return out('queued', 'rollout', t);
  if (i.pendingRequest) return out('queued', 'pending_request', t);
  if (i.mode === 'WINDOW' && !i.windowOpen) return out('queued', 'outside_window', t);
  // The install restarts RustDesk, which ends a remote session: never during one.
  if (i.sessionOpen) return out('queued', 'session_open', t);
  if (i.mode === 'WINDOW' && i.skipLoggedOnUser) {
    if (i.loggedOnUser === undefined || i.loggedOnUser === null) return out('queued', 'user_unknown', t);
    if (i.loggedOnUser.trim()) return out('queued', 'user_logged_on', t);
  }
  if (inAttempt) return out('updating', 'attempt_open', { ...t, dispatch: 'resend', nextAt: new Date(last! + ATTEMPT_WINDOW_MS) });
  if (verifyEnd !== null && now < verifyEnd) return out('updating', 'verifying', { ...t, nextAt: new Date(verifyEnd) });
  const due = last === null ? now : last + backoffMs(i.attempts);
  if (now < due) return out('queued', 'backoff', { ...t, nextAt: new Date(due) });
  return out('queued', 'next_heartbeat', { ...t, dispatch: 'new' });
}

/**
 * Should a signed agent run its own periodic update check now (0.36, the
 * signed heartbeat's jittered daily check)? The same opt-outs and holds as a
 * server-started attempt, minus the version comparison: the check is how a
 * signed agent learns of a build the portal has not been told about. The
 * signed pause is enforced again by `rem0te-agent.exe update` itself.
 */
export function selfCheckAllowed(i: Pick<DecideInput, 'settings' | 'mode' | 'windowOpen' | 'paused' | 'rollout' | 'sessionOpen'>): boolean {
  return i.settings.enabled && i.settings.processOn && i.mode !== 'OFF' && !(i.mode === 'WINDOW' && !i.windowOpen) && !i.paused && !i.rollout && !i.sessionOpen;
}

export const REASON_TEXT: Record<Reason, string> = {
  read_only_agent: 'The Linux and macOS agents act on nothing the server sends, so they are never updated from here. Re-run the installer on the computer.',
  not_windows: 'Not a Windows agent the server can update.',
  no_device_secret: 'This computer has never authenticated with a device secret (an agent older than 0.13.0), so the server cannot ask it for anything. Re-run the installer with an enrolment token from Add device.',
  signed_only: 'This portal is in Signed only, which hands standard agents nothing to run. Upgrade it to the signed agent (rem0te-agent.exe migrate, locally or through GPO/Intune).',
  archived: 'Archived: nothing is sent to an archived computer.',
  no_target: 'The server cannot say what to update to (no readable version.json, or no signed build published).',
  version_unparsed: 'The agent reports a version that is not a dotted number, so it cannot be compared.',
  no_signed_build_reported: 'The signed agent has not reported which build it runs.',
  platform_off: 'Automatic agent updates are off for the whole platform (Settings → Client updates).',
  process_off: 'Automatic agent updates are turned off on this server (AGENT_AUTO_UPDATE=off).',
  policy_off: 'This computer’s update policy opts out of automatic agent updates.',
  paused: 'Updates are paused (containment) for this business or everywhere.',
  rollout: 'A staged rollout owns this computer’s updates.',
  pending_request: 'Another request that re-runs the installer is already queued here (a RustDesk client update, Update agent, or an upgrade to the signed agent); it updates the agent too.',
  portal_migration: 'This portal hands standard agents the migration to the signed agent on every check-in (Signed only + portal migration).',
  outside_window: 'Waiting for the update window of the policy that governs it.',
  session_open: 'A remote session is open on it; the install restarts RustDesk, so it waits.',
  user_logged_on: 'Someone is logged on, and its policy skips computers with a user.',
  user_unknown: 'Its agent does not report who is logged on, and its policy skips computers with a user.',
  backoff: 'The last attempt did not update it; the next one is spaced out.',
  pacing: 'Waiting its turn: the platform starts at most a set number of agent updates an hour.',
  next_heartbeat: 'Goes on its next check-in.',
  attempt_open: 'Asked to update; re-running the installer.',
  verifying: 'Asked to update; waiting for it to report the new version.',
  attempts_exhausted: 'It did not reach the new version after every attempt, so it is not asked again until the next release or someone clicks Update agent.',
  current: 'Runs what this server serves.',
};
