/**
 * The background terminal's decisions (0.77 Conduit), pure: they import only
 * ./limits, take the clock as an argument and touch no database, so
 * apps/api/scripts/unit-terminal.mjs runs them as they are.
 *
 * TerminalService asks these; it never decides an order, a deadline or a
 * permission of its own.
 */
import {
  END_REASONS, TERMINAL_IDLE_MS, TERMINAL_INPUT_FRAME_MAX, TERMINAL_MAX_MS, TERMINAL_OUTPUT_FRAME_MAX,
  TERMINAL_OUTPUT_FRAMES_PER_POST, TERMINAL_REASON_MAX, TERMINAL_REASON_MIN, TERMINAL_SHELLS, TERMINAL_LIVE_PER_COMPUTER,
  type EndReason, type TerminalShell,
} from './limits';

export interface Refusal { status: 400 | 403 | 404 | 409; code: string; message: string }

/** a.b.c compared as numbers; null when either is not a version. */
export function compareVersion(a: string | null | undefined, b: string): number | null {
  const p = (v: string | null | undefined) => (v && /^\d+\.\d+\.\d+/.test(v) ? v.split(/[.+-]/).slice(0, 3).map(Number) : null);
  const x = p(a), y = p(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

export function isShell(v: unknown): v is TerminalShell {
  return typeof v === 'string' && (TERMINAL_SHELLS as readonly string[]).includes(v);
}

/** The reason a technician gives: trimmed, 3–500 characters, no control characters. */
export function cleanReason(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const r = v.replace(/\s+/g, ' ').trim();
  if (r.length < TERMINAL_REASON_MIN || r.length > TERMINAL_REASON_MAX) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(r)) return null;
  return r;
}

/** What the open decision reads about the computer, after scope (a computer out of scope is a 404 before this). */
export interface OpenFacts {
  pooled: boolean;
  windows: boolean;
  signed: boolean;
  /** A device secret is on record: every agent call can be authenticated. */
  deviceSecret: boolean;
  agentVersion: string | null;
  minAgent: string;
  /** connectivity.ts: a current heartbeat. */
  online: boolean;
  /** A `remote` containment pause covers it. */
  paused: boolean;
  /** This technician already has a live terminal on it. */
  ownLive: boolean;
  /** Live terminals on it, from everyone. */
  liveCount: number;
}

/**
 * Whether a terminal may open, in this order (the first refusal wins). Scope,
 * the capability and the fresh confirmation were checked before.
 */
export function openRefusal(f: OpenFacts): Refusal | null {
  if (f.pooled) return { status: 403, code: 'ENDPOINT_UNASSIGNED', message: 'This computer is in the unassigned pool: adopt it into a business first.' };
  if (!f.windows || !f.signed) return { status: 409, code: 'TERMINAL_SIGNED_AGENT_REQUIRED', message: 'A terminal needs a Windows computer running the signed (full) agent.' };
  if (!f.deviceSecret) return { status: 409, code: 'TERMINAL_NO_DEVICE_SECRET', message: 'This computer has no device secret on record, so nothing it sends can be authenticated. Re-run its installer once.' };
  const v = compareVersion(f.agentVersion, f.minAgent);
  if (v === null || v < 0) return { status: 409, code: 'TERMINAL_AGENT_TOO_OLD', message: `A terminal needs the signed agent ${f.minAgent} or later; publish it and let the computer update.` };
  if (f.paused) return { status: 403, code: 'CONTAINED', message: 'Remote access is paused by containment for this computer: no terminal was opened.' };
  if (!f.online) return { status: 409, code: 'TERMINAL_OFFLINE', message: 'This computer is not reporting, so it cannot be asked to open a terminal. Try again once it checks in.' };
  if (f.ownLive) return { status: 409, code: 'TERMINAL_ALREADY_OPEN', message: 'You already have a terminal open on this computer. End it first.' };
  if (f.liveCount >= TERMINAL_LIVE_PER_COMPUTER) return { status: 409, code: 'TERMINAL_TOO_MANY', message: `At most ${TERMINAL_LIVE_PER_COMPUTER} terminals can be open on one computer.` };
  return null;
}

/** The hard limit for a session opened at `createdAt`. */
export function hardLimit(createdAt: number): number {
  return createdAt + TERMINAL_MAX_MS;
}

export interface Timed { state: string; notAfter: Date | number; lastActivityAt: Date | number }

const ms = (d: Date | number) => (typeof d === 'number' ? d : d.getTime());

/** When it ends on its own, and why: the earlier of the idle limit and the hard limit. */
export function deadline(s: Timed): { at: number; reason: 'expired_idle' | 'expired_max' } {
  const idle = ms(s.lastActivityAt) + TERMINAL_IDLE_MS;
  const max = ms(s.notAfter);
  return idle < max ? { at: idle, reason: 'expired_idle' } : { at: max, reason: 'expired_max' };
}

/** Whether a live session is past a limit now; null while it may go on. */
export function expiry(s: Timed, now: number): 'expired_idle' | 'expired_max' | null {
  if (s.state === 'ended') return null;
  if (now >= ms(s.notAfter)) return 'expired_max';
  if (now >= ms(s.lastActivityAt) + TERMINAL_IDLE_MS) return 'expired_idle';
  return null;
}

/**
 * Activity: only the technician's own input (or Keep alive) moves the idle
 * clock, and never past the hard limit. Reads, the agent's polls and output
 * never call this.
 */
export function touch(s: { notAfter: Date | number }, now: number): Date {
  return new Date(Math.min(now, ms(s.notAfter)));
}

/** Seconds left on each clock, for the console. */
export function remaining(s: Timed, now: number): { idleSeconds: number; totalSeconds: number } {
  return {
    idleSeconds: Math.max(0, Math.floor((ms(s.lastActivityAt) + TERMINAL_IDLE_MS - now) / 1000)),
    totalSeconds: Math.max(0, Math.floor((ms(s.notAfter) - now) / 1000)),
  };
}

export interface EnderFacts {
  userId: string;
  isPlatformAdmin: boolean;
  /** The actor acts through a technician assignment (MSP staff). */
  technician: boolean;
  businessId: string | null;
  canEditComputers: boolean;
}

/**
 * Who may end a session, and what it is called. The session's own technician
 * closes it; a Platform Admin, or the business's own member with Edit
 * computers, revokes it. Anyone else: null (the route answers 404).
 */
export function endAs(actor: EnderFacts, s: { technicianId: string; businessId: string }): 'closed' | 'revoked' | null {
  if (s.technicianId === actor.userId) return 'closed';
  if (actor.isPlatformAdmin) return 'revoked';
  if (!actor.technician && actor.businessId === s.businessId && actor.canEditComputers) return 'revoked';
  return null;
}

/** The audit action for an end reason. */
export function endAction(r: EndReason): 'TERMINAL_CLOSED' | 'TERMINAL_REVOKED' | 'TERMINAL_EXPIRED' | 'TERMINAL_ENDED' {
  if (r === 'closed') return 'TERMINAL_CLOSED';
  if (r === 'revoked') return 'TERMINAL_REVOKED';
  if (r === 'expired_idle' || r === 'expired_max') return 'TERMINAL_EXPIRED';
  return 'TERMINAL_ENDED';
}

export const isEndReason = (v: unknown): v is EndReason => typeof v === 'string' && (END_REASONS as readonly string[]).includes(v);

/** One Send from the browser: 1 to 4,096 bytes of UTF-8, no NUL. */
export function inputBytes(v: unknown): Buffer | null {
  if (typeof v !== 'string' || v.length === 0 || v.includes('\u0000')) return null;
  const b = Buffer.from(v, 'utf8');
  return b.length >= 1 && b.length <= TERMINAL_INPUT_FRAME_MAX ? b : null;
}

export interface OutFrame { seq: number; stream: 'stdout' | 'stderr'; data: Buffer }

/**
 * The agent's output frames, checked: at most 16 a post, each 1–16,384 bytes
 * of base64-decoded data on stdout or stderr, with sequence numbers that
 * follow on from `lastSeq` without a gap. Frames at or below `lastSeq` are a
 * retry of what was already taken and are dropped. Anything else refuses the
 * whole post (null).
 */
export function outputFrames(raw: unknown, lastSeq: number): OutFrame[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > TERMINAL_OUTPUT_FRAMES_PER_POST) return null;
  const out: OutFrame[] = [];
  let next = lastSeq + 1;
  for (const f of raw as unknown[]) {
    if (!f || typeof f !== 'object') return null;
    const { seq, stream, data } = f as { seq?: unknown; stream?: unknown; data?: unknown };
    if (!Number.isInteger(seq) || (seq as number) < 1 || (stream !== 'stdout' && stream !== 'stderr') || typeof data !== 'string') return null;
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length > Math.ceil(TERMINAL_OUTPUT_FRAME_MAX / 3) * 4) return null;
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length < 1 || bytes.length > TERMINAL_OUTPUT_FRAME_MAX) return null;
    if ((seq as number) <= lastSeq) continue;
    if (seq !== next) return null;
    out.push({ seq: seq as number, stream, data: bytes });
    next++;
  }
  return out;
}
