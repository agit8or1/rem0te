/**
 * File transfer's decisions (0.78 Courier, docs/file-transfer.md).
 *
 * These are pure. They import only node:crypto, ./limits and ./policy, take
 * the clock as an argument, and touch no database, so
 * apps/api/scripts/unit-files.mjs runs them as they are.
 *
 * The path rule is the agent's own (internal/remote/filepath.go). Both are
 * tested against one fixture, internal/remote/testdata/file-paths.json. The
 * portal refuses early so the technician hears why at once. The agent decides
 * again on the computer, and only the agent can see a reparse point.
 */
import { createHash } from 'node:crypto';
import {
  FILE_CHUNK_BYTES, FILE_DIRECTIONS, FILE_END_REASONS, FILE_LIVE_PER_COMPUTER, FILE_PATH_MAX, FILE_PATH_MIN,
  FILE_STALL_MS, RESERVED_NAMES, SHA256_RE, type FileDirection, type FileEndReason,
} from './limits';
import { compareVersion, type Refusal } from './policy';

/** Characters Windows does not allow in a name, plus the stream separator. */
// eslint-disable-next-line no-control-regex
const BAD_CHARS = /[<>:"|?*\u0000-\u001f\u007f]/;

/**
 * Whether a path is one the agent may touch. Returns null when it is, or a
 * short reason when it is not. The rules:
 *
 * - An absolute local path: a drive letter, a colon and a backslash, then at
 *   least one name. Nothing relative.
 * - No UNC or device path (`\\server\…`, `\\?\…`, `\\.\…`), and no forward
 *   slash anywhere.
 * - No `..` anywhere, and no `.` component.
 * - No empty component, so no doubled or trailing backslash.
 * - No name ending in a dot or a space.
 * - No character Windows refuses, and no colon after the drive, so no
 *   alternate data stream.
 * - No reserved device name (CON, NUL, COM1 …), with or without an extension.
 * - 4 to 1,024 characters.
 */
export function checkPath(p: unknown): string | null {
  if (typeof p !== 'string') return 'not a path';
  const n = [...p].length;
  if (n < FILE_PATH_MIN || n > FILE_PATH_MAX) return `must be ${FILE_PATH_MIN} to ${FILE_PATH_MAX} characters`;
  if (p.startsWith('\\\\') || p.startsWith('//')) return 'network and device paths are refused';
  if (!/^[A-Za-z]:\\/.test(p)) return 'must be an absolute local path such as C:\\Temp\\file.txt';
  if (p.includes('/')) return 'use backslashes only';
  if (p.includes('..')) return '".." is refused';
  const parts = p.slice(3).split('\\');
  for (const c of parts) {
    if (c === '') return 'empty folder name (a doubled or trailing backslash)';
    if (c === '.') return '"." is refused';
    if (BAD_CHARS.test(c)) return `"${c}" has a character Windows does not allow (or a stream name)`;
    if (c.endsWith('.') || c.endsWith(' ')) return `"${c}" ends in a dot or a space`;
    const base = c.split('.')[0].replace(/ +$/, '').toUpperCase();
    if ((RESERVED_NAMES as readonly string[]).includes(base)) return `"${c}" is a reserved device name`;
  }
  return null;
}

export const isDirection = (v: unknown): v is FileDirection => typeof v === 'string' && (FILE_DIRECTIONS as readonly string[]).includes(v);
export const isFileEndReason = (v: unknown): v is FileEndReason => typeof v === 'string' && (FILE_END_REASONS as readonly string[]).includes(v);
export const isSha256 = (v: unknown): v is string => typeof v === 'string' && SHA256_RE.test(v);

/** The business's limit in bytes. */
export function maxBytesOf(mb: number): number {
  return mb * 1024 * 1024;
}

/** The chunks a file of `size` bytes takes. */
export function chunksFor(size: number): number {
  return Math.ceil(size / FILE_CHUNK_BYTES);
}

/** What the request decision reads about the computer, after scope. */
export interface FileFacts {
  pooled: boolean;
  windows: boolean;
  signed: boolean;
  deviceSecret: boolean;
  agentVersion: string | null;
  minAgent: string;
  online: boolean;
  paused: boolean;
  /** Live transfers on it, from everyone. */
  liveCount: number;
}

/**
 * Whether a transfer may be requested, in this order (the first refusal
 * wins). Scope, the capability for the direction, the path, the reason, the
 * size and the fresh confirmation were checked before this.
 */
export function fileRefusal(f: FileFacts): Refusal | null {
  if (f.pooled) return { status: 403, code: 'ENDPOINT_UNASSIGNED', message: 'This device is in the unassigned pool: adopt it into a customer first.' };
  if (!f.windows || !f.signed) return { status: 409, code: 'FILES_SIGNED_AGENT_REQUIRED', message: 'File transfer needs a Windows device running the signed (full) agent.' };
  if (!f.deviceSecret) return { status: 409, code: 'FILES_NO_DEVICE_SECRET', message: 'This device has no device secret on record, so nothing it sends can be authenticated. Re-run its installer once.' };
  const v = compareVersion(f.agentVersion, f.minAgent);
  if (v === null || v < 0) return { status: 409, code: 'FILES_AGENT_TOO_OLD', message: `File transfer needs the signed agent ${f.minAgent} or later; publish it and let the device update.` };
  if (f.paused) return { status: 403, code: 'CONTAINED', message: 'Remote access is paused by containment for this device: no transfer was started.' };
  if (!f.online) return { status: 409, code: 'FILES_OFFLINE', message: 'This device is not reporting, so it cannot be asked to transfer a file. Try again once it checks in.' };
  if (f.liveCount >= FILE_LIVE_PER_COMPUTER) return { status: 409, code: 'FILES_TOO_MANY', message: `At most ${FILE_LIVE_PER_COMPUTER} transfers can run on one device at a time.` };
  return null;
}

export interface TransferTimed { state: string; notAfter: Date | number; lastProgressAt: Date | number }
const ms = (d: Date | number) => (typeof d === 'number' ? d : d.getTime());
export const LIVE_TRANSFER = ['pending', 'transferring'] as const;
export const isLiveTransfer = (state: string) => (LIVE_TRANSFER as readonly string[]).includes(state);

/** Whether a live transfer is past its limit (`expired`), or nothing moved for 10 minutes (`stalled`). */
export function fileExpiry(t: TransferTimed, now: number): 'expired' | 'stalled' | null {
  if (!isLiveTransfer(t.state)) return null;
  if (now >= ms(t.notAfter)) return 'expired';
  if (now >= ms(t.lastProgressAt) + FILE_STALL_MS) return 'stalled';
  return null;
}

/** The audit action for an end reason. */
export function fileEndAction(r: FileEndReason): 'FILE_TRANSFER_COMPLETED' | 'FILE_TRANSFER_CANCELLED' | 'FILE_TRANSFER_FAILED' {
  if (r === 'completed') return 'FILE_TRANSFER_COMPLETED';
  if (r === 'cancelled' || r === 'revoked') return 'FILE_TRANSFER_CANCELLED';
  return 'FILE_TRANSFER_FAILED';
}

export function sha256Hex(b: Buffer | Uint8Array): string {
  return createHash('sha256').update(b).digest('hex');
}

/**
 * One chunk as it arrives, checked. It must be base64 of 1 to 524,288 bytes,
 * and its SHA-256 must be the one declared beside it. Otherwise: null.
 */
export function decodeChunk(data: unknown, sha: unknown): Buffer | null {
  if (typeof data !== 'string' || !isSha256(sha)) return null;
  if (data.length === 0 || data.length > Math.ceil(FILE_CHUNK_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return null;
  const b = Buffer.from(data, 'base64');
  if (b.length < 1 || b.length > FILE_CHUNK_BYTES) return null;
  return sha256Hex(b) === sha ? b : null;
}

/**
 * Whether a chunk's size fits the file. Every chunk but the last is exactly
 * one chunk long, and the last one makes up the declared size.
 */
export function chunkFits(seq: number, len: number, size: number): boolean {
  const total = chunksFor(size);
  if (seq < 1 || seq > total) return false;
  if (seq < total) return len === FILE_CHUNK_BYTES;
  return len === size - (total - 1) * FILE_CHUNK_BYTES;
}
