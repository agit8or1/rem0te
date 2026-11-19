import { z } from 'zod';

/**
 * The signed agent's read-only RustDesk preflight (0.69, Managed Secure
 * Access build step 2; docs/managed-secure-access.md §3.7).
 *
 * What the agent reports, on its authenticated signed heartbeat, about the
 * RustDesk installed on the computer. Pure: zod only. The agent's side is
 * `tools/windows-installer/internal/msa` (the same key list, charsets and
 * closed values) and its one exec site runs the INSTALLED rustdesk.exe with
 * `--option <key>` — a read, never a value, never `--password`.
 *
 * The block is facts, not settings:
 *   - `installed`: rustdesk.exe is where the installer puts it
 *     (%ProgramFiles%\RustDesk\rustdesk.exe).
 *   - `expectedPath`: the RustDesk service runs that exe. Reported as a
 *     boolean, never as path text: a RustDesk installed somewhere else is
 *     often under a user's profile, and the path would carry their name.
 *   - `version`: the exe's FileVersion resource ("1.4.7+65").
 *   - `build`: flutter / sciter / unknown — a heuristic (flutter_windows.dll
 *     or sciter.dll beside the exe).
 *   - `service`: running / stopped / missing / other.
 *   - `cli` and `keys`: whether each `--option <key>` READ answered with a
 *     well-formed value. The values themselves are not reported.
 *
 * Anything that does not parse is dropped whole — the heartbeat goes on, an
 * older or newer agent is never refused for it (the DTO only `@Allow`s it).
 */

export const PREFLIGHT_SCHEMA = 'rem0te-rustdesk-preflight/1';

/**
 * The options Managed Secure Access will set (§3.3), read-only here. The
 * same list, in the same order, as the agent's `msa.Keys` and the lab's
 * probe (tools/lab/windows/rustdesk-probe.ps1).
 */
export const PREFLIGHT_KEYS = [
  'access-mode',
  'enable-keyboard',
  'enable-clipboard',
  'enable-file-transfer',
  'enable-audio',
  'enable-tunnel',
  'enable-remote-restart',
  'approve-mode',
  'verification-method',
  'allow-auto-disconnect',
  'auto-disconnect-timeout',
] as const;
export type PreflightKey = (typeof PREFLIGHT_KEYS)[number];

export const KEY_RESULTS = ['ok', 'unparsed', 'timeout', 'error'] as const;
export const BUILDS = ['flutter', 'sciter', 'unknown'] as const;
export const SERVICE_STATES = ['running', 'stopped', 'missing', 'other'] as const;
export const CLI_RESULTS = ['ok', 'partial', 'failed', 'not_run'] as const;

/** RustDesk's FileVersion: "1.4.7+65" on every lab-tested release. */
// eslint-disable-next-line security/detect-unsafe-regex -- anchored, bounded repetitions, one optional group starting with a literal [.+] the digit classes exclude: nothing to backtrack over
export const VERSION_RE = /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}([.+][0-9]{1,6})?$/;
/** The agent writes UTC to the second. */
export const CHECKED_AT_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;

const KeyResult = z.enum(KEY_RESULTS);
const keyShape = Object.fromEntries(PREFLIGHT_KEYS.map((k) => [k, KeyResult.optional()])) as { [K in PreflightKey]: z.ZodOptional<typeof KeyResult> };

export const Preflight = z.strictObject({
  schema: z.literal(PREFLIGHT_SCHEMA),
  checkedAt: z.string().regex(CHECKED_AT_RE),
  installed: z.boolean(),
  expectedPath: z.boolean(),
  version: z.string().regex(VERSION_RE).nullable(),
  build: z.enum(BUILDS),
  service: z.enum(SERVICE_STATES),
  cli: z.enum(CLI_RESULTS),
  keys: z.strictObject(keyShape),
  durationMs: z.number().int().min(0).max(600_000),
}).superRefine((p, ctx) => {
  const answered = Object.values(p.keys).filter(Boolean).length;
  const ok = Object.values(p.keys).filter((v) => v === 'ok').length;
  // `cli` must agree with the keys, or the block is not believed at all.
  const want = answered === 0 ? 'not_run' : ok === PREFLIGHT_KEYS.length ? 'ok' : ok === 0 ? 'failed' : 'partial';
  if (p.cli === 'not_run' ? answered !== 0 : (answered !== PREFLIGHT_KEYS.length || p.cli !== want)) {
    ctx.addIssue({ code: 'custom', message: 'cli_disagrees_with_keys' });
  }
  // The agent never runs an exe that is not the installed one.
  if (p.cli !== 'not_run' && !(p.installed && p.expectedPath)) ctx.addIssue({ code: 'custom', message: 'ran_without_installed_exe' });
});
export type PreflightBlock = z.infer<typeof Preflight>;

/** How far ahead of the server's clock a `checkedAt` may be. */
export const MAX_CLOCK_SKEW_MS = 10 * 60_000;

/**
 * Parse a heartbeat's block. Null for anything malformed, unknown, or dated
 * in the future (a clock far ahead would pin "newest" forever). Never throws.
 */
export function parsePreflight(raw: unknown, now: number = Date.now()): (PreflightBlock & { checkedAtDate: Date; keysOk: number }) | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  // Bounded before zod sees it: a block is ~600 bytes.
  try { if (JSON.stringify(raw).length > 8000) return null; } catch { return null; }
  const p = Preflight.safeParse(raw);
  if (!p.success) return null;
  const at = new Date(p.data.checkedAt);
  if (!Number.isFinite(at.getTime()) || at.getTime() > now + MAX_CLOCK_SKEW_MS) return null;
  const keysOk = Object.values(p.data.keys).filter((v) => v === 'ok').length;
  return { ...p.data, checkedAtDate: at, keysOk };
}
