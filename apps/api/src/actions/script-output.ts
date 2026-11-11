import { z } from 'zod';
import { redactLog } from './logs';
import { MAX_SCRIPT_OUTPUT_BYTES } from './script-run';

/**
 * What a computer reports for windows.script.run (0.34), made fit to store.
 *
 * The agent caps each stream at MAX_SCRIPT_OUTPUT_BYTES, redacts it and
 * sends it base64-encoded (so neither its own JSON writer nor Windows
 * PowerShell's re-serialisation can inflate it past the heartbeat's body
 * limit). That copy is the agent's, so the portal decodes it, replaces
 * invalid UTF-8, redacts it again with the same rules as collected logs
 * (logs.ts redactLog: control characters, user-profile paths, long opaque
 * tokens, key=value credentials) and caps it again. Plain module: the unit
 * test reads what the API runs.
 */

const B64 = z.string().max(120_000).regex(/^[A-Za-z0-9+/]*={0,2}$/);

export const ScriptAgentResult = z.object({
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  exitCode: z.number().int().min(-2_147_483_648).max(4_294_967_295).nullable(),
  timedOut: z.boolean(),
  durationMs: z.number().int().min(0).max(4 * 3600_000).optional(),
  stdout: B64,
  stderr: B64,
  stdoutBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  stderrBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  stdoutTruncated: z.boolean(),
  stderrTruncated: z.boolean(),
  cleanup: z.enum(['removed', 'failed']).optional(),
}).strict();
export type ScriptAgentResult = z.infer<typeof ScriptAgentResult>;

/** The first `max` bytes of s as UTF-8, never splitting a character. */
export function headBytes(s: string, max: number): string {
  const b = Buffer.from(s, 'utf8');
  if (b.length <= max) return s;
  let end = max;
  while (end > 0 && (b[end] & 0xc0) === 0x80) end--;
  return b.subarray(0, end).toString('utf8');
}

export interface StoredStream { text: string; truncated: boolean }

/** One stream: decode, redact again, cap again. */
export function sanitizeStream(b64: string, agentTruncated: boolean): StoredStream {
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(Buffer.from(b64, 'base64'));
  const red = redactLog(decoded);
  const text = headBytes(red, MAX_SCRIPT_OUTPUT_BYTES);
  return { text, truncated: agentTruncated || text.length < red.length };
}

export interface StoredScriptOutput {
  exitCode: number | null; timedOut: boolean; durationMs: number | null;
  stdout: StoredStream; stderr: StoredStream; stdoutBytes: number; stderrBytes: number; cleanup: string | null;
}

export function sanitizeScriptOutput(r: ScriptAgentResult): StoredScriptOutput {
  return {
    // Windows exit codes are unsigned 32-bit (0xC000013A is 3221225786); stored as the signed int32 Windows would show as a negative HRESULT.
    exitCode: r.exitCode === null ? null : r.exitCode > 2_147_483_647 ? r.exitCode - 4_294_967_296 : r.exitCode,
    timedOut: r.timedOut, durationMs: r.durationMs ?? null,
    stdout: sanitizeStream(r.stdout, r.stdoutTruncated), stderr: sanitizeStream(r.stderr, r.stderrTruncated),
    stdoutBytes: r.stdoutBytes, stderrBytes: r.stderrBytes, cleanup: r.cleanup ?? null,
  };
}

/** What stays on the ActionTarget row: the summary, never the text. */
export function scriptSummary(r: ScriptAgentResult) {
  return {
    contentSha256: r.contentSha256, exitCode: r.exitCode, timedOut: r.timedOut, durationMs: r.durationMs ?? null,
    stdoutBytes: r.stdoutBytes, stderrBytes: r.stderrBytes, stdoutTruncated: r.stdoutTruncated, stderrTruncated: r.stderrTruncated, cleanup: r.cleanup ?? null,
  };
}
