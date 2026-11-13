import { z } from 'zod';

/**
 * Automatic migration to the signed agent (0.37): the pure rules, so the
 * sweep, the Full agent page and scripts/unit-auto-migration.mjs cannot each
 * grow their own idea of them.
 *
 * What it does. Once a signed agent is published (the signed repository lists
 * windows/rem0te-agent.exe) and the portal is not in Signed only, standard
 * Windows agents are moved to it without anyone pressing Upgrade:
 *
 *   choosing_canary  one eligible computer is picked — reporting now, most
 *                    recently heard from — and an ordinary 0.34 per-computer
 *                    migration request is made for it (AgentMigration, the
 *                    same nonce flow and the same fixed script), automatic,
 *                    with no requester;
 *   canary           waiting for it to report the signed channel on exactly
 *                    the published build (its digest). Not within
 *                    CANARY_CONFIRM_MS (2 hours, the same as a request's
 *                    "Not confirmed"), or a failed update result, or the
 *                    request cancelled by a person: HALTED;
 *   soaking          it has; it must keep reporting that build for the soak
 *                    (15–1440 minutes, default 60) with no failed update
 *                    result, and check in after the soak ends. Anything else:
 *                    HALTED. Never "moves on" by default;
 *   rolling          the rest, paced by the 0.36 automatic-update pace (the
 *                    same per-hour number), each through the same
 *                    precondition function as a person's request
 *                    (migrationBlock), skipping an updates pause, a staged
 *                    rollout, an opt-out and a computer that is not
 *                    reporting;
 *   halted           with its reason, until a Platform Admin resumes it (the
 *                    same canary, timers from now) or restarts it with
 *                    another canary — both with fresh authentication.
 *
 * One rollout per published build. A new build starts a new rollout (a new
 * canary) for the computers still on the standard agent; computers already on
 * the signed agent are never migrated again — they update themselves through
 * 0.36's automatic updates.
 *
 * Nothing here adds a way to run code on a computer: the only effect of any
 * state is an AgentMigration row, which the heartbeat hands out exactly as it
 * hands out a person's.
 */

export type AutoMigrationMode = 'off' | 'canary_then_all';
export const AUTO_MIGRATION_MODES: readonly AutoMigrationMode[] = ['off', 'canary_then_all'];
export const DEFAULT_AUTO_MIGRATION_MODE: AutoMigrationMode = 'canary_then_all';

export const SOAK_MIN = 15;
export const SOAK_MAX = 1440;
export const SOAK_DEFAULT = 60;

const MIN = 60_000;
const H = 60 * MIN;
/** The canary must report the published build within this of being asked (agent-migration.ts NOT_CONFIRMED_AFTER_MS). */
export const CANARY_CONFIRM_MS = 2 * H;
/** After the soak ends, the canary must check in (still on the build) within this, or the rollout halts. */
export const CANARY_REPORT_GRACE_MS = 2 * H;
/** At most this many automatic requests are made in one sweep tick, whatever the pace leaves. */
export const BATCH_PER_TICK = 50;

export type RolloutState = 'choosing_canary' | 'canary' | 'soaking' | 'rolling' | 'halted';
export const ROLLOUT_STATES: readonly RolloutState[] = ['choosing_canary', 'canary', 'soaking', 'rolling', 'halted'];

export interface AutoMigrationSettings {
  mode: AutoMigrationMode;
  soakMinutes: number;
  /** AUTO_MIGRATION_SWEEP=off in this API process. */
  processOn: boolean;
}

export function settingsFrom(
  row: { agentAutoMigrationMode?: string | null; agentAutoMigrationSoakMinutes?: number | null } | null,
  env: Record<string, string | undefined> = process.env,
): AutoMigrationSettings {
  const mode = (AUTO_MIGRATION_MODES as readonly string[]).includes(row?.agentAutoMigrationMode ?? '')
    ? (row!.agentAutoMigrationMode as AutoMigrationMode) : DEFAULT_AUTO_MIGRATION_MODE;
  const s = row?.agentAutoMigrationSoakMinutes;
  return {
    mode,
    soakMinutes: Number.isInteger(s) && (s as number) >= SOAK_MIN && (s as number) <= SOAK_MAX ? (s as number) : SOAK_DEFAULT,
    processOn: env.AUTO_MIGRATION_SWEEP !== 'off',
  };
}

export const SettingsUpdate = z.object({
  mode: z.enum(['off', 'canary_then_all']).optional(),
  soakMinutes: z.number().int().min(SOAK_MIN).max(SOAK_MAX).optional(),
}).strict();
export type SettingsUpdate = z.infer<typeof SettingsUpdate>;

/** Validate a settings change; throws an Error whose message is fit for a 400. */
export function parseSettingsUpdate(raw: unknown): SettingsUpdate {
  const p = SettingsUpdate.safeParse(raw ?? {});
  if (!p.success) throw new Error(p.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  if (!Object.keys(p.data).length) throw new Error('Nothing to change: give mode or soakMinutes.');
  return p.data;
}

/**
 * Does this change widen what the sweep does? Turning it on, or shortening
 * the soak while it is on, needs fresh authentication; turning it off, or
 * lengthening the soak, never does — stopping must always be easy.
 */
export function isWidening(before: Pick<AutoMigrationSettings, 'mode' | 'soakMinutes'>, after: Pick<AutoMigrationSettings, 'mode' | 'soakMinutes'>): boolean {
  if (after.mode === 'off') return false;
  if (before.mode === 'off') return true;
  return after.soakMinutes < before.soakMinutes;
}

// ── Update results ──────────────────────────────────────────────────────────

/**
 * Is an agent-status.json lastResult (agent.go writeStatus) a failure? The
 * agent writes `installer exit <n>`, `installer failed: …`,
 * `metadata-refused: …` or `paused: …` (plus a tray note). A signed pause is
 * not a failure of the build; anything that is not a clean exit 0 is.
 */
export function updateResultFailed(result: string | null | undefined): boolean {
  if (!result) return false;
  const r = result.trim();
  if (/^paused:/i.test(r)) return false;
  if (/^installer exit 0(?![0-9])/.test(r)) return false;
  return /^(installer exit [0-9]|installer failed|metadata-refused)/i.test(r);
}

// ── The gate: may the sweep do anything at all ──────────────────────────────

export type GateReason = 'mode_off' | 'process_off' | 'no_repository' | 'no_release' | 'signed_only';

export interface GateInput {
  settings: AutoMigrationSettings;
  repoConfigured: boolean;
  publishedSha256: string | null;
  trustMode: 'legacy_allowed' | 'signed_only';
}

/**
 * Null when the sweep may run. In Signed only it does nothing at all: with
 * portal migration on, every standard agent is already handed the migration
 * on each check-in; without it, the portal hands standard agents nothing to
 * run, which is exactly what a per-computer migration is refused for
 * (agent-migration.ts, SIGNED_ONLY).
 */
export function gate(i: GateInput): GateReason | null {
  if (i.settings.mode === 'off') return 'mode_off';
  if (!i.settings.processOn) return 'process_off';
  if (!i.repoConfigured) return 'no_repository';
  if (!i.publishedSha256 || !/^[0-9a-f]{64}$/.test(i.publishedSha256)) return 'no_release';
  if (i.trustMode === 'signed_only') return 'signed_only';
  return null;
}

export const GATE_TEXT: Record<GateReason, string> = {
  mode_off: 'Automatic migration is off. Computers move only when someone presses Upgrade to full agent.',
  process_off: 'Automatic migration is turned off on this server (AUTO_MIGRATION_SWEEP=off).',
  no_repository: 'Waiting for step 1: this server has no signed update repository.',
  no_release: 'Waiting for step 2: no signed agent is published.',
  signed_only: 'The portal is in Signed only, so nothing is migrated from here (with portal migration on, every standard agent is already handed the migration).',
};

// ── One rollout's next step ─────────────────────────────────────────────────

export interface RolloutRow {
  state: RolloutState;
  targetSha256: string;
  canaryEndpointId: string | null;
  canaryRequestedAt: Date | null;
  canaryConfirmedAt: Date | null;
}

export interface CanaryFacts {
  /** Null: the computer no longer exists, or is archived. */
  exists: boolean;
  updateChannel: string | null;
  agentSha256: string | null;
  lastSeenAt: Date | null;
  agentUpdateCheckedAt: Date | null;
  agentUpdateResult: string | null;
  /** The canary's request: cancelled by a person (cancelledById set)? */
  requestCancelledByPerson: boolean;
}

export type HaltCode = 'canary_not_confirmed' | 'canary_failed' | 'canary_left_build' | 'canary_silent' | 'canary_cancelled' | 'canary_gone';

export type Step =
  | { do: 'choose_canary' }
  | { do: 'wait'; until: Date | null; text: string }
  | { do: 'confirm' }
  | { do: 'start_rolling' }
  | { do: 'migrate_rest' }
  | { do: 'halt'; code: HaltCode; reason: string }
  | { do: 'none' };

export const onBuild = (f: Pick<CanaryFacts, 'updateChannel' | 'agentSha256'>, sha: string) => f.updateChannel === 'signed' && f.agentSha256 === sha;

/** A failed update result reported after `since`. */
const failedSince = (f: CanaryFacts, since: Date | null) =>
  !!f.agentUpdateCheckedAt && (!since || f.agentUpdateCheckedAt.getTime() >= since.getTime()) && updateResultFailed(f.agentUpdateResult);

/**
 * What the sweep does next for one rollout. Pure: the caller loads the row
 * and the canary's facts and applies the step. Every path that is not "the
 * canary did exactly what was expected" either waits or halts; none moves on.
 */
export function nextStep(r: RolloutRow, canary: CanaryFacts | null, now: Date, soakMinutes: number): Step {
  const t = now.getTime();
  switch (r.state) {
    case 'halted':
      return { do: 'none' };
    case 'rolling':
      return { do: 'migrate_rest' };
    case 'choosing_canary':
      return { do: 'choose_canary' };
    case 'canary': {
      if (!canary || !canary.exists) return { do: 'halt', code: 'canary_gone', reason: 'The canary computer was removed or archived before it reported the signed agent.' };
      if (canary.requestCancelledByPerson) return { do: 'halt', code: 'canary_cancelled', reason: 'Someone cancelled the canary\'s migration request.' };
      if (onBuild(canary, r.targetSha256)) return { do: 'confirm' };
      if (failedSince(canary, r.canaryRequestedAt)) {
        return { do: 'halt', code: 'canary_failed', reason: `The canary reported a failed update: ${canary.agentUpdateResult}` };
      }
      const asked = r.canaryRequestedAt?.getTime() ?? t;
      if (t - asked > CANARY_CONFIRM_MS) {
        return {
          do: 'halt', code: 'canary_not_confirmed',
          reason: canary.updateChannel === 'signed'
            ? 'The canary moved to the signed agent but did not report the published build within 2 hours of being asked.'
            : 'The canary did not report the signed agent within 2 hours of being asked. The standard agent does not report the migration script\'s exit code; run rem0te-agent.exe status on it.',
        };
      }
      return { do: 'wait', until: new Date(asked + CANARY_CONFIRM_MS), text: 'Waiting for the canary to report the signed agent on the published build.' };
    }
    case 'soaking': {
      if (!canary || !canary.exists) return { do: 'halt', code: 'canary_gone', reason: 'The canary computer was removed or archived during the soak.' };
      if (!onBuild(canary, r.targetSha256)) {
        return { do: 'halt', code: 'canary_left_build', reason: 'The canary stopped reporting the published signed build during the soak.' };
      }
      if (failedSince(canary, r.canaryConfirmedAt)) {
        return { do: 'halt', code: 'canary_failed', reason: `The canary reported a failed update during the soak: ${canary.agentUpdateResult}` };
      }
      const end = (r.canaryConfirmedAt?.getTime() ?? t) + soakMinutes * MIN;
      if (t < end) return { do: 'wait', until: new Date(end), text: 'The canary runs the published build; soaking.' };
      if (canary.lastSeenAt && canary.lastSeenAt.getTime() >= end) return { do: 'start_rolling' };
      if (t - end > CANARY_REPORT_GRACE_MS) {
        return { do: 'halt', code: 'canary_silent', reason: 'The canary has not checked in since the soak ended, so it is not known to be still working.' };
      }
      return { do: 'wait', until: new Date(end + CANARY_REPORT_GRACE_MS), text: 'The soak is over; waiting for the canary to check in once more.' };
    }
    default:
      return { do: 'none' };
  }
}

// ── Picking computers ───────────────────────────────────────────────────────

export interface Candidate {
  id: string;
  isOnline: boolean;
  lastSeenAt: Date | null;
}

/**
 * Order the canary candidates: reporting now (online, heard from inside the
 * heartbeat window) only, most recently heard from first, never one already
 * tried. A computer that is not reporting would only run out the 2-hour
 * clock, so it is not picked at all.
 */
export function canaryOrder<C extends Candidate>(cands: C[], rejected: readonly string[], now: Date, staleMs: number): C[] {
  const rej = new Set(rejected);
  return cands
    .filter((c) => !rej.has(c.id) && reporting(c, now, staleMs))
    .sort((a, b) => (b.lastSeenAt?.getTime() ?? 0) - (a.lastSeenAt?.getTime() ?? 0) || a.id.localeCompare(b.id));
}

export const reporting = (c: Candidate, now: Date, staleMs: number) =>
  c.isOnline && !!c.lastSeenAt && now.getTime() - c.lastSeenAt.getTime() <= staleMs;

/** How many requests this tick may make: the hour's pace less what it used, and never more than a batch. */
export function budget(perHour: number, usedLastHour: number): number {
  return Math.max(0, Math.min(BATCH_PER_TICK, perHour - usedLastHour));
}

// ── What the page says ──────────────────────────────────────────────────────

export const STATE_TEXT: Record<RolloutState, string> = {
  choosing_canary: 'Choosing a canary: waiting for an eligible standard Windows computer that is checking in.',
  canary: 'Canary asked to move; waiting for it to report the signed agent on the published build.',
  soaking: 'The canary runs the published build; soaking before the rest move.',
  rolling: 'The canary passed. The rest are moving, paced.',
  halted: 'Halted.',
};

/** Why a computer is not being moved, as one word for the page's counts. */
export type HoldCode = 'contained' | 'rollout' | 'opted_out' | 'outside_window' | 'offline' | 'no_device_secret' | 'archived' | 'cancelled_by_person' | 'other';

export const HOLD_LABEL: Record<HoldCode, string> = {
  contained: 'Updates paused (containment)',
  rollout: 'A staged rollout owns it',
  opted_out: 'Opted out by its update policy',
  outside_window: 'Outside its policy\'s update window',
  offline: 'Not checking in',
  no_device_secret: 'No device secret (re-run the installer once)',
  archived: 'Archived',
  cancelled_by_person: 'Someone cancelled its move',
  other: 'Other',
};

/** A migrationBlock code → the page's hold. Null: not a hold (eligible, or not a standard Windows computer). */
export function holdOf(code: string | null): HoldCode | null {
  switch (code) {
    case null: return null;
    case 'CONTAINED': return 'contained';
    case 'IN_ROLLOUT': return 'rollout';
    case 'NO_DEVICE_SECRET': return 'no_device_secret';
    case 'ARCHIVED': return 'archived';
    case 'ALREADY_SIGNED': case 'LINUX_AGENT_READ_ONLY': case 'MACOS_AGENT_READ_ONLY': case 'NOT_WINDOWS': return null;
    // Platform-wide: the page's steps 1 and 2 (and the mode) say so, not each computer.
    case 'NO_SIGNED_RELEASE': case 'NO_PORTAL_ADDRESS': case 'SIGNED_ONLY': return null;
    default: return 'other';
  }
}
