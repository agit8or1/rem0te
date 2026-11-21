/**
 * The background terminal's limits (0.77 Conduit, docs/remote-terminal.md).
 *
 * Pure constants: no imports. The agent compiles the same numbers
 * (tools/windows-installer/internal/remote/limits.go) and enforces them
 * itself, so a portal that asked for more would still be cut off at these;
 * §87 of the security invariants checks the two files agree.
 */

/** Without the technician's input for this long, the session ends. Only input moves it; output, reads and reconnects never do. */
export const TERMINAL_IDLE_MS = 15 * 60_000;
/** The hard limit, from when it was opened. Never extended, by anything. */
export const TERMINAL_MAX_MS = 60 * 60_000;

/** The only two shells. The agent maps each to one absolute System32 path. */
export const TERMINAL_SHELLS = ['cmd', 'powershell'] as const;
export type TerminalShell = (typeof TERMINAL_SHELLS)[number];

/** One input frame (what one Send carries), in bytes of UTF-8. */
export const TERMINAL_INPUT_FRAME_MAX = 4096;
/** One output frame, in bytes. */
export const TERMINAL_OUTPUT_FRAME_MAX = 16384;
/** Everything typed in one session. Beyond it the session ends (input_cap). */
export const TERMINAL_SESSION_INPUT_MAX = 1024 * 1024;
/** Everything printed in one session. Beyond it the session ends (output_cap). */
export const TERMINAL_SESSION_OUTPUT_MAX = 8 * 1024 * 1024;
/** Output frames in one agent post, and input frames in one poll answer. */
export const TERMINAL_OUTPUT_FRAMES_PER_POST = 16;
export const TERMINAL_INPUT_FRAMES_PER_POLL = 32;
/** Output frames in one read by the browser. */
export const TERMINAL_READ_FRAMES = 64;
/** Live (pending or open) terminals on one computer, from everyone. One per technician (0094 index). */
export const TERMINAL_LIVE_PER_COMPUTER = 3;

/** The agent release that first carries the remote worker. */
export const TERMINAL_MIN_AGENT = '0.77.0';

/** How long a worker's poll is held when there is nothing for it. */
export const REMOTE_POLL_HOLD_MS = 20_000;
/** A held poll also re-reads the database this often (another API process may have the news). */
export const REMOTE_POLL_RECHECK_MS = 2_000;

export const TERMINAL_REASON_MIN = 3;
export const TERMINAL_REASON_MAX = 500;

/** Transcript retention, when a business turned transcripts on. */
export const TRANSCRIPT_DAYS_DEFAULT = 30;
export const TRANSCRIPT_DAYS_MIN = 1;
export const TRANSCRIPT_DAYS_MAX = 365;

/** Why a session ended: a closed list (0094 CHECK). */
export const END_REASONS = [
  'closed', 'revoked', 'expired_idle', 'expired_max', 'paused', 'exited',
  'agent_refused', 'agent_error', 'output_cap', 'input_cap', 'endpoint_unavailable',
] as const;
export type EndReason = (typeof END_REASONS)[number];

/** What the agent may say when it will not start a shell: a closed list. */
export const AGENT_REFUSALS = ['shell_unavailable', 'start_failed', 'too_many', 'bad_request'] as const;

export const SESSION_ID_RE = /^[0-9a-f]{32}$/;
export const ENDPOINT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// ── File transfer (0.78 Courier, docs/file-transfer.md) ──────────────────────
// The agent compiles the same numbers (internal/remote/limits.go), and §88 of
// the security invariants checks that they agree.

/**
 * One chunk, in bytes, in both directions. As base64 in JSON it is about
 * 700 KB, which is under the API's 1 MB body limit.
 */
export const FILE_CHUNK_BYTES = 512 * 1024;
/** At most this many chunks stored and not yet taken by the other end (0095 CHECK). */
export const FILE_WINDOW_CHUNKS = 8;
/** The per-business size limit, in MiB: 100 by default, 2 GiB at most (0095 CHECK). */
export const FILE_MAX_MB_DEFAULT = 100;
export const FILE_MAX_MB_MIN = 1;
export const FILE_MAX_MB_MAX = 2048;
/** A transfer's hard limit, from when it was requested (0095 CHECK). */
export const FILE_TRANSFER_MAX_MS = 60 * 60_000;
/** If no chunk moves for this long, the transfer fails as `stalled`. */
export const FILE_STALL_MS = 10 * 60_000;
/** A finished download's chunks wait this long for the browser, then are deleted. */
export const FILE_CHUNK_KEEP_MS = 15 * 60_000;
/** At most this many live (pending or transferring) transfers on one computer, from everyone. */
export const FILE_LIVE_PER_COMPUTER = 2;
/** The first agent release that carries file transfer. */
export const FILES_MIN_AGENT = '0.78.0';
/** A path's length, in characters. */
export const FILE_PATH_MIN = 4;
export const FILE_PATH_MAX = 1024;

export const FILE_DIRECTIONS = ['to_computer', 'from_computer'] as const;
export type FileDirection = (typeof FILE_DIRECTIONS)[number];

/**
 * The closed list of codes the agent may report instead of completing. The
 * agent's Go code uses the same list.
 */
export const AGENT_FILE_ERRORS = [
  'exists', 'not_found', 'not_a_file', 'no_folder', 'reparse_point', 'path_refused', 'path_changed',
  'too_large', 'hash_mismatch', 'size_mismatch', 'file_changed', 'write_failed', 'read_failed',
] as const;
export type AgentFileError = (typeof AGENT_FILE_ERRORS)[number];

/** Why a transfer ended: a closed list (0095 CHECK). */
export const FILE_END_REASONS = [
  'completed', 'cancelled', 'revoked', 'expired', 'stalled', 'paused', 'endpoint_unavailable', 'agent_error',
  ...AGENT_FILE_ERRORS,
] as const;
export type FileEndReason = (typeof FILE_END_REASONS)[number];

/**
 * Windows' reserved device names. Any path component that is one of these,
 * with or without an extension, is refused.
 */
export const RESERVED_NAMES = [
  'CON', 'PRN', 'AUX', 'NUL',
  'COM0', 'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT0', 'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
] as const;

export const SHA256_RE = /^[0-9a-f]{64}$/;
