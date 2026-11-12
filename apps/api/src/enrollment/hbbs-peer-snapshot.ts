/**
 * One shared, short-lived copy of hbbs's peer table (0.34).
 *
 * The question it answers is "has hbbs ever accepted a registration from this
 * RustDesk ID?" — `rustdeskRegistered` in the heartbeat response, which the
 * Windows installer polls for up to 90 s and on which it refuses to report
 * success when the answer is a certain *no*, and the "has it registered before"
 * line of a computer's diagnostics. Until 0.34 every heartbeat spawned a
 * `sqlite3` process to ask it for one ID; at 5,000 computers that process was
 * most of the API's CPU (docs/server-sizing.md). Now one `sqlite3` reads every
 * ID at most once per window and the answers come from a Set.
 *
 * What may not change is what an answer means. So:
 *
 *   - A snapshot is used only while it is younger than the window, measured
 *     from when its read *started* (a slow read cannot stretch the window).
 *     After that it is never consulted again: an ID deleted from the peer
 *     table stops answering `true` within one window — the same as a row
 *     deleted between two of the old per-heartbeat reads, plus at most the
 *     window.
 *   - A failed read discards the previous snapshot. An unreadable database
 *     answers `null` (unknown), exactly as the per-call read did, and never
 *     falls back to an older copy. The failure is remembered for the same
 *     window, so a host without hbbs does not spawn a process per heartbeat
 *     to learn the same thing again.
 *   - The window is clamped to MAX_WINDOW_MS whatever the configuration says,
 *     so staleness cannot be configured into something unbounded.
 *   - Only IDs that are 6–15 digits are kept (filtered in the SQL and again
 *     here), and only such IDs are asked about; anything else is `null`, as
 *     before. A peer ID containing a newline cannot smuggle a second "ID"
 *     into the parsed output, because the SQL refuses any non-digit.
 *   - Concurrent callers share one read in flight.
 */
export const DEFAULT_WINDOW_MS = 10_000;
export const MIN_WINDOW_MS = 1_000;
export const MAX_WINDOW_MS = 30_000;

export const PEER_ID_RE = /^[0-9]{6,15}$/;

/** The one query: every digits-only ID of plausible length, nothing else. */
export const PEER_SNAPSHOT_SQL =
  "SELECT id FROM peer WHERE length(id) BETWEEN 6 AND 15 AND id NOT GLOB '*[^0-9]*';";

export function clampWindowMs(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_WINDOW_MS;
  return Math.min(MAX_WINDOW_MS, Math.max(MIN_WINDOW_MS, Math.round(n)));
}

/** Parse the sqlite3 CLI's list output: one ID per line. */
export function parsePeerIds(stdout: string): Set<string> {
  const ids = new Set<string>();
  for (const line of stdout.split('\n')) {
    const id = line.trim();
    if (PEER_ID_RE.test(id)) ids.add(id);
  }
  return ids;
}

type Snapshot = { startedAt: number; ids: Set<string> | null };

export class HbbsPeerSnapshot {
  private snap: Snapshot | null = null;
  private inflight: Promise<Snapshot> | null = null;
  readonly windowMs: number;
  /** Reads attempted so far (for tests and the bench). */
  loads = 0;

  constructor(
    /** Read every peer ID; reject when the table cannot be read. */
    private readonly load: () => Promise<Set<string>>,
    windowMs: unknown = DEFAULT_WINDOW_MS,
    private readonly now: () => number = Date.now,
  ) {
    this.windowMs = clampWindowMs(windowMs);
  }

  /** true registered, false certainly not, null unknown. Never throws. */
  async has(rustdeskId: string): Promise<boolean | null> {
    if (!PEER_ID_RE.test(rustdeskId)) return null;
    const s = await this.current();
    return s.ids === null ? null : s.ids.has(rustdeskId);
  }

  private fresh(s: Snapshot | null): s is Snapshot {
    if (!s) return false;
    const age = this.now() - s.startedAt;
    // A clock that went backwards makes the age meaningless: treat as stale.
    return age >= 0 && age < this.windowMs;
  }

  private async current(): Promise<Snapshot> {
    if (this.fresh(this.snap)) return this.snap;
    // Expired: never consulted again, whether or not the next read works.
    this.snap = null;
    if (!this.inflight) {
      const startedAt = this.now();
      this.loads++;
      this.inflight = this.load()
        .then((ids) => ({ startedAt, ids }), () => ({ startedAt, ids: null }))
        .then((s) => { this.snap = s; this.inflight = null; return s; });
    }
    return this.inflight;
  }
}
